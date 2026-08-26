#!/usr/bin/env node
// seed/promotion_capsule.mjs — file the promotion capsule: one `start` row and its terminal.
//
// Usage:
//   node --experimental-strip-types seed/promotion_capsule.mjs --org <uuid>            file the capsule
//   node --experimental-strip-types seed/promotion_capsule.mjs --org <uuid> --dry-run  print the two payloads, write nothing
//   node --experimental-strip-types seed/promotion_capsule.mjs --org <uuid> --status   what is filed for this organisation
//
// Connection comes from DATABASE_URL, or from the standard PG* environment.
//
// ## RUN THIS BY HAND, ONCE, BEFORE THE REHEARSAL. NEVER IN CI.
//
// The three check scripts each drop and rebuild their own database and the cluster-wide roles, so
// none of them can produce this row and none of them should try: a row written into a database that
// is dropped forty seconds later is not evidence of anything. What CI proves is the CONTRACT of the
// writer, the SQL invariant and the rendered page. The row itself is an operator's act against the
// rehearsal database, and this file is that act.
//
// ## AND THERE IS NO HTTP ROUTE THAT DOES THIS, WHICH IS A DECISION
//
// `ledger_writer_insert` reads ONLY `org_id` — measured in `pg_policy`:
// `with check (org_id = ((auth.jwt()->>'org_id')::uuid))`, with no `role` and no `sub`. There is no
// analogue of `ticket_write_is_staff` for the ledger. So an open route would let ANY `app_rw`
// session whose organisation claim matches file a promotion attempt: a customer's cookie would be
// enough. And the beat is a SCREEN beat — the map marks all three of its steps "Pantalla" — so a
// route would be attack surface bought with no stage benefit at all.
//
// ## code_sha IS REFUSED UNLESS THE TREE IS CLEAN
//
// The trigger accepts any non-null string in that key; the empty one passes, measured. A sha taken
// from a dirty tree, or the word "unknown", pins a tree nobody can check, which is the one thing the
// reproducibility block exists to prevent — `external_ref` stores the commit sha and verification is
// a `git cat-file`, not a promise.
//
// ## WHAT IT DOES NOT DO
//
// It never inserts into `prompt_version`. The incumbent is RESOLVED, by the rule `ensurePromptLineage`
// uses: the row whose `schema_hash` equals the digest this build publishes, ordering by
// `generation desc`. Registering a generation to give this row a candidate would silently displace
// the prompt every agent runs under, for the sake of one demonstration row.
//
// **Measured against the rehearsal database on 2026-08-26:** the published digest is
// `2e257e23…` and the row that matches it is `7a1a9e00-0000-4000-8000-000000000002`, triage
// generation **1** — not generation 0. Anybody reasoning from "the incumbent is the oldest" gets the
// wrong row.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { digestOf } from '../agents/canonical.ts';
import { PgLedgerStore } from '../agents/ledger/pg.ts';
import {
  attemptIdFor,
  capsulePair,
  capsuleRunIdFor,
  filePromotionCapsule,
  payloadText,
  promotionRulesetHash,
  PROMOTION_ATTEMPT_PAYLOAD_CONTRACT,
} from '../agents/ledger/promotion_row.ts';
import { AGENT_IO_SCHEMA_SHA256 } from '../agents/triage/schema.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The schema component of `state_hash`, transcribed from `STATE_SCHEMA_VERSION` in
 * `src/server/agents.ts`.
 *
 * It is transcribed rather than imported because that module cannot be loaded outside a bundler —
 * every import in it goes through the `@agents/` and `@/` aliases that only `tsconfig.app.json`
 * resolves — and `test_PROMO_state_and_toolchain_are_transcribed_not_invented` compares the two
 * files so the transcription cannot drift.
 */
const STATE_SCHEMA_VERSION = '1.0';

/** The value the snapshot component carries when an organisation holds no corpus head at all. */
const NO_SNAPSHOT = 'none';

const HEX40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INCUMBENT = `
  select id, generation, schema_hash
    from prompt_version
   where agent = 'triage'
   order by generation desc`;

const SNAPSHOT_HEAD = `select kb_snapshot from kb_snapshot_head where org_id = $1::uuid`;

const ORG = `select id::text as id, name from org where id = $1::uuid`;

const FILED = `
  select class::text as class, run_id::text as run_id, seq, prev_hash, row_hash, ts,
         output ->> 'outcome' as outcome, output ->> 'failing_conjunct' as failing_conjunct
    from ledger_entry
   where class in ('start', 'promotion_attempt')
     and output ->> 'attempt_id' = $1
   order by seq`;

function fail(message) {
  console.error(`promotion capsule: ${message}`);
  process.exit(1);
}

function connectionOptions() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'postgres',
  };
}

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const o = connectionOptions();
  return `postgresql://${o.user}:${o.password}@${o.host}:${o.port}/${o.database}`;
}

/** The commit this row pins, or a refusal. A dirty tree is a refusal, not a warning. */
function codeSha() {
  let head;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    fail('git rev-parse HEAD did not resolve, so no commit can be pinned. Nothing was written.');
  }
  if (!HEX40.test(head)) {
    fail(`git rev-parse HEAD returned '${head}', which is not forty hexadecimal characters.`);
  }

  let dirty;
  try {
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    fail('git status --porcelain did not run, so the tree could not be shown to be clean.');
  }
  if (dirty !== '') {
    console.error('promotion capsule: the working tree is not clean:');
    console.error(dirty);
    fail('a sha taken from a dirty tree pins a tree nobody can check. Nothing was written.');
  }
  return head;
}

function appVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function usage() {
  console.log('usage: node --experimental-strip-types seed/promotion_capsule.mjs --org <uuid> [--dry-run|--status]');
}

async function main() {
  const argv = process.argv.slice(2);
  const orgIndex = argv.indexOf('--org');
  const orgId = orgIndex >= 0 ? argv[orgIndex + 1] : undefined;
  const dryRun = argv.includes('--dry-run');
  const status = argv.includes('--status');

  if (!orgId || !UUID.test(orgId)) {
    usage();
    fail('--org <uuid> is required: the organisation is named by the operator and derived from nothing.');
  }

  const client = new pg.Client(connectionOptions());
  await client.connect();

  try {
    const org = await client.query(ORG, [orgId]);
    if (org.rowCount === 0) fail(`no organisation ${orgId} exists in this database.`);
    const orgName = org.rows[0].name;

    const attemptId = attemptIdFor(orgId);
    const runId = capsuleRunIdFor(orgId);

    if (status) {
      const filed = await client.query(FILED, [attemptId]);
      console.log(`organisation : ${orgName} (${orgId})`);
      console.log(`attempt      : ${attemptId}`);
      console.log(`run          : ${runId}`);
      if (filed.rowCount === 0) {
        console.log('filed        : nothing. The panel renders the no-attempt text.');
      } else {
        for (const row of filed.rows) {
          console.log(
            `filed        : ${row.class.padEnd(17)} seq ${String(row.seq).padStart(3)}  ` +
              `${row.row_hash.slice(0, 12)}  ${row.outcome ?? ''} ${row.failing_conjunct ?? ''}`.trimEnd(),
          );
        }
        const classes = new Set(filed.rows.map((row) => row.class));
        if (!classes.has('promotion_attempt')) {
          console.log('filed        : the start is standing and the terminal is not. Run this again to complete it.');
        }
      }
      return;
    }

    // The incumbent, resolved and never typed. Same rule as `ensurePromptLineage`.
    const registered = await client.query(INCUMBENT);
    const incumbent = registered.rows.find((row) => row.schema_hash === AGENT_IO_SCHEMA_SHA256);
    if (!incumbent) {
      fail(
        `no registered generation of the triage prompt demands the contract this build publishes ` +
          `(${AGENT_IO_SCHEMA_SHA256.slice(0, 12)}). Run the application against this database once, ` +
          'so that the lineage registers itself. Nothing was written.',
      );
    }

    const head = await client.query(SNAPSHOT_HEAD, [orgId]);
    const snapshot = head.rows[0]?.kb_snapshot ?? NO_SNAPSHOT;

    const ruleset_hash = promotionRulesetHash();

    // Composed HERE and handed whole to the writer, once, for both rows. A field with two producers
    // is a field that can disagree with itself; there is one producer and it is this block. Each
    // component is transcribed-and-compared or read from the database, never invented.
    const state = {
      schema_version: STATE_SCHEMA_VERSION,
      ruleset_hash,
      kb_snapshot: `${orgId}:${snapshot}`,
    };
    const toolchain = { app: appVersion(), ruleset: `contract@${ruleset_hash.slice(0, 12)}` };

    // One instant, for the `ts` of the start row and for its `started_at`, byte for byte.
    const ts = new Date().toISOString();

    const input = {
      claims: { org_id: orgId },
      incumbent_prompt_version_id: incumbent.id,
      code_sha: dryRun ? await dryRunSha() : codeSha(),
      ts,
      state,
      toolchain,
    };

    if (dryRun) {
      const pair = capsulePair(input);
      console.log(`organisation : ${orgName} (${orgId})`);
      console.log(`run          : ${pair.run_id}`);
      console.log(`incumbent    : ${incumbent.id} (triage generation ${incumbent.generation})`);
      console.log(`state_hash   : over ${JSON.stringify(state)}`);
      console.log(`toolchain    : ${JSON.stringify(toolchain)}`);
      console.log(`contract     : ${digestOf(PROMOTION_ATTEMPT_PAYLOAD_CONTRACT).slice(0, 12)}`);
      console.log('');
      console.log(`start        : ${payloadText(pair.start)}`);
      console.log('');
      console.log(`terminal     : ${payloadText(pair.terminal)}`);
      console.log('');
      console.log('nothing was written.');
      return;
    }

    const store = new PgLedgerStore({ connectionString: connectionString() });
    try {
      const filed = await filePromotionCapsule(store, store, input);
      console.log(`organisation : ${orgName} (${orgId})`);
      console.log(`action       : ${filed.action}`);
      console.log(`attempt      : ${filed.attempt_id}`);
      console.log(`run          : ${filed.run_id}`);
      console.log(`incumbent    : ${incumbent.id} (triage generation ${incumbent.generation})`);
      console.log(`start        : seq ${filed.start.seq}  ${filed.start.row_hash}`);
      console.log(`terminal     : seq ${filed.terminal.seq}  ${filed.terminal.row_hash}`);
    } finally {
      await store.close();
    }
  } finally {
    await client.end();
  }
}

/**
 * A dry run prints what WOULD be written, so it needs a sha of the same shape without demanding a
 * clean tree — an operator inspecting the payloads mid-edit is exactly the case for it. It is never
 * used by a real filing: the branch above calls `codeSha()`, which refuses a dirty tree.
 */
async function dryRunSha() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (HEX40.test(head)) return head;
  } catch {
    /* falls through to the placeholder below */
  }
  return '0'.repeat(40);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
