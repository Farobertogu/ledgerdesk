// test_APP_intake_dedupe_collapses_to_incumbent
//
// A customer who clicks send twice raises one ticket, not two.
//
// The reason this matters in money rather than in tidiness: the chokepoint's cache is keyed on a
// digest of the input envelope, and that envelope carries the ticket identifier. Two tickets
// holding identical words are two different calls and two different charges. Every duplicate that
// is not absorbed here is paid for later, once, per duplicate.
//
// Four claims:
//
//   1. the same words inside the window fold into the ticket that already holds them, and the
//      customer is given that ticket's number with a 200 rather than a 201;
//   2. a burst of identical submissions arriving together folds into ONE ticket. This is the lock:
//      the uniqueness constraint alone cannot close the race, because each concurrent request that
//      sees no incumbent names ITSELF as the anchor of a new group and therefore builds a
//      different key. Both would insert. Nothing would fail;
//   3. a ticket that has been resolved is not an incumbent — a customer writing the same words
//      after a closure is raising the matter again, not clicking twice;
//   4. and the collapse is never a 500. A `23505` on that constraint is the same fact the lookup
//      reports and is answered the same way.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  asOwner,
  cleanup,
  fileTicket,
  identities,
  RUN_ID,
  sessionFor,
  ticketRow,
  waitForServer,
} from './harness.mjs';

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('test_APP_intake_dedupe_collapses_to_incumbent', () => {
  let customer;
  let org;

  before(async () => {
    await waitForServer();
    const people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    org = people.northwindCustomer.org_id;
  });

  after(cleanup);

  async function rowsWithDigest(digest) {
    return asOwner(async (client) => {
      const result = await client.query(
        'select id, status, created_at, dedupe_key from ticket where body_sha256 = $1 order by created_at',
        [digest],
      );
      return result.rows;
    });
  }

  it('folds a repeated submission into the ticket that already holds it', async () => {
    const body = `The invoice reference on our statement is missing again this month. [${RUN_ID}-once]`;
    const subject = `Missing invoice reference [${RUN_ID}]`;

    const first = await fileTicket(customer, { subject, body });
    assert.equal(first.status, 201, 'the first submission did not create a ticket');

    const second = await fileTicket(customer, { subject, body });
    assert.equal(second.status, 200, 'a duplicate was answered as though a ticket had been created');
    assert.equal(second.body.tracking_id, first.body.tracking_id, 'the duplicate got a number of its own');
    assert.equal(second.body.acknowledgement, first.body.acknowledgement);

    assert.equal((await rowsWithDigest(sha256Hex(body))).length, 1, 'the duplicate became a second row');
  });

  it('stores the digest and names the group by the instant that opened it', async () => {
    const body = `Our export destination list will not save the second entry. [${RUN_ID}-key]`;
    const filed = await fileTicket(customer, { subject: `Export list [${RUN_ID}]`, body });
    assert.equal(filed.status, 201);

    const row = await ticketRow(filed.body.tracking_id);
    assert.equal(row.body_sha256, sha256Hex(body), 'the stored digest is not the digest of the stored body');

    // The key is organisation, digest and the anchor instant — and the anchor has to be THIS row's
    // own created_at, or the five-minute window would be measured from an instant no row carries.
    // The instant is recomputed by the database rather than parsed here, so the comparison is
    // against what the row holds and not against a driver's rounding of it.
    const anchor = await asOwner(async (client) => {
      const result = await client.query(
        'select (floor(extract(epoch from created_at) * 1000))::bigint as ms from ticket where id = $1',
        [row.id],
      );
      return result.rows[0].ms;
    });
    assert.equal(row.dedupe_key, `${org}:${row.body_sha256}:${anchor}`);
  });

  it('folds a burst arriving together into one ticket', async () => {
    const body = `Two people pressed send on the same request about the warehouse feed. [${RUN_ID}-burst]`;
    const subject = `Warehouse feed [${RUN_ID}]`;

    const burst = await Promise.all(
      Array.from({ length: 5 }, () => fileTicket(customer, { subject, body })),
    );

    // Nothing fell over. This is also the whole of what can be asserted about the 23505 mapping
    // from out here: a conflict that reached the surface untranslated would be a 500, and there
    // are none. The constraint's name is checked separately below, because the mapping keys on it.
    for (const response of burst) {
      assert.ok(response.status < 500, `the intake answered ${response.status} under concurrency`);
      assert.ok([200, 201].includes(response.status), `unexpected status ${response.status}`);
    }

    const created = burst.filter((response) => response.status === 201);
    assert.equal(created.length, 1, `${created.length} of 5 concurrent duplicates created a ticket`);

    const trackingIds = new Set(burst.map((response) => response.body.tracking_id));
    assert.equal(trackingIds.size, 1, 'the burst produced more than one tracking number');
    assert.equal([...trackingIds][0], created[0].body.tracking_id);

    assert.equal((await rowsWithDigest(sha256Hex(body))).length, 1, 'the burst produced more than one row');
  });

  it('keys the collapse on the constraint the intake translates', async () => {
    // The mapping from a uniqueness violation to a collapse names this constraint. Renaming it
    // would turn a duplicate into a 500 with nothing else in the suite noticing.
    const exists = await asOwner(async (client) => {
      const result = await client.query(
        `select 1 from pg_constraint where conname = 'ticket_org_id_dedupe_key_key'`,
      );
      return result.rowCount === 1;
    });
    assert.ok(exists, 'ticket_org_id_dedupe_key_key no longer exists, so the collapse mapping is dead code');
  });

  it('does not fold into a ticket that has been resolved or closed', async () => {
    const body = `The password reset link expired before we could use it. [${RUN_ID}-terminal]`;
    const subject = `Reset link expired [${RUN_ID}]`;

    const first = await fileTicket(customer, { subject, body });
    assert.equal(first.status, 201);

    for (const terminal of ['RESOLVED', 'CLOSED']) {
      await asOwner((client) =>
        client.query('update ticket set status = $1 where id = $2', [terminal, first.body.tracking_id]),
      );

      const again = await fileTicket(customer, { subject, body });
      assert.equal(
        again.status,
        201,
        `a submission after a ${terminal} ticket was folded into it instead of raising the matter again`,
      );
      assert.notEqual(again.body.tracking_id, first.body.tracking_id);

      // The new ticket becomes the incumbent, so it is put out of the way before the next round.
      await asOwner((client) =>
        client.query('update ticket set status = $1 where id = $2', ['CLOSED', again.body.tracking_id]),
      );
    }
  });

  it('does not fold two different enquiries together', async () => {
    const subject = `Different questions [${RUN_ID}]`;
    const one = await fileTicket(customer, {
      subject,
      body: `Can we add a second recipient to the nightly report? [${RUN_ID}-a]`,
    });
    const two = await fileTicket(customer, {
      subject,
      body: `Can we add a third recipient to the nightly report? [${RUN_ID}-b]`,
    });

    assert.equal(one.status, 201);
    assert.equal(two.status, 201, 'two different bodies were treated as one submission');
    assert.notEqual(one.body.tracking_id, two.body.tracking_id);
  });

  it('leaves the seeded rows out of it, because they carry no digest', async () => {
    // 0008 adds `body_sha256` without a backfill, and ADR-023 §3 declares the consequence: a row
    // written before the column existed never takes part in the collapse, on either side.
    const seeded = await asOwner(async (client) => {
      const result = await client.query(
        'select body_raw from ticket where body_sha256 is null and dedupe_key = $1',
        ['nf-inv-10021'],
      );
      return result.rows[0] ?? null;
    });
    assert.ok(seeded, 'the seeded ticket is gone, so this declaration is no longer measurable here');

    const filed = await fileTicket(customer, {
      subject: `Same words as a seeded ticket [${RUN_ID}]`,
      body: seeded.body_raw,
    });
    assert.equal(filed.status, 201, 'a submission folded into a row that carries no digest');
    assert.notEqual(filed.body.tracking_id, null);
  });
});
