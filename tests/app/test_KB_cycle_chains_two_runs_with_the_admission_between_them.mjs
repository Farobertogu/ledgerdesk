// test_KB_cycle_chains_two_runs_with_the_admission_between_them
//
// The closing evidence of the whole card, and the sentence the board holds it to: **one chain, two
// `state_hash` values, and the admission row between them by `seq`.**
//
// **Why it has to be one chain and not two runs.** It is tempting to give the second half a run of
// its own — it is a second act, the state has changed, a new run looks tidier in a listing. It is
// wrong, and it destroys the evidence while appearing to produce it: two runs are two chains,
// nothing orders them relative to each other, the admission belongs to neither, and the sentence
// "here is the same question before and after, in order, in one append-only record" stops being
// true. So the run is a function of the organisation and the label, an admission evicts the runtime
// rather than replacing the run, and this is where that is measured instead of asserted.
//
// **And the second assertion, which is the one that separates a demonstration from a coincidence.**
// Before the admission the question returns nothing at all. Afterwards the admitted key comes back
// AND comes back first by rank. "The re-run found something" is a condition a corpus can satisfy by
// accident — an unrelated article clearing the floor — and a cycle that closed on it would be
// demonstrating anchoring by luck, which is the one failure mode nobody watching could tell from
// success.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { MIN_RANK, RANK_FUNCTION, TEXT_SEARCH_CONFIG, TOP_K } from '../../src/alg/retrieval.ts';

import {
  admissionsFor,
  admit,
  allBeats,
  asOwner,
  cleanup,
  gapsFor,
  identities,
  restoreCorpusHead,
  ledgerRowsFor,
  sessionFor,
  snapshotHead,
  ticketWithAnOpenGap,
  verifyGap,
  waitForServer,
} from './harness.mjs';

/** This file admits, so it holds a beat of its own. */
const BEAT = 'driver-rest-interval';

let people;
let orgUnderTest;
let seededHead;
let customer;
let agent;
let supervisor;

/**
 * The published retrieval, TRANSCRIBED, so this file can ask the corpus what it would return.
 *
 * The server's query lives behind path aliases the runner does not resolve, so the shape is written
 * out here from the published constants — which is also what makes a change to the ordering visible:
 * the constants come from the module, so `k`, the floor, the ranking function and the configuration
 * cannot drift without this following them.
 */
function retrievalSql() {
  const document = `to_tsvector('${TEXT_SEARCH_CONFIG}', a.title || ' ' || a.body)`;
  const rank = `${RANK_FUNCTION}(${document}, q.query)`;
  return `
    with lexemes as (
      select string_agg(quote_literal(lexeme), ' | ' order by lexeme) as expression
        from unnest(to_tsvector('${TEXT_SEARCH_CONFIG}', $1)) as t(lexeme, positions, weights)
    ),
    q as (
      select to_tsquery('${TEXT_SEARCH_CONFIG}', expression) as query
        from lexemes where expression is not null
    )
    select a.canonical_key, ${rank}::float8 as rank
      from kb_article a
     cross join q
     where a.kb_snapshot = $2
       and a.citable
       and ${document} @@ q.query
     order by ${rank} desc, a.canonical_key collate "C" asc, a.id asc
     limit ${TOP_K}`;
}

async function whatTheCorpusReturns(terms, snapshot) {
  return asOwner(async (client) => {
    const found = await client.query(retrievalSql(), [terms, snapshot]);
    return found.rows.filter((row) => Number(row.rank) >= MIN_RANK);
  });
}

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

describe('test_KB_cycle_chains_two_runs_with_the_admission_between_them', () => {
  it('keeps every beat lexically disjoint from every other document', async () => {
    // The property the whole application suite rests on, measured with the database's own analyser
    // rather than by eye. These tests share one corpus in a fixed order, so a beat whose enquiry
    // shared one stemmed word with another beat's document would stop returning nothing the moment
    // that document was admitted — and the test that opened with it would fail for a reason
    // belonging to a different file.
    const beats = allBeats();
    const lexemesOf = async (text) =>
      asOwner(async (client) => {
        const found = await client.query(
          `select lexeme from unnest(to_tsvector('${TEXT_SEARCH_CONFIG}', $1)) as t(lexeme, p, w)`,
          [text],
        );
        return new Set(found.rows.map((row) => row.lexeme));
      });

    for (const asking of beats) {
      const enquiry = await lexemesOf(`${asking.subject}\n${asking.body}`);
      for (const other of beats) {
        if (other.document.canonical_key === asking.document.canonical_key) continue;
        const document = await lexemesOf(`${other.document.title} ${other.document.body}`);
        const shared = [...enquiry].filter((lexeme) => document.has(lexeme));
        assert.deepEqual(
          shared,
          [],
          `'${asking.subject}' shares ${shared.join(', ')} with the document of ` +
            `'${other.document.canonical_key}', so admitting one would answer the other`,
        );
      }
    }
  });

  it('answers the same question before and after, in one chain, with the admission between', async () => {
    const org = people.northwindSupervisor.org_id;
    const { ticketId, gap, beat: which } = await ticketWithAnOpenGap(
      customer,
      agent,
      BEAT,
      'cycle',
    );

    // --- before: the corpus has nothing to say ------------------------------------------------
    const beforeHead = await snapshotHead(org);

    // **Nothing in this file has moved the corpus yet, so this is an assertion about what the file
    // INHERITED.** The preamble above files a ticket and escalates it; neither admits. If the
    // pointer has moved since this file started, an earlier file moved it and did not put it back,
    // and every chain assertion below would be measuring that instead of the cycle it names. It is
    // checked here, where the cause is one line away, rather than eighty lines later where the
    // symptom is two digests that differ for a reason nothing on screen explains.
    assert.equal(
      beforeHead,
      seededHead,
      'the corpus in force is not the one this file started from, so a file that ran earlier moved ' +
        'it and did not restore it',
    );

    const beforeRows = await whatTheCorpusReturns(gap.query_terms, beforeHead);
    assert.deepEqual(
      beforeRows,
      [],
      'the beat this file measures is supposed to open on a corpus that returns nothing at all',
    );

    const firstHalf = await ledgerRowsFor(ticketId);
    assert.ok(firstHalf.length > 0, 'the first half of the cycle wrote no rows');
    const runId = firstHalf[0].run_id;
    const stateBefore = firstHalf[0].state_hash;
    const restartsBefore = Number(firstHalf[0].restarts);

    // --- the admission ------------------------------------------------------------------------
    const admitted = await admit(supervisor, gap.id, which.document);
    assert.equal(admitted.status, 200, `the admission was refused: ${JSON.stringify(admitted.body)}`);

    const afterHead = await snapshotHead(org);
    assert.notEqual(afterHead, beforeHead, 'the corpus in force did not move');

    // --- after: the question is answerable, and by the right document --------------------------
    const afterRows = await whatTheCorpusReturns(gap.query_terms, afterHead);
    assert.ok(afterRows.length > 0, 'the admitted document did not make the question answerable');
    assert.equal(
      afterRows[0].canonical_key,
      which.document.canonical_key,
      `the question is answered first by '${afterRows[0].canonical_key}' rather than by the ` +
        'document admitted to answer it, so a closure conditioned on finding something would be ' +
        'demonstrating anchoring by accident',
    );

    // --- the re-run ---------------------------------------------------------------------------
    const verified = await verifyGap(agent, gap.id);
    assert.equal(verified.status, 200, `the re-run was refused: ${JSON.stringify(verified.body)}`);
    assert.equal(
      verified.body.verification.outcome,
      'CLOSED',
      `the gap did not close: ${verified.body.verification.because ?? ''}`,
    );

    // --- the chain, which is the evidence -----------------------------------------------------
    const chain = await ledgerRowsFor(ticketId);
    assert.ok(chain.length > firstHalf.length, 'the second half of the cycle wrote no rows');

    for (const row of chain) {
      assert.equal(row.run_id, runId, 'the second half opened a chain of its own, which orders nothing');
      assert.equal(
        Number(row.restarts),
        restartsBefore,
        'a rebuilt runtime was counted as a restart of the process behind it',
      );
    }

    const seqs = chain.map((row) => Number(row.seq));
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(seqs[index] > seqs[index - 1], 'the chain is not monotonic in seq');
    }

    const admissionRow = chain.find((row) => row.class === 'kb_admission');
    assert.ok(admissionRow, 'the admission left no row in the chain of this ticket');

    const earlier = chain.filter((row) => Number(row.seq) < Number(admissionRow.seq));
    const later = chain.filter((row) => Number(row.seq) > Number(admissionRow.seq));
    assert.ok(earlier.length > 0, 'nothing was written before the admission');
    assert.ok(later.length > 0, 'nothing was written after the admission');

    // **The first half is the triage call and nothing else, and that is the evidence that the
    // escalation cost nothing.** The ungrounded escalation files an audit event and writes no chain
    // row, so a drafting or validating row on this side would mean a model was asked to write an
    // answer for a question the corpus could not support — the opposite of what this beat exists to
    // show. It is also why `statesBefore.size === 1` below is a weaker statement than it looks: a
    // single row is trivially written under a single state, so it cannot on its own establish that
    // the state is the right one.
    assert.deepEqual(
      [...new Set(earlier.map((row) => row.agent))],
      ['triage'],
      'something other than the triage call wrote into the chain before the admission, so a model ' +
        'was asked to draft an answer the corpus could not ground',
    );

    // --- which corpus the admission pinned: the labels first, then the digest -------------------
    //
    // **The readable labels are checked before `state_hash`, and the order is the point.** The
    // property is one sentence — the admission is decided under the corpus in force and produces
    // the next one — but `state_hash` is a digest of THREE components, of which the corpus is one.
    // Comparing digests alone can only report that two opaque strings differ; it cannot say which
    // component moved, or which side of the comparison moved it. `snapshot_from` and `snapshot_to`
    // are the same fact in labels a person can read, they are carried by the row's own published
    // contract, and they fail with the values printed.
    assert.equal(
      admissionRow.output.snapshot_from,
      beforeHead,
      `the admission names '${admissionRow.output.snapshot_from}' as the corpus it was decided ` +
        `under, and the corpus in force when it was decided was '${beforeHead}'`,
    );
    assert.equal(
      admissionRow.output.snapshot_to,
      afterHead,
      `the admission says it produced '${admissionRow.output.snapshot_to}', and the corpus now in ` +
        `force is '${afterHead}'`,
    );

    // Two state values, one chain, and the admission on the side that decided.
    const statesBefore = new Set(earlier.map((row) => row.state_hash));
    const statesAfter = new Set(later.map((row) => row.state_hash));
    assert.equal(
      statesBefore.size,
      1,
      `the first half is not written under one state: ${[...statesBefore].join(', ')}`,
    );
    assert.equal(
      statesAfter.size,
      1,
      `the second half is not written under one state: ${[...statesAfter].join(', ')}`,
    );
    assert.equal([...statesBefore][0], stateBefore);

    // **Three outcomes, and the failure names which one happened rather than leaving it to be
    // inferred.** Equal to the first half is the contract. Equal to the second half is the
    // admission pinning the corpus it produced — a row recording a state that did not exist when
    // the decision was taken, which is the defect this assertion exists to catch. Equal to neither
    // is something outside this cycle having moved the corpus between the escalation and the
    // admission, which is a fact about the run rather than about the product, and the two are not
    // the same finding.
    const pinned =
      admissionRow.state_hash === [...statesAfter][0]
        ? 'the corpus it produced, so the row records a state that did not exist when it was decided'
        : 'neither half of its own chain, so the corpus moved between the escalation and the admission';
    assert.equal(
      admissionRow.state_hash,
      stateBefore,
      `the admission pins ${pinned}. It was decided under ` +
        `'${admissionRow.output.snapshot_from}' and produced '${admissionRow.output.snapshot_to}'; ` +
        `the pointer read '${beforeHead}' before the admission and '${afterHead}' after it`,
    );
    assert.notEqual(
      [...statesAfter][0],
      stateBefore,
      'the two halves carry the same state, so nothing on this chain says the corpus moved',
    );

    // And the record of the whole thing, in one place a person can read.
    const closed = (await gapsFor(ticketId)).find((row) => row.id === gap.id);
    assert.equal(closed.state, 'CLOSED');
    const admissions = await admissionsFor(gap.id);
    assert.equal(admissions.length, 1);
    assert.equal(String(admissions[0].ledger_ref), String(admissionRow.id));
  });
});
