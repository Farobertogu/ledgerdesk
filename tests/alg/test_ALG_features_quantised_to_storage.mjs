// test_ALG_features_quantised_to_storage
//
// The claim: the value the rule judges and the value the column stores are the SAME value.
//
// It is worth stating why that is not automatic. A model answers with a full-precision number; the
// column is `numeric(4,3)`. If the rule judged the model's number and the database then rounded
// it, an auditor re-running the decision from the stored columns could reach the opposite verdict
// — with every input identical and no bug anywhere to point at. So the adapter quantises FIRST and
// stores exactly what it judged.
//
// Two cases are chosen because each flips a clause in a different direction:
//
//   · confidence 0.6995 — judged raw it is below the 0.700 floor and CONF fires; quantised to
//     0.700 it is not below the floor and CONF does not. Storage is the one that decides.
//   · sentiment −0.4996 — judged raw it is above the −0.500 threshold and SENT does not fire;
//     quantised to −0.500 it is at the threshold and SENT does. Storage decides again, the other
//     way.
//
// The thresholds are the fixtures', which differ from every published default on purpose: a test
// that only demonstrated this at one calibration would be demonstrating the calibration.
//
// And the rounding itself: half AWAY from zero, symmetric about zero. `Math.round` is neither —
// it rounds −0.5 towards +∞ — and sentiment is the field that is routinely negative and whose
// comparison is `≤`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateEscalation } from '../../src/alg/escalation.ts';
import { featuresFromTicket, formatStored, quantiseStored } from '../../src/alg/features.ts';
import { NOW, T0, HOUR, THRESHOLDS } from './fixtures.mjs';

const account = { tier: 'standard', valueBand: 3 };

function ticketFacts(overrides = {}) {
  return {
    id: 'T-000001',
    createdAt: T0,
    slaDueAt: T0 + 4 * HOUR,
    language: 'en-AU',
    retries: 0,
    ...overrides,
  };
}

function build(triage) {
  return featuresFromTicket({
    ticket: ticketFacts(),
    account,
    triage,
    redactedBodyLength: 120,
    policyFlags: [],
  });
}

describe('test_ALG_features_quantised_to_storage', () => {
  it('judges the stored confidence, not the reported one', () => {
    const reported = 0.6995;
    const { features, stored } = build({
      category: 'billing',
      severity: 2,
      sentiment: 0,
      confidence: reported,
    });

    assert.equal(stored.confidence, 0.7, '0.6995 must quantise to 0.700');
    assert.equal(features.confidence, stored.confidence, 'the rule saw a different number than storage keeps');
    assert.equal(formatStored(reported), '0.700');

    // Raw, the clause fires; stored, it does not. That difference is the whole point of the test.
    assert.equal(reported < THRESHOLDS.confidence, true, 'the raw value is below the floor');
    const verdict = evaluateEscalation(features, NOW, THRESHOLDS);
    assert.equal(verdict.escalate, false, 'the ticket escalated on a confidence that is not stored');
  });

  it('judges the stored sentiment, not the reported one', () => {
    const reported = -0.4996;
    const { features, stored } = build({
      category: 'billing',
      severity: 2,
      sentiment: reported,
      confidence: 0.9,
    });

    assert.equal(stored.sentiment, -0.5, '−0.4996 must quantise to −0.500');
    assert.equal(features.sentiment, stored.sentiment);
    assert.equal(formatStored(reported), '-0.500');

    // Raw, the clause does not fire; stored, it does.
    assert.equal(reported <= THRESHOLDS.sentiment, false, 'the raw value is above the threshold');
    const verdict = evaluateEscalation(features, NOW, THRESHOLDS);
    assert.equal(verdict.escalate, true);
    assert.equal(verdict.reason, 'SENT');
    assert.equal(verdict.clause, 'sentiment_at_or_below_threshold');
  });

  it('rounds half away from zero, symmetrically', () => {
    assert.equal(quantiseStored(0.0005), 0.001);
    assert.equal(quantiseStored(-0.0005), -0.001, 'Math.round would answer 0 here');
    assert.equal(quantiseStored(0.5995), 0.6);
    assert.equal(quantiseStored(-0.5995), -0.6);

    for (const value of [0, 0.0005, 0.4445, 0.5, 0.7495, 0.999, 1]) {
      const positive = quantiseStored(value);
      const negative = quantiseStored(-value);
      assert.equal(
        negative,
        positive === 0 ? 0 : -positive,
        `the rounding is not symmetric at ${value}`,
      );
    }
  });

  it('renders at the scale the column declares', () => {
    assert.equal(formatStored(0.75), '0.750');
    assert.equal(formatStored(0), '0.000');
    // A value that rounds to zero from below is stored as zero, not as a negative zero: the two
    // are the same number to the column and should be the same string on the way in.
    assert.equal(formatStored(-0.0004), '0.000');
    assert.equal(formatStored(1), '1.000');
    assert.equal(formatStored(-1), '-1.000');
  });

  it('refuses a value that is not a number', () => {
    assert.throws(() => quantiseStored(Number.NaN), RangeError);
    assert.throws(() => quantiseStored(Number.POSITIVE_INFINITY), RangeError);
  });

  it('quantises once: the stored value is already fixed', () => {
    const { stored } = build({ category: 'billing', severity: 2, sentiment: -0.4996, confidence: 0.6995 });
    assert.equal(quantiseStored(stored.sentiment), stored.sentiment);
    assert.equal(quantiseStored(stored.confidence), stored.confidence);
  });
});
