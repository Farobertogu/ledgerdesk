// test_SEC_non_citable_material_is_never_retrieved
//
// `citable` has been a column since the first migration and nothing read it. With a corpus only a
// seed wrote, every row was citable and the omission cost exactly nothing — which is why it survived
// three increments without anybody noticing.
//
// An admission is where it stops being free. The supervisor admitting a document is asked, in as
// many words, whether it may be quoted to a customer, and a retrieval that ignored the answer would
// hand a model an excerpt of a document whose own approver said no. The reply would then cite it,
// correctly, because everything downstream of the retrieval is entitled to quote what it was given:
// the filter has to be at the query or it is nowhere.
//
// **What this measures, and what it deliberately does not.** It measures that the document is
// invisible to the search — not that it is invisible to the database. The row exists, it is in the
// corpus, it carries its provenance and its approver, and a person with a reason to look at the
// corpus can see it. That is the intended shape: non-citable is *not quotable*, not *not recorded*.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { TEXT_SEARCH_CONFIG } from '../../src/alg/retrieval.ts';

import {
  admissionsFor,
  admit,
  asOwner,
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
const BEAT = 'reefer-alarm';

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

describe('test_SEC_non_citable_material_is_never_retrieved', () => {
  it('admits the document, records it, and never returns it to a search', async () => {
    const org = people.northwindSupervisor.org_id;
    const { ticketId, gap, beat: which } = await ticketWithAnOpenGap(
      customer,
      agent,
      BEAT,
      'citable',
    );

    const admitted = await admit(supervisor, gap.id, { ...which.document, citable: false });
    assert.equal(admitted.status, 200, `the admission was refused: ${JSON.stringify(admitted.body)}`);

    // It is in the corpus. That is the point: it is recorded, with its approver and its provenance,
    // and what it is not is quotable.
    const head = await snapshotHead(org);
    const stored = await asOwner(async (client) => {
      const found = await client.query(
        'select id, citable, canonical_key from kb_article where id = $1',
        [admitted.body.admission.article_id],
      );
      return found.rows[0];
    });
    assert.ok(stored, 'the admitted document is not in the corpus at all');
    assert.equal(stored.citable, false, 'the citability decision was not carried into the corpus');
    assert.equal(stored.canonical_key, which.document.canonical_key);

    const admissions = await admissionsFor(gap.id);
    assert.equal(admissions.length, 1, 'a non-citable admission left no record of itself');

    // And it is invisible to the search that would quote it. The document matches the query — that
    // is measured first, without the filter, so a false pass cannot come from a query that simply
    // finds nothing.
    const withoutTheFilter = await asOwner(async (client) => {
      const found = await client.query(
        `select a.canonical_key
           from kb_article a
          where a.org_id = $1 and a.kb_snapshot = $2
            and to_tsvector('${TEXT_SEARCH_CONFIG}', a.title || ' ' || a.body)
                @@ plainto_tsquery('${TEXT_SEARCH_CONFIG}', $3)`,
        [org, head, 'refrigeration alarm reefer unit'],
      );
      return found.rows.map((row) => row.canonical_key);
    });
    assert.ok(
      withoutTheFilter.includes(which.document.canonical_key),
      'this case is not measuring what it says it is: the document does not match its own question',
    );

    // Now through the cycle that would quote it. The re-run finds nothing, so the gap stays open —
    // which is the honest outcome: material that may not be quoted cannot close a gap by being
    // quoted.
    const verified = await verifyGap(agent, gap.id);
    assert.equal(verified.status, 200, `the re-run was refused: ${JSON.stringify(verified.body)}`);
    assert.equal(
      verified.body.verification.outcome,
      'STILL_OPEN',
      'a gap closed on material whose approver said it may not be quoted',
    );
    assert.match(
      verified.body.verification.because,
      /still matches nothing/i,
      verified.body.verification.because,
    );

    const rows = await gapsFor(ticketId);
    assert.equal(rows.find((row) => row.id === gap.id).state, 'OPEN');
  });
});
