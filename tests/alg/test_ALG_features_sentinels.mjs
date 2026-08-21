// test_ALG_features_sentinels
//
// `QueueFeatures.severity` and `slaDueAt` are not nullable, and the rule still has to be evaluated
// on a ticket nothing has triaged — that is what the `NEW → ESCALATED` and
// `TRIAGE_FAILED → ESCALATED` edges are for. Two values stand in, and the claim this test makes is
// not that they are present but that **neither of them can cause a clause to fire**. A sentinel
// that escalated tickets by itself would be worse than a null: it would look like a decision.
//
// The third case is the one that would be easiest to get wrong and hardest to notice.
// `kbResultCount` MUST be null and never 0, because `effectiveGrounded` reads a count of zero as
// "the search ran and found nothing" and fires GROUND on it. A zero here would escalate every
// ticket in the system, correctly by the rule, for a retrieval that does not exist yet.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  effectiveConfidence,
  effectiveGrounded,
  evaluateEscalation,
  evaluateEscalationClauses,
  isPremiumHighSeverity,
} from '../../src/alg/escalation.ts';
import {
  NO_SLA_INSTANT,
  UNTRIAGED_SEVERITY,
  featuresFromTicket,
} from '../../src/alg/features.ts';
import { computePriority, isBreached, normalisedSeverity } from '../../src/alg/priority.ts';
import { NOW, T0, THRESHOLDS } from './fixtures.mjs';

/** The hardest case available: the highest tier, the highest band, and no triage at all. */
function untriaged(overrides = {}) {
  return featuresFromTicket({
    ticket: { id: 'T-000001', createdAt: T0, slaDueAt: null, language: 'en-AU', retries: 0 },
    account: { tier: 'premium', valueBand: 5 },
    triage: null,
    redactedBodyLength: null,
    policyFlags: [],
    ...overrides,
  });
}

describe('test_ALG_features_sentinels', () => {
  it('stands in for severity with the level that cannot reach the premium floor', () => {
    const { features } = untriaged();

    assert.equal(features.severity, UNTRIAGED_SEVERITY);
    assert.equal(features.severity, 1);
    assert.equal(normalisedSeverity(features.severity), 0.25);
    assert.ok(
      normalisedSeverity(features.severity) < THRESHOLDS.premiumSeverity,
      'the sentinel severity reaches the premium floor, so an untriaged premium ticket escalates on it',
    );
    assert.equal(isPremiumHighSeverity(features.tier, features.severity, THRESHOLDS.premiumSeverity), false);
  });

  it('stands in for the SLA instant with one that is never breached and never urgent', () => {
    const { features } = untriaged();

    assert.equal(features.slaDueAt, NO_SLA_INSTANT);
    assert.equal(features.slaDueAt, Number.POSITIVE_INFINITY);
    assert.equal(isBreached(features, NOW), false);

    // The arithmetic has to survive it too: elapsed / (∞ − createdAt) is 0, not NaN.
    const priority = computePriority(features, NOW);
    assert.equal(priority.components.urgency.normalised, 0);
    assert.ok(Number.isFinite(priority.score), 'the sentinel produced a score that is not a number');
    assert.ok(Number.isFinite(priority.storedScore));
    assert.deepEqual([...priority.anomalies], ['SENTIMENT_ABSENT']);
  });

  it('leaves the knowledge base null and never zero', () => {
    const { features } = untriaged();

    assert.equal(features.kbResultCount, null);
    assert.notEqual(features.kbResultCount, 0);
    assert.equal(features.grounded, null);

    // The clause is not evaluable, so it does not fire. With a zero it would fire on every ticket.
    assert.equal(effectiveGrounded(features), null);

    const withZero = { ...features, kbResultCount: 0 };
    assert.equal(
      effectiveGrounded(withZero),
      false,
      'a count of zero no longer means "the search ran and found nothing", so this sentinel has stopped mattering',
    );
  });

  it('leaves confidence and sentiment absent rather than assumed', () => {
    const { features, stored } = untriaged();

    assert.equal(stored, null);
    assert.equal(features.confidence, null);
    assert.equal(features.sentiment, null);
    assert.equal(effectiveConfidence(features, THRESHOLDS), null, 'an absent confidence was scored');
  });

  it('escalates an untriaged ticket for nothing at all', () => {
    const verdict = evaluateEscalation(untriaged().features, NOW, THRESHOLDS);
    assert.deepEqual(verdict, { escalate: false, reason: null, clause: null });
  });

  it('leaves only the record-stage clauses able to fire before triage', () => {
    // Every clause of the triage and draft stages must be unreachable on an untriaged ticket, over
    // the two account tiers and both ends of the retry budget. If one of them ever fires here, the
    // sentinels have stopped being sentinels, and this is where to find out.
    for (const tier of ['standard', 'premium']) {
      for (const valueBand of [1, 5]) {
        const { features } = featuresFromTicket({
          ticket: { id: 'T-1', createdAt: T0, slaDueAt: null, language: 'en', retries: 0 },
          account: { tier, valueBand },
          triage: null,
          redactedBodyLength: null,
          policyFlags: [],
        });

        for (const outcome of evaluateEscalationClauses(features, NOW, THRESHOLDS)) {
          assert.equal(
            outcome.fired,
            false,
            `${outcome.clause} fired on an untriaged ${tier} ticket in band ${valueBand}`,
          );
        }
      }
    }
  });

  it('reads a body emptied by redaction as zero confidence, which is not a sentinel', () => {
    // Zero here is a value with a meaning and must NOT be confused with the sentinels above:
    // nothing survived redaction, so there is nothing to be confident about.
    const { features } = untriaged({ redactedBodyLength: 0 });
    assert.equal(effectiveConfidence(features, THRESHOLDS), 0);

    const verdict = evaluateEscalation(features, NOW, THRESHOLDS);
    assert.equal(verdict.escalate, true);
    assert.equal(verdict.reason, 'CONF');
  });

  it('records what the account normalisation had to guess', () => {
    const { features, anomalies } = featuresFromTicket({
      ticket: { id: 'T-1', createdAt: T0, slaDueAt: null, language: 'en', retries: 0 },
      account: { tier: 'gold', valueBand: 9 },
      triage: null,
      redactedBodyLength: null,
      policyFlags: [],
    });

    assert.deepEqual([...anomalies], ['UNKNOWN_TIER', 'UNKNOWN_VALUE_BAND']);
    assert.equal(features.tier, 'standard', 'an unknown account did not default down');
    assert.equal(features.valueBand, 1);
  });
});
