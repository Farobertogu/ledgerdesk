// test_US01_ticket_created_and_acknowledged
//
// US-01 · "As a customer I submit a ticket and receive an acknowledgement with a tracking number."
// Acceptance criterion: 201 + tracking_id visible + status NEW in the database.
//
// The test runs against the HTTP surface of the running application and against the database it
// writes to. Two halves, and both are needed:
//
//   · the intake half asserts the criterion literally — the status code, the tracking number in
//     the acknowledgement, and the row in NEW read straight out of the table;
//   · the isolation half asserts that the same ticket is invisible to a customer of the other
//     organisation THROUGH THE APPLICATION. The policy is already tested in SQL; what is measured
//     here is that the application's own connection does not slip past it.
//
// The second half checks that the other organisation still sees its own tickets. Without that,
// a zero would prove nothing — a broken connection would produce the same number.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { asOwner, cleanup, identities, request, RUN_ID, sessionFor, waitForServer } from './harness.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT = `Card declined at checkout [${RUN_ID}]`;
const BODY = 'Every attempt since Tuesday is declined at the payment step.';

describe('test_US01_ticket_created_and_acknowledged', () => {
  let people;
  let customerA;
  let customerB;
  let agentA;
  let acknowledgement;

  before(async () => {
    await waitForServer();
    people = await identities();
    customerA = await sessionFor(people.northwindCustomer.user_id);
    customerB = await sessionFor(people.corellaCustomer.user_id);
    agentA = await sessionFor(people.northwindAgent.user_id);
  });

  after(cleanup);

  it('answers 201 with a tracking number the customer can quote', async () => {
    const response = await request(customerA, '/api/tickets', {
      method: 'POST',
      body: { subject: SUBJECT, body: BODY },
    });

    assert.equal(response.status, 201, 'intake must answer 201 Created');
    acknowledgement = response.body;

    assert.match(acknowledgement.tracking_id, UUID, 'the acknowledgement carries no tracking number');
    assert.equal(acknowledgement.status, 'NEW');
    assert.equal(acknowledgement.subject, SUBJECT);
    assert.ok(
      acknowledgement.acknowledgement.includes(acknowledgement.tracking_id),
      'the acknowledgement text must quote the tracking number the customer will use',
    );
    assert.equal(
      response.headers.get('location'),
      `/api/tickets/${acknowledgement.tracking_id}`,
      'the created ticket must be addressable at the location it reports',
    );
  });

  it('persists the row in NEW, in the tenant and to the customer of the claims', async () => {
    const row = await asOwner(async (client) => {
      const result = await client.query(
        `select org_id, customer_id, account_id, status, subject, body_raw, body_redacted,
                sla_policy_id, retries
           from ticket where id = $1`,
        [acknowledgement.tracking_id],
      );
      return result.rows[0];
    });

    assert.ok(row, 'the tracking number resolves to no row');
    assert.equal(row.status, 'NEW', 'a filed ticket starts in NEW');
    assert.equal(row.org_id, people.northwindCustomer.org_id, 'the row landed in another tenant');
    assert.equal(row.customer_id, people.northwindCustomer.user_id, 'the row is owned by another user');
    assert.equal(row.subject, SUBJECT);
    assert.equal(row.body_raw, BODY);
    assert.ok(row.account_id, 'account_id is NOT NULL and must have been resolved');

    // Two columns intake must NOT fill, asserted so that filling them later is a deliberate change:
    // the redacted body belongs to the gateway, and the SLA policy is chosen from a severity that
    // triage has not assigned yet.
    assert.equal(row.body_redacted, null, 'intake wrote a redacted body, which is not its to write');
    assert.equal(row.sla_policy_id, null, 'intake assigned an SLA policy with no severity to derive it from');
    assert.equal(row.retries, 0);
  });

  it('shows the ticket to its own customer', async () => {
    const response = await request(customerA, '/api/tickets');
    assert.equal(response.status, 200);
    const found = response.body.tickets.find((t) => t.id === acknowledgement.tracking_id);
    assert.ok(found, 'the customer cannot see the ticket they just filed');
    assert.equal(found.status, 'NEW');
  });

  it('hides it from a customer of the other organisation', async () => {
    const list = await request(customerB, '/api/tickets');
    assert.equal(list.status, 200);
    assert.ok(
      list.body.tickets.length > 0,
      'the other organisation sees nothing at all, so its not seeing this ticket proves nothing',
    );
    assert.ok(
      !list.body.tickets.some((t) => t.id === acknowledgement.tracking_id),
      'a customer of the other organisation can list this ticket',
    );

    const direct = await request(customerB, `/api/tickets/${acknowledgement.tracking_id}`);
    assert.equal(direct.status, 404, 'the ticket is reachable by id from the other organisation');
    assert.equal(direct.body.error.code, 'E_TICKET_NOT_VISIBLE');
  });

  it('shows it to an agent of its own organisation', async () => {
    const response = await request(agentA, '/api/tickets');
    assert.equal(response.status, 200);
    assert.ok(
      response.body.tickets.some((t) => t.id === acknowledgement.tracking_id),
      'the agent of the ticket’s own organisation cannot see it',
    );
  });

  it('refuses intake without a session and from a role that does not file tickets', async () => {
    const anonymous = await request(null, '/api/tickets', {
      method: 'POST',
      body: { subject: `anonymous [${RUN_ID}]`, body: 'no session' },
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'E_NO_SESSION');

    const asAgent = await request(agentA, '/api/tickets', {
      method: 'POST',
      body: { subject: `agent filed [${RUN_ID}]`, body: 'wrong role' },
    });
    assert.equal(asAgent.status, 403);
    assert.equal(asAgent.body.error.code, 'E_ROLE_NOT_PERMITTED');

    const empty = await request(customerA, '/api/tickets', {
      method: 'POST',
      body: { subject: '   ', body: BODY },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'E_FIELD_INVALID');

    const stored = await asOwner(async (client) => {
      const result = await client.query('select count(*)::int as n from ticket where subject like $1', [
        `%[${RUN_ID}]%`,
      ]);
      return result.rows[0].n;
    });
    assert.equal(stored, 1, 'a refused intake still wrote a row');
  });
});
