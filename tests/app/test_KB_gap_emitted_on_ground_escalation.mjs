// test_KB_gap_emitted_on_ground_escalation
//
// The first half of the requirement: when the escalation fires under `GROUND`, exactly one gap
// record is emitted, with the query evidence, an owner, a committed date and a rule for what the
// absence means that was declared in advance.
//
// **What makes this test worth having is what it measures the record AGAINST.** A test that only
// checked that a row appeared would pass on a row full of values the writer invented. So every field
// is checked against the thing it is supposed to have come from: the terms against the query the
// retrieval actually composed, the digest against a recomputation of it, the owner against the
// commitment the organisation declared in advance, and `zero_match` against which of the two ways of
// finding nothing actually happened.
//
// **The emission fires on the CLAUSE, not on the stored reason**, and the second half of this file
// is that distinction: a ticket whose SLA has already passed escalates under `SLA` — the precedence
// decides which fact survives in the column — and a knowledge gap does not stop being one because
// something else won. That ticket must still carry a record.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  asOwner,
  cleanup,
  draft,
  fileBeatTicket,
  gapsFor,
  identities,
  sessionFor,
  snapshotHead,
  ticketWithAnOpenGap,
  triage,
  waitForServer,
} from './harness.mjs';

/**
 * How the retrieval composes a query, TRANSCRIBED rather than imported.
 *
 * The composer lives in the server layer, whose modules reach for the application's path aliases and
 * are therefore not importable by a runner that resolves none. Transcribing it is the same
 * arrangement the seeded account facts live under in the dataset test, and it has the same value: if
 * somebody changes how a query is composed, this disagrees rather than following along.
 */
const composeQuery = (subject, body) => `${subject}\n${body}`;

/**
 * The beat this file asks.
 *
 * Named, because the application tests share one database and admitting a document changes the
 * corpus for everything after it. This file admits nothing, so no later test depends on which beat
 * it takes — but taking a named one is what keeps that true when somebody adds a case here.
 */
const BEAT = 'consignment-label-reprint';

let people;
let customer;
let agent;

before(async () => {
  await waitForServer();
  people = await identities();
  customer = await sessionFor(people.northwindCustomer.user_id);
  agent = await sessionFor(people.northwindAgent.user_id);
});

after(cleanup);

describe('test_KB_gap_emitted_on_ground_escalation', () => {
  it('emits exactly one record, carrying the evidence the retrieval produced', async () => {
    const { ticketId, gap, subject, body } = await ticketWithAnOpenGap(
      customer,
      agent,
      BEAT,
      'emit',
    );
    const head = await snapshotHead(people.northwindAgent.org_id);

    assert.equal(gap.org_id, people.northwindAgent.org_id);
    assert.equal(gap.ticket_id, ticketId);
    assert.equal(gap.state, 'OPEN', 'a record is born open and is closed by verification alone');

    // The evidence, against what the retrieval actually did rather than against a plausible value.
    assert.equal(gap.kb_snapshot, head, 'the record names a corpus other than the one searched');
    assert.equal(
      gap.zero_match,
      true,
      'this enquiry matches no document at all, and the record has to say which of the two ' +
        'ways of finding nothing happened',
    );

    // The words the harness actually filed, returned by it rather than rebuilt here. Rebuilding
    // them would make this file a second producer of the query it is checking.
    const expectedTerms = composeQuery(subject, body);
    assert.equal(gap.query_terms, expectedTerms, 'the stored terms are not the terms that were searched');

    // The digest ties, and the receiver is what tied it. Recomputed here from the stored terms and
    // the stored snapshot, which is the only definition that makes the re-run identical rather than
    // similar.
    const recomputed = createHash('sha256')
      .update(`${gap.query_terms}${gap.kb_snapshot}`, 'utf8')
      .digest('hex');
    assert.equal(gap.query_sha256, recomputed, 'the digest does not tie to the terms beside it');

    // The rule for what a null means, which the requirement insists precedes the null.
    assert.ok(gap.null_rule && gap.null_rule.trim() !== '', 'a record with no null rule declares nothing');
    assert.match(
      gap.null_rule,
      /never a statement that the fact is untrue/,
      'the stored rule is not the published one, so two records could mean different things by a null',
    );
  });

  it('names an owner and a date that a person committed to in advance', async () => {
    const { gap } = await ticketWithAnOpenGap(customer, agent, BEAT, 'owner');

    // The owner resolves to a live user OF THIS ORGANISATION. The composite foreign key makes the
    // cross-tenant case unrepresentable; this is the other half, that the value is not merely
    // well-shaped but is somebody who exists.
    const owner = await asOwner(async (client) => {
      const found = await client.query('select id, org_id, role from app_user where id = $1', [
        gap.owner_id,
      ]);
      return found.rows[0] ?? null;
    });
    assert.ok(owner, 'the record names an owner who does not exist');
    assert.equal(owner.org_id, gap.org_id, 'the owner belongs to another organisation');

    // A commitment cannot be born overdue. The database refuses it as well; this is the statement
    // that the writer does not produce one in the first place.
    const opened = new Date(gap.created_at);
    const openedDay = `${opened.getFullYear()}-${`${opened.getMonth() + 1}`.padStart(2, '0')}-${`${opened.getDate()}`.padStart(2, '0')}`;
    const committed = gap.committed_date instanceof Date
      ? `${gap.committed_date.getFullYear()}-${`${gap.committed_date.getMonth() + 1}`.padStart(2, '0')}-${`${gap.committed_date.getDate()}`.padStart(2, '0')}`
      : String(gap.committed_date);
    assert.ok(committed >= openedDay, `a gap opened on ${openedDay} is committed for ${committed}`);
  });

  it('emits a record even when another clause wins the reason column', async () => {
    // The precedence stores one reason and this ticket has two facts to state: its first response
    // has already passed, and its question cannot be answered. `SLA` outranks `GROUND` at the
    // record stage, so the column says SLA — and the record of the gap must exist anyway, because a
    // gap does not stop being one because a clock expired in the same second.
    const { ticketId } = await fileBeatTicket(customer, BEAT, 'sla');

    const triaged = await triage(agent, ticketId);
    assert.equal(triaged.status, 200);

    // Backdated past its own first response, past every policy this seed holds. Done as the owner,
    // because moving a clock is not something the application offers and must not be.
    await asOwner(async (client) => {
      await client.query(
        `update ticket set created_at = now() - interval '30 days',
                           sla_due_at = now() - interval '29 days'
          where id = $1`,
        [ticketId],
      );
    });

    const drafted = await draft(agent, ticketId);
    assert.equal(drafted.status, 200);
    assert.equal(
      drafted.body.draft.reason,
      'SLA',
      'this ticket was arranged so that another clause wins the column',
    );

    const gaps = await gapsFor(ticketId);
    assert.equal(
      gaps.length,
      1,
      'the reason column says SLA and the gap was still a gap; the record has to exist',
    );
    assert.equal(gaps[0].zero_match, true);
  });

  it('writes one record per unanswered query, however many times it is asked', async () => {
    const { ticketId } = await ticketWithAnOpenGap(customer, agent, BEAT, 'once');

    // The ticket is put back where the drafting cycle can take it and the cycle is run again. The
    // corpus has not moved, so it is the same question under the same corpus — one record.
    await asOwner(async (client) => {
      await client.query(
        `update ticket set status = 'TRIAGED', escalation_reason = null, escalation_clause = null
          where id = $1`,
        [ticketId],
      );
    });

    const again = await draft(agent, ticketId);
    assert.equal(again.status, 200);
    assert.equal(again.body.draft.outcome, 'ESCALATED_NO_SOURCES');

    const gaps = await gapsFor(ticketId);
    assert.equal(
      gaps.length,
      1,
      'a retried emission is the same record, not a second one and not an error',
    );
  });
});
