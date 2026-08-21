// test_GW_budget_cuts_off
//
// The ceiling, measured as a ceiling: calls are made until one is refused, and then the questions
// that matter are asked about the refusal and about everything before it.
//
// The test does not compute in advance how many calls fit. It could — the fixture provider's token
// counts are a function of the request — but a test that pins the arithmetic would be re-deriving
// the pricing rather than measuring the property, and it would go red the day the fixture's text
// changes length. What is asserted instead is what the ceiling is FOR: that consumption never
// crossed the cut, that the refused call cost nothing and left nothing behind, and that the refusal
// is not a fact this process happens to remember.
//
// That last one is the point of the second half. The consumption counter is recomputed from the
// chain on every call, so a gateway built fresh — the same run, the same store, no memory of what
// went before — refuses immediately. A counter held in a variable would let a restart hand the
// budget back, and a ceiling that can be reset by restarting is a ceiling multiplied by however
// many times somebody restarts.

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
  refusedWith,
  registerPrompt,
  spentOnChain,
  spyOn,
  MODEL,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000902';
const GENERATION = 902;

/** A low cut and a deliberately expensive fixture model, so the ceiling is reached in a few calls. */
const CUT_AUD = 0.5;
const PRICING = { [MODEL]: { input_aud_per_1k: 1, output_aud_per_1k: 1 } };

/** More attempts than can possibly fit. A ceiling that never trips is the failure, not the timeout. */
const ATTEMPTS = 40;

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });
});

after(async () => {
  await store.close();
});

test('the call that would cross the cut is refused, costs nothing and writes nothing', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({
      store,
      provider: spy.provider,
      run_id,
      pricing: PRICING,
      budget: { cap_aud: 1, cut_aud: CUT_AUD, scope: 'run' },
    }),
  );

  let accepted = 0;
  let refusal = null;
  let refusedBody = null;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // Each body is different, so every call is a real call: an identical body would be served from
    // the cache for nothing and the ceiling would never be approached.
    const body = `Exports have been timing out since run ${attempt}, please advise on the retry policy.`;
    try {
      await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body }));
      accepted += 1;
    } catch (error) {
      refusal = error;
      refusedBody = body;
      break;
    }
  }

  assert.ok(accepted > 0, 'the ceiling refused the very first call, so nothing was measured');
  assert.ok(refusal, `no call was refused in ${ATTEMPTS} attempts; the ceiling never tripped`);
  assert.equal(refusal.code, 'E_BUDGET_EXHAUSTED', `refused with ${refusal.code}`);

  const callsAtRefusal = spy.calls.length;
  const rowsAtRefusal = await readChain(run_id);
  const spentAtRefusal = await spentOnChain(run_id);

  assert.equal(
    callsAtRefusal,
    accepted,
    'the provider was called for a request the ceiling had refused',
  );
  assert.equal(rowsAtRefusal.length, accepted, 'the refused call wrote a row');
  assert.ok(
    spentAtRefusal <= CUT_AUD,
    `consumption reached ${spentAtRefusal}, past the cut of ${CUT_AUD}`,
  );
  assert.ok(spentAtRefusal > 0, 'nothing was spent, so the ceiling was not what stopped the run');

  // The refusal names the figures it acted on, so an operator reading it can tell a breaker that
  // tripped from a call that failed.
  assert.equal(refusal.detail.cut_aud, CUT_AUD.toFixed(6));
  assert.equal(refusal.detail.scope, 'run');

  // --- the same ceiling, from a gateway with no memory of any of this -------------------------
  const secondSpy = spyOn(stubProvider());
  const restarted = createGateway(
    baseConfig({
      store,
      provider: secondSpy.provider,
      run_id,
      pricing: PRICING,
      budget: { cap_aud: 1, cut_aud: CUT_AUD, scope: 'run' },
    }),
  );

  // The call that was just refused, made again by a gateway that was not there when it happened.
  // It has to be the same call: the projection is a function of the request, so a shorter enquiry
  // could legitimately still fit under the cut and would prove nothing either way.
  await refusedWith('E_BUDGET_EXHAUSTED', () =>
    restarted.call(baseCall({ prompt_version_id: PROMPT_ID, body: refusedBody })),
  );

  assert.equal(secondSpy.calls.length, 0, 'a fresh gateway spent past a ceiling already reached');
  assert.equal(
    (await readChain(run_id)).length,
    accepted,
    'the fresh gateway wrote a row past the ceiling',
  );
  assert.equal(await spentOnChain(run_id), spentAtRefusal, 'consumption moved after the cut');
});

test('a run under its own ceiling is unaffected by another run that reached one', async () => {
  // `scope: 'run'` measures this session. The previous test exhausted its own run; a new run starts
  // with an empty chain and must therefore be able to spend. Without this, a passing first test
  // could be a ceiling that refuses everything for any reason at all.
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({
      store,
      provider: spy.provider,
      run_id,
      pricing: PRICING,
      budget: { cap_aud: 1, cut_aud: CUT_AUD, scope: 'run' },
    }),
  );

  const result = await gateway.call(
    baseCall({ prompt_version_id: PROMPT_ID, body: 'A short enquiry about invoice timing.' }),
  );

  assert.equal(spy.calls.length, 1);
  assert.equal(result.cached, false);
  assert.ok(Number(result.cost_aud) > 0, 'a real call was recorded as costing nothing');
});

test('a ceiling that cuts above its own cap is refused as a configuration', async () => {
  assert.throws(
    () =>
      createGateway(
        baseConfig({
          store,
          provider: spyOn(stubProvider()).provider,
          run_id: newRunId(),
          budget: { cap_aud: 10, cut_aud: 20, scope: 'term' },
        }),
      ),
    (error) => error.code === 'E_CONFIG_INVALID',
  );
});
