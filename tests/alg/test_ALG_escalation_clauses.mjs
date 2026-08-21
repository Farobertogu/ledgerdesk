/**
 * The escalation rule itself: the closed alphabet, the eight clauses, and the two properties that
 * make the stored reason worth anything — that each clause fires under its own reason and only its
 * own, and that the clause reported is a function of the features rather than of evaluation order.
 *
 * The combination tests are exhaustive rather than sampled. Eight clauses have 256 combinations,
 * which is small enough to enumerate, and enumerating them is the difference between "we tried
 * some cases" and "there is no case".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCALATION_CLAUSES,
  ESCALATION_REASONS,
  clauseByName,
  evaluateEscalation,
  evaluateEscalationClauses,
  isEscalationReason,
  isSupportedLanguage,
} from '../../src/alg/escalation.ts';
import { HOUR, T0, THRESHOLDS, escalationTicket } from './fixtures.mjs';

/**
 * One field change per clause, each chosen to trip that clause and nothing else.
 *
 * They are independent by construction — no two of them touch the same field, and none of them
 * disturbs a threshold another clause reads — which is what makes the exhaustive combination below
 * a test of the rule rather than of the fixture.
 */
const TRIPS = {
  language_out_of_scope: { language: 'pt-BR' },
  policy_flag_raised: { policyFlags: ['refund'] },
  sla_breached: { now: T0 + 5 * HOUR },
  retry_budget_exhausted: { retries: THRESHOLDS.maxRetries + 1 },
  confidence_below_threshold: { confidence: THRESHOLDS.confidence - 0.01 },
  sentiment_at_or_below_threshold: { sentiment: THRESHOLDS.sentiment },
  premium_high_severity: { tier: 'premium', severity: 3 },
  draft_not_grounded: { grounded: false },
};

const CLAUSE_NAMES = ESCALATION_CLAUSES.map((clause) => clause.name);

test('test_ALG_escalation_alphabet_is_closed', () => {
  assert.equal(ESCALATION_REASONS.length, 8, 'the alphabet has eight indices');
  assert.equal(new Set(ESCALATION_REASONS).size, 8, 'and no repetitions');
  assert.deepEqual([...ESCALATION_REASONS].sort(), ['CONF', 'GROUND', 'LANG', 'POLICY', 'RETRY', 'SENT', 'SLA', 'TIER']);

  for (const reason of ESCALATION_REASONS) assert.equal(isEscalationReason(reason), true);
  for (const outsider of ['INCONSIST', 'OTHER', '', 'conf', null, 3]) {
    assert.equal(isEscalationReason(outsider), false, `'${String(outsider)}' is not in the alphabet`);
  }

  // Every reason has exactly one clause and every clause has exactly one reason, so a stored reason
  // identifies the predicate that produced it without any further lookup.
  assert.equal(ESCALATION_CLAUSES.length, 8);
  assert.deepEqual([...ESCALATION_CLAUSES.map((clause) => clause.reason)].sort(), [...ESCALATION_REASONS].sort());
  assert.equal(new Set(CLAUSE_NAMES).size, 8, 'clause names are unique');

  for (const clause of ESCALATION_CLAUSES) {
    assert.equal(isEscalationReason(clause.reason), true);
    assert.match(clause.name, /^[a-z][a-z_]+$/, 'a clause name is a stable identifier, not prose');
    assert.ok(clause.statement.length > 10, `${clause.name} must carry a statement a person can read`);
    assert.equal(clauseByName(clause.name), clause);
  }
  assert.equal(clauseByName('no_such_clause'), undefined);
});

test('test_ALG_escalation_quiet_ticket_does_not_escalate', () => {
  const verdict = evaluateEscalation(escalationTicket(), THRESHOLDS);
  assert.deepEqual(verdict, { escalate: false, reason: null, clause: null });

  const outcomes = evaluateEscalationClauses(escalationTicket(), THRESHOLDS);
  assert.equal(outcomes.length, 8);
  assert.deepEqual(outcomes.filter((outcome) => outcome.fired), []);
});

test('test_ALG_escalation_each_clause_fires_with_its_own_reason', () => {
  assert.deepEqual(Object.keys(TRIPS).sort(), [...CLAUSE_NAMES].sort(), 'every clause has a case here');

  for (const clause of ESCALATION_CLAUSES) {
    const ticket = escalationTicket(TRIPS[clause.name]);
    const verdict = evaluateEscalation(ticket, THRESHOLDS);

    assert.equal(verdict.escalate, true, `${clause.name} did not fire on its own case`);
    assert.equal(verdict.reason, clause.reason, `${clause.name} reported the wrong reason`);
    assert.equal(verdict.clause, clause.name);

    const fired = evaluateEscalationClauses(ticket, THRESHOLDS).filter((outcome) => outcome.fired);
    assert.deepEqual(
      fired.map((outcome) => outcome.clause),
      [clause.name],
      `${clause.name}'s case tripped another clause as well`,
    );
  }
});

test('test_ALG_escalation_reports_the_first_clause_in_the_published_order', () => {
  // All 256 combinations of the eight cases. For each, the set of clauses that fire must be exactly
  // the set that was tripped, and the clause reported must be the earliest of them in the published
  // order — a function of the features, never of which predicate happened to be evaluated first.
  let combinations = 0;
  for (let mask = 0; mask < 1 << CLAUSE_NAMES.length; mask++) {
    const tripped = CLAUSE_NAMES.filter((_, index) => (mask & (1 << index)) !== 0);
    const ticket = escalationTicket(Object.assign({}, ...tripped.map((name) => TRIPS[name])));

    const fired = evaluateEscalationClauses(ticket, THRESHOLDS)
      .filter((outcome) => outcome.fired)
      .map((outcome) => outcome.clause);
    assert.deepEqual(
      [...fired].sort(),
      [...tripped].sort(),
      `the clauses that fired were not the ones tripped (mask ${mask})`,
    );

    const verdict = evaluateEscalation(ticket, THRESHOLDS);
    if (tripped.length === 0) {
      assert.deepEqual(verdict, { escalate: false, reason: null, clause: null });
    } else {
      const expected = ESCALATION_CLAUSES.find((clause) => tripped.includes(clause.name));
      assert.equal(verdict.escalate, true);
      assert.equal(verdict.clause, expected.name, `mask ${mask} reported the wrong clause`);
      assert.equal(verdict.reason, expected.reason);
      assert.equal(clauseByName(verdict.clause).reason, verdict.reason);
    }
    combinations++;
  }
  assert.equal(combinations, 256);
});

test('test_ALG_escalation_is_monotone_in_its_clauses', () => {
  // The rule is a disjunction, so tripping one more clause can never call a ticket back. This is
  // the property that lets the evaluator stop at the first clause that fires: there is nothing
  // further down the list that could have overruled it.
  for (let mask = 0; mask < 1 << CLAUSE_NAMES.length; mask++) {
    const tripped = CLAUSE_NAMES.filter((_, index) => (mask & (1 << index)) !== 0);
    const before = evaluateEscalation(
      escalationTicket(Object.assign({}, ...tripped.map((name) => TRIPS[name]))),
      THRESHOLDS,
    );
    if (!before.escalate) continue;

    for (const extra of CLAUSE_NAMES) {
      if (tripped.includes(extra)) continue;
      const after = evaluateEscalation(
        escalationTicket(Object.assign({}, ...[...tripped, extra].map((name) => TRIPS[name]))),
        THRESHOLDS,
      );
      assert.equal(after.escalate, true, `adding ${extra} to {${tripped.join(', ')}} cancelled the escalation`);
    }
  }
});

test('test_ALG_escalation_account_never_suppresses', () => {
  // The account is allowed to raise an escalation and never to hold one back. Every combination
  // that trips at least one clause other than the account's own must escalate under every account
  // the system can resolve, including the one it resolves for an account it cannot identify.
  const accounts = [
    { tier: 'standard', valueBand: 1 },
    { tier: 'standard', valueBand: 5 },
    { tier: 'premium', valueBand: 1 },
    { tier: 'premium', valueBand: 5 },
  ];

  for (let mask = 1; mask < 1 << CLAUSE_NAMES.length; mask++) {
    const tripped = CLAUSE_NAMES.filter((_, index) => (mask & (1 << index)) !== 0);
    const others = tripped.filter((name) => name !== 'premium_high_severity');
    if (others.length === 0) continue;

    for (const account of accounts) {
      const ticket = escalationTicket({
        ...Object.assign({}, ...others.map((name) => TRIPS[name])),
        ...account,
      });
      const verdict = evaluateEscalation(ticket, THRESHOLDS);
      assert.equal(
        verdict.escalate,
        true,
        `a ${account.tier} account in band ${account.valueBand} suppressed {${others.join(', ')}}`,
      );
    }
  }
});

test('test_ALG_escalation_thresholds_are_parameters_not_constants', () => {
  // A rule whose verdict does not move with its thresholds is a constant wearing a rule's clothes.
  const ticket = escalationTicket({ confidence: 0.6, sentiment: -0.4, retries: 2 });

  assert.equal(evaluateEscalation(ticket, { ...THRESHOLDS, confidence: 0.5 }).escalate, false);
  assert.equal(evaluateEscalation(ticket, { ...THRESHOLDS, confidence: 0.7 }).reason, 'CONF');

  assert.equal(evaluateEscalation(ticket, { ...THRESHOLDS, confidence: 0.5, sentiment: -0.5 }).escalate, false);
  assert.equal(evaluateEscalation(ticket, { ...THRESHOLDS, confidence: 0.5, sentiment: -0.3 }).reason, 'SENT');

  assert.equal(evaluateEscalation(ticket, { ...THRESHOLDS, confidence: 0.5, maxRetries: 2 }).escalate, false);
  assert.equal(evaluateEscalation(ticket, { ...THRESHOLDS, confidence: 0.5, maxRetries: 1 }).reason, 'RETRY');

  // The supported set is a parameter too, and the match is on the primary subtag.
  assert.equal(isSupportedLanguage('es-CO', ['en']), false);
  assert.equal(isSupportedLanguage('es-CO', ['en', 'es']), true);
  assert.equal(isSupportedLanguage('ES', ['es']), true);
  assert.equal(
    evaluateEscalation(escalationTicket({ language: 'es-CO' }), { ...THRESHOLDS, supportedLanguages: ['en', 'es'] })
      .escalate,
    false,
  );
});
