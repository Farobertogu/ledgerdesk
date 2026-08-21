// test_ALG_features_null_when_the_step_has_not_run
//
// The companion to `test_ALG_features_sentinels`, and deliberately a SEPARATE file.
//
// That test asserts the sentinels of a ticket nothing has looked at, including the one this
// increment turns on: `kbResultCount` must be null and must never be zero, because
// `effectiveGrounded` reads a count of zero as "the search ran and found nothing" and fires GROUND
// on it. It was written when the field had exactly one possible value, and it is not edited — the
// cases that arrive with a retrieval are added beside it, which is what a test asserting a
// prohibition is for.
//
// The prohibition now has a name and a shape. `FeatureInput` gained two optional members, both of
// them `{...} | null`, and the single most natural edit anybody will make is `?? 0` on one and
// `?? false` on the other: the types demand a value, every consumer wants one, and a defaulting
// operator makes the type error go away in one keystroke. What it also does is escalate every
// ticket in the system, correctly by the rule, for a retrieval that never ran.
//
// Three values, three facts:
//
//   · null  — this step has not run. The clause is not evaluable and does not fire.
//   · 0     — it ran against the snapshot in force and matched nothing. The clause fires.
//   · n > 0 — it found sources, and grounding is then the validator's question.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  effectiveGrounded,
  evaluateEscalation,
  evaluateEscalationClauses,
} from '../../src/alg/escalation.ts';
import { featuresFromTicket } from '../../src/alg/features.ts';
import { NOW, T0, THRESHOLDS } from './fixtures.mjs';

/** A ticket that has been triaged calmly: nothing about it escalates on its own. */
function triaged(overrides = {}) {
  return featuresFromTicket({
    ticket: { id: 'T-000001', createdAt: T0, slaDueAt: T0 + 86_400_000, language: 'en', retries: 0 },
    account: { tier: 'standard', valueBand: 3 },
    triage: { category: 'billing', severity: 2, sentiment: 0.1, confidence: 0.92 },
    redactedBodyLength: 120,
    policyFlags: [],
    ...overrides,
  });
}

describe('test_ALG_features_null_when_the_step_has_not_run', () => {
  it('produces null from an input that omits the two members entirely', () => {
    // The triage cycle passes neither, and this is the case that must never become a zero.
    const { features } = triaged();
    assert.equal(features.kbResultCount, null);
    assert.equal(features.grounded, null);
    assert.notEqual(features.kbResultCount, 0, 'an omitted retrieval became a search that found nothing');
    assert.notStrictEqual(features.grounded, false, 'an omitted validation became a verdict of not grounded');
  });

  it('produces null from an input that passes them as null explicitly', () => {
    const { features } = triaged({ retrieval: null, validation: null });
    assert.equal(features.kbResultCount, null);
    assert.equal(features.grounded, null);
  });

  it('leaves the grounding clause unevaluable, and therefore unfired, on both', () => {
    for (const input of [triaged(), triaged({ retrieval: null, validation: null })]) {
      assert.equal(effectiveGrounded(input.features), null);
      const verdict = evaluateEscalation(input.features, NOW, THRESHOLDS);
      assert.deepEqual(verdict, { escalate: false, reason: null, clause: null });
    }
  });

  it('carries a count of zero through as zero, which is a different fact', () => {
    const { features } = triaged({ retrieval: { resultCount: 0 }, validation: null });
    assert.equal(features.kbResultCount, 0);
    assert.equal(effectiveGrounded(features), false, 'a search that ran and found nothing is not grounded');

    const verdict = evaluateEscalation(features, NOW, THRESHOLDS);
    assert.equal(verdict.escalate, true);
    assert.equal(verdict.reason, 'GROUND');
    assert.equal(verdict.clause, 'draft_not_grounded');
  });

  it('carries a count above zero without deciding anything by itself', () => {
    const { features } = triaged({ retrieval: { resultCount: 3 }, validation: null });
    assert.equal(features.kbResultCount, 3);
    // Sources were found and no draft has been validated: the clause is still not evaluable.
    assert.equal(effectiveGrounded(features), null);
    assert.equal(evaluateEscalation(features, NOW, THRESHOLDS).escalate, false);
  });

  it('carries the validator’s verdict through in both directions', () => {
    const grounded = triaged({ retrieval: { resultCount: 2 }, validation: { grounded: true } });
    assert.equal(grounded.features.grounded, true);
    assert.equal(effectiveGrounded(grounded.features), true);
    assert.equal(evaluateEscalation(grounded.features, NOW, THRESHOLDS).escalate, false);

    const ungrounded = triaged({ retrieval: { resultCount: 2 }, validation: { grounded: false } });
    assert.equal(ungrounded.features.grounded, false);
    assert.equal(evaluateEscalation(ungrounded.features, NOW, THRESHOLDS).reason, 'GROUND');
  });

  it('lets a zero count overrule a validator that said grounded', () => {
    // `effectiveGrounded` reads the count first, and it should: a verdict of grounded over an empty
    // set of sources is a verdict about nothing. The arithmetic wins.
    const { features } = triaged({ retrieval: { resultCount: 0 }, validation: { grounded: true } });
    assert.equal(effectiveGrounded(features), false);
    assert.equal(evaluateEscalation(features, NOW, THRESHOLDS).reason, 'GROUND');
  });

  it('fires exactly one clause on a calm ticket with an empty retrieval', () => {
    // The shape the demonstration's knowledge-gap beat depends on: nothing else about the ticket is
    // wrong, so the only thing that fires is the gap.
    const { features } = triaged({ retrieval: { resultCount: 0 }, validation: { grounded: false } });
    const fired = evaluateEscalationClauses(features, NOW, THRESHOLDS).filter((outcome) => outcome.fired);
    assert.deepEqual(fired.map((outcome) => outcome.clause), ['draft_not_grounded']);
  });
});
