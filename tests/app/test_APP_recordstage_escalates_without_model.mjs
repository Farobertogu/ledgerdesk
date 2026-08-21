// test_APP_recordstage_escalates_without_model
//
// Four of the eight clauses are decidable from the ticket's own record: POLICY, RETRY, LANG and
// SLA. When one of them fires there is nothing to ask a model about — the guard on the escalation
// edge says a clause of the rule fired, not that an answer was attempted — and paying for an answer
// nobody will read is the wrong kind of thorough.
//
// So the measurement is negative as much as positive: the ticket escalates under the right code,
// AND the chain holds nothing for it. A cycle that called the model and then escalated anyway
// would satisfy every assertion about the ticket and would be wrong in the only place it costs
// money.
//
// The declared consequence, asserted rather than tolerated: such a ticket reaches ESCALATED with
// its category, severity and priority NULL. That is legal — 0008's invariant binds the reason and
// the clause and nothing else — and it is the honest picture of a decision taken before anything
// was known about the ticket's content.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  asOwner,
  auditRowsFor,
  cleanup,
  fileTicket,
  identities,
  ledgerRowsFor,
  RUN_ID,
  sessionFor,
  ticketRow,
  triage,
  waitForServer,
} from './harness.mjs';

describe('test_APP_recordstage_escalates_without_model', () => {
  let customer;
  let agent;
  let people;
  let accountId;

  before(async () => {
    await waitForServer();
    people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    agent = await sessionFor(people.northwindAgent.user_id);

    accountId = await asOwner(async (client) => {
      const result = await client.query('select id from account where org_id = $1 order by id limit 1', [
        people.northwindCustomer.org_id,
      ]);
      return result.rows[0].id;
    });
  });

  after(cleanup);

  /** A ticket written straight into the table, for the columns the intake does not let a test set. */
  async function park(fields) {
    return asOwner(async (client) => {
      const result = await client.query(
        `insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, dedupe_key,
                             language, retries, sla_due_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          people.northwindCustomer.org_id,
          accountId,
          people.northwindCustomer.user_id,
          `${fields.subject} [${RUN_ID}]`,
          fields.body,
          `apptest-${RUN_ID}-${fields.key}`,
          fields.language ?? 'en',
          fields.retries ?? 0,
          fields.slaDueAt ?? null,
        ],
      );
      return result.rows[0].id;
    });
  }

  /** Escalated under this reason, with nothing in the chain and nothing claimed about the content. */
  async function assertEscalatedWithoutCost(ticketId, reason, clause) {
    const row = await ticketRow(ticketId);
    assert.equal(row.status, 'ESCALATED', `the ticket is ${row.status}, not ESCALATED`);
    assert.equal(row.escalation_reason, reason);
    assert.equal(row.escalation_clause, clause);

    assert.equal(
      (await ledgerRowsFor(ticketId)).length,
      0,
      'the record settled it and the system called the model anyway',
    );

    assert.equal(row.category, null, 'a ticket nobody triaged carries a category');
    assert.equal(row.severity, null);
    assert.equal(row.sentiment, null);
    assert.equal(row.confidence, null);
    assert.equal(row.priority, null);
    assert.equal(row.body_redacted, null, 'a body was redacted for a call that never happened');

    const audit = await auditRowsFor(ticketId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'TICKET_ESCALATED');
    assert.equal(audit[0].detail.stage, 'record', 'the decision was filed as though a model had been asked');
    assert.equal(audit[0].detail.reason, reason);
  }

  it('escalates on a policy flag, through the real intake, without a call', async () => {
    // Filed by the customer through the portal's API, so the body is one a customer really could
    // write and the matcher really does see it.
    const filed = await fileTicket(customer, {
      subject: `Passing this to our solicitors [${RUN_ID}]`,
      body: 'We have asked twice and nothing has moved. Our solicitors have the file now and will be in touch about breach of contract.',
    });
    assert.equal(filed.status, 201);

    const cycle = await triage(agent, filed.body.tracking_id);
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body));
    assert.equal(cycle.body.triage.outcome, 'ESCALATED_AT_RECORD');
    assert.equal(cycle.body.triage.reason, 'POLICY');

    await assertEscalatedWithoutCost(filed.body.tracking_id, 'POLICY', 'policy_flag_raised');
  });

  it('escalates a ticket in a language it does not answer, without a call', async () => {
    const ticketId = await park({
      key: 'lang',
      subject: 'Consulta sobre la factura',
      body: 'La factura de este mes no coincide con lo acordado y necesitamos revisarla.',
      language: 'es-CO',
    });

    const cycle = await triage(agent, ticketId);
    assert.equal(cycle.body.triage.outcome, 'ESCALATED_AT_RECORD');
    await assertEscalatedWithoutCost(ticketId, 'LANG', 'language_out_of_scope');
  });

  it('escalates a breached ticket, without a call', async () => {
    const ticketId = await park({
      key: 'sla',
      subject: 'Waiting since last week',
      body: 'We raised this some time ago and have not heard back about the export schedule.',
      slaDueAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const cycle = await triage(agent, ticketId);
    assert.equal(cycle.body.triage.outcome, 'ESCALATED_AT_RECORD');
    await assertEscalatedWithoutCost(ticketId, 'SLA', 'sla_breached');
  });

  it('escalates a ticket whose retry budget is already spent, without a call', async () => {
    const ticketId = await park({
      key: 'retry',
      subject: 'Tried before',
      body: 'The report export keeps stopping halfway through and we have to start it again.',
      retries: 9,
    });

    const cycle = await triage(agent, ticketId);
    assert.equal(cycle.body.triage.outcome, 'ESCALATED_AT_RECORD');
    await assertEscalatedWithoutCost(ticketId, 'RETRY', 'retry_budget_exhausted');

    // The counter is not touched on the way past: the cycle did not attempt anything.
    assert.equal((await ticketRow(ticketId)).retries, 9);
  });

  it('records the reason the rule chose, not the first one that happened to be true', async () => {
    // Both POLICY and SLA hold. The published precedence puts POLICY first, because no column
    // carries the flags and `breached` is recoverable from `sla_due_at` by anyone who looks.
    const ticketId = await park({
      key: 'both',
      subject: 'Complaint, and it has been a while',
      body: 'I would like to raise a formal complaint about this, and we have had no reply for days.',
      slaDueAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await triage(agent, ticketId);
    await assertEscalatedWithoutCost(ticketId, 'POLICY', 'policy_flag_raised');

    // And the audit row carries the clause that did NOT survive the precedence, which is the whole
    // reason the decision is filed as well as stored.
    const [decision] = await auditRowsFor(ticketId);
    const sla = decision.detail.clauses.find((entry) => entry.clause === 'sla_breached');
    assert.equal(sla.fired, true, 'the audit lost the clause the precedence discarded');
  });
});
