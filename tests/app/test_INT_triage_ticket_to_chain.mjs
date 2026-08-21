// test_INT_triage_ticket_to_chain
//
// The one test that measures the composition.
//
// Every other test in this repository measures a piece: the rule against a feature vector, the
// chokepoint against a database, the machine against an HTTP surface. Each of them passes with the
// system unable to triage a single ticket, and for six increments each of them did. What was never
// measured is the sentence the product is: **a customer files a ticket, the system asks a model,
// judges the answer, moves the ticket and can account for what it spent.** Three of those clauses
// live in three different processes' worth of code, and the seam between them is where the whole
// thing was broken.
//
// So: one database, one server, the real HTTP surface, the real policies, the real chain. The
// customer files through the portal's API. The agent fires the cycle through the endpoint that
// exists to fire one. Everything asserted about the ticket is read back with an owner connection —
// the database's own answer, not the application's — and everything asserted about the money is
// read out of `ledger_entry`, which is the row the gateway wrote inside its own transaction on its
// own pool. If the seam between those two is broken, this test is where it shows.
//
// The provider is the triage fixture, and the bodies below carry markers that pin its answer. A
// fixture derived from a digest would make the verdict a function of the subject line, and a test
// whose expected outcome moves when somebody rewords a fixture is a test nobody trusts.
//
// The four parts are the four claims of the card:
//
//   1. the ticket is filed and lands in NEW;
//   2. one cycle triages it, fills every column and leaves EXACTLY ONE paid row in the chain —
//      this is US-02, and the assertion that the row exists with a cost is the whole of it;
//   3. a second cycle over the same ticket costs nothing and moves nothing;
//   4. an answer that is not an envelope ends in TRIAGE_FAILED → ESCALATED with a named reason,
//      because a ticket stranded in TRIAGE_FAILED is a ticket nobody comes back for.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  auditRowsFor,
  fileTicket,
  identities,
  ledgerRowsFor,
  request,
  RUN_ID,
  sessionFor,
  ticketRow,
  triage,
  waitForServer,
} from './harness.mjs';

/**
 * The bodies. Each carries a marker the fixture provider answers to, and neither carries a word the
 * policy matcher raises a flag on — a ticket that escalated at the record stage would never reach
 * the model, and this test is about what happens when it does.
 */
const CLEAN_BODY =
  'Our nightly export finished but the summary count looks lower than usual for a Tuesday. ' +
  'Could you confirm which run produced it? TRIAGE-FIXTURE-CLEAN';

const UNPARSEABLE_BODY =
  'The dashboard shows two different totals on the same screen and we cannot tell which is right. ' +
  'TRIAGE-FIXTURE-INVALID';

describe('test_INT_triage_ticket_to_chain', () => {
  let customer;
  let agent;
  let org;

  before(async () => {
    await waitForServer();
    const people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    agent = await sessionFor(people.northwindAgent.user_id);
    org = people.northwindCustomer.org_id;
  });

  // No cleanup: the rows this test writes into the chain cannot be removed — `ledger_entry` is
  // append-only by trigger, for the owner too — so the tickets they point at cannot be deleted
  // either. The harness builds this database from nothing and drops it on the way out.

  it('carries a ticket from the portal to the chain and back', async () => {
    // ---- 1 · the customer files it -----------------------------------------------------------
    const filed = await fileTicket(customer, {
      subject: `Export summary count looks low [${RUN_ID}]`,
      body: CLEAN_BODY,
    });

    assert.equal(filed.status, 201, 'the ticket was not created');
    const ticketId = filed.body.tracking_id;
    assert.ok(ticketId, 'the acknowledgement carried no tracking number');
    assert.equal(filed.body.status, 'NEW');

    const filedRow = await ticketRow(ticketId);
    assert.equal(filedRow.status, 'NEW');
    assert.equal(filedRow.category, null, 'the intake decided something it has no business deciding');
    assert.equal(filedRow.severity, null);
    assert.equal(filedRow.sla_due_at, null, 'a deadline was set before a severity existed');
    assert.equal(filedRow.priority, null);
    assert.equal(filedRow.retries, 0);
    assert.ok(filedRow.body_sha256, 'the intake stored no digest, so nothing can be deduplicated');

    // ---- 2 · one cycle · THIS IS US-02 -------------------------------------------------------
    const cycle = await triage(agent, ticketId);
    assert.equal(cycle.status, 200, `the cycle was refused: ${JSON.stringify(cycle.body)}`);
    assert.equal(cycle.body.triage.outcome, 'TRIAGED');
    assert.equal(cycle.body.triage.escalated, false, 'the clean fixture escalated');
    assert.equal(cycle.body.ticket.status, 'TRIAGED');

    const triaged = await ticketRow(ticketId);
    assert.equal(triaged.status, 'TRIAGED');

    // Every column the cycle owns, and none of them left as an assumption.
    assert.equal(triaged.category, 'billing');
    assert.equal(triaged.severity, 2);
    assert.equal(triaged.sentiment, '0.100', 'the sentiment is not stored at the scale it was judged at');
    assert.equal(triaged.confidence, '0.920');
    assert.ok(triaged.body_redacted, 'the body the model saw was not persisted');
    assert.ok(triaged.sla_policy_id, 'no SLA policy was chosen for the severity that was assigned');
    assert.ok(triaged.sla_due_at, 'no first-response instant was computed');
    assert.ok(triaged.priority, 'the composite priority was not stored');

    // standard tier at severity 2 is a four-hour first response in the seeded policy family.
    const due = new Date(triaged.sla_due_at).getTime() - new Date(triaged.created_at).getTime();
    assert.equal(due, 240 * 60_000, 'the SLA instant is not created_at plus the policy window');

    // The priority is in range and is stored at the precision the ordering key uses.
    const priority = Number(triaged.priority);
    assert.ok(priority >= 0 && priority <= 1, `the stored priority ${triaged.priority} is not a score`);
    assert.match(triaged.priority, /^\d\.\d{6}$/, 'the priority is not stored at six decimals');

    assert.equal(triaged.escalation_reason, null, 'a ticket that did not escalate carries a reason');
    assert.equal(triaged.escalation_clause, null);

    // ---- 2b · exactly one paid row in the chain, and it is about this ticket ------------------
    const chain = await ledgerRowsFor(ticketId);
    assert.equal(chain.length, 1, `the cycle wrote ${chain.length} ledger rows for one answer`);

    const [row] = chain;
    assert.equal(row.class, 'agent_call');
    assert.equal(row.agent, 'triage');
    assert.equal(row.org_id, org);
    assert.ok(row.prompt_version_id, 'the row names no prompt version, so nothing could be replayed');
    assert.ok(row.input_hash && row.input_path, 'the reproducibility block is incomplete');
    assert.ok(row.state_hash, 'the row does not pin the conditions it ran under');
    assert.equal(Number(row.seed), 0, 'the first attempt did not seed from the persisted counter');
    assert.equal(row.output.cache.hit, false, 'the first call was served from a cache that was empty');

    assert.ok(Number(row.cost_aud) > 0, 'the call cost nothing, so nothing was actually asked');
    assert.ok(row.tokens_in > 0 && row.tokens_out > 0);
    assert.equal(
      row.confidence,
      '0.920',
      "the ledger's own reading of confidence disagrees with the validator's",
    );

    // The chain is the only place the money lives, and this is the first time the foreign key from
    // a ledger row to a real ticket has ever been exercised by a real ticket.
    assert.equal(row.ticket_id, ticketId);

    // ---- 2c · the decision was filed where a decision belongs ---------------------------------
    const audit = await auditRowsFor(ticketId);
    assert.equal(audit.length, 1, `the cycle filed ${audit.length} decisions for one verdict`);
    assert.equal(audit[0].action, 'TICKET_TRIAGED');
    assert.equal(audit[0].actor_id, null, 'a component was given a person as its actor');
    assert.equal(audit[0].detail.stage, 'triage');
    assert.equal(audit[0].detail.reason, null);
    assert.equal(audit[0].detail.clauses.length, 8, 'the audit does not carry every clause evaluated');
    assert.ok(audit[0].detail.ruleset_hash, 'the verdict was filed without the rules that produced it');
    assert.ok(
      !JSON.stringify(audit[0].detail).includes('nightly export'),
      'the audit row quoted the body, in a table nothing can edit',
    );

    // ---- 3 · a second cycle over the same ticket ----------------------------------------------
    const again = await triage(agent, ticketId);
    assert.equal(again.status, 200);
    assert.equal(again.body.triage.outcome, 'SKIPPED', 'the cycle ran again on a ticket it had triaged');
    assert.equal(again.body.triage.status, 'TRIAGED');

    assert.deepEqual(
      (await ledgerRowsFor(ticketId)).map((entry) => entry.id),
      chain.map((entry) => entry.id),
      'the second cycle called the provider again',
    );
    assert.equal((await auditRowsFor(ticketId)).length, 1, 'the second cycle filed a second decision');

    const unchanged = await ticketRow(ticketId);
    assert.equal(unchanged.status, 'TRIAGED', 'the second cycle moved the ticket');
    assert.equal(unchanged.priority, triaged.priority);
    assert.equal(unchanged.retries, 0);
  });

  it('ends an unparseable answer in ESCALATED under a named reason', async () => {
    const filed = await fileTicket(customer, {
      subject: `Two totals on one screen [${RUN_ID}]`,
      body: UNPARSEABLE_BODY,
    });
    assert.equal(filed.status, 201);
    const ticketId = filed.body.tracking_id;

    const cycle = await triage(agent, ticketId);
    assert.equal(cycle.status, 200, `the cycle was refused: ${JSON.stringify(cycle.body)}`);
    assert.equal(cycle.body.triage.outcome, 'FAILED');
    assert.equal(cycle.body.triage.code, 'E_SCHEMA', 'the failure was not the one the fixture produced');

    const failed = await ticketRow(ticketId);

    // ESCALATED and not TRIAGE_FAILED. TRIAGE_FAILED is a state with no edge out of it but the
    // escalation one, so a ticket left there is a ticket nobody comes back for — and the reason is
    // what tells a supervisor which pile it belongs in.
    assert.equal(failed.status, 'ESCALATED');
    assert.equal(failed.escalation_reason, 'RETRY', 'the retry budget was spent and the row does not say so');
    assert.equal(failed.escalation_clause, 'retry_budget_exhausted');

    // Nothing was learned about the ticket, so nothing about it is claimed.
    assert.equal(failed.category, null);
    assert.equal(failed.severity, null);
    assert.equal(failed.sentiment, null);
    assert.equal(failed.confidence, null);
    assert.equal(failed.priority, null);

    const audit = await auditRowsFor(ticketId);
    assert.equal(audit.at(-1).action, 'TICKET_ESCALATED');
    assert.equal(audit.at(-1).detail.failure_code, 'E_SCHEMA');

    // The state machine still refuses this edge to a person, which is what keeps the partition
    // {console: 3, guarded: 16, illegal: 81} true after this card.
    const byHand = await request(agent, `/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: { to: 'RESOLVED' },
    });
    assert.equal(byHand.status, 403, 'an agent closed out an escalation');
    assert.equal(byHand.body.error.code, 'E_ROLE_NOT_PERMITTED');
  });

  it('refuses the trigger to everyone but staff of the tickets own organisation', async () => {
    const people = await identities();
    const filed = await fileTicket(customer, {
      subject: `Standing on the trigger [${RUN_ID}]`,
      body: `A short question about the invoice reference. TRIAGE-FIXTURE-CLEAN`,
    });
    const ticketId = filed.body.tracking_id;

    const asCustomer = await triage(customer, ticketId);
    assert.equal(asCustomer.status, 403);
    assert.equal(asCustomer.body.error.code, 'E_ROLE_NOT_PERMITTED');

    const anonymous = await triage(null, ticketId);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'E_NO_SESSION');

    // The other organisation's agent is told the row is not visible rather than that the operation
    // was refused: the second answer would confirm the ticket exists.
    const otherOrg = await sessionFor(people.corellaAgent.user_id);
    const crossTenant = await triage(otherOrg, ticketId);
    assert.equal(crossTenant.status, 404);
    assert.equal(crossTenant.body.error.code, 'E_TICKET_NOT_VISIBLE');

    assert.equal((await ticketRow(ticketId)).status, 'NEW', 'a refused trigger ran the cycle anyway');
    assert.equal((await ledgerRowsFor(ticketId)).length, 0, 'a refused trigger spent money');
  });
});
