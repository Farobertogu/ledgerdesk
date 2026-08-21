// test_APP_draft_atomic_with_validation
//
// The twin of `test_APP_escalation_atomic_with_triage`, pointed at the cycle that makes two calls.
//
// The drafting cycle writes an answer and takes two edges — `TRIAGED → DRAFTED`, then
// `DRAFTED → AWAITING_AGENT` — and they are one transaction. The tempting shape is the other one:
// write the draft, move the ticket to `DRAFTED`, then validate. It reads naturally and each step
// commits what it achieved.
//
// It also leaves a ticket in `DRAFTED` that nothing will ever move. `DRAFTED` has exactly two exits
// and both belong to the validator; if the validation never happens, the ticket sits in a state
// whose only way out belongs to the step that just failed. There is no sweeper in this system and
// there is not meant to be one, so a state that needs one must not be reachable.
//
// The failure is injected where it matters — between the two edges — by a trigger that refuses the
// second. The database is the injector rather than a flag in the code: a code-level seam could be
// moved by the next refactor without anybody noticing that the property stopped being tested,
// whereas a write the database refuses is a fault the transaction has to survive whatever the code
// looks like.
//
// What has to be true afterwards:
//
//   · the ticket is back in `TRIAGED`, and the intermediate `DRAFTED` was never committed;
//   · NO answer row exists. An answer visible to a console, for a ticket whose state says nothing
//     was drafted, is the row a person would read and act on;
//   · no citation row, and no decision filed, because no decision took effect;
//   · and two rows ARE in the chain, paid for. That is the window the design declares and does not
//     pretend to close — the ledger rows commit inside the gateway's own transaction on its own
//     pool, and no distributed transaction exists to bind them to the ticket's.
//
// The recovery is the other half. The seed is an attempt index that restarts at zero, so the re-run
// sends the same digests, the chain answers both calls from the cache at zero cost, and the same
// answer is applied. The cache IS the idempotence mechanism, and this is where that is measured for
// a cycle that makes two calls rather than one.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  RUN_ID,
  asOwner,
  auditRowsFor,
  citationsFor,
  draft,
  fileTicket,
  identities,
  ledgerRowsFor,
  responsesFor,
  sessionFor,
  ticketRow,
  triage,
  waitForServer,
} from './harness.mjs';

const ANSWERABLE =
  'TRIAGE-FIXTURE-CLEAN Can the nightly export window be moved later so it does not overlap our ' +
  'own batch, and who is allowed to change it?';

// The trigger name sorts before `trg_ticket_state_evidence`, so this fault fires first and the
// refusal under test is the injected one rather than the guard 0009 installs.
const BLOCK = `
  create or replace function ledgerdesk_block_awaiting() returns trigger
    language plpgsql as $$
  begin
    if new.status = 'AWAITING_AGENT' then
      raise exception 'INJECTED_FAULT: the validated transition is refused';
    end if;
    return new;
  end $$;
  create trigger trg_ledgerdesk_block_awaiting before update on ticket
    for each row execute function ledgerdesk_block_awaiting();`;

const UNBLOCK = `
  drop trigger if exists trg_ledgerdesk_block_awaiting on ticket;
  drop function if exists ledgerdesk_block_awaiting();`;

describe('test_APP_draft_atomic_with_validation', () => {
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

  it('writes the answer and both edges together, or none of them', async () => {
    const filed = await fileTicket(customer, {
      subject: `Moving the nightly window [${RUN_ID}]`,
      body: ANSWERABLE,
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const ticketId = filed.body.tracking_id;

    const triaged = await triage(agent, ticketId);
    assert.equal(triaged.body.triage.outcome, 'TRIAGED');
    assert.equal(triaged.body.triage.escalated, false);

    // ---- the fault, between the two compare-and-sets -------------------------------------------
    await asOwner((client) => client.query(BLOCK));

    const refused = await draft(agent, ticketId);
    assert.equal(refused.status, 500, 'the injected fault did not reach the caller');
    assert.equal(refused.body.error.code, 'E_INTERNAL');

    const rolledBack = await ticketRow(ticketId);
    assert.equal(rolledBack.status, 'TRIAGED', 'the first compare-and-set committed without the second');

    assert.equal(
      (await responsesFor(ticketId)).length,
      0,
      'an answer is readable for a ticket whose state says nothing was drafted',
    );
    assert.equal(
      (await auditRowsFor(ticketId)).filter((row) => row.detail.stage === 'draft').length,
      0,
      'a drafting decision that took no effect was filed',
    );

    // The retry budget the triage cycle owns did not move. A failed draft must never spend it —
    // `retry_budget_exhausted` reads that counter and nothing else does.
    assert.equal(rolledBack.retries, 0, 'a failed drafting cycle advanced the triage retry counter');

    // The declared window: both answers were produced and paid for, and the ticket does not know.
    const afterFault = await ledgerRowsFor(ticketId);
    assert.equal(afterFault.length, 3, 'the two calls of the cycle are not both in the chain');
    assert.deepEqual(
      afterFault.map((row) => row.agent),
      ['triage', 'draft', 'validate'],
    );
    for (const row of afterFault.slice(1)) {
      assert.ok(Number(row.cost_aud) > 0, 'a call that happened is recorded as free');
      assert.equal(row.output.cache.hit, false);
    }

    // ---- the recovery ---------------------------------------------------------------------------
    await asOwner((client) => client.query(UNBLOCK));

    const recovered = await draft(agent, ticketId);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.draft.outcome, 'DRAFTED');
    assert.equal(recovered.body.draft.grounded, true);

    const settled = await ticketRow(ticketId);
    assert.equal(settled.status, 'AWAITING_AGENT');
    assert.equal(settled.escalation_reason, null);

    const [answer] = await responsesFor(ticketId);
    assert.ok(answer, 'the recovery wrote no answer');
    assert.equal(answer.grounded, true);
    assert.ok(answer.validated_at);
    assert.ok((await citationsFor(answer.id)).length > 0, 'the recovery wrote no citations');

    // The recovery cost nothing, because the seed is an attempt index that restarts at zero and the
    // chain already held both answers. This is the idempotence mechanism, measured for a pair.
    const chain = await ledgerRowsFor(ticketId);
    assert.equal(chain.length, 5, 'the recovery did not write its own honest rows');
    for (const row of chain.slice(3)) {
      assert.equal(row.output.cache.hit, true, 'the recovery paid for the same answer twice');
      assert.equal(row.cost_aud, '0.000000');
      assert.equal(Number(row.seed), 0, 'the attempt index did not restart at zero');
    }
    assert.equal(chain[3].response_hash, chain[1].response_hash, 'the recovery drafted something else');
    assert.equal(chain[4].response_hash, chain[2].response_hash, 'the recovery validated something else');

    // And the decisions are filed once, by the attempt that took effect.
    const drafting = (await auditRowsFor(ticketId)).filter(
      (row) => row.action === 'TICKET_DRAFTED' || row.action === 'TICKET_VALIDATED',
    );
    assert.equal(drafting.length, 2, 'the drafting cycle filed the wrong number of decisions');
  });

  it('leaves no ticket anywhere in DRAFTED once every cycle has settled', async () => {
    // The state exists in the machine and is passed THROUGH inside one transaction; it is never a
    // resting place. A ticket found sitting in it is a ticket nothing can move, and this is the
    // sweep that would find one.
    const stranded = await asOwner(async (client) => {
      const result = await client.query("select id::text as id from ticket where status = 'DRAFTED'");
      return result.rows.map((row) => row.id);
    });
    assert.deepEqual(stranded, [], 'a ticket is resting in DRAFTED, which has no exit but the validator');
  });
});
