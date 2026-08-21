// test_APP_composition_root_serves_two_orgs
//
// Two organisations starting their triage runtimes at the same instant, on a cold registry.
//
// This is a regression test for a deadlock, and the deadlock is worth describing because nothing
// about it is visible in a single-tenant run. The composition root holds one runtime per
// organisation and asserts that no two of them share a run. An earlier version asserted it by
// **awaiting the other organisation's in-flight runtime** — which is fine when the other one is
// already built, and is a mutual wait when it is not: A waits for B while B waits for A, with no
// timeout on either side. The request never answers. The server never recovers. And it only
// happens when two organisations start together, which is exactly what the demonstration does —
// its beats are spread across both seeded tenants.
//
// So the test starts both together and puts a deadline on it. **The deadline is the assertion**: a
// hang is the failure this file exists to catch, and a hang with no deadline is a CI job that runs
// until somebody kills it rather than a test that fails.
//
// This file runs FIRST in the application suite, and that placement is part of it. The registry is
// a process-wide cache: once any earlier test has triaged anything, the runtime it needed is
// already built and starting "together" starts nothing. A cold registry is only available once.
//
// **What this test does NOT do, measured rather than assumed.** It does not deterministically
// reproduce the deadlock. The window is narrow — both runtimes have to be registered before either
// passes its first await, and each request does several database round trips of its own before it
// gets there — and with the faulty assert deliberately restored, this file went green. It is a
// guard on the symptom, and it depends on luck to fire. The guard on the mechanism is
// `test_TRIAGE_run_registry_claims_without_awaiting`, which is deterministic, needs no server, and
// fails the moment the run claim becomes something that can be awaited. Both are kept: one says
// the two tenants really do compose end to end, the other says the thing that broke cannot break
// the same way again.
//
// It also exercises, incidentally, the one other thing two cold starts do at once: both register
// the triage prompt, and exactly one insert can win `unique (agent, generation)`.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  asOwner,
  fileTicket,
  identities,
  ledgerRowsFor,
  RUN_ID,
  sessionFor,
  ticketRow,
  triage,
  waitForServer,
} from './harness.mjs';

/** Generous for a preflight and two model calls; a rounding error away from forever. */
const DEADLINE_MS = 30_000;

const BODY = 'A short question about the reference on this month statement. TRIAGE-FIXTURE-CLEAN';

function withDeadline(work, what) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not answer within ${DEADLINE_MS}ms; the composition root is deadlocked`)),
      DEADLINE_MS,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

describe('test_APP_composition_root_serves_two_orgs', () => {
  let northwind;
  let corella;
  let people;
  /** The two tickets the first case triages, kept for the two that read what it wrote. */
  let ticketA;
  let ticketB;

  before(async () => {
    await waitForServer();
    people = await identities();
    northwind = {
      customer: await sessionFor(people.northwindCustomer.user_id),
      agent: await sessionFor(people.northwindAgent.user_id),
    };
    corella = {
      customer: await sessionFor(people.corellaCustomer.user_id),
      agent: await sessionFor(people.corellaAgent.user_id),
    };
  });

  // No cleanup: these tickets carry ledger rows, and the chain is append-only.

  it('builds both runtimes when both organisations arrive together', async () => {
    // Filed one after the other. The intake needs no runtime, so this warms nothing.
    const filedA = await fileTicket(northwind.customer, {
      subject: `Statement reference, Northwind [${RUN_ID}]`,
      body: `${BODY} [${RUN_ID}-nw]`,
    });
    const filedB = await fileTicket(corella.customer, {
      subject: `Statement reference, Corella [${RUN_ID}]`,
      body: `${BODY} [${RUN_ID}-ch]`,
    });
    assert.equal(filedA.status, 201);
    assert.equal(filedB.status, 201);
    ticketA = filedA.body.tracking_id;
    ticketB = filedB.body.tracking_id;

    // Both cycles start together on a cold registry. Before the fix this never returned.
    const [cycleA, cycleB] = await withDeadline(
      Promise.all([triage(northwind.agent, ticketA), triage(corella.agent, ticketB)]),
      'two organisations triaging at once',
    );

    assert.equal(cycleA.status, 200, `Northwind: ${JSON.stringify(cycleA.body)}`);
    assert.equal(cycleB.status, 200, `Corella: ${JSON.stringify(cycleB.body)}`);
    assert.equal(cycleA.body.triage.outcome, 'TRIAGED');
    assert.equal(cycleB.body.triage.outcome, 'TRIAGED');

    assert.equal((await ticketRow(ticketA)).status, 'TRIAGED');
    assert.equal((await ticketRow(ticketB)).status, 'TRIAGED');
  });

  it('gives each organisation a run of its own', async () => {
    // The invariant the claim exists for: a run whose rows belong to two organisations has a
    // writer proposing a `prev_hash` that the trigger rejects, for as long as anyone retries.
    const rowsA = await ledgerRowsFor(ticketA);
    const rowsB = await ledgerRowsFor(ticketB);

    assert.equal(rowsA.length, 1, 'Northwind wrote no ledger row');
    assert.equal(rowsB.length, 1, 'Corella wrote no ledger row');

    assert.notEqual(rowsA[0].run_id, rowsB[0].run_id, 'both organisations wrote into the same run');
    assert.equal(rowsA[0].org_id, people.northwindCustomer.org_id);
    assert.equal(rowsB[0].org_id, people.corellaCustomer.org_id);

    // Both runs opened at restart 0: this is the first process to write into either of them.
    assert.equal(rowsA[0].restarts, 0);
    assert.equal(rowsB[0].restarts, 0);
  });

  it('registers each prompt generation exactly once, however many organisations started', async () => {
    // Two cold starts both try to register the same generations. `unique (agent, generation)` admits
    // one of each; the loser has to read back what the winner wrote rather than assume the race went
    // its way. What is counted is the number of ROWS, so a second registration would show up here as
    // a duplicate rather than as a silent overwrite — which `prompt_version` would refuse anyway,
    // being immutable by trigger.
    const registered = await asOwner(async (client) => {
      const result = await client.query(
        `select agent::text as agent, generation, id::text as id, parent_id::text as parent_id,
                schema_hash
           from prompt_version order by agent, generation`,
      );
      return result.rows;
    });

    const byAgent = new Map();
    for (const row of registered) {
      byAgent.set(row.agent, [...(byAgent.get(row.agent) ?? []), row]);
    }

    // Three agents write prompts now. The drafting agent and the validator have one generation
    // each; triage has two, and the second one is why.
    assert.deepEqual([...byAgent.keys()].sort(), ['draft', 'triage', 'validate']);
    assert.equal(byAgent.get('draft').length, 1);
    assert.equal(byAgent.get('validate').length, 1);

    const triage = byAgent.get('triage');
    assert.equal(triage.length, 2, `${triage.length} triage prompts are registered`);
    assert.deepEqual(
      triage.map((row) => row.generation),
      [0, 1],
      'the triage lineage has a gap or a repeat',
    );

    // The lineage is a chain: the root has no parent and generation 1 names generation 0. Nothing
    // in the schema enforces that — `parent_id` accepts any row of the table — so it is checked.
    assert.equal(triage[0].parent_id, null, 'the root generation names a parent');
    assert.equal(triage[1].parent_id, triage[0].id, 'generation 1 does not descend from generation 0');

    // And the reason there are two: the contract moved. Generation 0 keeps the digest it was
    // registered under and generation 1 carries this build's, which is what makes the correction a
    // new row instead of an edit to an immutable one.
    assert.notEqual(
      triage[0].schema_hash,
      triage[1].schema_hash,
      'the two generations demand the same contract, so the second one had no reason to exist',
    );
    assert.equal(
      triage[1].schema_hash,
      byAgent.get('draft')[0].schema_hash,
      'the generation in force does not demand the contract this build publishes',
    );
  });
});
