// test_APP_escalation_atomic_with_triage
//
// When a verdict fires on a fresh answer, the ticket takes TWO edges: `NEW → TRIAGED`, then
// `TRIAGED → ESCALATED`. They are two compare-and-sets and they are one transaction, and this is
// the measurement of that.
//
// The failure is injected where it matters — **between the two** — by a trigger that refuses the
// second one. The database is the injector rather than a flag in the code, and that is deliberate:
// a code-level seam could be moved by the next refactor without anybody noticing that the property
// stopped being tested, whereas a write the database refuses is a fault the transaction has to
// survive whatever the code looks like.
//
// What has to be true afterwards:
//
//   · the ticket is back in NEW, with none of the six triage columns written. Columns in one
//     transaction and the state in another would leave a NEW ticket carrying half a verdict;
//   · the intermediate TRIAGED was never committed, so nothing — a console, a query, another
//     cycle — could ever have seen it. There is no history table for it to be missing from and no
//     sweeper anywhere that would come looking for a ticket stranded between the two;
//   · no decision was filed, because no decision took effect;
//   · and a row IS in the chain, paid for. That is the window the design declares and does not
//     pretend to close: the ledger row commits inside the gateway's own transaction on its own
//     pool, and no distributed transaction exists to bind it to the ticket's.
//
// The recovery is the other half, and it is why the window is survivable. The retry counter did
// not move — this was not a retryable failure — so the second cycle sends the same seed, the chain
// answers from the cache at zero cost, and the same verdict is applied. The cache IS the idempotence
// mechanism, and the test proves it by asserting the second row is a hit.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  asOwner,
  auditRowsFor,
  fileTicket,
  identities,
  ledgerRowsFor,
  RUN_ID,
  sessionFor,
  ticketRow,
  triage,
  waitForServer,
} from './harness.mjs';

/** A body the fixture answers with a sentiment below the threshold, so the verdict fires. */
const ANGRY_BODY =
  'This is the third time the same charge has come through and nobody has called back. ' +
  'TRIAGE-FIXTURE-ANGRY';

const BLOCK = `
  create or replace function ledgerdesk_block_escalation() returns trigger
    language plpgsql as $$
  begin
    if new.status = 'ESCALATED' then
      raise exception 'INJECTED_FAULT: the escalation write is refused';
    end if;
    return new;
  end $$;
  create trigger trg_ledgerdesk_block_escalation before update on ticket
    for each row execute function ledgerdesk_block_escalation();`;

const UNBLOCK = `
  drop trigger if exists trg_ledgerdesk_block_escalation on ticket;
  drop function if exists ledgerdesk_block_escalation();`;

describe('test_APP_escalation_atomic_with_triage', () => {
  let customer;
  let agent;

  before(async () => {
    await waitForServer();
    const people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    agent = await sessionFor(people.northwindAgent.user_id);
  });

  // Belt and braces: the trigger is global to the table for as long as it exists, so it is dropped
  // in the test AND again here. A suite that left it behind would fail every later file with a
  // fault nobody injected.
  after(async () => {
    await asOwner((client) => client.query(UNBLOCK));
  });

  it('applies both edges together or neither of them', async () => {
    const filed = await fileTicket(customer, {
      subject: `Third time the same charge [${RUN_ID}]`,
      body: ANGRY_BODY,
    });
    assert.equal(filed.status, 201);
    const ticketId = filed.body.tracking_id;

    // ---- the fault, between the two compare-and-sets -----------------------------------------
    await asOwner((client) => client.query(BLOCK));

    const refused = await triage(agent, ticketId);
    assert.equal(refused.status, 500, 'the injected fault did not reach the caller');
    assert.equal(refused.body.error.code, 'E_INTERNAL');

    const rolledBack = await ticketRow(ticketId);
    assert.equal(rolledBack.status, 'NEW', 'the first compare-and-set committed without the second');
    assert.equal(rolledBack.category, null, 'a NEW ticket is carrying half a verdict');
    assert.equal(rolledBack.severity, null);
    assert.equal(rolledBack.sentiment, null);
    assert.equal(rolledBack.confidence, null);
    assert.equal(rolledBack.priority, null);
    assert.equal(rolledBack.sla_due_at, null);
    assert.equal(rolledBack.body_redacted, null);
    assert.equal(rolledBack.escalation_reason, null);
    assert.equal(rolledBack.retries, 0, 'a failure that is not retryable advanced the retry budget');

    assert.equal((await auditRowsFor(ticketId)).length, 0, 'a decision that took no effect was filed');

    // The declared window: the answer was produced and paid for, and the ticket does not know.
    const afterFault = await ledgerRowsFor(ticketId);
    assert.equal(afterFault.length, 1, 'the model was asked and the chain does not say so');
    assert.ok(Number(afterFault[0].cost_aud) > 0);
    assert.equal(afterFault[0].output.cache.hit, false);
    assert.equal(Number(afterFault[0].seed), 0);

    // ---- the recovery ------------------------------------------------------------------------
    await asOwner((client) => client.query(UNBLOCK));

    const recovered = await triage(agent, ticketId);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.triage.outcome, 'TRIAGED');
    assert.equal(recovered.body.triage.escalated, true);
    assert.equal(recovered.body.triage.reason, 'SENT');

    const settled = await ticketRow(ticketId);
    assert.equal(settled.status, 'ESCALATED');
    assert.equal(settled.escalation_reason, 'SENT');
    assert.equal(settled.escalation_clause, 'sentiment_at_or_below_threshold');

    // The columns of the intermediate state are all there: the escalation did not replace the
    // triage, it followed it inside the same transaction.
    assert.equal(settled.category, 'billing');
    assert.equal(settled.severity, 3);
    assert.equal(settled.sentiment, '-0.800');
    assert.equal(settled.confidence, '0.910');
    assert.ok(settled.priority, 'the escalated ticket carries no priority, so the queue cannot order it');
    assert.ok(settled.sla_due_at);

    // The recovery cost nothing, because the seed did not move and the chain already held the
    // answer. This is the idempotence mechanism, measured rather than described.
    const chain = await ledgerRowsFor(ticketId);
    assert.equal(chain.length, 2, 'the recovery did not write its own honest row');
    assert.equal(chain[1].output.cache.hit, true, 'the recovery paid for the same answer twice');
    assert.equal(chain[1].cost_aud, '0.000000');
    assert.equal(chain[1].response_hash, chain[0].response_hash, 'the recovery got a different answer');
    assert.equal(Number(chain[1].seed), 0, 'the recovery did not send the persisted counter');

    const audit = await auditRowsFor(ticketId);
    assert.equal(audit.length, 1, 'the recovery filed more than one decision');
    assert.equal(audit[0].action, 'TICKET_ESCALATED');
    assert.equal(audit[0].detail.stage, 'triage');
    assert.equal(audit[0].detail.clause, 'sentiment_at_or_below_threshold');

    // Every clause is in the record, fired or not. The columns keep one reason; the chain keeps
    // the whole evaluation, which is what survives a reopen overwriting the columns later.
    assert.equal(audit[0].detail.clauses.length, 8);
    const fired = audit[0].detail.clauses.filter((entry) => entry.fired).map((entry) => entry.clause);
    assert.deepEqual(fired, ['sentiment_at_or_below_threshold']);
  });
});
