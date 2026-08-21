// test_LEDGER_system_row_is_not_a_model_call
//
// The writer of the rows that are not model calls, and the three things it is not allowed to be.
//
// Eight of the nine row classes describe something the system did without asking anybody. Until now
// nothing could write one, because the only writer in the tree was the model chokepoint — and the
// chokepoint's whole shape is redact, attest, price, call, record. The admission cycle needs a
// `kb_admission` row; the anchoring discipline needs a `checkpoint`; the promotion gate needs a
// `commitment`. This is the writer they share, and this file measures the boundaries that keep it
// from becoming a second path to a model.
//
//   · **The costs are not parameters.** A caller that could pass a cost could raise the ceiling by
//     writing a row, and the ceiling is recomputed from the chain.
//   · **The class is narrowed to what the schema will actually accept.** `agent_call` is refused by
//     a check constraint on the reproducibility block; `promotion_attempt` and `modification_event`
//     are refused by a check constraint requiring `agent = 'evolve'`.
//   · **The class's keys are checked before the insert.** The trigger catches them too, and does it
//     from inside a transaction eight frames away, naming nothing about which key was missing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendSystemRow, CLASS_REQUIRED_KEYS } from '../../agents/ledger/system_row.ts';
import { verifyRowHash } from '../../agents/ledger/row.ts';
import { ORG_A, makeStore, newRunId, readChain } from './harness.mjs';

const store = makeStore();
test.after(async () => {
  await store.close();
});

const STATE = { schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: 'kb-2026-08-22' };
const TOOLCHAIN = { app: '0.1.0', node: '22', model_sdk: 'none', ruleset: 'ruleset-1' };

function admission(overrides = {}) {
  return {
    admission_id: 'ad000001-0000-4000-8000-000000000001',
    gap_id: '9a000001-0000-4000-8000-000000000001',
    approved_by: '1a000000-0000-4000-8000-000000000002',
    snapshot_from: 'kb-2026-08-01',
    snapshot_to: 'kb-2026-08-22',
    content_hash: 'c'.repeat(64),
    provenance_source: 'the operations handbook',
    ...overrides,
  };
}

test('writes a non-model row that the schema accepts, with every cost at zero', async () => {
  const run_id = newRunId();

  const written = await appendSystemRow(store, {
    run_id,
    org_id: ORG_A,
    ticket_id: null,
    class: 'kb_admission',
    output: admission(),
    state: STATE,
    toolchain: TOOLCHAIN,
    ts: new Date('2026-08-22T04:00:00.000Z').toISOString(),
  });

  assert.equal(written.seq, 1);
  assert.equal(written.prev_hash, 'GENESIS');

  const [row] = await readChain(run_id);
  assert.equal(row.class, 'kb_admission');
  // Fixed, not passed: the constraint `ledger_nonmodel_costs_zero` is what would refuse anything
  // else, and this writer cannot construct anything else.
  assert.equal(row.agent, 'system');
  assert.equal(row.tokens_in, 0);
  assert.equal(row.tokens_out, 0);
  assert.equal(row.cost_aud, '0.000000');
  assert.equal(row.latency_ms, 0);
  assert.equal(row.restarts, 0);
  assert.equal(row.cum_tokens, 0);

  // No reproducibility block at all, which is what makes it not a model call.
  assert.equal(row.prompt_version_id, null);
  assert.equal(row.model_requested, null);
  assert.equal(row.input_hash, null);
  assert.equal(row.response_hash, null);
  assert.equal(row.confidence, null);

  // It still pins its state and its toolchain, like every other row in the chain.
  assert.equal(row.state_hash.length, 64);
  assert.ok(verifyRowHash(row), 'the row does not hash to what it says it does');
});

test('chains behind whatever is already there, and carries the running total without adding to it', async () => {
  const run_id = newRunId();

  const first = await appendSystemRow(store, {
    run_id,
    org_id: ORG_A,
    class: 'checkpoint',
    output: { seq_covered: 1, head_row_hash: 'a'.repeat(64), k: 50 },
    state: STATE,
    toolchain: TOOLCHAIN,
    ts: new Date('2026-08-22T04:00:00.000Z').toISOString(),
  });

  const second = await appendSystemRow(store, {
    run_id,
    org_id: ORG_A,
    class: 'kb_admission',
    output: admission(),
    state: STATE,
    toolchain: TOOLCHAIN,
    ts: new Date('2026-08-22T04:00:01.000Z').toISOString(),
  });

  assert.equal(second.seq, 2);
  assert.equal(second.prev_hash, first.row_hash);

  const chain = await readChain(run_id);
  assert.equal(chain.length, 2);
  assert.equal(chain[1].cum_tokens, chain[0].cum_tokens, 'a row that spent nothing advanced the total');
  for (const row of chain) assert.ok(verifyRowHash(row));
});

test('refuses a required key that is absent, and names it', async () => {
  const run_id = newRunId();

  for (const key of CLASS_REQUIRED_KEYS.kb_admission) {
    const output = admission();
    delete output[key];

    let raised = null;
    try {
      await appendSystemRow(store, {
        run_id,
        org_id: ORG_A,
        class: 'kb_admission',
        output,
        state: STATE,
        toolchain: TOOLCHAIN,
        ts: new Date('2026-08-22T04:00:00.000Z').toISOString(),
      });
    } catch (error) {
      raised = error;
    }

    assert.equal(raised?.code, 'E_CONFIG_INVALID', `a ${key}-less admission row was written`);
    assert.equal(raised.detail.missing_key, key);
  }

  assert.equal((await readChain(run_id)).length, 0, 'a refused row reached the chain');
});

test('refuses a required key carrying JSON null, because a key carrying null names nothing', async () => {
  const run_id = newRunId();

  let raised = null;
  try {
    await appendSystemRow(store, {
      run_id,
      org_id: ORG_A,
      class: 'kb_admission',
      output: admission({ approved_by: null }),
      state: STATE,
      toolchain: TOOLCHAIN,
      ts: new Date('2026-08-22T04:00:00.000Z').toISOString(),
    });
  } catch (error) {
    raised = error;
  }

  assert.equal(raised?.code, 'E_CONFIG_INVALID');
  assert.equal(raised.detail.missing_key, 'approved_by');
  assert.equal((await readChain(run_id)).length, 0);
});

test('transcribes the class contract the migration publishes', () => {
  // The table in the writer is a transcription of `migrations/0002_ledger.sql` §3, and a
  // transcription that nobody checks is a transcription that drifts. The three classes this writer
  // must NOT offer are absent, and the reason each one is absent is a constraint rather than taste.
  assert.deepEqual(Object.keys(CLASS_REQUIRED_KEYS).sort(), [
    'agreement_r3',
    'checkpoint',
    'commitment',
    'kb_admission',
    'prereg_anchor',
    'start',
  ]);
  assert.ok(!('agent_call' in CLASS_REQUIRED_KEYS), 'this writer produces no reproducibility block');
  assert.ok(!('promotion_attempt' in CLASS_REQUIRED_KEYS), "that class must carry agent = 'evolve'");
  assert.ok(!('modification_event' in CLASS_REQUIRED_KEYS), "that class must carry agent = 'evolve'");

  assert.equal(CLASS_REQUIRED_KEYS.kb_admission.length, 7);
});
