// tests/gateway/harness.mjs — what the chokepoint's tests share: a store that speaks to the real
// database, an owner connection used only as an oracle, and a provider that records what it was
// given.
//
// The distinction this file is built around is the same one the application's harness draws, moved
// one layer down. Every assertion ABOUT THE GATEWAY goes through the gateway: the payload that
// leaves is read off the provider it was handed to, and the row that is written is written by the
// store the gateway holds, under the policy that admits it. The direct owner connection bypasses
// those policies on purpose — it is how a test asks the database what is actually stored, which is
// a question the thing under test must not be the one to answer.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { PgLedgerStore, rowFromDatabase } from '../../agents/ledger/pg.ts';

export const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set: the gateway tests need the database of the harness');
}

/** The two seeded organisations, and one of the seeded tickets. Fixed, like the seed. */
export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const TICKET_A = 'aaaa0001-0000-4000-8000-000000000001';

export function newRunId() {
  return randomUUID();
}

export async function asOwner(work) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Registers a prompt version, because `ledger_entry.prompt_version_id` is a foreign key and a row
 * that names a prompt nobody registered is a row the database is right to refuse.
 *
 * Each test file owns its own `generation`: `unique (agent, generation)` is a real constraint and
 * two files sharing a number would make the suite's verdict depend on which ran first.
 */
export async function registerPrompt({ id, generation, agent = 'triage', text = 'a prompt' }) {
  await asOwner(async (client) => {
    await client.query(
      `insert into prompt_version (id, agent, generation, text, schema_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [id, agent, generation, text, 'e'.repeat(64)],
    );
  });
}

export function makeStore() {
  return new PgLedgerStore({ connectionString: DATABASE_URL });
}

/**
 * Wraps a provider and keeps every request it was handed.
 *
 * The captured object is the one the gateway built, not a reconstruction of it: what a test asserts
 * about egress is asserted about the exact value that was passed across the boundary. It is frozen
 * on the way in so that nothing downstream can quietly edit the evidence.
 */
export function spyOn(inner) {
  const calls = [];
  const provider = async (request, options) => {
    calls.push(Object.freeze(structuredClone(request)));
    return inner(request, options);
  };
  return { provider, calls };
}

/** The model the tests price and request. A name, not a claim about any real model. */
export const MODEL = 'fixture-small';

export const SAMPLING = { temperature: 0, top_p: 1, max_tokens: 64 };

/**
 * A configuration with everything the gateway insists on, so each test states only what it is
 * actually about. The ceiling carries the two figures the requirement carries; a test that is about
 * the ceiling overrides them and says so.
 */
export function baseConfig({ store, provider, run_id, ...overrides }) {
  return {
    provider,
    provider_id: 'fixture-stub@1',
    store,
    run_id,
    state: {
      schema_version: '1.0',
      ruleset_hash: 'r'.repeat(64),
      kb_snapshot: 'kb-2026-08-22',
    },
    toolchain: { app: '0.1.0', ruleset: 'ruleset-1' },
    pricing: { [MODEL]: { input_aud_per_1k: 0.001, output_aud_per_1k: 0.004 } },
    budget: { cap_aud: 120, cut_aud: 100, scope: 'term' },
    timeout_ms: 5_000,
    ...overrides,
  };
}

/** A call with everything the gateway insists on. Tests override the field they are about. */
export function baseCall({ prompt_version_id, body, ...overrides }) {
  return {
    agent: 'triage',
    org_id: ORG_A,
    ticket_id: TICKET_A,
    prompt_version_id,
    prompt_text: 'Classify the request. Answer as JSON.',
    body,
    locale: 'en-AU',
    model_requested: MODEL,
    sampling: SAMPLING,
    seed: 7,
    input_path: 'seed/orgs.sql',
    ...overrides,
  };
}

/** Every row of a run, in chain order, converted back into the form the writer hashed. */
export async function readChain(runId) {
  return asOwner(async (client) => {
    const result = await client.query('select * from ledger_entry where run_id = $1 order by seq', [
      runId,
    ]);
    return result.rows.map((row) => ({ id: row.id, ...rowFromDatabase(row) }));
  });
}

/** What the chain says was spent, read straight from the database rather than from the gateway. */
export async function spentOnChain(runId) {
  return asOwner(async (client) => {
    const result = await client.query(
      "select coalesce(sum(cost_aud), 0)::text as total from ledger_entry where run_id = $1",
      [runId],
    );
    return Number(result.rows[0].total);
  });
}

/** Asserts that `work` fails with exactly this gateway error code, and returns the error. */
export async function refusedWith(code, work) {
  try {
    await work();
  } catch (error) {
    assert.equal(
      error.code,
      code,
      `expected ${code}, got ${error.code ?? error.name}: ${error.message}`,
    );
    return error;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}
