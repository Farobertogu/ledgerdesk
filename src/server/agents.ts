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
 * ## The run does NOT change when the corpus does
 *
 * This is the single easiest thing to get wrong in this increment, and getting it wrong destroys
 * the evidence while looking like it is producing it.
 *
 * The demonstration's closing act is two runs "chained": a question asked against a corpus that
 * cannot answer it, material admitted, the same question asked again and answered. It is tempting
 * to give the second half a run of its own — it is a second act, the state has changed, a new run
 * looks tidier in a listing. It is wrong. What makes the two halves comparable is that they are
 * **one chain with two `state_hash` values and the admission row between them, ordered by `seq`**.
 * Two runs are two chains: nothing orders them relative to each other, the admission belongs to
 * neither, and the sentence "here is the same question before and after, in order, in one
 * append-only record" stops being true.
 *
 * So the run identifier is a function of the organisation and the run label and of nothing else,
 * `evictRuntime` rebuilds a runtime **into the same run**, and `claimRun` is idempotent for the
 * holder precisely so that rebuilding is not a collision.
 *
 * ## `restarts`, counted from the chain — and not from a rebuild
 *
 * The column exists to say how many times the process behind a row had been restarted. It is
 * computed from the chain, not from a counter this process holds: the first writer into a run
 * records 0, and a later process reads the highest value the run already carries and records one
 * more. A variable would reset with the process it is meant to be counting.
 *
 * The count is then **remembered for the life of the process**, keyed by run. `evictRuntime` exists
 * so that a corpus change can be picked up without a restart, and a rebuild that re-read the chain
 * would record one more restart than had happened — a column that lies in the other direction from
 * the one ADR-023 §9 fixed.
 *
 * **Declared deviation, carried forward from ADR-023 §9.** The brief for the triage increment asked
 * for a `class = 'start'` row per process boot. `migrations/0002_ledger.sql` §5 states the opposite
 * in the published contract of that class, so the column is made honest without inventing rows the
 * schema says mean something else.
 *
 * ## Which provider, and how a real one is chosen
 *
 * `LEDGERDESK_PROVIDER` selects between the fixture and a real model. The fixture is the default
 * and it is what CI and all five batteries run on, always: they are determinism and zero network,
 * and a suite whose verdict depends on a remote service is not a suite. The real provider is for a
 * rehearsal and for the demonstration, it requires `ANTHROPIC_API_KEY` in the environment, and it
 * refuses to start without one rather than discovering the absence at the first ticket.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson, derivedUuid, sha256Hex } from '@agents/canonical.ts';
import type { Json } from '@agents/canonical.ts';
import { createGateway, type Gateway, type GatewayConfig, type ModelPrice, type ModelProvider } from '@agents/gateway.ts';
import { PgLedgerStore } from '@agents/ledger/pg.ts';
import type { LedgerStore } from '@agents/ledger/store.ts';
import type { PromptRegistration } from '@agents/prompt_version.ts';
import {
  ANTHROPIC_LARGE_MODEL,
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_SMALL_MODEL,
  anthropicPricing,
  anthropicProvider,
} from '@agents/providers/anthropic.ts';
import { fixtureProvider } from '@agents/providers/fixture.ts';
import type { DraftFixtureEntry } from '@agents/providers/draft_fixture.ts';
import type { TriageFixtureEntry } from '@agents/providers/triage_fixture.ts';
import { DRAFT_PROMPT_GENERATIONS } from '@agents/draft/prompt.ts';
import { VALIDATE_PROMPT_GENERATIONS } from '@agents/validate/prompt.ts';
import { AgentError } from '@agents/triage/errors.ts';
import { TRIAGE_PROMPT_GENERATIONS } from '@agents/triage/prompt.ts';
import { AGENT_IO_SCHEMA_SHA256 } from '@agents/triage/schema.ts';
import {
  DEFAULT_ESCALATION_THRESHOLDS,
  type EscalationThresholds,
} from '@/alg/escalation';
import { rulesetDescription } from '@/alg/ruleset';
import { withAppSession } from '@/server/db';
import { AppError } from '@/server/errors';
import { componentClaims } from '@/server/pipeline';
import { snapshotHeadFor } from '@/server/kb/retrieval';
import { claimRun, createRunClaims, releaseRun, type RunClaims } from '@/server/run_registry';

/** The version that travels into `toolchain.app` on every row. */
const APP_VERSION = '0.1.0';

/** The two provider worlds. `fixture` is the default and is what every battery runs on. */
export type ProviderMode = 'fixture' | 'real';

/** The fixture's model identities. Names, not claims about any real model. */
export const FIXTURE_MODELS = {
  triage: 'fixture-triage-small',
  draft: 'fixture-draft-large',
  validate: 'fixture-validate-small',
} as const;

/** What each agent asks for, in each world. */
export type AgentModels = { triage: string; draft: string; validate: string };

const REAL_MODELS: AgentModels = {
  // ADR-004: cheap for the two narrow jobs, strong for the reply a person will read.
  triage: ANTHROPIC_SMALL_MODEL,
  draft: ANTHROPIC_LARGE_MODEL,
  validate: ANTHROPIC_SMALL_MODEL,
};

/**
 * Temperature zero, and that is a requirement rather than a preference: the retry counter is the
 * seed, and at temperature zero the same seed is a fixed point — which is what makes a re-run
 * after a crash a cache hit at zero cost, and what makes an incremented counter the only way to
 * ask the same question twice and get a different answer.
 */
export const TRIAGE_SAMPLING = { temperature: 0, top_p: 1, max_tokens: 256 } as const;

/**
 * The drafting call's allowance.
 *
 * Larger than triage's because the answer is prose rather than four fields, and bounded well under
 * what the envelope permits: the contract caps a reply at 4096 characters, which is roughly a
 * thousand tokens, and the rest is the envelope around it. The number matters twice — it is the
 * ceiling on the answer and it is what the budget projection charges the call at before it is made.
 */
export const DRAFT_SAMPLING = { temperature: 0, top_p: 1, max_tokens: 1536 } as const;

/** The validator answers with a boolean and a short list. It needs very little room. */
export const VALIDATE_SAMPLING = { temperature: 0, top_p: 1, max_tokens: 512 } as const;

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
 *
 * **Measured before the rehearsal, and stated here so it is not a surprise:** this increment
 * TRIPLES the calls a ticket can make. A triage was one call; a triage followed by a drafting cycle
 * is three, and the third is on the expensive model. The share each organisation holds did not
 * change, so the number of tickets a term can carry fell by roughly the same factor.
 */
export const TERM_BUDGET_AUD = { cap_aud: 120, cut_aud: 100 } as const;

/**
 * The value the state component carries when an organisation has no snapshot at all.
 *
 * It survives for exactly that case and no other. An organisation that holds articles has a head,
 * the head is what the state records, and `test_GW_state_hash_tracks_the_snapshot_in_force` is what
 * keeps a regression from quietly putting every row back under this sentinel.
 */
export const NO_KB_SNAPSHOT = 'kb:none';

/**
 * The schema component of `state_hash`.
 *
 * Exported for the tests that pin the state a row is written under. **The admission writer is NOT a
 * consumer of it**, and the reason is worth keeping: it takes `OrgRuntime.state` — the composed
 * object the chokepoint pinned — rather than rebuilding the three components beside it, so there is
 * one producer of that fact and not two. An earlier version of this sentence named the admission as
 * the reason for the export, and went on naming it after the composition moved.
 */
export const STATE_SCHEMA_VERSION = '1.0';

/** Where the frozen demonstration dataset lives, relative to the repository root. */
const DEMO_DATASET_PATH = 'seed/demo_tickets.json';

export type OrgRuntime = {
  org_id: string;
  run_id: string;
  gateway: Gateway;
  /** The prompt version each agent runs under, chosen by generation. */
  prompts: { triage: string; draft: string; validate: string };
  models: AgentModels;
  /** The snapshot in force when this runtime was built. `evictRuntime` is how it moves. */
  kb_snapshot: string;
  /** The digest of everything the verdict depends on, as it travels into `state_hash`. */
  ruleset_hash: string;
  /**
   * The three components whose digest is `state_hash`, in the form every row of this run carries.
   *
   * **One object, handed to both writers, for the same reason `toolchain` below is.** The chokepoint
   * pins this when its gateway is built and the admission writer pins it when it appends its row, and
   * those two rows have to be comparable — the evidence of the gap cycle is one chain whose halves
   * differ in exactly one state, with the admission on the side that decided. Composed twice from
   * three parts, it is a field with two producers, and a field with two producers is a field that can
   * disagree with itself. Composed once here, the two rows cannot say different things about the
   * state they were written under, and the assertion that checks it stops being a matter of
   * vigilance.
   */
  state: { schema_version: string; ruleset_hash: string; kb_snapshot: string };
  thresholds: EscalationThresholds;
  /** What this process recorded as its restart count for this run. */
  restarts: number;
  /**
   * What produced the rows of this run, in the form every row carries.
   *
   * Held on the runtime rather than rebuilt by each writer: the chokepoint and the admission writer
   * both pin it, and two spellings of one toolchain would put two rows of one chain under two
   * different claims about what wrote them.
   */
  toolchain: Toolchain;
  provider_mode: ProviderMode;
};

/** What produced a row, in the two fields every row of this system carries. */
export type Toolchain = { app: string; ruleset: string };

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
  /**
   * The restart count this process recorded for each run, remembered so that a rebuild is not
   * counted as a restart. See the header.
   */
  restarts: Map<string, number>;
};

// Next.js reloads modules in development. Without this, every reload would build a second store
// with a pool of its own that nothing closes.
const globalForAgents = globalThis as unknown as { ledgerdeskAgents?: Registry };

/**
 * The digest of everything that decides what the system would do with an input, other than the
 * input itself.
 *
 * It travels into `state_hash`, whose whole purpose is to say that two rows carrying the same
 * `input_hash` under different conditions are not comparable. With a rule, a matcher and now a
 * retrieval in the path, all three are among those conditions: two runs under different thresholds,
 * different weights, a different policy table or a different `k` must not pool, and the digest is
 * what keeps them apart.
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
 *
 * The knowledge-base snapshot is deliberately NOT an input. See the header.
 */
export function runIdFor(orgId: string, label: string): string {
  return derivedUuid(`ledgerdesk:run:${label}:${orgId}`);
}

/**
 * The derivation of an identifier from a written seed now lives in `@agents/canonical.ts`, and is
 * re-exported here so that the callers who reach for it through this module keep working.
 *
 * It moved because it gained a second caller below the seam — the promotion writer of
 * `agents/ledger/promotion_row.ts`, which mints the identity of an attempt from its organisation and
 * has to load under a bare `node --experimental-strip-types` with no bundler. This file cannot be
 * loaded that way: every import above goes through the `@agents/` and `@/` aliases that only
 * `tsconfig.app.json` resolves. Copying twenty lines across the seam would have been two producers of
 * one identity, so the function went to the module that owns digests and both sides import it.
 */
export { derivedUuid };

/**
 * The `kb_snapshot` component of `state_hash`, qualified by organisation.
 *
 * Two organisations share the label `kb-2026-08-01` today and hold entirely different corpora under
 * it. An unqualified component would give their rows the same state — the column whose one job is
 * to say "these two rows are not comparable" saying that they are. The organisation is in front of
 * the label so that a row identifies the corpus it cited and not merely the date somebody stamped
 * on two of them.
 */
export function kbSnapshotComponent(orgId: string, label: string): string {
  return `${orgId}:${label}`;
}

function runLabel(): string {
  return process.env.LEDGERDESK_RUN ?? 'demo';
}

function replayEnabled(): boolean {
  return process.env.LEDGERDESK_REPLAY === '1';
}

/**
 * Which provider this process runs on, or a refusal.
 *
 * An unrecognised value is refused rather than falling back to the fixture. A typo in a deployment
 * variable that silently produced a fixture-answering production process is the kind of failure
 * nobody finds until a customer reads an answer no model wrote.
 */
export function providerMode(): ProviderMode {
  const declared = process.env.LEDGERDESK_PROVIDER ?? 'fixture';
  if (declared === 'fixture' || declared === 'real') return declared;
  throw new Error(
    `LEDGERDESK_PROVIDER is '${declared}'; it selects the model provider and the values are 'fixture' or 'real'`,
  );
}

export function modelsFor(mode: ProviderMode): AgentModels {
  return mode === 'real' ? REAL_MODELS : { ...FIXTURE_MODELS };
}

/**
 * Every price this process could need, in both worlds.
 *
 * The fixture's models are priced because a call that cannot be charged is refused with
 * `E_MODEL_PRICE_UNKNOWN`, and a fixture call still writes a row with a cost in it. The real models
 * are priced from the published list, converted once at a declared rate. Both sets are present in
 * both modes: the map is configuration and a mode does not make a price wrong, it makes it unused.
 */
export function pricingTable(): Record<string, ModelPrice> {
  return {
    [FIXTURE_MODELS.triage]: { input_aud_per_1k: 0.001, output_aud_per_1k: 0.004 },
    [FIXTURE_MODELS.draft]: { input_aud_per_1k: 0.004, output_aud_per_1k: 0.016 },
    [FIXTURE_MODELS.validate]: { input_aud_per_1k: 0.001, output_aud_per_1k: 0.004 },
    ...anthropicPricing(),
  };
}

/**
 * The demonstration's authored answers, if the frozen dataset is on disk.
 *
 * Absence is not an error: the dataset is the demonstration's, the built-in markers are the
 * tests', and a checkout that has one and not the other is a checkout that still runs. A malformed
 * dataset IS an error, because a silently ignored fixture table is a rehearsal that produces the
 * wrong verdict on the day.
 */
function demoFixtures(): {
  triage: readonly TriageFixtureEntry[];
  draft: readonly DraftFixtureEntry[];
} {
  let text: string;
  try {
    text = readFileSync(path.join(process.cwd(), DEMO_DATASET_PATH), 'utf8');
  } catch {
    return { triage: [], draft: [] };
  }
  const parsed = JSON.parse(text) as {
    triage_fixtures?: TriageFixtureEntry[];
    draft_fixtures?: DraftFixtureEntry[];
  };
  return { triage: parsed.triage_fixtures ?? [], draft: parsed.draft_fixtures ?? [] };
}

function store(): PgLedgerStore {
  return registry().store;
}

function registry(): Registry {
  if (globalForAgents.ledgerdeskAgents) return globalForAgents.ledgerdeskAgents;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The agents need the same PostgreSQL instance the consoles ' +
        'use, with the migration set applied in order, plus the seed.',
    );
  }

  const created: Registry = {
    // Four connections, declared beside the application's eight at the top of this file.
    store: new PgLedgerStore({ connectionString, max: 4 }),
    runtimes: new Map(),
    runs: createRunClaims(),
    restarts: new Map(),
  };
  globalForAgents.ledgerdeskAgents = created;
  return created;
}

/**
 * The privileges a first call would otherwise discover one statement at a time.
 *
 * This is the trap ADR-020, ADR-021 and ADR-023 were all written for: a development database
 * created before a grant migration existed applies every later migration cleanly and works
 * entirely, until the first row that needs the missing grant. Asking the questions at startup turns
 * "permission denied" in the middle of a demonstration into a refusal to start with the fix in the
 * message.
 *
 * The three new questions are 0009's, and they are the ones a drafting cycle would hit in order:
 * it reads the corpus, it reads the gap records beside a ticket, and it writes an answer.
 */
async function assertPrivileges(): Promise<void> {
  const granted = await withAppSession(null, async (client) => {
    const result = await client.query<{
      seq: boolean;
      audit: boolean;
      prompt: boolean;
      kb_article: boolean;
      kb_gap: boolean;
      response: boolean;
      kb_admission: boolean;
      gap_open: boolean;
      advance: boolean;
      close_gap: boolean;
    }>(
      // The last four are 0010's, and they are asked for the reason the header gives. 0010 grants a
      // read and three EXECUTEs, and a database built before it applies every later migration
      // cleanly, starts without complaint, triages, drafts and opens the gap — then fails with
      // "permission denied" at the instant a supervisor presses admit, which in this system is in
      // front of an audience. A privilege that is only exercised at the end of a cycle is exactly
      // the one a preflight has to ask about, because nothing earlier will.
      `select has_sequence_privilege('app_rw','ledger_entry_id_seq','usage') as seq,
              has_table_privilege('app_rw','audit_event','insert')          as audit,
              has_table_privilege('app_rw','prompt_version','insert')       as prompt,
              has_table_privilege('app_rw','kb_article','select')           as kb_article,
              has_table_privilege('app_rw','kb_gap','select')               as kb_gap,
              has_table_privilege('app_rw','response','insert')             as response,
              has_table_privilege('app_rw','kb_admission','select')         as kb_admission,
              has_function_privilege('app_rw',
                'kb_gap_open(uuid,uuid,uuid,text,text,boolean,text,text,uuid,date,text,uuid[],bigint)',
                'execute')                                                  as gap_open,
              has_function_privilege('app_rw','kb_snapshot_advance(bigint,jsonb)','execute')
                                                                            as advance,
              has_function_privilege('app_rw','kb_gap_close_by_verification(uuid,uuid)','execute')
                                                                            as close_gap`,
    );
    return result.rows[0];
  });

  const missing = [
    granted.seq ? null : 'usage on ledger_entry_id_seq (0006)',
    granted.audit ? null : 'insert on audit_event (0007)',
    granted.prompt ? null : 'insert on prompt_version (0008)',
    granted.kb_article ? null : 'select on kb_article (0009)',
    granted.kb_gap ? null : 'select on kb_gap (0009)',
    granted.response ? null : 'insert on response (0009)',
    granted.kb_admission ? null : 'select on kb_admission (0010)',
    granted.gap_open ? null : 'execute on kb_gap_open (0010)',
    granted.advance ? null : 'execute on kb_snapshot_advance(bigint,jsonb) (0010)',
    granted.close_gap ? null : 'execute on kb_gap_close_by_verification (0010)',
  ].filter((entry): entry is string => entry !== null);

  if (missing.length > 0) {
    throw new Error(
      `the application role is missing ${missing.join(' and ')}. This database was built before ` +
        'those migrations existed; apply migrations/ in order on a clean database, plus the seed.',
    );
  }
}

/**
 * One agent's prompt lineage, registered, and the generation this build runs under.
 *
 * **Every generation is registered, not only the current one.** A row that already stands is
 * checked and left alone; a row that is missing is inserted. That is what makes the two kinds of
 * database — a clean one, and one carried forward from the previous increment — end in the same
 * state with no branch anywhere asking which kind this is. On the clean database both triage
 * generations are inserted; on the carried-forward one generation 0 is found exactly as it was
 * registered and only generation 1 is new. `parent_id` is then a real reference in both.
 *
 * **A standing row that disagrees is a refusal to start.** `prompt_version` is immutable by
 * trigger, so there is no third option: either the row describes what this build carries, or this
 * build would be writing ledger rows naming a prompt whose words produced none of them.
 *
 * **The current generation is the highest one whose contract this build publishes.** Not simply the
 * highest: a build rolled back to an earlier schema must run under the generation registered for
 * that schema, not under a later one describing a contract it no longer holds.
 */
async function ensurePromptLineage(generations: readonly PromptRegistration[]): Promise<string> {
  const agent = (generations[0] as PromptRegistration).agent;

  return withAppSession(null, async (client) => {
    for (const generation of generations) {
      const existing = await client.query<{ id: string; text: string; schema_hash: string }>(
        'select id, text, schema_hash from prompt_version where agent = $1 and generation = $2',
        [generation.agent, generation.generation],
      );

      const row = existing.rows[0];
      if (row) {
        if (row.id !== generation.id) {
          throw new AgentError(
            'E_PROMPT_NOT_REGISTERED',
            `generation ${generation.generation} of the ${agent} prompt is registered under a different identifier than this build carries`,
            { registered: row.id, published: generation.id },
          );
        }
        if (row.text !== generation.text) {
          throw new AgentError(
            'E_PROMPT_NOT_REGISTERED',
            `generation ${generation.generation} of the ${agent} prompt is registered under different words than this build carries`,
            { prompt_version_id: row.id, generation: generation.generation },
          );
        }
        if (row.schema_hash !== generation.schema_hash) {
          throw new AgentError(
            'E_PROMPT_NOT_REGISTERED',
            `generation ${generation.generation} of the ${agent} prompt demands a different output schema than this build publishes for it`,
            {
              prompt_version_id: row.id,
              registered_schema_hash: row.schema_hash,
              published_schema_hash: generation.schema_hash,
            },
          );
        }
        continue;
      }

      await client.query(
        `insert into prompt_version (id, agent, generation, text, schema_hash, parent_id)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (agent, generation) do nothing`,
        [
          generation.id,
          generation.agent,
          generation.generation,
          generation.text,
          generation.schema_hash,
          generation.parent_id,
        ],
      );
    }

    // Read back rather than assume: `do nothing` above swallows the race in which another process
    // registered the same generation between the select and the insert, and assuming the identifier
    // would be assuming the race went our way.
    const registered = await client.query<{ id: string; generation: number; schema_hash: string }>(
      'select id, generation, schema_hash from prompt_version where agent = $1 order by generation desc',
      [agent],
    );

    const current = registered.rows.find((row) => row.schema_hash === AGENT_IO_SCHEMA_SHA256);
    if (!current) {
      throw new AgentError(
        'E_PROMPT_NOT_REGISTERED',
        `no registered generation of the ${agent} prompt demands the contract this build publishes`,
        { agent, published_schema_hash: AGENT_IO_SCHEMA_SHA256, generations: registered.rowCount },
      );
    }
    return current.id;
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

/** The restart count this process records for a run, read from the run itself, once. */
async function restartsOf(orgId: string, runId: string): Promise<number> {
  const remembered = registry().restarts.get(runId);
  if (remembered !== undefined) return remembered;

  const counted = await withAppSession(componentClaims(orgId), async (client) => {
    const result = await client.query<{ rows_written: number; highest: number | null }>(
      `select count(*)::int as rows_written, max(restarts) as highest
         from ledger_entry where run_id = $1::uuid`,
      [runId],
    );
    const row = result.rows[0];
    if (!row || row.rows_written === 0) return 0;
    return Number(row.highest ?? 0) + 1;
  });

  registry().restarts.set(runId, counted);
  return counted;
}

/** The provider this process runs on, built once per runtime. */
function buildProvider(mode: ProviderMode, models: AgentModels): { provider: ModelProvider; provider_id: string } {
  if (mode === 'real') {
    return { provider: anthropicProvider(), provider_id: ANTHROPIC_PROVIDER_ID };
  }
  const fixtures = demoFixtures();
  return {
    provider: fixtureProvider({ models, triage: fixtures.triage, draft: fixtures.draft }),
    provider_id: 'ledgerdesk-fixture@2',
  };
}

/**
 * Everything an organisation's runtime needs, built once.
 *
 * `run_id` arrives as an argument rather than being derived here, and that is deliberate: it is
 * claimed synchronously by `runtimeFor` before this function is called, so there is exactly one
 * derivation site and the invariant is enforced before anything can await.
 */
async function buildRuntime(orgId: string, run_id: string): Promise<OrgRuntime> {
  await assertPrivileges();

  const prompts = {
    triage: await ensurePromptLineage(TRIAGE_PROMPT_GENERATIONS),
    draft: await ensurePromptLineage(DRAFT_PROMPT_GENERATIONS),
    validate: await ensurePromptLineage(VALIDATE_PROMPT_GENERATIONS),
  };

  const share = await tenantCount();
  const restarts = await restartsOf(orgId, run_id);
  const ruleset_hash = rulesetHash();

  // READ, never assumed and never configured. An organisation with a corpus and no head is a
  // database that predates 0009; the sentinel is for an organisation that genuinely has none.
  const kb_snapshot = (await snapshotHeadFor(orgId)) ?? NO_KB_SNAPSHOT;

  const mode = providerMode();
  const models = modelsFor(mode);
  const { provider, provider_id } = buildProvider(mode, models);

  const toolchain: Toolchain = { app: APP_VERSION, ruleset: `ruleset@${ruleset_hash.slice(0, 12)}` };

  // Composed ONCE and handed to both writers. See `OrgRuntime.state` for why it is not composed
  // again anywhere else.
  const state = {
    schema_version: STATE_SCHEMA_VERSION,
    ruleset_hash,
    kb_snapshot: kbSnapshotComponent(orgId, kb_snapshot),
  };

  const config: GatewayConfig = {
    provider,
    provider_id,
    store: store(),
    run_id,
    state,
    toolchain,
    audit: store(),
    pricing: pricingTable(),
    budget: {
      cap_aud: TERM_BUDGET_AUD.cap_aud / share,
      cut_aud: TERM_BUDGET_AUD.cut_aud / share,
      scope: 'term',
    },
    timeout_ms: 30_000,
    restarts,
    replay: replayEnabled(),
  };

  return {
    org_id: orgId,
    run_id,
    gateway: createGateway(config),
    prompts,
    models,
    kb_snapshot,
    ruleset_hash,
    state,
    thresholds: DEFAULT_ESCALATION_THRESHOLDS,
    restarts,
    toolchain,
    provider_mode: mode,
  };
}

/**
 * The chain this process writes into.
 *
 * Exported because the chokepoint is no longer the only writer. The admission records a non-model
 * row, and it has to land in the SAME chain as the calls around it — the evidence of this whole
 * cycle is one chain with two state values and the admission row between them by `seq`, and a second
 * store would be a second chain with nothing ordering the two.
 *
 * It is the store and not the gateway: this is not a path to a model and must never become one.
 */
export function ledgerStore(): LedgerStore {
  return store();
}

/**
 * The runtime of one organisation, built once and shared.
 *
 * **The promise is what is cached, not the value.** Two requests arriving together on a cold
 * registry would otherwise both run the preflight, both register the prompts and both build a
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
export async function runtimeFor(orgId: string): Promise<OrgRuntime> {
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

/**
 * Forgets an organisation's runtime so that the next call rebuilds it.
 *
 * This exists because the snapshot in force is read at build time and the corpus can move while a
 * process is running: an admission advances the head, and every runtime holding the old label would
 * go on writing rows that name a corpus the organisation has left. Restarting the server would fix
 * it and is not a thing anybody can do in the middle of a demonstration.
 *
 * **The rebuilt runtime writes into the SAME run**, because `runIdFor` is a pure function of the
 * organisation and the label. The claim is released and re-taken by the rebuild, which `claimRun`
 * permits for the holder; the restart count is remembered, so a rebuild is not counted as a
 * restart; and the chain gains its second `state_hash` in the place where the evidence needs it —
 * after the admission row, in one chain, ordered by `seq`.
 *
 * Nothing else is dropped: the store, its pool and the run claims outlive every rebuild.
 */
export function evictRuntime(orgId: string): void {
  const { runtimes, runs } = registry();
  if (!runtimes.delete(orgId)) return;
  releaseRun(runs, runIdFor(orgId, runLabel()), orgId);
}

/**
 * Refuses to run a cycle on a runtime whose corpus has moved underneath it.
 *
 * **This is the half that makes forgetting the other half impossible to ignore**, and it is worth
 * being explicit about what it prevents, because the failure it prevents is invisible while it
 * happens. The pointer is read twice with two lifetimes: frozen into `state` when a runtime is
 * built, and fresh at the top of every cycle. After an admission that did not evict, the retrieval
 * reads the NEW corpus — it queries by the fresh head — while every row the cycle writes records the
 * OLD label in `state_hash`. The answer improves, the rows look ordinary, and the evidence that this
 * card exists to produce is falsified in the act of producing it. Nothing downstream could tell.
 *
 * So the two are compared and a divergence is a typed refusal rather than a silent divergence. The
 * runtime is evicted on the way out, which makes the refusal recoverable rather than permanent: the
 * next attempt rebuilds against the corpus in force and proceeds. Noisy once, in front of whoever
 * pressed the control, is the outcome to want; quiet for ever is the one to make unreachable.
 */
export function refuseIfRuntimeIsStale(runtime: OrgRuntime, head: string): void {
  if (runtime.kb_snapshot === head) return;
  evictRuntime(runtime.org_id);
  throw new AppError(
    'E_RUNTIME_SNAPSHOT_STALE',
    409,
    'the corpus in force has moved since this runtime was built, so a cycle run now would cite one ' +
      'snapshot and record another. The runtime has been discarded; run it again.',
    { org_id: runtime.org_id, runtime_snapshot: runtime.kb_snapshot, head },
  );
}
