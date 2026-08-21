// test_GW_state_hash_differs_across_rulesets
//
// `state_hash` exists to say that two rows carrying the same `input_hash` under different
// conditions are NOT comparable. Until this increment there was only one condition that ever moved
// — the knowledge-base snapshot, which has no writer yet — so the column was correct and idle.
//
// With a rule and a policy matcher in the path, the ruleset becomes the condition that moves. The
// same ticket, the same words, the same model and the same answer produce a different verdict under
// a different confidence floor or a different policy table; two runs under two rulesets are two
// different experiments, and pooling them would be pooling the treatment with the control.
//
// So the digest of the ruleset is what the application puts into `state.ruleset_hash`, and the two
// consequences are measured here: rows written under different rulesets carry different
// `state_hash` values, and the cache — which is keyed on it — never serves one to the other.
//
// The value the application digests into `ruleset_hash` is exercised at the end, through the same
// two functions the composition root uses on it. What is asserted is what a re-implementation of
// the digest could not check: that it moves when the thresholds move, when the weights move and
// when a policy pattern moves, and that it does not move between two calls that changed nothing.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { canonicalJson, sha256Hex } from '../../agents/canonical.ts';
import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import { stateHash } from '../../agents/ledger/row.ts';
import { rulesetDescription } from '../../src/alg/ruleset.ts';
import { DEFAULT_ESCALATION_THRESHOLDS } from '../../src/alg/escalation.ts';
import { DEFAULT_PRIORITY_WEIGHTS } from '../../src/alg/priority.ts';
import {
  baseCall,
  baseConfig,
  makeStore,
  newRunId,
  readChain,
  registerPrompt,
  spyOn,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000909';
const GENERATION = 909;

const BODY = 'The invoice total does not match the delivery note for last week.';

const RULESET_A = 'a'.repeat(64);
const RULESET_B = 'b'.repeat(64);

function stateWith(ruleset_hash) {
  return { schema_version: '1.0', ruleset_hash, kb_snapshot: 'kb:none' };
}

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });
});

after(async () => {
  await store.close();
});

test('two rulesets write two different state hashes for the same input', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());

  const underA = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, state: stateWith(RULESET_A) }),
  );
  const underB = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, state: stateWith(RULESET_B) }),
  );

  const first = await underA.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));
  const second = await underB.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));

  assert.equal(first.input_hash, second.input_hash, 'the inputs differed, so nothing was measured');
  assert.equal(second.cached, false, 'the second ruleset was served an answer produced under the first');
  assert.equal(spy.calls.length, 2, 'the provider was not asked under the second ruleset');

  const chain = await readChain(run_id);
  assert.equal(chain.length, 2);
  assert.notEqual(chain[0].state_hash, chain[1].state_hash);
  assert.equal(chain[0].state_hash, stateHash(stateWith(RULESET_A)));
  assert.equal(chain[1].state_hash, stateHash(stateWith(RULESET_B)));
});

test('the same ruleset is still one cache', async () => {
  // The negative control. Without it, a state hash that changed on every call would pass the test
  // above and would also empty the cache on every request.
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const body = 'Our purchase order reference is missing from the statement.';

  const gateway = () =>
    createGateway(baseConfig({ store, provider: spy.provider, run_id, state: stateWith(RULESET_A) }));

  await gateway().call(baseCall({ prompt_version_id: PROMPT_ID, body }));
  const second = await gateway().call(baseCall({ prompt_version_id: PROMPT_ID, body }));

  assert.equal(spy.calls.length, 1, 'the same ruleset asked twice');
  assert.equal(second.cached, true);
});

test('the ruleset digest moves with everything the verdict depends on', () => {
  const rulesetHash = (thresholds, weights) =>
    sha256Hex(canonicalJson(rulesetDescription(thresholds, weights)));

  const base = rulesetHash();
  assert.equal(base.length, 64);
  assert.equal(rulesetHash(), base, 'the digest is not stable across two calls that changed nothing');
  assert.equal(rulesetHash(DEFAULT_ESCALATION_THRESHOLDS, DEFAULT_PRIORITY_WEIGHTS), base);

  const moved = {
    confidence: { ...DEFAULT_ESCALATION_THRESHOLDS, confidence: 0.8 },
    sentiment: { ...DEFAULT_ESCALATION_THRESHOLDS, sentiment: -0.5 },
    maxRetries: { ...DEFAULT_ESCALATION_THRESHOLDS, maxRetries: 4 },
    premiumSeverity: { ...DEFAULT_ESCALATION_THRESHOLDS, premiumSeverity: 0.5 },
    supportedLanguages: { ...DEFAULT_ESCALATION_THRESHOLDS, supportedLanguages: ['en', 'es'] },
    nullSentimentConfidencePenalty: {
      ...DEFAULT_ESCALATION_THRESHOLDS,
      nullSentimentConfidencePenalty: 0.3,
    },
  };

  for (const [name, thresholds] of Object.entries(moved)) {
    assert.notEqual(
      rulesetHash(thresholds),
      base,
      `the ruleset digest ignores ${name}, so two runs calibrated differently would pool`,
    );
  }

  // The queue's weights are part of the verdict too: the stored priority is computed from them and
  // is written in the same transaction as the state.
  for (const weights of [
    { severity: 0.4, negativity: 0.2, urgency: 0.3, tier: 0.1 },
    { severity: 0.35, negativity: 0.25, urgency: 0.2, tier: 0.2 },
  ]) {
    assert.notEqual(
      rulesetHash(DEFAULT_ESCALATION_THRESHOLDS, weights),
      base,
      'the ruleset digest ignores the priority weights',
    );
  }

  // And the matcher's table, which is the only producer of the highest-precedence code.
  const description = rulesetDescription();
  assert.ok(description.policyPatterns.length > 0, 'the ruleset carries no policy patterns');
  const withoutAPattern = {
    ...description,
    policyPatterns: description.policyPatterns.slice(1),
  };
  assert.notEqual(
    sha256Hex(canonicalJson(withoutAPattern)),
    base,
    'the ruleset digest ignores the policy table, so a rewritten matcher would pool with the old one',
  );
});
