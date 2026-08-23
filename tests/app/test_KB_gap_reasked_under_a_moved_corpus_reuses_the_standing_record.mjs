// test_KB_gap_reasked_under_a_moved_corpus_reuses_the_standing_record
//
// The upper bound of the requirement, measured on the case that used to break it.
//
// The unit the requirement counts is the **escalation**: *every `GROUND` escalation has exactly one
// gap record*. The digest that made a record unique — `sha256(query_terms ‖ kb_snapshot)` — carries
// the corpus inside it, so the same question asked again after ANY admission produces a different
// digest and, before this card, a second record. Not a second question: the same question, twice,
// with two owners and two committed dates, and a supervisor's queue growing one row per unrelated
// admission somewhere else in the organisation.
//
// The fix is a second identity beside the first — the digest of the question with the corpus left
// out — under a **partial** unique index that ignores closed records. This is what measures it, and
// it measures it the way it actually happens: a gap is opened, **somebody else's** admission moves
// the corpus, and the question is asked again.
//
// **The record is REUSED and not rewritten**, which is the other half. Its evidence still describes
// the corpus it was raised against — the terms, the snapshot, the digest of that pair — because that
// is what the re-run of the requirement is checked against. A record that quietly re-pointed itself
// at the newest corpus would be a record whose evidence had been edited to match its outcome.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  admit,
  asOwner,
  auditRowsFor,
  cleanup,
  draft,
  gapsFor,
  identities,
  restoreCorpusHead,
  sessionFor,
  snapshotHead,
  ticketWithAnOpenGap,
  waitForServer,
} from './harness.mjs';

/** The question that is asked twice. Nothing is ever admitted against it. */
const ASKED_TWICE = 'consignment-label-reprint';

/** The question whose answer moves the corpus underneath the first one. */
const MOVER = 'dock-slot-booking';

let people;
let orgUnderTest;
let seededHead;
let customer;
let agent;
let supervisor;

before(async () => {
  await waitForServer();
  people = await identities();
  orgUnderTest = people.northwindAgent.org_id;
  seededHead = await snapshotHead(orgUnderTest);
  customer = await sessionFor(people.northwindCustomer.user_id);
  agent = await sessionFor(people.northwindAgent.user_id);
  supervisor = await sessionFor(people.northwindSupervisor.user_id);
});

/**
 * The corpus goes back where this file found it.
 *
 * The runner sorts these files rather than running them in the order the list names, so a corpus
 * left moved is a corpus every alphabetically-later file reads — and four of them pin the seeded
 * snapshot by name. The admitted articles stay; only the pointer moves back. The refusal that moving
 * it arms is absorbed by `throughStaleRuntime`, on the next cycle-driving request.
 */
after(async () => {
  if (seededHead) await restoreCorpusHead(orgUnderTest, seededHead);
  await cleanup();
});

describe('test_KB_gap_reasked_under_a_moved_corpus_reuses_the_standing_record', () => {
  it('keeps one record when the corpus moves under it and the question is asked again', async () => {
    const org = people.northwindAgent.org_id;

    // --- the question that goes unanswered ----------------------------------------------------
    const asked = await ticketWithAnOpenGap(customer, agent, ASKED_TWICE, 'reask');
    const first = asked.gap;
    const snapshotWhenRaised = await snapshotHead(org);
    assert.equal(first.kb_snapshot, snapshotWhenRaised);

    // --- somebody else's admission, which moves the corpus --------------------------------------
    const mover = await ticketWithAnOpenGap(customer, agent, MOVER, 'mover');
    const admitted = await admit(supervisor, mover.gap.id, mover.beat.document);
    assert.equal(admitted.status, 200, `the admission was refused: ${JSON.stringify(admitted.body)}`);

    const movedTo = await snapshotHead(org);
    assert.notEqual(movedTo, snapshotWhenRaised, 'the corpus did not move, so this case measures nothing');

    // --- and the same question, asked again ------------------------------------------------------
    // The ticket is put back where the drafting cycle can take it. Only the state is touched: the
    // subject and the body are the question, and editing either would make this a different one.
    await asOwner(async (client) => {
      await client.query(
        `update ticket set status = 'TRIAGED', escalation_reason = null, escalation_clause = null
          where id = $1`,
        [asked.ticketId],
      );
    });

    const again = await draft(agent, asked.ticketId);
    assert.equal(again.status, 200, `the second cycle was refused: ${JSON.stringify(again.body)}`);
    assert.equal(
      again.body.draft.outcome,
      'ESCALATED_NO_SOURCES',
      'the admitted document answered a question it was not written for, so the beats are not disjoint',
    );

    // --- one record, the same one ---------------------------------------------------------------
    const rows = await gapsFor(asked.ticketId);
    assert.equal(
      rows.length,
      1,
      `the ticket holds ${rows.length} records for one question; a corpus that moved for an ` +
        'unrelated reason opened a second one',
    );
    assert.equal(rows[0].id, first.id, 'the record was replaced rather than reused');

    // Reused, not rewritten: the evidence still describes the corpus the question was raised
    // against, which is what the re-run is checked against.
    assert.equal(rows[0].kb_snapshot, snapshotWhenRaised, 'the record re-pointed itself at the newest corpus');
    assert.equal(rows[0].query_sha256, first.query_sha256, 'the evidence of the first asking was overwritten');
    assert.equal(rows[0].question_sha256, first.question_sha256, 'the identity of the question moved');
    assert.equal(rows[0].state, 'OPEN');

    // --- and both escalations name it ------------------------------------------------------------
    // This is the LOWER bound of the same requirement, and the instrument for it already existed:
    // the append-only chain holds one `TICKET_ESCALATED` per escalation, and each names the record
    // it rested on. Counting escalations is counting those rows; counting records is counting the
    // table. The two agree here because one record served two escalations, which is the whole point.
    const chain = await auditRowsFor(asked.ticketId);
    const escalations = chain.filter(
      (row) => row.action === 'TICKET_ESCALATED' && row.detail.stage === 'draft',
    );
    assert.equal(escalations.length, 2, `this ticket escalated ${escalations.length} times, not twice`);
    for (const row of escalations) {
      assert.equal(
        row.detail.gap_id,
        first.id,
        'an escalation was filed without naming the record it rested on',
      );
      assert.equal(row.detail.gap_refused, null, 'a record was refused on a path that should not refuse');
    }
  });
});
