/**
 * The composition root: where the chokepoint, the ledger, the provider and the run are wired
 * together, once per process, and where the process refuses to start if any of it is missing.
 *
 * ## One store, cached where a hot reload can find it
 *
 * `PgLedgerStore` opens a pool in its constructor and has a `close()` that no server ever calls.
 * A module-level instance would therefore leak four connections on every hot reload of the
 * development server, and a long afternoon of editing would end in an exhausted `max_connections`
 * with no obvious culprit. `src/server/db.ts` solved that for the application's own pool by
 * caching it on `globalThis`; this file does the same for the ledger's, for the same reason.
 *
 * **The process's connection budget, declared rather than discovered:** 8 for the application pool
 * (`DATABASE_POOL_MAX`, default 8) and 4 for the ledger's, so twelve against whatever the target
 * allows. A managed platform's pooler sits in front of both, which is a thing to size against and
 * not a thing that makes the number smaller.
 *
 * ## One gateway, one run, one organisation
 *
 * The registry is keyed by organisation and each entry holds a gateway and the run it writes into.
 * That the three are in one-to-one-to-one correspondence is not a convention, it is the condition
 * under which the ledger works at all: `ledger_link()` is `security definer` and reads the true
 * head of a run across tenants, while the writer reads a head clipped by the tenant policy — so a
 * run whose rows belong to two organisations has a writer proposing a `prev_hash` the trigger will
 * reject for as long as anyone retries. `E_LEDGER_WRITE_FAILED`, permanently, on a run that looks
 * ordinary.
 *
 * The invariant is held structurally rather than asserted: the run identifier is **derived** from
 * the organisation identifier by the rule below, so two organisations cannot share a run without a
 * sha256 collision. It is claimed anyway, in a map keyed by run, because a derivation that somebody
 * later replaces with a configuration value should fail here rather than in the chain. The claim is
 * taken **synchronously**, before any runtime is built and therefore before anything can await —
 * an assertion that waited on another organisation's half-built runtime would be two organisations
 * waiting on each other with no timeout, which is a worse failure than the one it was checking for.
 *
 * A run identifier that were minted at random on each boot would also be wrong, in a quieter way:
 * every restart would open a chain of its own, the consumption the ceiling recomputes would reset
 * with it, and `restarts` would have nothing to count.
 *
 * ## `restarts`, counted from the chain
 *
 * The column exists to say how many times the process behind a row had been restarted. It is
 * computed the way every other figure in this system is computed — from the chain, not from a
 * counter this process holds: the first writer into a run records 0, and a later process reads the
 * highest value the run already carries and records one more. A variable would reset with the
 * process it is meant to be counting.
 *
 * **Declared deviation.** The brief for this increment asked for a `class = 'start'` row per
 * process boot, with `restarts` counted from those rows. `migrations/0002_ledger.sql` §5 states
 * the opposite in the published contract of that class: *"A start is the opening of a promotion
 * attempt, not the launch of a run"*, and its terminal is the `promotion_attempt` row with the
 * same `attempt_id`. Writing one per boot would put starts with no terminals into a table the
 * promotion gate reads as attempts, and the consumption counter reads starts. The column is made
 * honest here without inventing rows the schema says mean something else; if the owner wants boot
 * rows, that is an amendment to the published class contract and belongs in its own record.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson, sha256Hex } from '@agents/canonical.ts';
import type { Json } from '@agents/canonical.ts';
import { createGateway, type Gateway, type GatewayConfig } from '@agents/gateway.ts';
import { PgLedgerStore } from '@agents/ledger/pg.ts';
import { triageFixtureProvider, type TriageFixtureEntry } from '@agents/providers/triage_fixture.ts';
import { AgentError } from '@agents/triage/errors.ts';
import { TRIAGE_PROMPT } from '@agents/triage/prompt.ts';
import { AGENT_IO_SCHEMA_SHA256 } from '@agents/triage/schema.ts';
import {
  DEFAULT_ESCALATION_THRESHOLDS,
  type EscalationThresholds,
} from '@/alg/escalation';
import { rulesetDescription } from '@/alg/ruleset';
import { withAppSession } from '@/server/db';
import { componentClaims } from '@/server/pipeline';
import { claimRun, createRunClaims, releaseRun, type RunClaims } from '@/server/run_registry';

/** The version that travels into `toolchain.app` on every row. */
const APP_VERSION = '0.1.0';

/** The model the triage agent asks for, and the sampling it asks with. */
export const TRIAGE_MODEL = 'fixture-triage-small';

/**
 * Temperature zero, and that is a requirement rather than a preference: the retry counter is the
 * seed, and at temperature zero the same seed is a fixed point — which is what makes a re-run
 * after a crash a cache hit at zero cost, and what makes an incremented counter the only way to
 * ask the same question twice and get a different answer.
 */
export const TRIAGE_SAMPLING = { temperature: 0, top_p: 1, max_tokens: 256 } as const;

/**
 * The ceiling, in the two figures the requirement carries, and the scope it is measured over.
 *
 * `term`, not `run`: the figures describe the whole term, so measuring them per session would let
 * a loop of restarts spend them again on every boot. `run` is for a limit on one session, which is
 * not what these two numbers are.
 *
 * **The split, and the reason there has to be one.** `spentMicroAud` runs under the tenant's claims
 * and the policy clips the sum to one organisation, so a term ceiling applied unchanged to each
 * organisation is a term ceiling multiplied by the number of them. Until a `security definer`
 * accessor can sum the whole term — a migration, named and not taken here — the honest reading is
 * to divide: each organisation gets its share, and the sum of the shares is the figure that was
 * approved.
 */
export const TERM_BUDGET_AUD = { cap_aud: 120, cut_aud: 100 } as const;

/** The knowledge base does not exist yet. The sentinel says so; an empty string would not. */
const KB_SNAPSHOT = 'kb:none';

const SCHEMA_VERSION = '1.0';

/** Where the frozen demonstration dataset lives, relative to the repository root. */
const DEMO_DATASET_PATH = 'seed/demo_tickets.json';

export type OrgRuntime = {
  org_id: string;
  run_id: string;
  gateway: Gateway;
  prompt_version_id: string;
  /** The digest of everything the verdict depends on, as it travels into `state_hash`. */
  ruleset_hash: string;
  thresholds: EscalationThresholds;
  /** What this process recorded as its restart count for this run. */
  restarts: number;
};

type Registry = {
  store: PgLedgerStore;
  runtimes: Map<string, Promise<OrgRuntime>>;
  /**
   * Which organisation holds which run, claimed **synchronously** before any runtime is built.
   *
   * The mechanism and the reasoning live in `src/server/run_registry.ts`; the short version is
   * that this is a second map rather than a walk over `runtimes` because the values of `runtimes`
   * are promises that are frequently in flight, and a check that awaited one of them while that
   * one was awaiting this one is two organisations waiting on each other with no timeout.
   */
  runs: RunClaims;
};

// Next.js reloads modules in development. Without this, every reload would build a second store
// with a pool of its own that nothing closes.
const globalForAgents = globalThis as unknown as { ledgerdeskAgents?: Registry };

/**
 * The digest of everything that decides what the system would do with an input, other than the
 * input itself.
 *
 * It travels into `state_hash`, whose whole purpose is to say that two rows carrying the same
 * `input_hash` under different conditions are not comparable. With a rule and a matcher in the
 * path, the ruleset is one of those conditions: two runs under different thresholds, different
 * weights or a different policy table must not pool, and the digest is what keeps them apart.
 *
 * The policy patterns are in it as their source text, because a `RegExp` has no JSON form and the
 * source is exactly what changes when a pattern changes.
 */
export function rulesetHash(thresholds: EscalationThresholds = DEFAULT_ESCALATION_THRESHOLDS): string {
  return sha256Hex(canonicalJson(rulesetDescription(thresholds) as unknown as Json));
}

/**
 * The run of an organisation, by a written rule rather than by a coin toss.
 *
 * A UUID derived from the organisation and a run label: stable across restarts, so a chain
 * survives them; distinct per organisation, so the one-to-one-to-one invariant holds by
 * construction; and distinct per label, so a rehearsal can be given a chain of its own without
 * touching the demonstration's.
 */
export function runIdFor(orgId: string, label: string): string {
  const digest = sha256Hex(`ledgerdesk:run:${label}:${orgId}`);
  const variant = ((parseInt(digest[16] as string, 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function runLabel(): string {
  return process.env.LEDGERDESK_RUN ?? 'demo';
}

function replayEnabled(): boolean {
  return process.env.LEDGERDESK_REPLAY === '1';
}

/**
 * The demonstration's authored verdicts, if the frozen dataset is on disk.
 *
 * Absence is not an error: the dataset is the demonstration's, the built-in markers are the
 * tests', and a checkout that has one and not the other is a checkout that still runs. A malformed
 * dataset IS an error, because a silently ignored fixture table is a rehearsal that produces the
 * wrong verdict on the day.
 */
function demoFixtures(): readonly TriageFixtureEntry[] {
  let text: string;
  try {
    text = readFileSync(path.join(process.cwd(), DEMO_DATASET_PATH), 'utf8');
  } catch {
    return [];
  }
  const parsed = JSON.parse(text) as { triage_fixtures?: TriageFixtureEntry[] };
  return parsed.triage_fixtures ?? [];
}

function store(): PgLedgerStore {
  return registry().store;
}

function registry(): Registry {
  if (globalForAgents.ledgerdeskAgents) return globalForAgents.ledgerdeskAgents;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The triage agent needs the same PostgreSQL instance the consoles ' +
        'use, with the migration set applied in order, plus the seed.',
    );
  }

  const created: Registry = {
    // Four connections, declared beside the application's eight at the top of this file.
    store: new PgLedgerStore({ connectionString, max: 4 }),
    runtimes: new Map(),
    runs: createRunClaims(),
  };
  globalForAgents.ledgerdeskAgents = created;
  return created;
}

/**
 * The privileges a first triage would otherwise discover one statement at a time.
 *
 * This is the trap ADR-020 and ADR-021 were both written for: a development database created
 * before a grant migration existed applies every later migration cleanly and works entirely,
 * until the first row that needs the missing grant. Asking the three questions at startup turns
 * "permission denied for sequence" in the middle of a demonstration into a refusal to start with
 * the fix in the message.
 */
async function assertPrivileges(): Promise<void> {
  const granted = await withAppSession(null, async (client) => {
    const result = await client.query<{ seq: boolean; audit: boolean; prompt: boolean }>(
      `select has_sequence_privilege('app_rw','ledger_entry_id_seq','usage') as seq,
              has_table_privilege('app_rw','audit_event','insert')          as audit,
              has_table_privilege('app_rw','prompt_version','insert')       as prompt`,
    );
    return result.rows[0];
  });

  const missing = [
    granted.seq ? null : 'usage on ledger_entry_id_seq (0006)',
    granted.audit ? null : 'insert on audit_event (0007)',
    granted.prompt ? null : 'insert on prompt_version (0008)',
  ].filter((entry): entry is string => entry !== null);

  if (missing.length > 0) {
    throw new Error(
      `the application role is missing ${missing.join(' and ')}. This database was built before ` +
        'those migrations existed; apply migrations/ in order on a clean database, plus the seed.',
    );
  }
}

/**
 * The prompt, registered or refused.
 *
 * Registered generation 0 is this build's triage prompt. If a row already stands there under a
 * different text or a different schema digest, the process refuses to start rather than writing
 * rows that name a prompt version whose words produced none of them. A new wording is a new
 * generation, and generations are the promotion gate's to mint.
 */
async function ensureTriagePrompt(): Promise<string> {
  return withAppSession(null, async (client) => {
    const existing = await client.query<{ id: string; text: string; schema_hash: string }>(
      'select id, text, schema_hash from prompt_version where agent = $1 and generation = $2',
      [TRIAGE_PROMPT.agent, TRIAGE_PROMPT.generation],
    );

    const row = existing.rows[0];
    if (row) {
      if (row.text !== TRIAGE_PROMPT.text) {
        throw new AgentError(
          'E_PROMPT_NO_REGISTRADO',
          'generation 0 of the triage prompt is registered under different words than this build carries',
          { prompt_version_id: row.id, generation: TRIAGE_PROMPT.generation },
        );
      }
      if (row.schema_hash !== AGENT_IO_SCHEMA_SHA256) {
        throw new AgentError(
          'E_PROMPT_NO_REGISTRADO',
          'the registered triage prompt demands a different output schema than this build publishes',
          {
            prompt_version_id: row.id,
            registered_schema_hash: row.schema_hash,
            published_schema_hash: AGENT_IO_SCHEMA_SHA256,
          },
        );
      }
      return row.id;
    }

    const inserted = await client.query<{ id: string }>(
      `insert into prompt_version (id, agent, generation, text, schema_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (agent, generation) do nothing
       returning id`,
      [
        TRIAGE_PROMPT.id,
        TRIAGE_PROMPT.agent,
        TRIAGE_PROMPT.generation,
        TRIAGE_PROMPT.text,
        TRIAGE_PROMPT.schema_hash,
      ],
    );

    const id = inserted.rows[0]?.id;
    if (!id) {
      // Another process registered it between the select and the insert. Reading it back is the
      // only honest answer; assuming the identifier would be assuming a race went our way.
      const reread = await client.query<{ id: string }>(
        'select id from prompt_version where agent = $1 and generation = $2',
        [TRIAGE_PROMPT.agent, TRIAGE_PROMPT.generation],
      );
      const found = reread.rows[0]?.id;
      if (!found) {
        throw new AgentError(
          'E_PROMPT_NO_REGISTRADO',
          'the triage prompt could not be registered and is not present',
          { generation: TRIAGE_PROMPT.generation },
        );
      }
      return found;
    }
    return id;
  });
}

/** How many organisations share the term ceiling. */
async function tenantCount(): Promise<number> {
  const n = await withAppSession(null, async (client) => {
    const result = await client.query<{ n: number }>('select count(*)::int as n from org');
    return result.rows[0]?.n ?? 0;
  });
  return Math.max(1, n);
}

/** The restart count this process records for a run, read from the run itself. */
async function restartsOf(orgId: string, runId: string): Promise<number> {
  return withAppSession(componentClaims(orgId), async (client) => {
    const result = await client.query<{ rows_written: number; highest: number | null }>(
      `select count(*)::int as rows_written, max(restarts) as highest
         from ledger_entry where run_id = $1::uuid`,
      [runId],
    );
    const row = result.rows[0];
    if (!row || row.rows_written === 0) return 0;
    return Number(row.highest ?? 0) + 1;
  });
}

/**
 * Everything an organisation's runtime needs, built once.
 *
 * `run_id` arrives as an argument rather than being derived here, and that is deliberate: it is
 * claimed synchronously by `triageRuntimeFor` before this function is called, so there is exactly
 * one derivation site and the invariant is enforced before anything can await.
 */
async function buildRuntime(orgId: string, run_id: string): Promise<OrgRuntime> {
  await assertPrivileges();

  const promptVersionId = await ensureTriagePrompt();
  const share = await tenantCount();
  const restarts = await restartsOf(orgId, run_id);
  const ruleset_hash = rulesetHash();

  const config: GatewayConfig = {
    provider: triageFixtureProvider({ entries: demoFixtures() }),
    provider_id: 'triage-fixture@1',
    store: store(),
    run_id,
    state: { schema_version: SCHEMA_VERSION, ruleset_hash, kb_snapshot: KB_SNAPSHOT },
    toolchain: { app: APP_VERSION, ruleset: `triage@${ruleset_hash.slice(0, 12)}` },
    audit: store(),
    pricing: { [TRIAGE_MODEL]: { input_aud_per_1k: 0.001, output_aud_per_1k: 0.004 } },
    budget: {
      cap_aud: TERM_BUDGET_AUD.cap_aud / share,
      cut_aud: TERM_BUDGET_AUD.cut_aud / share,
      scope: 'term',
    },
    timeout_ms: 15_000,
    restarts,
    replay: replayEnabled(),
  };

  return {
    org_id: orgId,
    run_id,
    gateway: createGateway(config),
    prompt_version_id: promptVersionId,
    ruleset_hash,
    thresholds: DEFAULT_ESCALATION_THRESHOLDS,
    restarts,
  };
}

/**
 * The runtime of one organisation, built once and shared.
 *
 * **The promise is what is cached, not the value.** Two requests arriving together on a cold
 * registry would otherwise both run the preflight, both register the prompt and both build a
 * gateway, and the in-flight budget reservation of the loser would live in an instance nobody
 * consults.
 *
 * **Everything up to the first `await` is one uninterruptible step**, and the whole invariant
 * rests on that. The run is derived, claimed and the promise registered before this function
 * yields, so two organisations starting at the same instant cannot observe each other half-built
 * — and, critically, neither of them ever waits on the other. An earlier version asserted the
 * invariant by awaiting the other organisation's in-flight runtime, which is a mutual wait with no
 * timeout: two organisations booting together hung permanently, and the demonstration's own seed
 * spreads its beats across both of them.
 */
export async function triageRuntimeFor(orgId: string): Promise<OrgRuntime> {
  const { runtimes, runs } = registry();

  const existing = runtimes.get(orgId);
  if (existing) return existing;

  const run_id = runIdFor(orgId, runLabel());

  // The one-to-one-to-one claim, synchronous by the contract of `run_registry.ts`. The derivation
  // makes a collision impossible today; this catches the day somebody replaces it with a configured
  // value and hands two organisations the same run, which is the case that produces
  // `E_LEDGER_WRITE_FAILED` for ever on a run that looks perfectly ordinary.
  claimRun(runs, run_id, orgId);

  const pending = buildRuntime(orgId, run_id).catch((error: unknown) => {
    // A failed preflight must not be cached, or a database fixed a minute later would still be
    // reported as broken until somebody restarted the server. The claim goes with it so the two
    // maps never disagree about what this process holds.
    runtimes.delete(orgId);
    releaseRun(runs, run_id, orgId);
    throw error;
  });
  runtimes.set(orgId, pending);
  return pending;
}
