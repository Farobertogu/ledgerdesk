// test_APP_retry_seed_from_persisted_counter
//
// The retry counter is a column, the seed is that column, and both halves of that sentence are
// load-bearing.
//
// **The seed has to move, or the retry is not a retry.** The chokepoint's cache is keyed on the
// input digest, the prompt, the state and the sampling parameters — the seed among them. Sampling
// runs at temperature zero, where the same seed is a fixed point. So a cycle that retried with an
// unchanged seed would ask the chain instead of the model, be served the SAME invalid envelope
// back, at zero cost, and fail on it again — four times, deterministically, having learned nothing
// and having asked nobody. The loop would look like it was retrying.
//
// **The counter has to be persisted, or the budget restarts with the process.** A counter living
// in the loop would be zero again after a crash, and a ticket that had already spent its retries
// would be handed a fresh set on every restart. It is also what makes the recovery cheap: a
// re-run after a crash sends the seed the column carries, and the chain answers.
//
// The measurement is the ledger rows themselves: four of them, seeds 0, 1, 2, 3, none of them a
// cache hit, each with a cost of its own — and a persisted counter that ends past the budget, which
// is why the ticket ends in ESCALATED under RETRY rather than stranded in TRIAGE_FAILED.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
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

/** The published default retry budget: the clause fires strictly above it. */
const MAX_RETRIES = 3;

const BODY =
  'The reconciliation screen shows a total that does not match the export, and we cannot tell which one is right. ' +
  'TRIAGE-FIXTURE-INVALID';

describe('test_APP_retry_seed_from_persisted_counter', () => {
  let customer;
  let agent;

  before(async () => {
    await waitForServer();
    const people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    agent = await sessionFor(people.northwindAgent.user_id);
  });

  // No cleanup: these tickets carry ledger rows, and the chain is append-only.

  it('advances the persisted counter before each attempt and seeds from it', async () => {
    const filed = await fileTicket(customer, {
      subject: `Reconciliation totals disagree [${RUN_ID}]`,
      body: BODY,
    });
    assert.equal(filed.status, 201);
    const ticketId = filed.body.tracking_id;
    assert.equal((await ticketRow(ticketId)).retries, 0, 'a fresh ticket has already retried something');

    const cycle = await triage(agent, ticketId);
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body));
    assert.equal(cycle.body.triage.outcome, 'FAILED');
    assert.equal(cycle.body.triage.code, 'E_SCHEMA');

    // ---- the counter -------------------------------------------------------------------------
    const row = await ticketRow(ticketId);
    assert.equal(
      row.retries,
      MAX_RETRIES + 1,
      'the cycle stopped somewhere other than one past the published budget',
    );

    // ---- the rows ----------------------------------------------------------------------------
    const chain = await ledgerRowsFor(ticketId);
    assert.equal(
      chain.length,
      MAX_RETRIES + 1,
      `the cycle made ${chain.length} attempts for a budget of ${MAX_RETRIES}`,
    );

    assert.deepEqual(
      chain.map((entry) => Number(entry.seed)),
      [0, 1, 2, 3],
      'the attempts did not seed from the counter, so the cache would answer them all',
    );

    for (const [index, entry] of chain.entries()) {
      assert.equal(
        entry.output.cache.hit,
        false,
        `attempt ${index} was served from the chain, so the model was never re-asked`,
      );
      assert.ok(
        Number(entry.cost_aud) > 0,
        `attempt ${index} cost nothing, which is what a cache hit costs`,
      );
      assert.equal(entry.class, 'agent_call');
      assert.equal(entry.agent, 'triage');
    }

    // Every attempt is a distinct call: the input digest is the same, the seed is not, and the
    // response therefore is not either.
    const inputs = new Set(chain.map((entry) => entry.input_hash));
    assert.equal(inputs.size, 1, 'the input changed between attempts, so the seed proved nothing');
    const seeds = new Set(chain.map((entry) => Number(entry.seed)));
    assert.equal(seeds.size, chain.length, 'two attempts shared a seed');

    // ---- where it ended ----------------------------------------------------------------------
    assert.equal(row.status, 'ESCALATED');
    assert.equal(row.escalation_reason, 'RETRY');
    assert.equal(row.escalation_clause, 'retry_budget_exhausted');

    const audit = await auditRowsFor(ticketId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail.stage, 'failure');
    assert.equal(audit[0].detail.failure_code, 'E_SCHEMA');
  });

  it('does not hand a ticket a fresh budget on the next cycle', async () => {
    // The ticket above is ESCALATED, which the triage agent has no edge out of, so the second
    // cycle abandons it before reading anything else. The counter is what would have been reset by
    // a loop-local variable, and it is still where the first cycle left it.
    const filed = await fileTicket(customer, {
      subject: `Budget is not refilled [${RUN_ID}]`,
      body: `A second body that also cannot be parsed. TRIAGE-FIXTURE-INVALID [${RUN_ID}]`,
    });
    const ticketId = filed.body.tracking_id;

    await triage(agent, ticketId);
    const first = await ticketRow(ticketId);
    assert.equal(first.retries, MAX_RETRIES + 1);

    const again = await triage(agent, ticketId);
    assert.equal(again.body.triage.outcome, 'SKIPPED');
    assert.equal(again.body.triage.status, 'ESCALATED');

    const second = await ticketRow(ticketId);
    assert.equal(second.retries, MAX_RETRIES + 1, 'the counter moved on a cycle that did nothing');
    assert.equal(
      (await ledgerRowsFor(ticketId)).length,
      MAX_RETRIES + 1,
      'the abandoned cycle called the provider',
    );
  });
});
