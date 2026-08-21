// test_SEC_cache_is_tenant_isolated
//
// The most expensive failure this component could have, measured rather than reasoned about.
//
// The cache is the ledger, read back by the digest of the input. If two organisations ever produced
// the same digest — and they can, trivially, because two customers can send the same sentence — then
// a cache that ignored the tenant would answer the second one with the FIRST ONE'S RESPONSE. That is
// not a stale answer or a wrong answer. It is one tenant's content delivered to another, through a
// component whose entire purpose is to stop tenant content going where it should not.
//
// The property holds by construction: the lookup runs under `ledger_tenant_select`, so a row of
// another organisation is not visible to it, and the query deliberately carries no `org_id`
// predicate of its own so that the policy is the thing being measured. But "holds by construction"
// is what everybody says about the control that turns out not to hold, and this file is the
// difference between that sentence and a measurement.
//
// The construction of the test is the part worth reading. Both calls use `ticket_id: null` and
// identical bodies, prompts, sampling and seeds, so the two inputs digest to the SAME `input_hash`.
// That is deliberate and it is the whole point: if the ticket differed, the second call would miss
// the cache for a trivial reason and the test would pass while proving nothing about isolation. The
// only thing standing between the second organisation and the first one's response is the policy.
//
// The two organisations write to two different runs, and that costs the test nothing: the cache
// lookup carries no run predicate — a demonstration replayed tomorrow is meant to hit yesterday's
// responses — so a cross-tenant hit would be found across runs exactly as it would within one. The
// reason they are separate is the declared limitation of the writer, which
// `test_GW_ledger_row_satisfies_contract` pins directly: a single run whose rows belong to two
// organisations cannot be extended at all, because the writer reads a head the policy has clipped
// while the trigger reads the true one.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createGateway } from '../../agents/gateway.ts';
import {
  ORG_A,
  ORG_B,
  baseCall,
  baseConfig,
  constantProvider,
  makeStore,
  newRunId,
  readChain,
  registerPrompt,
  spyOn,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000905';
const GENERATION = 905;

const SHARED_BODY = 'Our nightly export has been failing since the weekend. What should we check?';

const ANSWER_A = '{"schema_version":"1.0","confidence":0.5,"for":"the first organisation"}';
const ANSWER_B = '{"schema_version":"1.0","confidence":0.5,"for":"the second organisation"}';

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });
});

after(async () => {
  await store.close();
});

test('an identical input from another organisation misses the cache and calls the provider', async () => {
  const runA = newRunId();
  const runB = newRunId();

  const spyA = spyOn(constantProvider(ANSWER_A));
  const gatewayA = createGateway(baseConfig({ store, provider: spyA.provider, run_id: runA }));

  const spyB = spyOn(constantProvider(ANSWER_B));
  const gatewayB = createGateway(baseConfig({ store, provider: spyB.provider, run_id: runB }));

  const callFor = (org_id) =>
    baseCall({ prompt_version_id: PROMPT_ID, body: SHARED_BODY, org_id, ticket_id: null });

  const first = await gatewayA.call(callFor(ORG_A));
  assert.equal(first.cached, false);
  assert.equal(spyA.calls.length, 1);
  assert.equal(first.response_text, ANSWER_A);

  // The same call again, from the same organisation, IS served from the chain. Without this the
  // test below could pass on a cache that never hits at all, which would prove nothing either.
  const repeat = await gatewayA.call(callFor(ORG_A));
  assert.equal(repeat.cached, true, 'the cache never hits, so the isolation case is not reachable');
  assert.equal(spyA.calls.length, 1);

  const other = await gatewayB.call(callFor(ORG_B));

  assert.equal(
    other.cached,
    false,
    'the second organisation was served from the cache of the first',
  );
  assert.equal(spyB.calls.length, 1, 'the second organisation did not call its own provider');
  assert.equal(
    other.response_text,
    ANSWER_B,
    'the second organisation received the first organisation’s response',
  );

  // The digests really were the same, so the miss was the policy and not a difference in the input.
  assert.equal(other.input_hash, first.input_hash, 'the two inputs did not collide, so nothing was measured');

  const chainA = await readChain(runA);
  const chainB = await readChain(runB);

  assert.deepEqual(chainA.map((row) => row.org_id), [ORG_A, ORG_A]);
  assert.deepEqual(chainB.map((row) => row.org_id), [ORG_B]);

  assert.equal(chainA[0].output.response, ANSWER_A);
  assert.equal(chainA[1].output.response, ANSWER_A, 'the served row did not carry the cached answer');
  assert.equal(chainA[1].output.cache.hit, true);

  // The row the second organisation's chain keeps holds its OWN answer. If isolation had failed
  // this would read as the first organisation's text, recorded under the second one's identity —
  // the leak made permanent and append-only.
  assert.equal(chainB[0].output.response, ANSWER_B);
  assert.equal(chainB[0].output.cache.hit, false);
});
