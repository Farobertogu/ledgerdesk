/**
 * The published edge cases of the priority and escalation algorithms, one test per case.
 *
 * The list of cases is fixed and each row of it has exactly one test here, named after the row. Two
 * of the fourteen are heavy enough to live in their own files — the starvation property and the
 * agreement between the two readings of the order key — and they are named in the harness beside
 * this one. Nothing else was added to round the number up, and nothing was folded together to
 * bring it down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRIORITY_WEIGHTS,
  applyReopen,
  collapseDuplicates,
  compareQueueKeys,
  computePriority,
  dedupeDecision,
  dedupeKey,
  isBreached,
  normaliseAccount,
  normalisedNegativity,
  normalisedUrgency,
  orderQueue,
  queueKey,
} from '../../src/alg/priority.ts';
import {
  POLICY_FLAGS,
  effectiveConfidence,
  effectiveGrounded,
  evaluateEscalation,
  evaluateEscalationClauses,
} from '../../src/alg/escalation.ts';
import { perturb } from '../../src/alg/sensitivity.ts';
import { HOUR, MINUTE, DAY, T0, THRESHOLDS, escalationTicket, queueTicket } from './fixtures.mjs';

// 1 — exact tie in P: tiebreak by created_at, then id.
test('test_ALG_total_order_deterministic', () => {
  // Four tickets whose feature vectors differ in nothing that enters the score, so the four scores
  // are the same number and the whole decision falls to the two tiebreaks.
  const shared = { severity: 3, sentiment: -0.25, tier: 'premium', valueBand: 4 };
  const older = T0;
  const newer = T0 + HOUR;
  const now = T0 + 2 * HOUR;
  const window = 6 * HOUR;

  const tickets = [
    queueTicket({ ...shared, id: 'T-000004', createdAt: newer, slaDueAt: newer + window, now }),
    queueTicket({ ...shared, id: 'T-000002', createdAt: older, slaDueAt: older + window, now }),
    queueTicket({ ...shared, id: 'T-000003', createdAt: newer, slaDueAt: newer + window, now }),
    queueTicket({ ...shared, id: 'T-000001', createdAt: older, slaDueAt: older + window, now }),
  ];

  // The two older tickets do carry more urgency than the two newer ones, so the tie has to be
  // built where the specification puts it: among tickets whose scores are equal.
  const scores = tickets.map((ticket) => computePriority(ticket).storedScore);
  assert.equal(scores[0], scores[2], 'the two tickets created together must score identically');
  assert.equal(scores[1], scores[3], 'the two tickets created together must score identically');

  const order = orderQueue(tickets).map((ticket) => ticket.id);
  assert.deepEqual(order, ['T-000001', 'T-000002', 'T-000003', 'T-000004']);

  // Older before newer, and inside each creation instant, the smaller identifier first.
  assert.ok(
    compareQueueKeys(queueKey(tickets[3]), queueKey(tickets[1])) < 0,
    'the earlier identifier must win a tie on created_at',
  );

  // The order is total: no two distinct tickets compare equal, and it does not depend on the order
  // the tickets were handed over.
  for (const a of tickets) {
    for (const b of tickets) {
      const verdict = compareQueueKeys(queueKey(a), queueKey(b));
      if (a.id === b.id) assert.equal(verdict, 0);
      else assert.notEqual(verdict, 0, `${a.id} and ${b.id} compared equal`);
    }
  }
  assert.deepEqual(orderQueue([...tickets].reverse()).map((ticket) => ticket.id), order);
});

// 2 — SLA already breached on intake (retro import): breached at intake, never negative time.
test('test_ALG_breached_on_intake', () => {
  const intake = T0;
  const imported = queueTicket({
    id: 'T-IMPORTED',
    severity: 1,
    sentiment: 1,
    tier: 'standard',
    valueBand: 1,
    createdAt: intake - 3 * DAY,
    slaDueAt: intake - 2 * DAY,
    now: intake,
  });

  assert.equal(isBreached(imported), true, 'a ticket imported past its due instant is breached');

  const urgency = normalisedUrgency(imported);
  assert.equal(urgency.value, 1, 'the spent fraction is clamped at one, never above it');
  assert.deepEqual(urgency.anomalies, []);

  const breakdown = computePriority(imported);
  assert.equal(breakdown.breached, true);
  assert.ok(breakdown.score >= 0, 'no term may go negative on a retro import');
  assert.ok(breakdown.components.urgency.contribution >= 0);

  // It carries the lowest severity, the happiest sentiment and the smallest account, so its score
  // is below the fresh ticket's — and it is still served first, because breach outranks score.
  const fresh = queueTicket({
    id: 'T-FRESH',
    severity: 4,
    sentiment: -1,
    tier: 'premium',
    valueBand: 5,
    createdAt: intake,
    slaDueAt: intake + HOUR,
    now: intake,
  });
  assert.ok(computePriority(fresh).score > breakdown.score);
  assert.deepEqual(orderQueue([fresh, imported]).map((ticket) => ticket.id), ['T-IMPORTED', 'T-FRESH']);
});

// 3 — body empty after PII redaction: confidence 0, and the ticket escalates.
test('test_ALG_empty_after_redaction_escalates', () => {
  const emptied = escalationTicket({ redactedBodyLength: 0 });
  assert.equal(effectiveConfidence(emptied, THRESHOLDS), 0);

  const verdict = evaluateEscalation(emptied, THRESHOLDS);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.reason, 'CONF');
  assert.equal(verdict.clause, 'confidence_below_threshold');

  // The same holds when triage never reported a confidence at all: an empty body settles the
  // question on its own rather than waiting for a number that is not coming.
  const neverTriaged = escalationTicket({ redactedBodyLength: 0, confidence: null });
  assert.equal(effectiveConfidence(neverTriaged, THRESHOLDS), 0);
  assert.equal(evaluateEscalation(neverTriaged, THRESHOLDS).reason, 'CONF');

  // And a ticket whose redaction simply has not run yet is not escalated for it.
  const notRedactedYet = escalationTicket({ redactedBodyLength: null, confidence: null });
  assert.equal(effectiveConfidence(notRedactedYet, THRESHOLDS), null);
  assert.equal(evaluateEscalation(notRedactedYet, THRESHOLDS).escalate, false);
});

// 4 — non-English ticket, declared out of scope: reason LANG, no answer attempted.
test('test_ALG_non_english_escalates', () => {
  const spanish = escalationTicket({ language: 'es-CO' });
  const verdict = evaluateEscalation(spanish, THRESHOLDS);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.reason, 'LANG');
  assert.equal(verdict.clause, 'language_out_of_scope');

  // Regional variants of a supported language are supported.
  for (const language of ['en', 'en-AU', 'EN-GB', 'en-us']) {
    assert.equal(evaluateEscalation(escalationTicket({ language }), THRESHOLDS).escalate, false, language);
  }

  // "No answer attempted" is the point: the reason recorded is the language, not the low confidence
  // or the empty grounding that attempting an answer in a language nobody supports would produce.
  const attempted = escalationTicket({
    language: 'de-DE',
    confidence: 0.1,
    grounded: false,
    kbResultCount: 0,
  });
  assert.equal(evaluateEscalation(attempted, THRESHOLDS).reason, 'LANG');

  // An absent or blank tag is out of scope too, rather than quietly treated as English.
  assert.equal(evaluateEscalation(escalationTicket({ language: '   ' }), THRESHOLDS).reason, 'LANG');
});

// 5 — the knowledge base returns nothing: grounded is false, and no draft goes out without a source.
test('test_ALG_no_kb_context_escalates', () => {
  const empty = escalationTicket({ kbResultCount: 0 });
  assert.equal(effectiveGrounded(empty), false);

  const verdict = evaluateEscalation(empty, THRESHOLDS);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.reason, 'GROUND');
  assert.equal(verdict.clause, 'draft_not_grounded');

  // A retrieval that returned nothing settles grounding even when the validator claimed otherwise:
  // there is no source for a draft to be grounded in, whatever a later stage reports.
  const contradicted = escalationTicket({ kbResultCount: 0, grounded: true });
  assert.equal(effectiveGrounded(contradicted), false);
  assert.equal(evaluateEscalation(contradicted, THRESHOLDS).reason, 'GROUND');

  // A validator that has not run yet is not a validator that said no.
  const noDraftYet = escalationTicket({ kbResultCount: null, grounded: null });
  assert.equal(effectiveGrounded(noDraftYet), null);
  assert.equal(evaluateEscalation(noDraftYet, THRESHOLDS).escalate, false);
});

// 6 — created_at in the future (clock skew): urgency clamped to zero, anomaly recorded.
test('test_ALG_future_timestamp_clamped', () => {
  const skewed = queueTicket({
    createdAt: T0 + 2 * HOUR,
    slaDueAt: T0 + 6 * HOUR,
    now: T0,
  });

  const urgency = normalisedUrgency(skewed);
  assert.equal(urgency.value, 0, 'time spent is clamped at zero, never negative');
  assert.deepEqual(urgency.anomalies, ['FUTURE_CREATED_AT']);

  const breakdown = computePriority(skewed);
  assert.equal(breakdown.components.urgency.normalised, 0);
  assert.equal(breakdown.components.urgency.contribution, 0);
  assert.ok(breakdown.anomalies.includes('FUTURE_CREATED_AT'), 'the anomaly is recorded, not swallowed');
  assert.equal(breakdown.breached, false);

  // The skew is recorded and the rest of the score is unaffected: the other three terms are what
  // they would have been, so a skewed clock costs urgency and nothing else.
  const straight = queueTicket({ createdAt: T0, slaDueAt: T0 + 4 * HOUR, now: T0 });
  assert.equal(breakdown.components.severity.contribution, computePriority(straight).components.severity.contribution);
  assert.equal(breakdown.components.tier.contribution, computePriority(straight).components.tier.contribution);

  // A window that is not positive is a different anomaly, and it is not silently the same one.
  const inverted = queueTicket({ createdAt: T0, slaDueAt: T0 - HOUR, now: T0 });
  assert.deepEqual(normalisedUrgency(inverted).anomalies, ['NON_POSITIVE_SLA_WINDOW']);
});

// 7 — reopen: the SLA clock restarts, the retries are preserved.
test('test_ALG_reopen_resets_sla_keeps_retries', () => {
  const exhausted = escalationTicket({
    createdAt: T0,
    slaDueAt: T0 + 4 * HOUR,
    now: T0 + 9 * HOUR,
    retries: 3,
  });
  assert.equal(isBreached(exhausted), true);

  const reopenedAt = T0 + 10 * HOUR;
  const window = 4 * HOUR;
  const reopened = applyReopen(exhausted, reopenedAt, window);

  assert.equal(reopened.createdAt, reopenedAt, 'the clock restarts at the reopen instant');
  assert.equal(reopened.slaDueAt, reopenedAt + window);
  assert.equal(isBreached({ ...reopened, now: reopenedAt }), false, 'the reopened ticket is not born breached');
  assert.equal(normalisedUrgency({ ...reopened, now: reopenedAt }).value, 0);

  assert.equal(reopened.retries, 3, 'a reopen does not hand back a spent retry budget');
  assert.equal(evaluateEscalation(reopened, THRESHOLDS).reason, 'RETRY');

  // Nothing else about the ticket was touched.
  assert.equal(reopened.id, exhausted.id);
  assert.equal(reopened.severity, exhausted.severity);
  assert.equal(reopened.sentiment, exhausted.sentiment);
  assert.equal(reopened.tier, exhausted.tier);

  // A reopen with no window is a mistake, not a ticket that is due the instant it reopens.
  assert.throws(() => applyReopen(exhausted, reopenedAt, 0), RangeError);
});

// 8 — provider retry loop: strictly above the budget escalates, at the budget does not.
test('test_ALG_retry_budget_exhausted_escalates', () => {
  const spent = escalationTicket({ retries: THRESHOLDS.maxRetries + 1 });
  const verdict = evaluateEscalation(spent, THRESHOLDS);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.reason, 'RETRY');
  assert.equal(verdict.clause, 'retry_budget_exhausted');

  const atBudget = escalationTicket({ retries: THRESHOLDS.maxRetries });
  assert.equal(evaluateEscalation(atBudget, THRESHOLDS).escalate, false, 'the budget is spent above it, not at it');

  // The rule is a rule, not a constant: it moves with the budget it is given.
  const generous = { ...THRESHOLDS, maxRetries: THRESHOLDS.maxRetries + 5 };
  assert.equal(evaluateEscalation(spent, generous).escalate, false);
});

// 10 — unknown tier or orphan account: default to standard, and never suppress an escalation.
test('test_ALG_unknown_tier_defaults', () => {
  const unknown = normaliseAccount('gold', 9);
  assert.equal(unknown.tier, 'standard', 'an account nobody can identify is served as standard');
  assert.equal(unknown.valueBand, 1, 'and in the lowest band');
  assert.deepEqual(unknown.anomalies, ['UNKNOWN_TIER', 'UNKNOWN_VALUE_BAND']);

  const orphan = normaliseAccount(null, null);
  assert.equal(orphan.tier, 'standard');
  assert.deepEqual(orphan.anomalies, ['UNKNOWN_TIER', 'UNKNOWN_VALUE_BAND']);

  // A known account is passed through untouched and records nothing.
  const known = normaliseAccount('premium', 4);
  assert.deepEqual(known, { tier: 'premium', valueBand: 4, anomalies: [] });

  // The defaulting never suppresses an escalation. Each of these tickets trips a clause that has
  // nothing to do with the account; whatever the account resolves to, the ticket still escalates.
  const tripping = [
    escalationTicket({ confidence: 0.1 }),
    escalationTicket({ sentiment: -0.9 }),
    escalationTicket({ retries: 9 }),
    escalationTicket({ now: T0 + 9 * HOUR }),
    escalationTicket({ kbResultCount: 0 }),
    escalationTicket({ policyFlags: ['legal'] }),
    escalationTicket({ language: 'fr' }),
  ];
  for (const ticket of tripping) {
    for (const account of [normaliseAccount('gold', 9), normaliseAccount('premium', 5), normaliseAccount('standard', 1)]) {
      const verdict = evaluateEscalation({ ...ticket, tier: account.tier, valueBand: account.valueBand }, THRESHOLDS);
      assert.equal(verdict.escalate, true, `the account changed the verdict on ${verdict.clause ?? 'a quiet ticket'}`);
      assert.notEqual(verdict.reason, 'TIER', 'the account clause must not be the one reported here');
    }
  }
});

// 11 — null sentiment from the model: neutral in the queue, charged to confidence in the rule.
test('test_ALG_null_sentiment_penalises_confidence', () => {
  assert.equal(normalisedNegativity(null), 0.5, 'an unscored sentiment is neutral, not negative');
  assert.equal(normalisedNegativity(0), 0.5, 'and neutral is exactly what a zero sentiment gives');

  const unscored = queueTicket({ sentiment: null });
  const neutral = queueTicket({ sentiment: 0 });
  assert.equal(computePriority(unscored).score, computePriority(neutral).score);
  assert.ok(computePriority(unscored).anomalies.includes('SENTIMENT_ABSENT'));
  assert.equal(computePriority(neutral).anomalies.includes('SENTIMENT_ABSENT'), false);

  // The penalty is charged where it belongs. This confidence clears the threshold when the model
  // scored the sentiment, and does not clear it when the model declined to.
  const confidence = THRESHOLDS.confidence + THRESHOLDS.nullSentimentConfidencePenalty / 2;
  const scored = escalationTicket({ sentiment: 0, confidence });
  const missing = escalationTicket({ sentiment: null, confidence });

  assert.equal(effectiveConfidence(scored, THRESHOLDS), confidence);
  assert.equal(
    effectiveConfidence(missing, THRESHOLDS),
    confidence - THRESHOLDS.nullSentimentConfidencePenalty,
  );
  assert.equal(evaluateEscalation(scored, THRESHOLDS).escalate, false);
  assert.equal(evaluateEscalation(missing, THRESHOLDS).reason, 'CONF');

  // The sentiment clause itself cannot fire on a value that does not exist.
  const clauses = evaluateEscalationClauses(escalationTicket({ sentiment: null }), THRESHOLDS);
  assert.equal(clauses.find((outcome) => outcome.reason === 'SENT').fired, false);

  // The penalty never pushes confidence below zero.
  assert.equal(
    effectiveConfidence(escalationTicket({ sentiment: null, confidence: 0.05 }), THRESHOLDS),
    0,
  );
});

// 12 — duplicate submission inside five minutes: one key, one queue entry.
test('test_ALG_duplicate_collapsed', () => {
  const window = 5 * MINUTE;
  const body = 'b3a1c0de'.repeat(8);
  const submissions = [
    { id: 'T-000001', orgId: 'org-a', bodySha256: body, createdAt: T0 },
    { id: 'T-000002', orgId: 'org-a', bodySha256: body, createdAt: T0 + 30 * 1000 },
    { id: 'T-000003', orgId: 'org-a', bodySha256: body, createdAt: T0 + 90 * 1000 },
    { id: 'T-000004', orgId: 'org-a', bodySha256: body, createdAt: T0 + 4 * MINUTE },
  ];

  const keys = new Set(submissions.map((s) => dedupeKey(s.orgId, s.bodySha256)));
  assert.equal(keys.size, 1, 'the same body from the same tenant is one key');

  const collapsed = collapseDuplicates(submissions, window);
  assert.deepEqual(collapsed.admitted.map((s) => s.id), ['T-000001']);
  assert.deepEqual(collapsed.collapsed.map((s) => s.submission.id), ['T-000002', 'T-000003', 'T-000004']);
  for (const entry of collapsed.collapsed) assert.equal(entry.into, 'T-000001');

  // One queue entry, which is what the case is about.
  const queue = orderQueue(collapsed.admitted.map((s) => queueTicket({ id: s.id, createdAt: s.createdAt })));
  assert.equal(queue.length, 1);

  // The window is measured from the entry that holds the key, so a run of duplicates cannot walk
  // it forward: the same complaint raised the next morning is a new fact and gets its own row.
  const later = { id: 'T-000005', orgId: 'org-a', bodySha256: body, createdAt: T0 + 6 * MINUTE };
  assert.equal(dedupeDecision(later, submissions[0], window).collapse, false);
  const withLater = collapseDuplicates([...submissions, later], window);
  assert.deepEqual(withLater.admitted.map((s) => s.id), ['T-000001', 'T-000005']);

  // Two tenants that submit the same words are two tickets. The key carries the tenant.
  const otherTenant = { id: 'T-000006', orgId: 'org-b', bodySha256: body, createdAt: T0 + 30 * 1000 };
  const across = collapseDuplicates([submissions[0], otherTenant], window);
  assert.deepEqual(across.admitted.map((s) => s.id), ['T-000001', 'T-000006']);
});

// 13 — prompt injection in the body: the policy list escalates it, and nothing is sent automatically.
test('test_SEC_prompt_injection_escalates', () => {
  const injected = escalationTicket({ policyFlags: ['injection'] });
  const verdict = evaluateEscalation(injected, THRESHOLDS);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.reason, 'POLICY');
  assert.equal(verdict.clause, 'policy_flag_raised');

  // Every member of the auditable list escalates, and each is reported under the same reason: the
  // channel carries one index from a closed set, never the text that earned the flag.
  for (const flag of POLICY_FLAGS) {
    const flagged = escalationTicket({ policyFlags: [flag] });
    assert.equal(evaluateEscalation(flagged, THRESHOLDS).reason, 'POLICY', flag);
  }

  // An injected body that a confident model was perfectly happy with still escalates. This is the
  // case the clause exists for: the model's own opinion of the ticket is not consulted.
  const confident = escalationTicket({
    policyFlags: ['injection'],
    confidence: 1,
    sentiment: 1,
    grounded: true,
    kbResultCount: 5,
  });
  assert.equal(evaluateEscalation(confident, THRESHOLDS).escalate, true);
  assert.equal(evaluateEscalation(confident, THRESHOLDS).reason, 'POLICY');

  // And an unflagged ticket is not escalated by this clause on suspicion.
  assert.equal(
    evaluateEscalationClauses(escalationTicket(), THRESHOLDS).find((o) => o.reason === 'POLICY').fired,
    false,
  );
});

test('test_ALG_weights_must_be_a_distribution', () => {
  // Not one of the published cases: the guard that keeps the published weights and the weights in
  // force from ever being two different things.
  assert.doesNotThrow(() => computePriority(queueTicket(), DEFAULT_PRIORITY_WEIGHTS));
  assert.throws(
    () => computePriority(queueTicket(), { severity: 0.5, negativity: 0.25, urgency: 0.3, tier: 0.1 }),
    RangeError,
  );
  assert.throws(
    () => computePriority(queueTicket(), { severity: -0.1, negativity: 0.4, urgency: 0.6, tier: 0.1 }),
    RangeError,
  );

  // Every component of the score is a share of it, and the four shares are the whole of it.
  const breakdown = computePriority(queueTicket({ severity: 4, sentiment: -0.4, tier: 'premium', valueBand: 5 }));
  const sum = Object.values(breakdown.components).reduce((total, part) => total + part.contribution, 0);
  assert.ok(Math.abs(sum - breakdown.score) < 1e-12, 'the breakdown must account for the whole score');
  assert.ok(breakdown.score >= 0 && breakdown.score <= 1, 'the score stays inside [0,1]');
  for (const part of Object.values(breakdown.components)) {
    assert.ok(part.normalised >= 0 && part.normalised <= 1, 'every term is normalised');
  }

  // Every configuration the sensitivity report publishes is a distribution that sums to one *as
  // printed*, and moves the weight its row names by exactly the amount its row claims. A reader
  // must be able to add up a row and get one; if they cannot, the row is not evidence.
  for (const name of ['severity', 'negativity', 'urgency', 'tier']) {
    for (const delta of [-0.1, -0.05, 0.05, 0.1]) {
      const weights = perturb(DEFAULT_PRIORITY_WEIGHTS, name, delta);
      assert.ok(weights !== null, `${name} ${delta} produced no configuration`);
      assert.doesNotThrow(() => computePriority(queueTicket(), weights));

      const printed = Object.values(weights).map((weight) => Number(weight.toFixed(2)));
      const sum = printed.reduce((total, weight) => total + weight, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${name} ${delta} printed as ${printed.join(' + ')} = ${sum}`);
      assert.equal(
        Number(weights[name].toFixed(2)),
        Number((DEFAULT_PRIORITY_WEIGHTS[name] + delta).toFixed(2)),
        `${name} ${delta} did not move the weight its row names`,
      );
    }
  }
});
