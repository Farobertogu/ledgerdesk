// test_KB_gap_commitment_names_live_users_of_its_organisation
//
// The artefact that answers the two questions no machine can: **who owns closing this gap, and by
// when.** It is authored in advance, in the repository, because the moment those fields are needed
// is the worst one available for asking anybody — inside the server transaction that escalates a
// ticket, downstream of a retrieval that found nothing, with nobody in the loop.
//
// **An artefact of that kind is exactly as good as the people it names, and it names them by
// identifier.** A commitment pointing at somebody who has left resolves to nothing, and the failure
// surfaces at the worst possible instant: mid-escalation, on a path where a refusal used to take the
// escalation down with it. So the declaration is measured against the database here, in the fast
// job, for **every** organisation that has one — not only for the one the demonstration exercises.
//
// **`declared_by` is the question a reader asks second**, and until this card it had no answer: an
// owner assigned by a document nobody signed is an owner assigned by nobody, which is the failure
// the commitment exists to prevent, moved one level up. It is resolved exactly as the owner is.
//
// What is deliberately NOT here: a `kb_gap_duty` table, a document anchored in the ledger, and
// inference from the supervisor role. ADR-026 §1 records why each was rejected — the third most
// sharply, because one of the two seeded organisations has no supervisor at all, so the rule would
// produce no owner for it, silently, at the moment a retrieval failed.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  GAP_COMMITMENTS,
  commitmentViolations,
  committedDateFrom,
  gapCommitmentFor,
  todayUtc,
} from '../../src/server/kb/commitment.ts';

import { asOwner, cleanup, waitForServer } from './harness.mjs';

let users;
let orgs;

before(async () => {
  await waitForServer();
  const rows = await asOwner(async (client) => {
    const found = await client.query(
      `select u.id::text as id, u.org_id::text as org_id, u.role::text as role,
              o.name as org_name
         from app_user u join org o on o.id = u.org_id`,
    );
    return found.rows;
  });
  users = new Map(rows.map((row) => [row.id, row]));
  orgs = [...new Set(rows.map((row) => row.org_id))];
});

after(cleanup);

describe('test_KB_gap_commitment_names_live_users_of_its_organisation', () => {
  it('declares a commitment for every organisation that could raise a gap', () => {
    assert.ok(orgs.length > 0, 'the seed holds no organisations');
    for (const orgId of orgs) {
      // Not a soft check: an organisation with no commitment cannot emit a gap record at all, and
      // the failure would arrive mid-escalation rather than here.
      const commitment = gapCommitmentFor(orgId);
      assert.equal(commitment.org_id, orgId);
    }
    assert.equal(
      GAP_COMMITMENTS.length,
      orgs.length,
      'the declaration and the seed disagree about how many organisations there are',
    );
  });

  it('names an owner and a declarer who are live users of that same organisation', () => {
    for (const commitment of GAP_COMMITMENTS) {
      for (const [field, id] of [
        ['owner_id', commitment.owner_id],
        ['declared_by', commitment.declared_by],
      ]) {
        const person = users.get(id);
        assert.ok(
          person,
          `${commitment.ref} names ${id} as ${field} and no such user exists; a gap record for this ` +
            'organisation would be refused at the moment it was most needed',
        );
        assert.equal(
          person.org_id,
          commitment.org_id,
          `${commitment.ref} names a ${field} who belongs to another organisation`,
        );
      }
    }
  });

  it('does not infer the owner from a role, because one organisation has no supervisor', () => {
    // The rejected instantiation, measured rather than argued. "Whoever is the supervisor" reads
    // like the obvious rule and produces nothing at all for one of the two organisations seeded
    // here — silently, at the instant a retrieval fails.
    const withoutSupervisor = orgs.filter(
      (orgId) => ![...users.values()].some((u) => u.org_id === orgId && u.role === 'supervisor'),
    );
    assert.ok(
      withoutSupervisor.length > 0,
      'this case no longer measures anything: every organisation now seeds a supervisor',
    );
    for (const orgId of withoutSupervisor) {
      const commitment = gapCommitmentFor(orgId);
      assert.ok(
        users.get(commitment.owner_id),
        `${commitment.ref} covers an organisation with no supervisor and still names a real owner`,
      );
    }
  });

  it('is well formed: a term that commits to something, a note inside the cap, a date', () => {
    for (const commitment of GAP_COMMITMENTS) {
      assert.deepEqual(
        commitmentViolations(commitment),
        [],
        `${commitment.ref} is not fit to put on the channel`,
      );
      assert.match(commitment.declared_on, /^\d{4}-\d{2}-\d{2}$/);

      // **One day of tolerance, and it is not slack.** `declared_on` is a calendar day written by a
      // person in whatever zone they were in; "today" here is a day in UTC. The two disagree for
      // several hours out of every twenty-four, and this assertion failed on exactly that — an
      // artefact authored on the 24th read against a UTC clock that had not left the 23rd. What is
      // worth catching is a date that is wrong by a typo, not one that is ahead by a time zone.
      const tomorrow = todayUtc(Date.now() + 24 * 60 * 60 * 1000);
      assert.ok(
        commitment.declared_on <= tomorrow,
        `${commitment.ref} was declared on ${commitment.declared_on}, which is not a day that has happened anywhere`,
      );
    }
  });

  it('computes a committed date that is ahead of the day the gap is opened', () => {
    // The receiver refuses a record whose commitment has already run out, and the database refuses
    // one born overdue. Neither should ever have to fire, and this is why: the term is applied to
    // the instant the cycle is evaluated at, in the zone every date in this cycle is written in.
    const now = Date.UTC(2026, 7, 24, 23, 59, 0);
    for (const commitment of GAP_COMMITMENTS) {
      const committed = committedDateFrom(now, commitment.term_days);
      assert.match(committed, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(
        committed > todayUtc(now),
        `${commitment.ref} commits to ${committed}, which is not after ${todayUtc(now)}`,
      );
    }
  });
});
