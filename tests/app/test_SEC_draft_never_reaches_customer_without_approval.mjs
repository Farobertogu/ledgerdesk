// test_SEC_draft_never_reaches_customer_without_approval
//
// The last thing standing between a machine-written answer and a customer's inbox, measured as four
// refusals from four different directions.
//
// The state machine has published the guard since the app skeleton: `AWAITING_AGENT → SENT` is
// admitted when *"approved_by is not null — a database constraint, not a convention"*. It was a
// convention. `no_autosend` on `response` required a `sent_at` to have an `approved_by`, and nothing
// at all connected either of them to the ticket's state — a component holding the write path could
// move a ticket to `SENT` with no response row in existence.
//
// Four ways in, four refusals:
//
//   1. **Through the console.** The edge's guard belongs to no console, so the HTTP surface refuses
//      it — the same partition it has refused since the skeleton, unchanged by this increment.
//   2. **Through the application role.** `app_rw` holds no UPDATE on `response`, so nothing the
//      application runs can set an approver at all. Editing and approving arrive with the agent
//      console's own migration.
//   3. **Through the door that migration will open.** A RESTRICTIVE policy requires
//      `auth.uid() is not null` on any update of `response`. Every component in this system runs
//      with `{org_id, role}` and NO subject, by the decision signed in ADR-023 §8 — so the day the
//      grant lands, a component still cannot approve. The guarantee is made once, before the door
//      opens, rather than depending on the increment that opens it remembering to leave one shut.
//   4. **Through the schema itself, as the owner.** A trigger refuses `status = 'SENT'` unless a
//      response of that ticket carries both an approver and a sent instant. This is the one that
//      makes the published sentence true in the present tense.
//
// The fifth assertion is the state this increment produces: a grounded answer sitting in
// `AWAITING_AGENT`, unapproved and unsent, which is exactly where it should stop.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  RUN_ID,
  asOwner,
  draft,
  fileTicket,
  identities,
  request,
  responsesFor,
  sessionFor,
  ticketRow,
  triage,
  waitForServer,
} from './harness.mjs';

const ANSWERABLE =
  'TRIAGE-FIXTURE-CLEAN Which plan covers a further export destination, and does it change the ' +
  'monthly total for us?';

describe('test_SEC_draft_never_reaches_customer_without_approval', () => {
  let customer;
  let agent;
  let supervisor;
  let ticketId;
  let answerId;

  before(async () => {
    await waitForServer();
    const people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    agent = await sessionFor(people.northwindAgent.user_id);
    supervisor = await sessionFor(people.northwindSupervisor.user_id);

    const filed = await fileTicket(customer, {
      subject: `A further export destination [${RUN_ID}]`,
      body: ANSWERABLE,
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    ticketId = filed.body.tracking_id;

    await triage(agent, ticketId);
    const drafted = await draft(agent, ticketId);
    assert.equal(drafted.body.draft.outcome, 'DRAFTED', JSON.stringify(drafted.body.draft));

    const [answer] = await responsesFor(ticketId);
    answerId = answer.id;
  });

  it('stops at AWAITING_AGENT, with an answer that nobody has approved or sent', async () => {
    const ticket = await ticketRow(ticketId);
    assert.equal(ticket.status, 'AWAITING_AGENT');

    const [answer] = await responsesFor(ticketId);
    assert.equal(answer.grounded, true, 'the fixture for this test did not produce a grounded answer');
    assert.equal(answer.approved_by, null, 'a component approved an answer');
    assert.equal(answer.sent_at, null, 'a component sent an answer');
  });

  it('refuses the edge to a console, because its guard belongs to no console', async () => {
    for (const session of [agent, supervisor]) {
      const refused = await request(session, `/api/tickets/${ticketId}/transition`, {
        method: 'POST',
        body: { to: 'SENT' },
      });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error.code, 'E_TRANSITION_GUARD_UNAVAILABLE');
      assert.equal(refused.body.error.guarded_by, 'approval-constraint');
    }

    assert.equal((await ticketRow(ticketId)).status, 'AWAITING_AGENT');
  });

  it('gives the application role no way to set an approver at all', async () => {
    const granted = await asOwner(async (client) => {
      const result = await client.query(
        `select has_table_privilege('app_rw','response','update') as can_update,
                has_table_privilege('app_rw','response','insert') as can_insert,
                has_table_privilege('app_rw','response','delete') as can_delete`,
      );
      return result.rows[0];
    });

    assert.equal(granted.can_update, false, 'app_rw can update a response, which is a later grant');
    assert.equal(granted.can_delete, false, 'app_rw can delete an answer');
    assert.equal(granted.can_insert, true, 'the drafting agent cannot write an answer at all');
  });

  it('shuts the door before the increment that opens it arrives', async () => {
    // The policy is checked as a standing object rather than by exercising it, because exercising
    // it needs the grant that deliberately does not exist yet. What matters is that the predicate
    // is in place NOW: a component carrying no subject can never satisfy it, whatever a later
    // migration grants.
    const policy = await asOwner(async (client) => {
      const result = await client.query(
        `select permissive, cmd, qual, with_check
           from pg_policies
          where tablename = 'response' and policyname = 'response_writer_has_a_subject'`,
      );
      return result.rows[0] ?? null;
    });

    assert.ok(policy, 'the restrictive update policy on response is missing');
    assert.equal(policy.permissive, 'RESTRICTIVE', 'a permissive policy would widen rather than narrow');
    assert.equal(policy.cmd, 'UPDATE');
    assert.match(policy.qual, /auth\.uid\(\) IS NOT NULL/);
    assert.match(policy.with_check, /auth\.uid\(\) IS NOT NULL/);
  });

  it('refuses SENT in the schema, even for the owner, until both halves exist', async () => {
    await asOwner(async (client) => {
      const refused = async (because) => {
        try {
          await client.query("update ticket set status = 'SENT' where id = $1", [ticketId]);
        } catch (error) {
          assert.match(error.message, /E_TICKET_ENVIO_SIN_APROBACION/, because);
          return;
        }
        assert.fail(`${because}: SENT was accepted`);
      };

      // Nothing approved and nothing sent.
      await refused('an unapproved answer');

      // Approved, not sent. `no_autosend` on the response is the other end of this rule and refuses
      // the reverse — a sent_at with no approver — at the row.
      const staff = await client.query(
        "select id from app_user where role = 'agent' and org_id = (select org_id from ticket where id = $1)",
        [ticketId],
      );
      await client.query('update response set approved_by = $1 where id = $2', [
        staff.rows[0].id,
        answerId,
      ]);
      await refused('an answer approved but never sent');

      // Put it back. This test does not leave a ticket looking as though a person had signed it.
      await client.query('update response set approved_by = null where id = $1', [answerId]);
    });

    const ticket = await ticketRow(ticketId);
    assert.equal(ticket.status, 'AWAITING_AGENT', 'the ticket moved during the refusals');
    const [answer] = await responsesFor(ticketId);
    assert.equal(answer.approved_by, null);
    assert.equal(answer.sent_at, null);
  });

  it('has never let a ticket reach SENT anywhere in this database', async () => {
    // A sweep rather than a case: the question is whether ANY ticket has crossed the line, which is
    // the shape the failure would actually take.
    const sent = await asOwner(async (client) => {
      const result = await client.query(
        `select t.id::text as id
           from ticket t
          where t.status = 'SENT'
            and not exists (select 1 from response r
                             where r.ticket_id = t.id
                               and r.approved_by is not null
                               and r.sent_at is not null)`,
      );
      return result.rows.map((row) => row.id);
    });
    assert.deepEqual(sent, [], 'a ticket is SENT with nothing approved behind it');
  });
});
