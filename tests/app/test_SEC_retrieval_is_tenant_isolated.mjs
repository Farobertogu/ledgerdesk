// test_SEC_retrieval_is_tenant_isolated
//
// A retrieval reads documents somebody else wrote and puts them into a prompt. Getting the tenant
// wrong here is not a leak of a row on a screen — it is one organisation's internal policy being
// quoted, verbatim and confidently, in a reply sent to another organisation's customer.
//
// **The two tenants share a snapshot LABEL**, which is what makes this worth measuring rather than
// assuming. Both hold `kb-2026-08-01`, and their corpora under it are entirely different. A
// retrieval that filtered on the label alone — which is the natural thing to write, since the label
// is the thing the ticket's own state names — would answer either organisation's question from
// either organisation's documents, and every test that only ever ran one tenant would pass.
//
// **The isolation is the POLICY's, not the query's.** There is no `org_id` predicate anywhere in
// the retrieval, deliberately: `tenant_isolation_kb_article` decides what the statement can see, and
// a query that also filtered would make the policy untestable — a hit on another tenant's row would
// mean the policy had failed, which is worth failing loudly rather than papering over.
//
// So the test asks the question twice, with the same words, in two organisations, and measures that
// the answers differ — and then asks the database directly, through the policy, what each tenant
// can see.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  RUN_ID,
  asOwner,
  asTenant,
  corpusOf,
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

/**
 * Words that Corella's corpus answers and Northwind's does not.
 *
 * The seeded article is Corella's alone: "A password reset link expires after thirty minutes;
 * requesting a second link invalidates the first." Northwind holds nothing about it.
 */
const SHARED_WORDS =
  'TRIAGE-FIXTURE-CLEAN A colleague says the password reset link expires after a while. How many ' +
  'minutes is it valid, and does requesting another link invalidate the earlier one?';

describe('test_SEC_retrieval_is_tenant_isolated', () => {
  let people;
  let northwindCustomer;
  let northwindAgent;
  let corellaCustomer;
  let corellaAgent;

  before(async () => {
    await waitForServer();
    people = await identities();
    northwindCustomer = await sessionFor(people.northwindCustomer.user_id);
    northwindAgent = await sessionFor(people.northwindAgent.user_id);
    corellaCustomer = await sessionFor(people.corellaCustomer.user_id);
    corellaAgent = await sessionFor(people.corellaAgent.user_id);
  });

  it('gives the two organisations different corpora under the same label', async () => {
    // The premise. Without it the rest of this file measures nothing.
    const northwind = await corpusOf(people.northwindCustomer.org_id);
    const corella = await corpusOf(people.corellaCustomer.org_id);

    assert.ok(northwind.length > 0 && corella.length > 0, 'one of the organisations has no corpus');
    assert.equal(
      northwind[0].kb_snapshot,
      corella[0].kb_snapshot,
      'the two tenants do not share a snapshot label, so the interesting case is not being tested',
    );

    const shared = new Set(northwind.map((a) => a.id)).intersection(new Set(corella.map((a) => a.id)));
    assert.equal(shared.size, 0, 'the two corpora share an article');
  });

  it('shows each tenant only its own articles, through the policy', async () => {
    // Under the claim set the retrieval actually runs with: an organisation, and NO role. A reader
    // that also asserted a role would hold the claims that open the ticket write path.
    for (const person of [people.northwindCustomer, people.corellaCustomer]) {
      const visible = await asTenant({ org_id: person.org_id }, async (client) => {
        const result = await client.query('select org_id::text as org_id, canonical_key from kb_article');
        return result.rows;
      });

      assert.ok(visible.length > 0, `${person.org_name} can see none of its own articles`);
      for (const article of visible) {
        assert.equal(
          article.org_id,
          person.org_id,
          `${person.org_name} can see ${article.canonical_key}, which belongs to another organisation`,
        );
      }
    }
  });

  it('answers the same question from one corpus and not from the other', async () => {
    // --- Corella, whose corpus covers it --------------------------------------------------------
    const theirs = await fileTicket(corellaCustomer, {
      subject: `Password reset link validity [${RUN_ID}]`,
      body: SHARED_WORDS,
    });
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    const theirTicket = theirs.body.tracking_id;

    const theirTriage = await triage(corellaAgent, theirTicket);
    assert.equal(theirTriage.body.triage.outcome, 'TRIAGED');
    assert.equal(theirTriage.body.triage.escalated, false, 'the premium tenant escalated before drafting');

    const theirDraft = await draft(corellaAgent, theirTicket);
    assert.equal(theirDraft.status, 200, JSON.stringify(theirDraft.body));
    assert.equal(
      theirDraft.body.draft.outcome,
      'DRAFTED',
      `Corella could not answer from its own corpus: ${JSON.stringify(theirDraft.body.draft)}`,
    );
    assert.equal((await ticketRow(theirTicket)).status, 'AWAITING_AGENT');

    // --- Northwind, whose corpus does not -------------------------------------------------------
    const ours = await fileTicket(northwindCustomer, {
      subject: `Password reset link validity [${RUN_ID}]`,
      body: SHARED_WORDS,
    });
    assert.equal(ours.status, 201, JSON.stringify(ours.body));
    const ourTicket = ours.body.tracking_id;

    await triage(northwindAgent, ourTicket);
    const ourDraft = await draft(northwindAgent, ourTicket);
    assert.equal(ourDraft.status, 200, JSON.stringify(ourDraft.body));

    // THE assertion. Identical words, and the other organisation's document is not reachable — so
    // the honest outcome is a knowledge gap and not a borrowed answer.
    assert.equal(
      ourDraft.body.draft.outcome,
      'ESCALATED_NO_SOURCES',
      `Northwind answered a question only Corella's corpus covers: ${JSON.stringify(ourDraft.body.draft)}`,
    );
    assert.equal(ourDraft.body.draft.reason, 'GROUND');
    assert.equal((await responsesFor(ourTicket)).length, 0, 'a draft was written from another tenant’s document');

    // And no model was asked to write one, which is also the cheap half.
    assert.equal((await ledgerRowsFor(ourTicket)).length, 1, 'the drafting agent was called with no sources');
  });

  it('cites nothing outside the citing tenant, in every citation ever written', async () => {
    // A sweep over the whole table rather than over this test's own rows: the question is whether
    // ANY answer in the database cites a document belonging to another organisation, which is the
    // shape a leak would actually take.
    const crossed = await asOwner(async (client) => {
      const result = await client.query(
        `select c.response_id::text as response_id, a.canonical_key
           from response_citation c
           join response r on r.id = c.response_id
           join ticket t on t.id = r.ticket_id
           join kb_article a on a.id = c.kb_article_id and a.kb_snapshot = c.kb_snapshot
          where a.org_id <> t.org_id`,
      );
      return result.rows;
    });

    assert.deepEqual(crossed, [], 'an answer cites a document belonging to another organisation');
  });
});
