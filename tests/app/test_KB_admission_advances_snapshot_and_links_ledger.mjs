// test_KB_admission_advances_snapshot_and_links_ledger
//
// One admission, end to end, through the route a supervisor presses — and then every claim it makes
// checked against the rows it left behind.
//
// **What this measures that a schema test cannot.** The existing SQL suite proves that the TABLE
// refuses an admission with no approver, an approver from another organisation, and an advance that
// changes nothing. What it cannot reach is the writer: that the chain row comes first because the
// foreign key leaves no choice, that the admission row is derived from that chain row rather than
// asserted beside it, that the copy is a complete set rather than a delta, that the outgoing
// snapshot is left exactly as it was, and that the row of the chain pins the state the decision was
// taken under rather than the one it produced.
//
// **The state on the chain row is the OUTGOING snapshot, and that is the assertion this file exists
// for.** It is what makes that row the visible frontier between the two halves of the cycle: the
// rows before it name one corpus, the rows after it name another, and the row itself belongs to the
// side that decided.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  admissionsFor,
  admit,
  asOwner,
  cleanup,
  identities,
  restoreCorpusHead,
  ledgerRowsFor,
  sessionFor,
  snapshotHead,
  ticketWithAnOpenGap,
  waitForServer,
} from './harness.mjs';

/**
 * The beat this file spends.
 *
 * It ADMITS, so it holds a question of its own: the beats are lexically disjoint, and admitting the
 * answer to this one leaves every other test's enquiry as unanswerable as it was.
 */
const BEAT = 'pallet-weight-tolerance';

/**
 * And a different beat for the case that only needs an open gap.
 *
 * **Because the first case answers the first beat.** Once `ops/pallet-weight-tolerance` is in the
 * corpus, the pallet enquiry retrieves it — which is the whole point of having admitted it — so a
 * later case opening a gap on that same question would find the corpus able to answer, and the
 * preamble that expects nothing would be right to complain. The refusals below are about who may
 * admit, not about which question was asked, so they take a question nothing ever admits an answer
 * for.
 */
const UNANSWERED_BEAT = 'consignment-label-reprint';

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

describe('test_KB_admission_advances_snapshot_and_links_ledger', () => {
  it('writes the chain row first, derives the admission from it, and moves the pointer', async () => {
    const org = people.northwindSupervisor.org_id;
    const { ticketId, gap, beat: which } = await ticketWithAnOpenGap(customer, agent, BEAT, 'admit');
    const document = which.document;

    const before_ = await snapshotHead(org);
    const corpusBefore = await asOwner(async (client) => {
      const found = await client.query(
        'select count(*)::int as n from kb_article where org_id = $1 and kb_snapshot = $2',
        [org, before_],
      );
      return found.rows[0].n;
    });

    const response = await admit(supervisor, gap.id, document);
    assert.equal(response.status, 200, `the admission was refused: ${JSON.stringify(response.body)}`);

    const outcome = response.body.admission;
    assert.equal(outcome.snapshot_from, before_, 'the admission came from a corpus other than the one in force');
    assert.notEqual(outcome.snapshot_to, before_, 'an admission that changes nothing is not an admission');
    assert.equal(outcome.resumed, false, 'a first attempt reported itself as a resumption');

    // The pointer moved, and it moved to the label the admission declared.
    assert.equal(await snapshotHead(org), outcome.snapshot_to, 'the pointer did not follow the admission');

    // A snapshot is a complete set and never a delta: everything the outgoing one held, plus one.
    const corpusAfter = await asOwner(async (client) => {
      const found = await client.query(
        'select count(*)::int as n from kb_article where org_id = $1 and kb_snapshot = $2',
        [org, outcome.snapshot_to],
      );
      return found.rows[0].n;
    });
    assert.equal(
      corpusAfter,
      corpusBefore + 1,
      'the incoming snapshot is not the outgoing one plus the admitted document',
    );

    // And the outgoing one is untouched, which is what makes the replay of every run under it mean
    // something.
    const outgoingStill = await asOwner(async (client) => {
      const found = await client.query(
        'select count(*)::int as n from kb_article where org_id = $1 and kb_snapshot = $2',
        [org, before_],
      );
      return found.rows[0].n;
    });
    assert.equal(outgoingStill, corpusBefore, 'the advance disturbed the snapshot it copied from');

    // The admission row, derived field for field from the chain row rather than asserted beside it.
    const admissions = await admissionsFor(gap.id);
    assert.equal(admissions.length, 1, 'one admission, or the chain and the table disagree');
    const admission = admissions[0];
    assert.equal(admission.id, outcome.admission_id);
    assert.equal(admission.org_id, org);
    assert.equal(admission.approved_by, people.northwindSupervisor.user_id, 'the approver is not the person who pressed');
    assert.equal(admission.snapshot_from, before_);
    assert.equal(admission.snapshot_to, outcome.snapshot_to);
    assert.equal(admission.article_id, outcome.article_id, 'the admission does not name the article it admitted');
    assert.ok(admission.ledger_ref, 'an admission with no row of the chain behind it');

    // `content_hash` is a hash OF the body that was inserted, checked by the writer against the body
    // it actually wrote rather than against the one the caller declared.
    const article = await asOwner(async (client) => {
      const found = await client.query('select * from kb_article where id = $1', [outcome.article_id]);
      return found.rows[0];
    });
    assert.ok(article, 'the admitted article does not exist');
    assert.equal(article.kb_snapshot, outcome.snapshot_to);
    assert.equal(article.body, document.body, 'the body in the corpus is not the body admitted');
    assert.equal(admission.content_hash, article.body_sha256, 'the declared hash is not the hash of what was stored');

    // The chain row: its class, its ticket, its costs, and the state it pins.
    const rows = await ledgerRowsFor(ticketId);
    const chainRow = rows.find((row) => String(row.id) === String(admission.ledger_ref));
    assert.ok(chainRow, 'the admission names a chain row that is not on this ticket');
    assert.equal(chainRow.class, 'kb_admission');
    assert.equal(chainRow.agent, 'system', 'the admission is not a model call and does not claim to be');
    assert.equal(Number(chainRow.tokens_in), 0);
    assert.equal(Number(chainRow.tokens_out), 0);
    assert.equal(Number(chainRow.cost_aud), 0);
    assert.equal(
      chainRow.ticket_id,
      ticketId,
      'without the ticket the admission never appears in the panel that shows this cycle',
    );
    for (const key of [
      'admission_id',
      'gap_id',
      'approved_by',
      'snapshot_from',
      'snapshot_to',
      'content_hash',
      'provenance_source',
    ]) {
      assert.ok(chainRow.output[key], `the chain row does not name ${key}`);
    }
    assert.equal(chainRow.output.snapshot_from, before_);
    assert.equal(chainRow.output.snapshot_to, outcome.snapshot_to);

    // The state pins the OUTGOING corpus: every row written before this one names the same state,
    // and the rows written after it do not.
    const earlier = rows.filter((row) => Number(row.seq) < Number(chainRow.seq));
    assert.ok(earlier.length > 0, 'this ticket produced no rows before its admission');
    for (const row of earlier) {
      assert.equal(
        row.state_hash,
        chainRow.state_hash,
        'the admission pins a state none of the rows before it pinned, so it is not the frontier',
      );
    }
  });

  it('refuses an admission from anyone but a supervisor, and from a gap that is not open', async () => {
    const { gap, beat: which } = await ticketWithAnOpenGap(customer, agent, UNANSWERED_BEAT, 'role');
    const document = which.document;

    // An agent CAN see the gap — the read policy admits staff — so it gets as far as the role check
    // and is refused there, by name. This is the case where 403 is the right answer.
    const asAgent = await admit(agent, gap.id, document);
    assert.equal(asAgent.status, 403, 'an agent admitted material into the corpus');
    assert.equal(asAgent.body.error.code, 'E_ROLE_NOT_PERMITTED');

    // **A customer gets 404, and that is the stronger refusal rather than a weaker one.** The
    // restrictive read policy this card adds to `kb_gap` is staff-only, because a gap record carries
    // the ticket's own words; so a customer cannot see the record at all, the route reports it as
    // not visible, and the answer is identical to the one it gives for a gap that does not exist.
    //
    // An earlier version of this case expected 403 and was wrong about which property matters. A 403
    // would confirm the record EXISTS to somebody with no standing to know it does — the exact leak
    // that "visibility before role" is ordered to prevent, and the reason the route checks in that
    // order. The test now asserts the order rather than contradicting it.
    const asCustomer = await admit(customer, gap.id, document);
    assert.equal(asCustomer.status, 404, 'a customer learned that this gap record exists');
    assert.equal(asCustomer.body.error.code, 'E_TICKET_NOT_VISIBLE');

    // A gap of another organisation is not visible, and is reported as not visible rather than as a
    // refused operation — which would confirm that it exists.
    const corella = await sessionFor(people.corellaAgent.user_id);
    const foreign = await admit(corella, gap.id, document);
    assert.equal(foreign.status, 404, "another organisation's gap answered something other than 404");
  });
});
