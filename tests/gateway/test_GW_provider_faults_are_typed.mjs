// test_GW_provider_faults_are_typed
//
// The three ways a call can go wrong once the payload has already left, and what each one does to
// the chain and to the ceiling. All three were written into the gateway before any of them was
// measured, which is the reason this file exists: code with no test is a claim.
//
//   · **The deadline passes.** The provider may have completed the work and billed for it. There is
//     no response, so there is no row — and that means the chain UNDER-COUNTS what was really spent.
//     The gateway answers this by holding the projection against the ceiling instead of releasing
//     it, so the ceiling's error is always the conservative one. The second case below is the
//     measurement of that: after a timeout the chain says nothing was spent, and the next call is
//     refused anyway.
//
//   · **Another model answers.** Recorded, never silently accepted. Without a pin it is a fact in
//     the row; with a pin it is also an error — and the row is written first, because a model that
//     answered under another name still answered, still cost money, and is exactly the event that
//     must not be the one the chain omits.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import {
  MODEL,
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

const PROMPT_ID = '9f000000-0000-4000-8000-000000000906';
const GENERATION = 906;

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });
});

after(async () => {
  await store.close();
});

test('a provider that does not answer in time is refused typed, and writes nothing', async () => {
  const run_id = newRunId();
  const gateway = createGateway(
    baseConfig({
      store,
      provider: stubProvider({ latency_ms: 400 }),
      run_id,
      timeout_ms: 50,
    }),
  );

  const error = await refusedWith('E_PROVIDER_TIMEOUT', () =>
    gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: 'A slow enquiry.' })),
  );

  assert.equal(error.detail.timeout_ms, 50);
  // The figure an operator needs: money that may have been spent and cannot be recorded.
  assert.match(error.detail.unrecorded_aud, /^\d+\.\d{6}$/);

  assert.equal((await readChain(run_id)).length, 0, 'a call with no response wrote a row');
  assert.equal(await spentOnChain(run_id), 0);
});

test('the cost of a timed-out call is held against the ceiling although no row records it', async () => {
  const run_id = newRunId();

  // The provider is slow once and quick afterwards, so the second call would succeed on every
  // ground except the one under test.
  let attempts = 0;
  const provider = async (request, options) => {
    attempts += 1;
    const inner = stubProvider(attempts === 1 ? { latency_ms: 400 } : {});
    return inner(request, options);
  };

  // A cut just above the projection of one call: with the timed-out call's reservation held, the
  // second call cannot fit; without it, the chain reads zero and the second call sails through.
  const gateway = createGateway(
    baseConfig({
      store,
      provider,
      run_id,
      timeout_ms: 50,
      pricing: { [MODEL]: { input_aud_per_1k: 1, output_aud_per_1k: 1 } },
      budget: { cap_aud: 1, cut_aud: 0.12, scope: 'run' },
    }),
  );

  await refusedWith('E_PROVIDER_TIMEOUT', () =>
    gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: 'The first enquiry, unanswered.' })),
  );

  assert.equal(await spentOnChain(run_id), 0, 'the chain records a call that produced no response');

  const refusal = await refusedWith('E_BUDGET_EXHAUSTED', () =>
    gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: 'The second enquiry, answerable.' })),
  );

  // The chain says nothing was spent; the ceiling refuses anyway, and the detail says why.
  assert.equal(refusal.detail.spent_aud, '0.000000');
  assert.ok(
    Number(refusal.detail.in_flight_aud) > 0,
    'nothing is held in flight, so the timed-out call was forgotten',
  );
  assert.equal((await readChain(run_id)).length, 0);
});

test('a model other than the one requested is recorded, and raises only under a pin', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider({ returns_model: 'someone-elses-model' }));
  const gateway = createGateway(baseConfig({ store, provider: spy.provider, run_id }));

  // Without a pin: a fact in the row, not an error.
  const drifted = await gateway.call(
    baseCall({ prompt_version_id: PROMPT_ID, body: 'An enquiry answered by another model.' }),
  );
  assert.equal(drifted.model_returned, 'someone-elses-model');

  const [recorded] = await readChain(run_id);
  assert.equal(recorded.model_requested, MODEL);
  assert.equal(recorded.model_returned, 'someone-elses-model');

  // With a pin: an error — and the row is written all the same.
  const error = await refusedWith('E_MODELO_INESPERADO', () =>
    gateway.call(
      baseCall({
        prompt_version_id: PROMPT_ID,
        body: 'A pinned enquiry answered by another model.',
        pin_model: true,
      }),
    ),
  );

  assert.equal(error.detail.model_requested, MODEL);
  assert.equal(error.detail.model_returned, 'someone-elses-model');

  const chain = await readChain(run_id);
  assert.equal(chain.length, 2, 'the pinned call was refused without recording what answered it');
  assert.equal(chain[1].model_returned, 'someone-elses-model');
  assert.equal(chain[1].row_hash, error.detail.ledger_row_hash);
  assert.ok(Number(chain[1].cost_aud) > 0, 'a call that cost money was recorded as free');
});

test('a provider that fails without answering releases its reservation', async () => {
  const run_id = newRunId();
  let attempts = 0;
  const provider = async (request, options) => {
    attempts += 1;
    if (attempts === 1) throw new Error('connection refused');
    return stubProvider()(request, options);
  };

  // A cut that admits exactly one call. If the refused connection kept its reservation, the second
  // call would be turned away and the ceiling would be leaking budget on every transient fault.
  const gateway = createGateway(
    baseConfig({
      store,
      provider,
      run_id,
      pricing: { [MODEL]: { input_aud_per_1k: 1, output_aud_per_1k: 1 } },
      budget: { cap_aud: 1, cut_aud: 0.12, scope: 'run' },
    }),
  );

  await refusedWith('E_PROVIDER_FAILED', () =>
    gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: 'An enquiry nobody received.' })),
  );

  const answered = await gateway.call(
    baseCall({ prompt_version_id: PROMPT_ID, body: 'An enquiry that did arrive.' }),
  );
  assert.equal(answered.cached, false);
  assert.equal((await readChain(run_id)).length, 1);
});
