// test_APP_state_machine_enforced_server_side
//
// The ticket state machine is validated by the server, over the whole matrix.
//
// The expected edges below are transcribed from the specification's state machine, NOT imported
// from the application. A test that imports the table it is checking asks the code whether the
// code agrees with itself; this one asks whether the code agrees with the document.
//
// Every one of the ten states is fixtured and every one of the hundred ordered pairs is attempted
// over HTTP. Each pair falls into exactly one of three classes:
//
//   · an edge a person may take from a console today  → 200, and the row moves;
//   · an edge the machine publishes whose guard is evaluated by a component that has not been
//     built  → 409 E_TRANSITION_GUARD_UNAVAILABLE, and the row does not move. Refusing these is
//     the point: a transition whose guard nobody evaluated is not a guarded transition;
//   · anything else  → 409 E_TRANSITION_ILLEGAL, and the row does not move.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { asOwner, cleanup, identities, request, RUN_ID, sessionFor, waitForServer } from './harness.mjs';

const STATES = [
  'NEW',
  'TRIAGED',
  'DRAFTED',
  'AWAITING_AGENT',
  'SENT',
  'ESCALATED',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
  'TRIAGE_FAILED',
];

/**
 * Edges a console may take today. `ESCALATED → RESOLVED` is narrower than the other two: it is the
 * supervisor's, which is why the matrix below is driven by a supervisor session — the only one
 * that can take all three. The role restriction itself has its own test further down.
 */
const CONSOLE_EDGES = [
  ['SENT', 'RESOLVED'],
  ['RESOLVED', 'CLOSED'],
  ['ESCALATED', 'RESOLVED'],
];

/** Edges the machine publishes whose guard belongs to a component of a later card. */
const GUARDED_EDGES = [
  ['NEW', 'TRIAGED'],
  ['NEW', 'TRIAGE_FAILED'],
  ['TRIAGED', 'DRAFTED'],
  ['DRAFTED', 'AWAITING_AGENT'],
  ['AWAITING_AGENT', 'SENT'],
  ['CLOSED', 'REOPENED'],
  ['REOPENED', 'TRIAGED'],
  // "* → ESCALATED": every state but ESCALATED itself.
  ...STATES.filter((state) => state !== 'ESCALATED').map((state) => [state, 'ESCALATED']),
];

const key = (from, to) => `${from}→${to}`;
const CONSOLE = new Set(CONSOLE_EDGES.map(([from, to]) => key(from, to)));
const GUARDED = new Set(GUARDED_EDGES.map(([from, to]) => key(from, to)));

describe('test_APP_state_machine_enforced_server_side', () => {
  let people;
  let agentA;
  let supervisorA;
  let customerA;
  let agentB;
  /** state → ticket id of the fixture parked in that state */
  const fixture = new Map();

  before(async () => {
    await waitForServer();
    people = await identities();
    agentA = await sessionFor(people.northwindAgent.user_id);
    supervisorA = await sessionFor(people.northwindSupervisor.user_id);
    customerA = await sessionFor(people.northwindCustomer.user_id);
    agentB = await sessionFor(people.corellaAgent.user_id);

    await asOwner(async (client) => {
      const account = await client.query(
        'select id from account where org_id = $1 order by id limit 1',
        [people.northwindCustomer.org_id],
      );

      for (const state of STATES) {
        // A fixture parked in ESCALATED has to carry a reason and a clause: 0008 makes that an
        // invariant of the state, not a convention of whoever writes the row. It is supplied once
        // here and never cleared, which is also what the invariant's one-directionality allows —
        // a ticket that leaves ESCALATED keeps the record of why it was there, so parking the row
        // back into ESCALATED later needs nothing further.
        const escalated = state === 'ESCALATED';
        const inserted = await client.query(
          `insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, status,
                               dedupe_key, escalation_reason, escalation_clause)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning id`,
          [
            people.northwindCustomer.org_id,
            account.rows[0].id,
            people.northwindCustomer.user_id,
            `fixture parked in ${state} [${RUN_ID}]`,
            'state machine fixture',
            state,
            `apptest-${RUN_ID}-${state}`,
            escalated ? 'SLA' : null,
            escalated ? 'sla_breached' : null,
          ],
        );
        fixture.set(state, inserted.rows[0].id);
      }
    });
  });

  after(cleanup);

  async function statusOf(ticketId) {
    return asOwner(async (client) => {
      const result = await client.query('select status from ticket where id = $1', [ticketId]);
      return result.rows[0].status;
    });
  }

  async function park(ticketId, state) {
    await asOwner(async (client) => {
      await client.query('update ticket set status = $1 where id = $2', [state, ticketId]);
    });
  }

  it('classifies the published edges and refuses the rest, over all 100 ordered pairs', async () => {
    const seen = { console: 0, guarded: 0, illegal: 0 };

    for (const from of STATES) {
      const ticketId = fixture.get(from);
      for (const to of STATES) {
        const response = await request(supervisorA, `/api/tickets/${ticketId}/transition`, {
          method: 'POST',
          body: { to },
        });
        const edge = key(from, to);

        if (CONSOLE.has(edge)) {
          assert.equal(response.status, 200, `${edge} should be applied, answered ${response.status}`);
          assert.equal(response.body.ticket.status, to, `${edge} reported the wrong state`);
          assert.equal(await statusOf(ticketId), to, `${edge} did not move the stored row`);
          await park(ticketId, from);
          seen.console += 1;
          continue;
        }

        const expectedCode = GUARDED.has(edge)
          ? 'E_TRANSITION_GUARD_UNAVAILABLE'
          : 'E_TRANSITION_ILLEGAL';
        assert.equal(response.status, 409, `${edge} should be refused with 409`);
        assert.equal(response.body.error.code, expectedCode, `${edge} was refused with the wrong code`);
        assert.equal(await statusOf(ticketId), from, `${edge} was refused and the row moved anyway`);

        if (GUARDED.has(edge)) {
          assert.ok(
            typeof response.body.error.guarded_by === 'string' && response.body.error.guarded_by,
            `${edge} was refused without naming the component that owns its guard`,
          );
          seen.guarded += 1;
        } else {
          seen.illegal += 1;
        }
      }
    }

    // The size of the machine is part of the contract: an edge quietly added or removed changes
    // these three numbers even when every individual pair still classifies as this test expects.
    assert.deepEqual(seen, { console: 3, guarded: 16, illegal: 81 });
  });

  // ESCALATED → RESOLVED is the supervisor's edge and nobody else's. It is the only place in the
  // machine where standing is narrower than the write path, so it gets its own three cases.
  it('gives the escalation exit to the supervisor and to no other role', async () => {
    const ticketId = fixture.get('ESCALATED');

    await park(ticketId, 'ESCALATED');
    const asAgent = await request(agentA, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(asAgent.status, 403, 'an agent closed out an escalation');
    assert.equal(asAgent.body.error.code, 'E_ROLE_NOT_PERMITTED');
    assert.deepEqual(asAgent.body.error.requires_role, ['supervisor']);
    assert.equal(await statusOf(ticketId), 'ESCALATED', 'the refused agent moved the row');

    const asCustomer = await request(customerA, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(asCustomer.status, 403);
    assert.equal(asCustomer.body.error.code, 'E_ROLE_NOT_PERMITTED');
    assert.equal(await statusOf(ticketId), 'ESCALATED', 'the refused customer moved the row');

    const asSupervisor = await request(supervisorA, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(asSupervisor.status, 200, 'the supervisor cannot take their own edge');
    assert.equal(asSupervisor.body.ticket.status, 'RESOLVED');
    assert.equal(await statusOf(ticketId), 'RESOLVED', 'the applied transition did not persist');

    await park(ticketId, 'ESCALATED');
  });

  it('advances a ticket along a chain of legal edges', async () => {
    const ticketId = fixture.get('SENT');
    await park(ticketId, 'SENT');

    const resolved = await request(agentA, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.ticket.status, 'RESOLVED');

    const closed = await request(supervisorA, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'CLOSED' },
    });
    assert.equal(closed.status, 200, 'a supervisor holds the same write role as an agent');
    assert.equal(closed.body.ticket.status, 'CLOSED');
    assert.equal(await statusOf(ticketId), 'CLOSED');

    // The chain does not run backwards: CLOSED → RESOLVED is not published.
    const backwards = await request(agentA, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(backwards.status, 409);
    assert.equal(backwards.body.error.code, 'E_TRANSITION_ILLEGAL');

    await park(ticketId, 'SENT');
  });

  it('refuses a transition the session has no standing to ask for', async () => {
    const ticketId = fixture.get('SENT');

    const asCustomer = await request(customerA, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(asCustomer.status, 403);
    assert.equal(asCustomer.body.error.code, 'E_ROLE_NOT_PERMITTED');

    const anonymous = await request(null, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'E_NO_SESSION');

    // The other organisation's agent is told the row is not visible, not that the transition was
    // refused: the second answer would confirm the ticket exists.
    const crossTenant = await request(agentB, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(crossTenant.status, 404);
    assert.equal(crossTenant.body.error.code, 'E_TICKET_NOT_VISIBLE');

    assert.equal(await statusOf(ticketId), 'SENT', 'a refused request moved the row');
  });

  it('rejects a target that is not a state of the enum', async () => {
    const ticketId = fixture.get('SENT');
    for (const to of ['resolved', 'DONE', '', null, 42]) {
      const response = await request(agentA, `/api/tickets/${ticketId}/transition`, {
        method: 'POST',
        body: { to },
      });
      assert.equal(response.status, 400, `"${to}" was not rejected as a field error`);
      assert.equal(response.body.error.code, 'E_FIELD_INVALID');
    }
    assert.equal(await statusOf(ticketId), 'SENT');
  });
});
