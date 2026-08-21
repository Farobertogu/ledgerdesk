// test_GW_ledger_row_satisfies_contract
//
// The rows the chokepoint writes are inserted against the real schema, so the check constraints and
// the trigger of `0002` are what accept them. That is most of the test and it happens before a
// single assertion runs: a row missing any of the eight columns that describe a model call, a row
// whose `prev_hash` is not the head, a row whose `row_hash` is not sixty-four hex characters — none
// of those reaches the assertions, because the database refuses it.
//
// What the assertions add is the part the database deliberately does not check. `ledger_link()`
// verifies that the chain is LINKED; it cannot verify that `row_hash` is the right digest, because
// a trigger cannot digest a row it is in the middle of inserting. So the digest is recomputed here,
// from the row read back out of the database, by the same function an auditor would use. A chain
// whose hashes were never recomputed by anyone is a chain of sixty-four-character strings.
//
// The last two cases exist so the first ones mean something. If a forged `prev_hash` were accepted
// and an `UPDATE` went through, then the rows above would be passing constraints that do not hold,
// and this file would be measuring a database that is not the one in the migration set.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { verifyRowHash } from '../../agents/ledger/row.ts';
import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import {
  ORG_A,
  TICKET_A,
  asOwner,
  baseCall,
  baseConfig,
  makeStore,
  newRunId,
  readChain,
  registerPrompt,
  spyOn,
  MODEL,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000904';
const GENERATION = 904;

/** The eight the check constraint `ledger_agent_call_complete` reinstates for this class. */
const CALL_COLUMNS = [
  'prompt_version_id',
  'model_requested',
  'model_returned',
  'sampling',
  'input_hash',
  'input_path',
  'prompt_hash',
  'response_hash',
];

let store;
let run_id;
let chain;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });

  run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(baseConfig({ store, provider: spy.provider, run_id }));

  // Two calls that differ, and a third that repeats the first: the chain under test carries both
  // kinds of row, because both kinds have to satisfy the same contract.
  await gateway.call({
    ...baseCall({ prompt_version_id: PROMPT_ID, body: 'The invoice was billed twice in March.' }),
  });
  await gateway.call({
    ...baseCall({ prompt_version_id: PROMPT_ID, body: 'Exports have been timing out since 06:00.' }),
  });
  await gateway.call({
    ...baseCall({ prompt_version_id: PROMPT_ID, body: 'The invoice was billed twice in March.' }),
  });

  chain = await readChain(run_id);
});

after(async () => {
  await store.close();
});

test('every row is a complete agent_call under the schema it was inserted against', () => {
  assert.equal(chain.length, 3);

  for (const row of chain) {
    assert.equal(row.class, 'agent_call');
    assert.equal(row.run_id, run_id);
    assert.equal(row.org_id, ORG_A);
    assert.equal(row.ticket_id, TICKET_A);
    assert.equal(row.agent, 'triage');
    assert.equal(row.model_requested, MODEL);
    assert.equal(row.input_path, 'seed/orgs.sql');

    for (const column of CALL_COLUMNS) {
      assert.notEqual(row[column], null, `${column} is null on an agent_call row`);
    }

    // The reproducibility block: hashes are hashes, and the toolchain pins what produced them.
    for (const column of ['input_hash', 'prompt_hash', 'response_hash', 'state_hash']) {
      assert.match(row[column], /^[a-f0-9]{64}$/, `${column} is not a sha256`);
    }
    assert.deepEqual(Object.keys(row.toolchain).sort(), ['app', 'model_sdk', 'node', 'ruleset']);
    assert.deepEqual(Object.keys(row.sampling).sort(), ['max_tokens', 'stop', 'temperature', 'top_p']);
    assert.equal(row.restarts, 0);
    assert.match(row.cost_aud, /^\d+\.\d{6}$/, 'cost is not at the scale of its column');
  }
});

test('the chain is linked, monotone, and its digests recompute', () => {
  let previous = 'GENESIS';
  let tokens = 0;

  for (const [index, row] of chain.entries()) {
    assert.equal(row.seq, index + 1, 'seq is not monotone from one');
    assert.equal(row.prev_hash, previous, 'the row does not attach to the head before it');
    assert.notEqual(row.row_hash, row.prev_hash);

    // The assertion the database cannot make: the stored digest is the digest of the stored row.
    assert.ok(
      verifyRowHash(row),
      `row ${row.seq} carries a row_hash that is not the digest of its own content`,
    );

    tokens += row.tokens_in + row.tokens_out;
    assert.equal(row.cum_tokens, tokens, 'cum_tokens is not the running total of the chain');

    previous = row.row_hash;
  }

  // A digest that is a function of its content also detects a change to that content. One field is
  // altered in memory and the same verifier must now say no.
  const tampered = { ...chain[1], cost_aud: '9.999999' };
  assert.equal(verifyRowHash(tampered), false, 'the digest does not cover the cost of the row');

  const relinked = { ...chain[2], prev_hash: 'GENESIS' };
  assert.equal(verifyRowHash(relinked), false, 'the digest does not cover the link');
});

test('a row that does not attach to the head is refused by the database', async () => {
  const head = chain[chain.length - 1];

  const rejection = await asOwner(async (client) => {
    try {
      await client.query(
        `insert into ledger_entry (
           run_id, seq, org_id, agent, prompt_version_id, model_requested, model_returned,
           sampling, input_hash, input_path, prompt_hash, response_hash, state_hash, toolchain,
           restarts, tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output,
           prev_hash, row_hash)
         values ($1, $2, $3, 'triage', $4, 'm', 'm', '{}'::jsonb,
                 $5, 'seed/orgs.sql', $5, $5, $5, '{}'::jsonb,
                 0, 1, 1, 0, 1, 1, 'agent_call', '{}'::jsonb, $6, $7)`,
        [
          run_id,
          head.seq + 1,
          ORG_A,
          PROMPT_ID,
          'a'.repeat(64),
          'b'.repeat(64), // a prev_hash that is not the head
          'c'.repeat(64),
        ],
      );
      return null;
    } catch (error) {
      return error.message;
    }
  });

  assert.match(
    rejection ?? '',
    /E_LEDGER_CHAIN_BROKEN/,
    'a row claiming a head it does not follow was accepted',
  );
});

test('a row already written cannot be changed', async () => {
  const rejection = await asOwner(async (client) => {
    try {
      await client.query('update ledger_entry set cost_aud = 0 where run_id = $1', [run_id]);
      return null;
    } catch (error) {
      return error.message;
    }
  });

  assert.match(rejection ?? '', /E_LEDGER_APPEND_ONLY/, 'a written row was updated');
});
