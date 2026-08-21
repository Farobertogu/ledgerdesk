// test_KB_retrieval_order_is_total
//
// Rank alone is a PARTIAL order, and this is what that costs.
//
// Two articles with equal `ts_rank_cd` come back in whatever order the plan produced. That order is
// perfectly stable — until the day the planner picks a different scan, because a table grew, because
// statistics were refreshed, because a version changed. The tied excerpts go into the envelope in
// that order; the envelope is digested into `input_hash`; the digest is the cache key. So a re-plan
// that swaps two tied rows produces a different key for the same question, and a rehearsal that
// expected a cache hit gets `E_REPLAY_CACHE_MISS` — in front of an audience, on a run that was
// working the day before, for a reason nobody can see in any diff.
//
// The published order is `rank desc, canonical_key collate "C" asc, id asc`, and the tiebreak pair
// cannot itself tie: `(kb_snapshot, canonical_key, id)` is unique.
//
// `collate "C"` is the half of the tiebreak that would otherwise have undone the rest, and it has a
// case of its own at the bottom of this file: a bare `order by` on a text column sorts under the
// DATABASE's collation, and a linguistic collation ignores punctuation on its first pass. Canonical
// keys carry `/` and `-` by construction, so the tiebreak written to make the order reproducible
// across clean clones was itself a property of how somebody's PostgreSQL had been initialised.
//
// **What is observed, and why it is observable at all.** The order the retrieval produced is the
// order the excerpts entered the message, which is the order the drafting fixture cites them in —
// and the fixture's envelope is stored verbatim in the ledger row of that call. So the row is a
// faithful record of the sequence, and reading `draft.kb_ids` out of it is reading what the
// retrieval actually did rather than re-running a copy of its query.
//
// The articles are inserted with IDENTICAL text, so the tie is not a coincidence to be hoped for:
// equal tsvectors give equal ranks for every possible query, which means the order below can only
// have come from the tiebreak.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  RUN_ID,
  asOwner,
  draft,
  fileTicket,
  identities,
  ledgerRowsFor,
  sessionFor,
  triage,
  waitForServer,
} from './harness.mjs';

const SNAPSHOT = 'kb-2026-08-01';

/**
 * One body, three articles.
 *
 * The vocabulary is deliberately unlike anything else in the corpus or in any other test's ticket:
 * these articles live in the same organisation as the demonstration's and must not start answering
 * its questions.
 */
const BODY =
  'Torque calibration of a widget requires a certified wrench and an annual calibration certificate.';

/**
 * Two canonical keys and three identities, ordered so that both tiebreaks are exercised:
 * `alpha` before `beta` by key, and within `alpha`, the lower identity first.
 */
const ARTICLES = [
  { id: 'f0de0001-0000-4000-8000-000000000001', key: 'zz-order/alpha' },
  { id: 'f0de0002-0000-4000-8000-000000000001', key: 'zz-order/alpha' },
  { id: 'f0de0003-0000-4000-8000-000000000001', key: 'zz-order/beta' },
];

const QUESTION =
  'TRIAGE-FIXTURE-CLEAN Does a widget torque calibration require a certified wrench, and is the ' +
  'calibration certificate annual?';

/** The identifier as the retrieval mints it. Transcribed rather than imported; see `kbIdOf`. */
const kbId = (article) => `${article.key}:${article.id.replace(/-/g, '')}`;

describe('test_KB_retrieval_order_is_total', () => {
  let customer;
  let agent;
  let orgId;

  before(async () => {
    await waitForServer();
    const people = await identities();
    customer = await sessionFor(people.northwindCustomer.user_id);
    agent = await sessionFor(people.northwindAgent.user_id);
    orgId = people.northwindCustomer.org_id;

    await asOwner(async (client) => {
      for (const article of ARTICLES) {
        await client.query(
          `insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
           values ($1, $2, $3, $4, $5, $6, encode(sha256(convert_to($6, 'UTF8')), 'hex'), true)
           on conflict (id) do nothing`,
          [article.id, orgId, SNAPSHOT, article.key, 'Widget torque calibration', BODY],
        );
      }
    });
  });

  it('gives the three articles a genuine rank tie, which is the premise of everything below', async () => {
    const ranks = await asOwner(async (client) => {
      const result = await client.query(
        `with lexemes as (
           select string_agg(quote_literal(lexeme), ' | ' order by lexeme) as expression
             from unnest(to_tsvector('english', $1)) as t(lexeme, positions, weights)
         ),
         q as (select to_tsquery('english', expression) as query from lexemes)
         select a.id::text as id, a.canonical_key,
                ts_rank_cd(to_tsvector('english', a.title || ' ' || a.body), q.query)::text as rank
           from kb_article a cross join q
          where a.id = any($2::uuid[])
          order by a.canonical_key, a.id`,
        [QUESTION, ARTICLES.map((article) => article.id)],
      );
      return result.rows;
    });

    assert.equal(ranks.length, 3, 'the fixture articles were not inserted');
    const distinct = new Set(ranks.map((row) => row.rank));
    assert.equal(
      distinct.size,
      1,
      `the three articles do not tie (${[...distinct].join(', ')}), so the order below could come from rank`,
    );
    assert.ok(Number(ranks[0].rank) > 0, 'the tie is a tie at zero, which no query would return');
  });

  it('breaks the tie by canonical key and then by identity, in that order', async () => {
    const filed = await fileTicket(customer, {
      subject: `Widget torque calibration [${RUN_ID}]`,
      body: QUESTION,
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const ticketId = filed.body.tracking_id;

    const triaged = await triage(agent, ticketId);
    assert.equal(triaged.body.triage.outcome, 'TRIAGED');
    assert.equal(triaged.body.triage.escalated, false);

    const drafted = await draft(agent, ticketId);
    assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
    assert.equal(drafted.body.draft.outcome, 'DRAFTED', JSON.stringify(drafted.body.draft));

    const chain = await ledgerRowsFor(ticketId);
    const draftRow = chain.find((row) => row.agent === 'draft');
    assert.ok(draftRow, 'the drafting call left no row');

    const envelope = JSON.parse(draftRow.output.response);
    assert.deepEqual(
      envelope.draft.kb_ids,
      ARTICLES.map(kbId),
      'the retrieval returned the tied articles in an order the published rule does not produce',
    );
  });

  it('produces the same order on an independent second call', async () => {
    // A different ticket with the same words: a different `input_hash`, so a real call rather than
    // a cache hit — which is what makes this a second observation of the ordering and not a second
    // reading of the first one.
    const filed = await fileTicket(customer, {
      subject: `Widget torque calibration again [${RUN_ID}]`,
      // The twin differs by words that stem to nothing in ANY seeded article, so its digest is its
      // own and the set of documents it retrieves is unchanged. A filler that happened to share a
      // lexeme with another article would pull a fourth source in, and the comparison below would
      // be comparing two different retrievals rather than two runs of one.
      body: `${QUESTION} Thanks in advance.`,
    });
    const ticketId = filed.body.tracking_id;

    await triage(agent, ticketId);
    const drafted = await draft(agent, ticketId);
    assert.equal(drafted.body.draft.outcome, 'DRAFTED', JSON.stringify(drafted.body.draft));

    const chain = await ledgerRowsFor(ticketId);
    const draftRow = chain.find((row) => row.agent === 'draft');
    assert.equal(draftRow.output.cache.hit, false, 'the second observation was served from the first');

    const envelope = JSON.parse(draftRow.output.response);
    assert.deepEqual(envelope.draft.kb_ids, ARTICLES.map(kbId), 'two calls ordered the tie differently');
  });

  it('breaks the tie in BYTE order, not in the collation the database happens to hold', async () => {
    // The fixture articles above sort the same way under either collation, so they cannot show this
    // on their own — which is exactly how the fault survived being written. The two orderings are
    // compared directly instead, over keys of the shape canonical keys actually take.
    //
    // Nothing is inserted for this: the pair is a literal list, so the case measures the property
    // without adding a document that other tests' tickets could start retrieving.
    const KEYS = ['exports/destinations', 'exports-legacy/alpha', 'exportsX/beta'];

    const [database, binary] = await asOwner(async (client) => {
      const result = await client.query(
        `with k(v) as (select unnest($1::text[]))
         select (select string_agg(v, '|' order by v)              from k) as database_order,
                (select string_agg(v, '|' order by v collate "C")  from k) as binary_order`,
        [KEYS],
      );
      return [result.rows[0].database_order, result.rows[0].binary_order];
    });

    // The premise: on THIS server the two disagree. If they ever agree, this machine cannot
    // demonstrate the hazard and the assertion below would be vacuous — so say so rather than pass.
    assert.notEqual(
      database,
      binary,
      'this database collates punctuation the same way C does, so the hazard cannot be shown here',
    );

    // And the order the retrieval publishes is the byte order, on every server.
    assert.equal(binary, [...KEYS].sort().join('|'), 'the binary collation is not plain byte order');
  });

  it('holds the order at the level the cache key is taken over', async () => {
    // The consequence, stated as the thing that actually breaks: two calls whose only difference is
    // the order of tied excerpts are two digests. Both rows above carry the same ordering, so a
    // rehearsal of either one finds its answer. This assertion is what would fail on the day the
    // planner changed its mind and nothing else did.
    const rows = await asOwner(async (client) => {
      const result = await client.query(
        `select l.input_hash, l.output -> 'response' as response
           from ledger_entry l
          where l.agent = 'draft'
            and l.output ->> 'response' like '%zz-order/alpha%'
          order by l.id asc`,
      );
      return result.rows;
    });

    assert.ok(rows.length >= 2, 'fewer than two drafting calls cited the tied articles');
    const orders = new Set(rows.map((row) => JSON.parse(row.response).draft.kb_ids.join('|')));
    assert.equal(orders.size, 1, 'the tied articles were ordered two different ways across calls');
  });
});
