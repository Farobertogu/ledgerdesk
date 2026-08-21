// test_US03_draft_generated_with_grounded_context
//
// The closing evidence of this card: a ticket answered from the knowledge base, with a draft that
// cites what it stands on and a verdict that says so, recorded end to end.
//
// It is written as two halves because the card has two outcomes and only one of them is the happy
// path. The second half is the one that is easy to leave untested and is the more important
// guarantee: when the corpus cannot answer a question, **no model is asked to write a reply anyway.**
// A system that produced a plausible answer from nothing would be worse than one that produced
// none, and the cheap escalation is what makes "grounded" mean something rather than being a label
// on whatever came back.
//
// Everything about the application goes through HTTP, so what is measured is the behaviour a
// browser would get, row-level security included. The owner connection is the oracle: it is how the
// test asks what is actually stored, which is a question the application must not be the one to
// answer.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { canonicalJson, sha256Hex } from '../../agents/canonical.ts';
import { stateHash } from '../../agents/ledger/row.ts';
import { rulesetDescription } from '../../src/alg/ruleset.ts';
import {
  RUN_ID,
  auditRowsFor,
  citationsFor,
  corpusOf,
  draft,
  fileTicket,
  identities,
  ledgerRowsFor,
  responsesFor,
  sessionFor,
  snapshotHead,
  ticketRow,
  triage,
  waitForServer,
} from './harness.mjs';

/**
 * A question the seeded corpus answers, with the marker that makes the triage land calm.
 *
 * The marker matters: a triage that escalated would never reach the drafting agent, and the test
 * would pass its first assertion and measure nothing. `TRIAGE-FIXTURE-CLEAN` is a confident,
 * neutral, mid-severity verdict on a standard-tier account, which fires no clause at all.
 */
const ANSWERABLE =
  'TRIAGE-FIXTURE-CLEAN We would like to add a further export destination for a second team. ' +
  'Does that change the monthly total, and who has to approve it?';

/**
 * A question the seeded corpus does not answer, in the same organisation.
 *
 * Nothing in it shares a stem with any Northwind article — that is what makes the retrieval return
 * zero rather than something loosely related — and nothing in it raises a policy flag, so the only
 * thing that can escalate it is the knowledge gap.
 */
const UNANSWERABLE =
  'TRIAGE-FIXTURE-CLEAN A supervisor asked whether the audit trail attached to a shipment is ' +
  'visible to everybody in the workspace or only to whoever raised it.';

describe('test_US03_draft_generated_with_grounded_context', () => {
  let customer;
  let agent;
  let orgId;

  before(async () => {
    await waitForServer();
    const people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    agent = await sessionFor(people.northwindAgent.user_id);
    orgId = people.northwindCustomer.org_id;
  });

  it('answers a question the corpus covers, and records what the answer stands on', async () => {
    const filed = await fileTicket(customer, {
      subject: `A second export destination [${RUN_ID}]`,
      body: ANSWERABLE,
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const ticketId = filed.body.tracking_id;

    const triaged = await triage(agent, ticketId);
    assert.equal(triaged.status, 200, JSON.stringify(triaged.body));
    assert.equal(triaged.body.triage.outcome, 'TRIAGED');
    assert.equal(triaged.body.triage.escalated, false, 'the ticket escalated before it could be drafted');

    const drafted = await draft(agent, ticketId);
    assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
    assert.equal(drafted.body.draft.outcome, 'DRAFTED', JSON.stringify(drafted.body.draft));
    assert.equal(drafted.body.draft.grounded, true);
    assert.ok(drafted.body.draft.citations > 0, 'a grounded draft that cites nothing');

    // --- the ticket -----------------------------------------------------------------------------
    const ticket = await ticketRow(ticketId);
    assert.equal(ticket.status, 'AWAITING_AGENT', 'the ticket is not waiting for a person');
    assert.equal(ticket.escalation_reason, null, 'a grounded answer escalated anyway');

    // --- the answer -----------------------------------------------------------------------------
    const [answer] = await responsesFor(ticketId);
    assert.ok(answer, 'no answer was written');
    assert.equal(answer.grounded, true);
    assert.ok(answer.draft.length > 0);
    assert.equal(answer.kb_snapshot, await snapshotHead(orgId), 'the answer names another corpus');
    assert.ok(answer.validated_at, 'the answer was never validated');
    assert.ok(answer.draft_ledger_ref, 'the answer does not name the call that produced it');
    assert.ok(answer.validate_ledger_ref, 'the answer does not name the call that checked it');
    assert.equal(answer.approved_by, null, 'a component approved an answer');
    assert.equal(answer.sent_at, null, 'a component sent an answer');

    // --- the citations, as references rather than as a list ---------------------------------------
    const citations = await citationsFor(answer.id);
    assert.ok(citations.length > 0, 'the citation rows are missing');
    for (const citation of citations) {
      // The join is on the composite key, so a row that came back at all is a row naming an article
      // that exists UNDER THAT SNAPSHOT. That is the guarantee the composite reference buys.
      assert.equal(citation.kb_snapshot, answer.kb_snapshot);
      assert.ok(citation.canonical_key, 'a citation names an article with no key');
    }

    // Every cited article really is one of this organisation's, under the snapshot in force.
    const corpus = await corpusOf(orgId);
    const known = new Set(corpus.map((article) => article.id));
    for (const citation of citations) {
      assert.ok(known.has(citation.kb_article_id), 'a citation names an article outside the corpus');
    }

    // --- the chain ------------------------------------------------------------------------------
    const chain = await ledgerRowsFor(ticketId);
    assert.equal(chain.length, 3, 'a ticket answered from the corpus should cost three calls');
    assert.deepEqual(
      chain.map((row) => row.agent),
      ['triage', 'draft', 'validate'],
    );
    for (const row of chain) {
      assert.equal(row.class, 'agent_call');
      assert.ok(row.input_path, 'a row that names no input cannot be replayed');
    }
    // The two calls of the drafting cycle name what they consumed, and the validator names the DRAFT
    // rather than the ticket — which is what its prompt is written against.
    assert.match(chain[1].input_path, /#body_raw\+kb\//);
    assert.match(chain[2].input_path, new RegExp(`#draft/${answer.id}\\+kb/`));

    // --- the state the rows were written under ---------------------------------------------------
    //
    // Recomputed here from the pure modules rather than copied off the row, so that what is checked
    // is the VALUE and not merely that the three rows agree with each other.
    const head = await snapshotHead(orgId);
    const expected = stateHash({
      schema_version: '1.0',
      ruleset_hash: sha256Hex(canonicalJson(rulesetDescription())),
      kb_snapshot: `${orgId}:${head}`,
    });
    for (const row of chain) {
      assert.equal(row.state_hash, expected, 'a row records a state the system was not in');
    }
    // And the value the constant used to be, for an organisation that demonstrably has a corpus.
    const sentinel = stateHash({
      schema_version: '1.0',
      ruleset_hash: sha256Hex(canonicalJson(rulesetDescription())),
      kb_snapshot: 'kb:none',
    });
    assert.notEqual(expected, sentinel, 'the rows still say the knowledge base does not exist');
    assert.ok(corpus.length > 0, 'the organisation has no corpus, so the assertion above is empty');

    // --- the record of the decision ---------------------------------------------------------------
    const audit = await auditRowsFor(ticketId);
    const actions = audit.map((row) => row.action);
    assert.ok(actions.includes('TICKET_TRIAGED'));
    assert.ok(actions.includes('TICKET_DRAFTED'), 'the drafting decision was not filed');
    assert.ok(actions.includes('TICKET_VALIDATED'), 'the verdict was not filed');

    const validated = audit.find((row) => row.action === 'TICKET_VALIDATED');
    assert.equal(validated.detail.grounded, true);
    assert.equal(validated.detail.response_id, answer.id);
    // The five terms are recorded separately, so an auditor can see WHICH one decided it. A single
    // boolean would hide the whole design.
    assert.deepEqual(validated.detail.conjuncts, {
      sources_present: true,
      citations_present: true,
      citations_offered: true,
      citations_overlap: true,
      model_agrees: true,
    });

    // Nothing anybody wrote reaches the append-only table. Not the body, not the draft, not an
    // excerpt — identifiers, counts, booleans and digests only.
    const stored = JSON.stringify(audit);
    assert.ok(!stored.includes('export destination'), 'the chain carries part of the ticket body');
    assert.ok(!stored.includes(answer.draft.slice(0, 40)), 'the chain carries part of the draft');
  });

  it('escalates a question the corpus cannot answer, without asking a model to answer it', async () => {
    const filed = await fileTicket(customer, {
      subject: `Audit trail visibility [${RUN_ID}]`,
      body: UNANSWERABLE,
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const ticketId = filed.body.tracking_id;

    const triaged = await triage(agent, ticketId);
    assert.equal(triaged.body.triage.outcome, 'TRIAGED');
    assert.equal(triaged.body.triage.escalated, false);

    const before = await ledgerRowsFor(ticketId);
    assert.equal(before.length, 1, 'the triage cost more than one call');

    const drafted = await draft(agent, ticketId);
    assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
    assert.equal(drafted.body.draft.outcome, 'ESCALATED_NO_SOURCES', JSON.stringify(drafted.body.draft));
    assert.equal(drafted.body.draft.reason, 'GROUND');
    assert.equal(drafted.body.draft.clause, 'draft_not_grounded');
    assert.equal(drafted.body.draft.retrieval, 'zero_match');

    const ticket = await ticketRow(ticketId);
    assert.equal(ticket.status, 'ESCALATED');
    assert.equal(ticket.escalation_reason, 'GROUND');
    assert.equal(ticket.escalation_clause, 'draft_not_grounded');

    // THE assertion of this half: the drafting cycle cost nothing at all. No draft was written from
    // no sources, and no validator was asked to check one.
    const after = await ledgerRowsFor(ticketId);
    assert.equal(after.length, 1, 'a model was asked to answer a question the corpus could not');
    assert.equal((await responsesFor(ticketId)).length, 0, 'a draft was written from nothing');

    // And the record says what happened, in the shape a later increment reads a gap out of.
    const audit = await auditRowsFor(ticketId);
    const escalation = audit.find(
      (row) => row.action === 'TICKET_ESCALATED' && row.detail.stage === 'draft',
    );
    assert.ok(escalation, 'the escalation on a knowledge gap was not filed');
    assert.equal(escalation.detail.retrieval_kind, 'zero_match');
    assert.equal(escalation.detail.result_count, 0);
    assert.equal(escalation.detail.kb_snapshot, await snapshotHead(orgId));

    // The gap clause FIRED, whatever survived the precedence — which is where the increment that
    // emits gap records reads it from, and why it reads it from there.
    const fired = escalation.detail.clauses.filter((entry) => entry.fired).map((entry) => entry.clause);
    assert.deepEqual(fired, ['draft_not_grounded'], `${fired.length} clauses fired on the gap beat`);

    // The query terms are the customer's words, and they do not travel into an append-only table.
    assert.ok(!JSON.stringify(audit).includes('audit trail attached'), 'the chain carries the query');
  });

  it('does nothing at all to a ticket that is not in TRIAGED', async () => {
    const filed = await fileTicket(customer, {
      subject: `Not yet triaged [${RUN_ID}]`,
      body: 'TRIAGE-FIXTURE-CLEAN A question about the nightly export window.',
    });
    const ticketId = filed.body.tracking_id;

    const drafted = await draft(agent, ticketId);
    assert.equal(drafted.status, 200);
    assert.equal(drafted.body.draft.outcome, 'SKIPPED');
    assert.equal(drafted.body.draft.status, 'NEW');

    assert.equal((await ledgerRowsFor(ticketId)).length, 0, 'a skipped cycle called a model');
    assert.equal((await responsesFor(ticketId)).length, 0);
    assert.equal((await ticketRow(ticketId)).status, 'NEW');
  });

  it('is a staff action, and reports visibility before it reports standing', async () => {
    const filed = await fileTicket(customer, {
      subject: `Standing check [${RUN_ID}]`,
      body: 'TRIAGE-FIXTURE-CLEAN A question about the nightly export window.',
    });
    const ticketId = filed.body.tracking_id;

    // The customer can SEE their own ticket and may not spend the organisation's ceiling on it.
    const refused = await draft(customer, ticketId);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'E_ROLE_NOT_PERMITTED');

    // A ticket of the OTHER organisation is reported as not visible rather than as refused, which
    // is the order that does not confirm the ticket exists.
    const people = await identities();
    const otherOrg = await sessionFor(people.corellaCustomer.user_id);
    const invisible = await draft(otherOrg, ticketId);
    assert.equal(invisible.status, 404);
    assert.equal(invisible.body.error.code, 'E_TICKET_NOT_VISIBLE');

    assert.equal((await ledgerRowsFor(ticketId)).length, 0, 'a refused request spent money');
  });
});
