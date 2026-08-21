// test_GW_cache_hit_skips_call
//
// The same input, twice. The first time it is a call; the second time it is a lookup in the chain,
// and the difference has to be visible in all three places it should be: the provider was not
// touched, the consumption did not move, and the row that records the second answer says where the
// answer came from.
//
// The last of those is the one worth explaining. A cache hit does write a row. It is a decision the
// system acted on — a customer got an answer — and a chain that records only the answers that were
// expensive is not a record of what the system did. The row carries the whole reproducibility block
// of the call that really happened, zero tokens, zero cost, and `output.cache.hit` set, so that
// nothing reading the chain can mistake it for a fresh invocation and no cost or latency figure
// computed from the chain is quietly diluted by it.
//
// The third case is the guard on the key. Two calls that agree on every word of the input but were
// sampled with a different seed are not the same call, and serving one from the other would put a
// response into the chain under parameters that did not produce it.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import {
  baseCall,
  baseConfig,
  makeStore,
  newRunId,
  readChain,
  registerPrompt,
  spentOnChain,
  spyOn,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000903';
const GENERATION = 903;

const BODY = 'Nightly exports have been timing out since about 06:00. What should we check first?';

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });
});

after(async () => {
  await store.close();
});

test('the second call is answered from the chain, without the provider and without cost', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(baseConfig({ store, provider: spy.provider, run_id }));

  const first = await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));
  assert.equal(spy.calls.length, 1);
  assert.equal(first.cached, false);
  assert.ok(Number(first.cost_aud) > 0, 'the first call cost nothing, so nothing is being saved');

  const spentAfterFirst = await spentOnChain(run_id);

  const second = await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));

  assert.equal(spy.calls.length, 1, 'the provider was called a second time for the same input');
  assert.equal(second.cached, true);
  assert.equal(second.response_text, first.response_text, 'the cached answer is a different answer');
  assert.equal(second.model_returned, first.model_returned);
  assert.equal(second.cost_aud, '0.000000');
  assert.equal(second.tokens_in, 0);
  assert.equal(second.tokens_out, 0);
  assert.equal(second.input_hash, first.input_hash);

  assert.equal(
    await spentOnChain(run_id),
    spentAfterFirst,
    'consumption moved although no call was made',
  );

  const chain = await readChain(run_id);
  assert.equal(chain.length, 2, 'the cached answer left no trace in the chain');

  const [fresh, served] = chain;
  assert.equal(fresh.output.cache.hit, false);
  assert.equal(fresh.output.cache.source_seq, null);

  assert.equal(served.output.cache.hit, true);
  assert.equal(served.output.cache.source_seq, fresh.seq);
  assert.equal(served.class, 'agent_call');
  assert.equal(served.input_hash, fresh.input_hash);
  assert.equal(served.response_hash, fresh.response_hash);
  assert.equal(served.model_returned, fresh.model_returned);
  assert.equal(served.cost_aud, '0.000000');
  assert.equal(served.tokens_in, 0);
  assert.equal(served.tokens_out, 0);

  // Nothing accumulated, and the series stayed readable row by row.
  assert.equal(served.cum_tokens, fresh.cum_tokens);
});

test('a call that differs only in a sampling parameter is not served from the cache', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(baseConfig({ store, provider: spy.provider, run_id }));

  await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY, seed: 11 }));
  assert.equal(spy.calls.length, 1);

  const other = await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY, seed: 12 }));

  assert.equal(spy.calls.length, 2, 'a different seed was served from a response it did not produce');
  assert.equal(other.cached, false);
  assert.ok(Number(other.cost_aud) > 0);
});

test('the cache is answered from the call that happened, never from a copy of it', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(baseConfig({ store, provider: spy.provider, run_id }));

  const body = 'The portal rejected our purchase order upload twice this morning.';
  const first = await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body }));
  const second = await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body }));
  const third = await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body }));

  assert.equal(spy.calls.length, 1);
  assert.equal(second.cached, true);
  assert.equal(third.cached, true);

  const chain = await readChain(run_id);
  assert.equal(chain.length, 3);
  // Both served rows point at the first row, not at each other: the provenance is one hop deep and
  // stays one hop deep however many times the same question is asked.
  assert.equal(chain[1].output.cache.source_seq, first.ledger.seq);
  assert.equal(chain[2].output.cache.source_seq, first.ledger.seq);
});
