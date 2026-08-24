// test_KB_gap_closes_only_by_verification
//
// A gap reaches `CLOSED` when the original query, re-run against the snapshot in force, comes back
// grounded on the admitted source — and by no other route at all.
//
// **The order of this file is the order of the argument.** First that the closure cannot be reached
// by hand, then that the re-run alone is not enough, then that the re-run against the admitted
// material is. A file that only demonstrated the last one would be demonstrating that a happy path
// works, which is not what the requirement says.
//
// **What "no application path" rests on, restated because the obvious reading is wrong.** The guard
// reads a session marker, and a session can set its own markers — `security definer` changes whose
// privileges the body runs under, not what the caller's session contains. So the closure is held
// shut by three things together: the guard refuses a state change with no marker; the check refuses
// a `CLOSED` row without the two witnesses; and the application role holds NO UPDATE on the table,
// which is the leg that actually holds. All three are exercised below.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  admit,
  asOwner,
  asTenant,
  beat,
  cleanup,
  gapsFor,
  identities,
  restoreCorpusHead,
  sessionFor,
  snapshotHead,
  ticketWithAnOpenGap,
  verifyGap,
  waitForServer,
} from './harness.mjs';

/** This file admits, so it holds a beat of its own. */
const BEAT = 'trailer-seal-reissue';

let people;
let orgUnderTest;
let seededHead;
let customer;
let agent;
let supervisor;

before(async () => {
  await waitForServer();
  people = await identities();
  orgUnderTest = people.northwindAgent.org_id;
  seededHead = await snapshotHead(orgUnderTest);
  customer = await sessionFor(people.northwindCustomer.user_id);
  agent = await sessionFor(people.northwindAgent.user_id);
  supervisor = await sessionFor(people.northwindSupervisor.user_id);
});

/**
 * The corpus goes back where this file found it.
 *
 * The runner sorts these files rather than running them in the order the list names, so a corpus
 * left moved is a corpus every alphabetically-later file reads — and four of them pin the seeded
 * snapshot by name. The admitted articles stay; only the pointer moves back. The refusal that moving
 * it arms is absorbed by `throughStaleRuntime`, on the next cycle-driving request.
 */
after(async () => {
  if (seededHead) await restoreCorpusHead(orgUnderTest, seededHead);
  await cleanup();
});

describe('test_KB_gap_closes_only_by_verification', () => {
  it('cannot be closed by hand: the role holds no UPDATE, and the guard refuses one anyway', async () => {
    const { gap } = await ticketWithAnOpenGap(customer, agent, BEAT, 'byhand');
    const claims = { org_id: people.northwindAgent.org_id, role: 'agent', sub: people.northwindAgent.user_id };

    // The leg that actually holds: there is no hand.
    const denied = await asTenant(claims, async (client) => {
      try {
        await client.query("update kb_gap set state = 'CLOSED' where id = $1", [gap.id]);
        return null;
      } catch (error) {
        return String(error.message ?? error);
      }
    });
    assert.ok(denied, 'the application role updated a gap record, so a gap can be closed by hand');
    assert.match(denied, /permission denied/i, denied);

    // And the guard, exercised where a role that COULD update still cannot change the state without
    // the marker only the closing function sets.
    const guarded = await asOwner(async (client) => {
      await client.query('begin');
      try {
        await client.query("update kb_gap set state = 'CLOSED' where id = $1", [gap.id]);
        return null;
      } catch (error) {
        return String(error.message ?? error);
      } finally {
        await client.query('rollback');
      }
    });
    assert.ok(guarded, 'a state change with no marker was accepted');
    assert.match(guarded, /E_KB_GAP_CIERRE_NO_VERIFICADO/, guarded);

    const still = await gapsFor(gap.ticket_id);
    assert.equal(still[0].state, 'OPEN', 'the gap moved after two refusals');
  });

  it('does not close on a re-run against a corpus nothing was admitted into', async () => {
    const { gap } = await ticketWithAnOpenGap(customer, agent, BEAT, 'early');

    const early = await verifyGap(agent, gap.id);
    assert.equal(early.status, 200, `the re-run was refused: ${JSON.stringify(early.body)}`);
    assert.equal(
      early.body.verification.outcome,
      'STILL_OPEN',
      'a gap closed against a corpus that had not changed',
    );
    assert.match(
      early.body.verification.because,
      /no material has been admitted/i,
      early.body.verification.because,
    );

    const rows = await gapsFor(gap.ticket_id);
    assert.equal(rows[0].state, 'OPEN');
    assert.equal(rows[0].closed_by_check_at, null, 'a gap that did not close carries a closing witness');
  });

  it('closes on the re-run that cites the admitted source, and carries both witnesses', async () => {
    const { ticketId, gap, beat: which } = await ticketWithAnOpenGap(
      customer,
      agent,
      BEAT,
      'close',
    );

    const admitted = await admit(supervisor, gap.id, which.document);
    assert.equal(admitted.status, 200, `the admission was refused: ${JSON.stringify(admitted.body)}`);

    const verified = await verifyGap(agent, gap.id);
    assert.equal(verified.status, 200, `the re-run was refused: ${JSON.stringify(verified.body)}`);
    assert.equal(
      verified.body.verification.outcome,
      'CLOSED',
      `the gap did not close: ${verified.body.verification.because ?? ''}`,
    );
    assert.equal(
      verified.body.verification.canonical_key,
      which.document.canonical_key,
      'the closure named a key other than the one admitted',
    );

    const rows = await gapsFor(ticketId);
    const closed = rows.find((row) => row.id === gap.id);
    assert.equal(closed.state, 'CLOSED');
    assert.ok(closed.closed_by_check_at, 'a closed gap with no verification instant');
    assert.ok(closed.closing_ledger_ref, 'a closed gap with no row of the chain to prove it');

    // The witness is the answer's OWN validation row, not a row number somebody supplied. Checked by
    // reading it back off the response the re-run wrote.
    const witness = await asOwner(async (client) => {
      const found = await client.query(
        'select validate_ledger_ref, grounded, kb_snapshot from response where id = $1',
        [verified.body.verification.response_id],
      );
      return found.rows[0];
    });
    assert.equal(
      String(closed.closing_ledger_ref),
      String(witness.validate_ledger_ref),
      'the closing witness is not the validation that decided the answer was anchored',
    );
    assert.equal(witness.grounded, true, 'the answer that closed the gap is not grounded');
    assert.notEqual(
      witness.kb_snapshot,
      gap.kb_snapshot,
      'the answer was produced under the same corpus the gap was opened against',
    );

    // The ticket did not move. The escalation put it in somebody's queue and the verification is not
    // entitled to take it back out.
    const ticket = await asOwner(async (client) => {
      const found = await client.query('select status from ticket where id = $1', [ticketId]);
      return found.rows[0];
    });
    assert.equal(ticket.status, 'ESCALATED', 'the verification moved a ticket it does not own');

    // And a second verification finds nothing to do rather than closing it twice.
    const again = await verifyGap(agent, gap.id);
    assert.equal(again.status, 200);
    assert.equal(again.body.verification.outcome, 'STILL_OPEN');
    assert.match(again.body.verification.because, /is CLOSED/, again.body.verification.because);
  });
});
