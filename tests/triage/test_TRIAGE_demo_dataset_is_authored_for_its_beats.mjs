// test_TRIAGE_demo_dataset_is_authored_for_its_beats
//
// Each ticket of the frozen demonstration dataset declares the escalation code it was written to
// produce. This runs the published rule over it and checks that the code which survives the
// precedence is the one it names.
//
// The reason this is a test and not a rehearsal note: the intra-stage precedence is CONF, SENT,
// TIER, and the ticket written to demonstrate SENT is on a premium account at severity 3 — which
// satisfies TIER as well. Which of the two is stored depends on an authored confidence staying
// above the floor. Nudge that number, or move the floor when the calibration lands, and the ticket
// still escalates, still looks right on screen, and reports the wrong reason to the room. The rule
// is the thing that changes underneath a frozen dataset, and this is where that gets caught.
//
// It also checks the fixtures the dataset carries: each authored answer must survive the strict
// validator, and each phrase must select exactly one ticket. A fixture that matched two bodies
// would serve one ticket's verdict to another, and a fixture that matched none would leave its
// ticket to the derived answer — which is valid, deterministic, and not what anybody authored.
//
// The account facts are TRANSCRIBED from seed/orgs.sql rather than read from it. The dataset names
// account identifiers; what tier those accounts hold is the seed's statement, and a test that
// derived it from the same file it is checking would be asking the seed whether it agrees with
// itself.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseTriageEnvelope } from '../../agents/triage/envelope.ts';
import { renderTriageEnvelope, TRIAGE_FIXTURE_MARKERS } from '../../agents/providers/triage_fixture.ts';
import {
  CLAUSE_STAGE,
  DEFAULT_ESCALATION_THRESHOLDS,
  evaluateEscalation,
} from '../../src/alg/escalation.ts';
import { featuresFromTicket } from '../../src/alg/features.ts';
import { matchPolicyFlags, policyInput } from '../../src/alg/policy.ts';

const DATASET = JSON.parse(readFileSync('seed/demo_tickets.json', 'utf8'));

/** seed/orgs.sql, §account. */
const ACCOUNTS = {
  '1acc0000-0000-4000-8000-000000000001': { tier: 'standard', valueBand: 3 },
  '2acc0000-0000-4000-8000-000000000001': { tier: 'premium', valueBand: 5 },
};

/** seed/orgs.sql, §sla_policy — first_response_minutes by tier and severity. */
const FIRST_RESPONSE_MINUTES = {
  standard: { 1: 480, 2: 240, 3: 120, 4: 60 },
  premium: { 1: 120, 2: 60, 3: 30, 4: 15 },
};

/** The demonstration is run on a freshly stamped ticket, a minute after it lands. */
const CREATED_AT = Date.UTC(2026, 7, 22, 9, 0, 0);
const NOW = CREATED_AT + 60_000;

const THRESHOLDS = DEFAULT_ESCALATION_THRESHOLDS;

function fixtureFor(body) {
  return DATASET.triage_fixtures.filter((entry) => body.includes(entry.match));
}

function recordStage(ticket) {
  return featuresFromTicket({
    ticket: {
      id: ticket.id,
      createdAt: CREATED_AT,
      // The loader leaves it unset: the policy is chosen from the severity triage assigns.
      slaDueAt: null,
      language: ticket.language,
      retries: 0,
    },
    account: ACCOUNTS[ticket.account_id],
    triage: null,
    redactedBodyLength: null,
    policyFlags: matchPolicyFlags(policyInput(ticket.subject, ticket.body)),
  });
}

describe('test_TRIAGE_demo_dataset_is_authored_for_its_beats', () => {
  it('names an account the seed actually holds, for every ticket', () => {
    assert.ok(DATASET.tickets.length > 0, 'the dataset carries no tickets');
    for (const ticket of DATASET.tickets) {
      assert.ok(ACCOUNTS[ticket.account_id], `${ticket.id} names an account the seed does not hold`);
      assert.ok(ticket.subject && ticket.body, `${ticket.id} is missing its text`);
      assert.ok(ticket.intended, `${ticket.id} declares no intended outcome`);
    }
  });

  it('gives every beat two tickets, so a rehearsal has a second attempt', () => {
    const beats = new Map();
    for (const ticket of DATASET.tickets) {
      const variants = beats.get(ticket.beat) ?? new Set();
      assert.ok(!variants.has(ticket.variant), `${ticket.beat} has two ${ticket.variant} variants`);
      variants.add(ticket.variant);
      beats.set(ticket.beat, variants);
    }
    for (const [beat, variants] of beats) {
      assert.deepEqual([...variants].sort(), ['A', 'B'], `${beat} does not have an A and a B`);
    }
  });

  it('gives every ticket a distinct body, so no two share a cache key', () => {
    const bodies = new Set(DATASET.tickets.map((ticket) => ticket.body));
    assert.equal(bodies.size, DATASET.tickets.length, 'two demonstration tickets carry the same words');

    const ids = new Set(DATASET.tickets.map((ticket) => ticket.id));
    assert.equal(ids.size, DATASET.tickets.length);

    const keys = new Set(DATASET.tickets.map((ticket) => ticket.dedupe_key));
    assert.equal(keys.size, DATASET.tickets.length, 'two tickets share a dedupe key and cannot both be loaded');
  });

  it('carries no test marker in any demonstration body', () => {
    for (const ticket of DATASET.tickets) {
      for (const marker of TRIAGE_FIXTURE_MARKERS) {
        const text = `${ticket.subject}\n${ticket.body}`;
        assert.ok(
          !text.includes(marker.match),
          `${ticket.id} contains ${marker.match}, so a test fixture would answer for it`,
        );
      }
    }
  });

  it('selects exactly one ticket with each authored phrase', () => {
    for (const entry of DATASET.triage_fixtures) {
      const matched = DATASET.tickets.filter((ticket) => ticket.body.includes(entry.match));
      assert.equal(
        matched.length,
        1,
        `'${entry.match}' matches ${matched.length} bodies; it must select exactly one`,
      );
    }
  });

  it('produces a valid envelope from every authored answer', () => {
    for (const entry of DATASET.triage_fixtures) {
      assert.ok(entry.answer.verdict, `'${entry.match}' authors no verdict`);
      const envelope = parseTriageEnvelope(renderTriageEnvelope(entry.answer.verdict));
      assert.equal(envelope.agent, 'triage');
      assert.equal(envelope.confidence, entry.answer.verdict.confidence);
      assert.equal(envelope.triage.severity, entry.answer.verdict.severity);
    }
  });

  it('escalates the record-stage tickets before any model is asked', () => {
    const atRecord = DATASET.tickets.filter(
      (ticket) => ticket.intended.reason !== null && CLAUSE_STAGE[ticket.intended.clause] === 'record',
    );
    assert.ok(atRecord.length > 0, 'no ticket demonstrates an escalation that costs nothing');

    for (const ticket of atRecord) {
      const verdict = evaluateEscalation(recordStage(ticket).features, NOW, THRESHOLDS);
      assert.equal(verdict.escalate, true, `${ticket.id} was written to escalate at the record stage`);
      assert.equal(verdict.reason, ticket.intended.reason, `${ticket.id} escalates under the wrong code`);
      assert.equal(verdict.clause, ticket.intended.clause);

      assert.equal(
        fixtureFor(ticket.body).length,
        0,
        `${ticket.id} escalates before any call, so an authored answer for it would never be used`,
      );
    }
  });

  it('reaches the model for every other ticket, and lands where it says it will', () => {
    const atTriage = DATASET.tickets.filter(
      (ticket) => ticket.intended.reason === null || CLAUSE_STAGE[ticket.intended.clause] !== 'record',
    );
    assert.ok(atTriage.length > 0, 'no ticket demonstrates a triage');

    for (const ticket of atTriage) {
      // Nothing may fire before the call, or the call never happens.
      const before = evaluateEscalation(recordStage(ticket).features, NOW, THRESHOLDS);
      assert.equal(
        before.escalate,
        false,
        `${ticket.id} escalates at the record stage (${before.reason}), so the model is never asked`,
      );

      const matched = fixtureFor(ticket.body);
      assert.equal(matched.length, 1, `${ticket.id} has ${matched.length} authored answers; it needs one`);
      const envelope = parseTriageEnvelope(renderTriageEnvelope(matched[0].answer.verdict));

      const account = ACCOUNTS[ticket.account_id];
      const minutes = FIRST_RESPONSE_MINUTES[account.tier][envelope.triage.severity];
      assert.ok(minutes, `no SLA policy is seeded for ${account.tier} at severity ${envelope.triage.severity}`);

      const { features } = featuresFromTicket({
        ticket: {
          id: ticket.id,
          createdAt: CREATED_AT,
          slaDueAt: CREATED_AT + minutes * 60_000,
          language: ticket.language,
          retries: 0,
        },
        account,
        triage: {
          category: envelope.triage.category,
          severity: envelope.triage.severity,
          sentiment: envelope.triage.sentiment,
          confidence: envelope.confidence,
        },
        redactedBodyLength: ticket.body.length,
        policyFlags: matchPolicyFlags(policyInput(ticket.subject, ticket.body)),
      });

      const verdict = evaluateEscalation(features, NOW, THRESHOLDS);
      assert.equal(
        verdict.reason,
        ticket.intended.reason,
        `${ticket.id} was authored for ${ticket.intended.reason} and the rule answers ${verdict.reason}`,
      );
      assert.equal(verdict.clause, ticket.intended.clause);
      assert.equal(verdict.escalate, ticket.intended.reason !== null);
    }
  });
});
