// test_TRIAGE_demo_dataset_is_authored_for_its_beats
//
// Each ticket of the frozen demonstration dataset declares the escalation code it was written to
// produce and what the retrieval is expected to return for it. This runs the published rule over
// every ticket, at every stage it passes through, and checks that the code which survives the
// precedence is the one it names.
//
// **It evaluates the COMPLETE rule of eight clauses.** Evaluating seven of them was enough while
// nothing in the system could produce the eighth: `draft_not_grounded` reads a field that was
// hard-wired to null, so a test that never supplied one was testing everything that could happen.
// A retrieval exists now. A test that went on evaluating seven clauses would stay green while the
// demonstration produced a different verdict in front of the people it was written for, which is
// precisely the failure this file was created to prevent — one stage later.
//
// The three stages are evaluated in the order a ticket meets them, and each transition between them
// is itself an assertion:
//
//   · the RECORD stage, from the ticket's own row — a ticket that escalates here never reaches a
//     model, so an authored answer for it would be an answer nobody ever asks for;
//   · the TRIAGE stage, from the authored envelope — a ticket that escalates here never reaches the
//     retrieval, so its declared retrieval expectation is null;
//   · the DRAFT stage, from the declared retrieval and the grounding it implies.
//
// It also checks the fixtures the dataset carries: each authored answer must survive the strict
// validator, each phrase must select exactly one ticket, and each phrase must survive the redactor
// unchanged. That last one is the newest and the least obvious. The message a fixture matches
// against now carries the knowledge-base excerpts as well as the enquiry, and both halves have been
// through the redactor — so a phrase containing anything the redactor removes would be a phrase
// that never matches, and a fixture that silently stops matching falls back to the derived answer,
// which is valid, deterministic, and not what anybody authored.
//
// The account facts are TRANSCRIBED from seed/orgs.sql rather than read from it. The dataset names
// account identifiers; what tier those accounts hold is the seed's statement, and a test that
// derived it from the same file it is checking would be asking the seed whether it agrees with
// itself.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseDraftEnvelope } from '../../agents/draft/envelope.ts';
import { parseTriageEnvelope } from '../../agents/triage/envelope.ts';
import { redact } from '../../agents/redaction.ts';
import { renderDraftEnvelope } from '../../agents/providers/draft_fixture.ts';
import { renderTriageEnvelope, TRIAGE_FIXTURE_MARKERS } from '../../agents/providers/triage_fixture.ts';
import { EXCERPT_MAX } from '../../agents/triage/schema.ts';
import {
  CLAUSE_STAGE,
  DEFAULT_ESCALATION_THRESHOLDS,
  evaluateEscalation,
  evaluateEscalationClauses,
} from '../../src/alg/escalation.ts';
import { featuresFromTicket } from '../../src/alg/features.ts';
import { matchPolicyFlags, policyInput as matchInput } from '../../src/alg/policy.ts';
import { MIN_RANK, kbIdOf } from '../../src/alg/retrieval.ts';

const RAW = readFileSync('seed/demo_tickets.json', 'utf8');
const DATASET = JSON.parse(RAW);

/**
 * The canonical keys seed/orgs.sql holds, TRANSCRIBED rather than read.
 *
 * Same rule the account facts above live under: a test that derived the keys from the file it is
 * checking would be asking the seed whether it agrees with itself. A marker naming a key that is not
 * here can never resolve, and the reply that carries it would cite nothing.
 */
const SEEDED_KEYS = [
  'billing/duplicate-charge',
  'exports/destinations',
  'exports/schedule',
  'access/password-reset',
];

/**
 * A key marker resolved the way the provider resolves it, against a stand-in identity.
 *
 * The identity is irrelevant to what this file measures — the shape of the envelope and what it
 * cites — and using a real one from the seed would reintroduce exactly the coupling the markers were
 * introduced to remove.
 */
function resolveKeyMarker(kb_id) {
  if (!kb_id.startsWith('<key:') || !kb_id.endsWith('>')) return kb_id;
  return kbIdOf(kb_id.slice(5, -1), '00000000-0000-4000-8000-000000000001');
}

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

function triageFixtureFor(body) {
  return DATASET.triage_fixtures.filter((entry) => body.includes(entry.match));
}

function stageOf(ticket) {
  return ticket.intended.clause === null ? null : CLAUSE_STAGE[ticket.intended.clause];
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
    retrieval: null,
    validation: null,
    policyFlags: matchPolicyFlags(matchInput(ticket.subject, ticket.body)),
  });
}

/** The features once triage has answered, with whatever the drafting cycle has learned so far. */
function afterTriage(ticket, envelope, { retrieval = null, validation = null } = {}) {
  const account = ACCOUNTS[ticket.account_id];
  const minutes = FIRST_RESPONSE_MINUTES[account.tier][envelope.triage.severity];
  assert.ok(minutes, `no SLA policy is seeded for ${account.tier} at severity ${envelope.triage.severity}`);

  return featuresFromTicket({
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
    retrieval,
    validation,
    policyFlags: matchPolicyFlags(matchInput(ticket.subject, ticket.body)),
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

  it('selects exactly one ticket with each authored phrase, in both fixture tables', () => {
    for (const entry of [...DATASET.triage_fixtures, ...DATASET.draft_fixtures]) {
      const matched = DATASET.tickets.filter((ticket) => ticket.body.includes(entry.match));
      assert.equal(
        matched.length,
        1,
        `'${entry.match}' matches ${matched.length} bodies; it must select exactly one`,
      );
    }
  });

  it('authors every phrase out of material the redactor leaves alone', () => {
    // The message a fixture matches against is the redacted enquiry and the redacted excerpts, so a
    // phrase carrying anything the dictionary removes is a phrase that can never match — and the
    // fallback is the derived answer, silently.
    for (const entry of [...DATASET.triage_fixtures, ...DATASET.draft_fixtures]) {
      const pass = redact(entry.match, []);
      assert.equal(
        pass.text,
        entry.match,
        `'${entry.match}' does not survive the redactor, so it can never match a message`,
      );
    }
  });

  it('produces a valid triage envelope from every authored answer', () => {
    for (const entry of DATASET.triage_fixtures) {
      assert.ok(entry.answer.verdict, `'${entry.match}' authors no verdict`);
      const envelope = parseTriageEnvelope(renderTriageEnvelope(entry.answer.verdict));
      assert.equal(envelope.agent, 'triage');
      assert.equal(envelope.confidence, entry.answer.verdict.confidence);
      assert.equal(envelope.triage.severity, entry.answer.verdict.severity);
    }
  });

  it('produces a valid draft envelope from every authored reply, citing only what it names', () => {
    for (const entry of DATASET.draft_fixtures) {
      assert.equal(entry.agent, 'draft', `'${entry.match}' does not say which agent it answers for`);
      assert.ok(entry.answer.draft, `'${entry.match}' authors no reply`);

      // The markers are resolved first, because that is what the provider does before an envelope is
      // ever rendered. Parsed against sources that are exactly the identifiers it cites, which
      // measures the shape and the containment. Whether it OVERLAPS the real corpus is a question
      // about the database and is measured there, by the cycle running against the seeded articles.
      const resolved = {
        ...entry.answer.draft,
        kb_ids: entry.answer.draft.kb_ids.map(resolveKeyMarker),
      };
      const offered = resolved.kb_ids.map((kb_id) => ({ kb_id, excerpt: '' }));
      const envelope = parseDraftEnvelope(renderDraftEnvelope(resolved), offered);
      assert.equal(envelope.agent, 'draft');
      assert.ok(envelope.draft.kb_ids.length > 0, 'a draft with no citation is not a draft');
    }
  });

  it('cites a canonical key and never an identity, in every authored reply', () => {
    // The assertion that keeps the anchored beat alive across an advance of the corpus. An advance
    // mints a new identity for every row it copies, so a citation naming one is a citation of a
    // document that stops existing the moment anything is admitted — and the beat would escalate for
    // lack of grounding, correctly, in the middle of the demonstration. A key is copied verbatim.
    //
    // Measured over the WHOLE file rather than over the citation lists, because a literal identity
    // pasted into a match phrase or a body would be the same failure arriving by another door.
    const hexRuns = [...RAW.matchAll(/[0-9a-f]{32}/g)].map((match) => match[0]);
    assert.deepEqual(
      hexRuns,
      [],
      `the dataset carries ${hexRuns.length} literal identity/identities; cite <key:...> instead`,
    );

    for (const entry of DATASET.draft_fixtures) {
      for (const kb_id of entry.answer.draft.kb_ids) {
        assert.match(
          kb_id,
          /^<key:[A-Za-z0-9_/-]{1,64}>$/,
          `'${kb_id}' is not a key marker, so it names something an advance can move`,
        );
        const key = kb_id.slice(5, -1);
        assert.ok(
          SEEDED_KEYS.includes(key),
          `'${key}' is not a canonical key the seed holds, so the marker can never resolve`,
        );
      }
    }
  });

  it('carries admissible material for every variant of the gap beat, and it is admissible', () => {
    const gapTickets = DATASET.tickets.filter((ticket) => stageOf(ticket) === 'draft');
    const material = DATASET.admissible_material ?? [];
    assert.equal(
      material.length,
      gapTickets.length,
      'a rehearsal spends one document per gap, so there is one per variant and no fewer',
    );

    for (const item of material) {
      const ticket = DATASET.tickets.find((entry) => entry.id === item.for_ticket);
      assert.ok(ticket, `${item.canonical_key} names a ticket the dataset does not hold`);
      assert.equal(stageOf(ticket), 'draft', `${item.canonical_key} is not attached to a gap beat`);

      // The alphabet the constraint on the column holds, transcribed. A key outside it produces an
      // identifier the envelope validator refuses, which is a retrieval that fails at the border.
      assert.match(
        item.canonical_key,
        /^[A-Za-z0-9_/-]{1,64}$/,
        `${item.canonical_key} is outside the published alphabet for a canonical key`,
      );

      // Whole inside one excerpt. A body whose deciding sentence falls past the cut would close a
      // gap on padding, and nothing downstream could tell.
      assert.ok(
        item.body.length <= EXCERPT_MAX,
        `${item.canonical_key} is ${item.body.length} characters and an excerpt carries ${EXCERPT_MAX}`,
      );

      // Unchanged by the redactor, which is the condition the writer imposes and the reason
      // content_hash has exactly one thing it can be a digest of.
      const pass = redact(item.body, []);
      assert.equal(
        pass.text,
        item.body,
        `the redactor removes ${pass.removed.length} value(s) from ${item.canonical_key}, so every citation of it would quote a marker`,
      );

      // And no flag, least of all the one that says somebody is talking to the model.
      const flags = matchPolicyFlags(matchInput(item.title, item.body));
      assert.deepEqual(
        [...flags],
        [],
        `${item.canonical_key} raises ${flags.join(', ')}, and material that raises a flag is not admitted`,
      );

      assert.equal(
        item.expected_rank_floor,
        MIN_RANK,
        `${item.canonical_key} declares a floor the retrieval does not publish`,
      );

      for (const field of ['source', 'obtained_at', 'citability']) {
        assert.ok(
          typeof item.provenance?.[field] === 'string' && item.provenance[field].trim() !== '',
          `${item.canonical_key} declares no provenance.${field}`,
        );
      }
      assert.equal(
        typeof item.citable,
        'boolean',
        `${item.canonical_key} does not say whether it may be quoted, and there is no default`,
      );
    }
  });

  it('declares a retrieval expectation for every ticket, in the published shape', () => {
    for (const ticket of DATASET.tickets) {
      assert.ok(
        'retrieval' in ticket.intended,
        `${ticket.id} declares no retrieval expectation; null is a declaration and absence is not`,
      );
      const declared = ticket.intended.retrieval;
      if (declared === null) {
        // Only legitimate when the ticket never reaches the retrieval, which is exactly the tickets
        // that escalate at the record or the triage stage.
        assert.notEqual(
          stageOf(ticket),
          'draft',
          `${ticket.id} escalates at the draft stage, so it does reach the retrieval`,
        );
        continue;
      }
      const keys = Object.keys(declared);
      assert.equal(keys.length, 1, `${ticket.id} declares a retrieval of an unpublished shape`);
      assert.ok(
        (keys[0] === 'hits' && Number.isInteger(declared.hits) && declared.hits > 0) ||
          (keys[0] === 'zero_match' && declared.zero_match === true),
        `${ticket.id} declares ${JSON.stringify(declared)}, which is neither {hits:n} nor {zero_match:true}`,
      );
    }
  });

  it('escalates the record-stage tickets before any model is asked', () => {
    const atRecord = DATASET.tickets.filter((ticket) => stageOf(ticket) === 'record');
    assert.ok(atRecord.length > 0, 'no ticket demonstrates an escalation that costs nothing');

    for (const ticket of atRecord) {
      const verdict = evaluateEscalation(recordStage(ticket).features, NOW, THRESHOLDS);
      assert.equal(verdict.escalate, true, `${ticket.id} was written to escalate at the record stage`);
      assert.equal(verdict.reason, ticket.intended.reason, `${ticket.id} escalates under the wrong code`);
      assert.equal(verdict.clause, ticket.intended.clause);

      assert.equal(
        triageFixtureFor(ticket.body).length,
        0,
        `${ticket.id} escalates before any call, so an authored answer for it would never be used`,
      );
      assert.equal(ticket.intended.retrieval, null, `${ticket.id} never reaches the retrieval`);
    }
  });

  it('reaches the model for every other ticket, and lands where it says it will', () => {
    const beyondRecord = DATASET.tickets.filter((ticket) => stageOf(ticket) !== 'record');
    assert.ok(beyondRecord.length > 0, 'no ticket demonstrates a triage');

    for (const ticket of beyondRecord) {
      // Nothing may fire before the call, or the call never happens.
      const before = evaluateEscalation(recordStage(ticket).features, NOW, THRESHOLDS);
      assert.equal(
        before.escalate,
        false,
        `${ticket.id} escalates at the record stage (${before.reason}), so the model is never asked`,
      );

      const matched = triageFixtureFor(ticket.body);
      assert.equal(matched.length, 1, `${ticket.id} has ${matched.length} authored answers; it needs one`);
      const envelope = parseTriageEnvelope(renderTriageEnvelope(matched[0].answer.verdict));

      const stage = stageOf(ticket);
      const atTriage = evaluateEscalation(afterTriage(ticket, envelope).features, NOW, THRESHOLDS);

      if (stage === 'triage') {
        assert.equal(atTriage.reason, ticket.intended.reason, `${ticket.id} escalates under the wrong code`);
        assert.equal(atTriage.clause, ticket.intended.clause);
        assert.equal(atTriage.escalate, true);
        continue;
      }

      // Everything left either escalates at the draft stage or does not escalate at all, and both
      // require the triage stage to have decided nothing.
      assert.equal(
        atTriage.escalate,
        false,
        `${ticket.id} escalates at the triage stage (${atTriage.reason}), so the retrieval never runs`,
      );
    }
  });

  it('escalates the draft-stage tickets on the knowledge gap, and on nothing else', () => {
    const atDraft = DATASET.tickets.filter((ticket) => stageOf(ticket) === 'draft');
    assert.ok(atDraft.length > 0, 'no ticket demonstrates an escalation on a knowledge gap');

    for (const ticket of atDraft) {
      assert.deepEqual(
        ticket.intended.retrieval,
        { zero_match: true },
        `${ticket.id} escalates on a gap, so its retrieval must be declared as finding nothing`,
      );

      const envelope = parseTriageEnvelope(
        renderTriageEnvelope(triageFixtureFor(ticket.body)[0].answer.verdict),
      );
      const { features } = afterTriage(ticket, envelope, {
        retrieval: { resultCount: 0 },
        validation: { grounded: false },
      });

      const verdict = evaluateEscalation(features, NOW, THRESHOLDS);
      assert.equal(verdict.escalate, true, `${ticket.id} was written to escalate on a knowledge gap`);
      assert.equal(verdict.reason, ticket.intended.reason);
      assert.equal(verdict.clause, ticket.intended.clause);

      // EXACTLY one, and this is the assertion the beat is authored for. A ticket that escalated on
      // the gap AND on something else would still look right on screen and would be demonstrating
      // two things at once — and the second one would decide the reason the moment the precedence
      // or a threshold moved.
      const fired = evaluateEscalationClauses(features, NOW, THRESHOLDS).filter((outcome) => outcome.fired);
      assert.deepEqual(
        fired.map((outcome) => outcome.clause),
        [ticket.intended.clause],
        `${ticket.id} fires ${fired.length} clauses; the beat needs exactly one`,
      );
    }
  });

  it('leaves the happy beat unescalated once its sources are found', () => {
    const grounded = DATASET.tickets.filter((ticket) => ticket.intended.reason === null);
    assert.ok(grounded.length > 0, 'no ticket demonstrates a grounded answer');

    for (const ticket of grounded) {
      const hits = ticket.intended.retrieval?.hits;
      assert.ok(hits > 0, `${ticket.id} answers a question, so its retrieval must find something`);

      const envelope = parseTriageEnvelope(
        renderTriageEnvelope(triageFixtureFor(ticket.body)[0].answer.verdict),
      );
      const { features } = afterTriage(ticket, envelope, {
        retrieval: { resultCount: hits },
        validation: { grounded: true },
      });

      const fired = evaluateEscalationClauses(features, NOW, THRESHOLDS).filter((outcome) => outcome.fired);
      assert.deepEqual(
        fired.map((outcome) => outcome.clause),
        [],
        `${ticket.id} is the beat that shows a grounded answer and something escalated it`,
      );

      // And it has an authored reply, which is what makes the beat a reply rather than a stitched
      // paraphrase of its own sources.
      const replies = DATASET.draft_fixtures.filter((entry) => ticket.body.includes(entry.match));
      assert.equal(replies.length, 1, `${ticket.id} has ${replies.length} authored replies; it needs one`);
    }
  });
});
