// test_GW_replay_never_calls_provider
//
// The README says, in the present tense, that replay from the ledger requires no network. This is
// the measurement of that sentence.
//
// A replay build reads its answers from the chain and from nowhere else. The provider it is
// configured with is one that THROWS if it is ever entered — because "the provider was not called"
// is only worth asserting if being called would be loud. A counter that the test inspected
// afterwards would pass on a build that called the provider and ignored the answer.
//
// The miss is the other half and it is the half that has to be typed. A replay that fell back to a
// call would make a rehearsal look identical to a live run right up to the moment it needed the
// network, which is a difference nobody discovers in a room with an audience. So a miss is
// `E_REPLAY_CACHE_MISS`, no row is written, and the pipeline stops before the ceiling and before
// the payload is assembled — there is nothing left to check about a call that will not happen.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import {
  ORG_A,
  baseCall,
  baseConfig,
  makeStore,
  newRunId,
  readChain,
  refusedWith,
  registerPrompt,
  spentOnChain,
  spyOn,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000908';
const GENERATION = 908;

const BODY = 'The nightly reconciliation has been failing since the upgrade on Tuesday.';

/** A provider whose only behaviour is to make being called impossible to miss. */
function refusingProvider() {
  return async () => {
    throw new Error('the provider was entered under replay');
  };
}

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });
});

after(async () => {
  await store.close();
});

test('a recorded call is replayed from the chain, with no provider and no cost', async () => {
  const run_id = newRunId();

  // The live run: one real call, recorded.
  const live = spyOn(stubProvider());
  const recorded = await createGateway(
    baseConfig({ store, provider: live.provider, run_id }),
  ).call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));

  assert.equal(live.calls.length, 1);
  assert.equal(recorded.cached, false);
  const spentAfterLive = await spentOnChain(run_id);

  // The replay: same input, a provider that would throw, and the flag.
  const replayed = await createGateway(
    baseConfig({ store, provider: refusingProvider(), run_id, replay: true }),
  ).call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));

  assert.equal(replayed.cached, true);
  assert.equal(replayed.response_text, recorded.response_text, 'the replay produced a different answer');
  assert.equal(replayed.response_text.length > 0, true);
  assert.equal(replayed.model_returned, recorded.model_returned);
  assert.equal(replayed.input_hash, recorded.input_hash);
  assert.equal(replayed.cost_aud, '0.000000');
  assert.equal(replayed.tokens_in, 0);
  assert.equal(replayed.tokens_out, 0);

  assert.equal(await spentOnChain(run_id), spentAfterLive, 'a replay moved the consumption figure');

  const chain = await readChain(run_id);
  assert.equal(chain.length, 2, 'the replay left no honest row behind it');
  assert.equal(chain[1].output.cache.hit, true);
  assert.equal(chain[1].output.cache.source_seq, chain[0].seq);
});

test('a miss is a typed refusal and not a call', async () => {
  const run_id = newRunId();
  const gateway = createGateway(
    baseConfig({ store, provider: refusingProvider(), run_id, replay: true }),
  );

  const error = await refusedWith('E_REPLAY_CACHE_MISS', () =>
    gateway.call(
      baseCall({
        prompt_version_id: PROMPT_ID,
        body: 'A question the chain has never been asked before, about a shipment to Broken Hill.',
      }),
    ),
  );

  assert.equal(error.detail.agent, 'triage');
  assert.ok(typeof error.detail.input_hash === 'string' && error.detail.input_hash.length === 64);

  assert.deepEqual(await readChain(run_id), [], 'a call that never happened wrote a row');
  assert.equal(await spentOnChain(run_id), 0);
});

test('a miss is refused before the ceiling, so an exhausted budget cannot mask it', async () => {
  // The ordering matters for the operator, not for the arithmetic: under replay nothing can be
  // spent, so a ceiling refusal here would name the wrong problem and send somebody to look at a
  // budget when what is missing is a recorded answer.
  const run_id = newRunId();
  const gateway = createGateway(
    baseConfig({
      store,
      provider: refusingProvider(),
      run_id,
      replay: true,
      budget: { cap_aud: 0.000002, cut_aud: 0.000001, scope: 'term' },
    }),
  );

  await refusedWith('E_REPLAY_CACHE_MISS', () =>
    gateway.call({
      ...baseCall({ prompt_version_id: PROMPT_ID, body: 'Another question nobody has asked.' }),
      org_id: ORG_A,
    }),
  );
});

test('a replay build with its cache switched off is refused at construction', async () => {
  // A configuration that can only ever fail is a defect of the caller, and it fails where the
  // caller is rather than at the first call.
  assert.throws(
    () =>
      createGateway(
        baseConfig({
          store,
          provider: refusingProvider(),
          run_id: newRunId(),
          replay: true,
          cache: false,
        }),
      ),
    (error) => error.code === 'E_CONFIG_INVALID',
  );
});

test('the same build without the flag calls the provider, so the flag is what did it', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const body = 'Whether the freight surcharge applies to a partial container.';

  const result = await createGateway(baseConfig({ store, provider: spy.provider, run_id })).call(
    baseCall({ prompt_version_id: PROMPT_ID, body }),
  );

  assert.equal(spy.calls.length, 1);
  assert.equal(result.cached, false);
  assert.ok(Number(result.cost_aud) > 0);
});
