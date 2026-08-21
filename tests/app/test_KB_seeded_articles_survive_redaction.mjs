// test_KB_seeded_articles_survive_redaction
//
// Every body in the knowledge base goes through the redactor and must come out unchanged.
//
// **Why an article with a redactable value in it is worse than a ticket with one.** A ticket body
// containing an address is the ordinary case: it is redacted, a marker takes its place, and the
// model answers around it. An ARTICLE containing one is a mine under the single agent whose whole
// job is to quote it. The excerpt reaches the drafting prompt with `[REDACTED:id]` where a fact used
// to be; the model writes a reply grounded in a marker; the overlap conjunct is satisfied, because
// the draft really did borrow wording from the excerpt it was given; and the answer that reaches a
// person is confidently, verifiably grounded in a hole.
//
// It is also silent. Nothing fails, no code path reports anything, and the only way to find it is
// to read a draft and wonder why it says nothing. So the corpus is checked, in the database, as it
// actually stands — not the seed file, which is one of the ways it can get there.
//
// The second half checks the identifiers, which is the other side of the same seam and the one that
// cost this increment a real defect: identifiers are NOT redacted, correctly, but the egress scan
// searches the whole payload for everything the redactor removed. An identifier containing a shape
// the dictionary recognises is a call that aborts on a value nobody leaked.
//
// The third half is phrase uniqueness, extended from the tickets to the corpus. The message a
// fixture matches against now carries the excerpts as well as the enquiry, so a fixture phrase that
// also appears in an article would answer for a ticket it was never written for.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';

import { redact } from '../../agents/redaction.ts';
import { kbIdOf } from '../../src/alg/retrieval.ts';
import { asOwner, identities, waitForServer } from './harness.mjs';

const DATASET = JSON.parse(readFileSync('seed/demo_tickets.json', 'utf8'));

const CLEAN = { literal: 0, email: 0, card: 0, account: 0, phone: 0, id: 0 };

/** Every article in the database, whatever organisation or snapshot it belongs to. */
async function everyArticle() {
  return asOwner(async (client) => {
    const result = await client.query(
      `select id::text as id, org_id::text as org_id, kb_snapshot, canonical_key, title, body
         from kb_article order by org_id, kb_snapshot, canonical_key, id`,
    );
    return result.rows;
  });
}

describe('test_KB_seeded_articles_survive_redaction', () => {
  let articles;

  before(async () => {
    await waitForServer();
    await identities();
    articles = await everyArticle();
  });

  it('holds a corpus at all, so the assertions below are not empty', () => {
    assert.ok(articles.length > 0, 'there is no knowledge base to check');
  });

  it('leaves every body exactly as it was written', () => {
    for (const article of articles) {
      const pass = redact(article.body, []);
      assert.equal(
        pass.text,
        article.body,
        `${article.canonical_key} carries a value the redactor removes, so a draft citing it would quote a marker`,
      );
      assert.deepEqual(pass.counts, CLEAN, `${article.canonical_key} matched a rule of the dictionary`);
    }
  });

  it('leaves every title alone too, since a title travels with its excerpt', () => {
    for (const article of articles) {
      const pass = redact(article.title, []);
      assert.equal(pass.text, article.title, `${article.canonical_key} has a redactable title`);
    }
  });

  it('mints an identifier the redactor does not recognise, for every article that exists', () => {
    for (const article of articles) {
      const kb_id = kbIdOf(article.canonical_key, article.id);
      const pass = redact(kb_id, []);
      assert.equal(
        pass.text,
        kb_id,
        `the identifier of ${article.canonical_key} is altered by the redactor, so a body containing the same run would abort the call`,
      );
      assert.deepEqual(pass.counts, CLEAN);
      assert.match(kb_id, /^[A-Za-z0-9:_/-]{1,128}$/, `${kb_id} is outside the published alphabet`);
    }
  });

  it('survives the whole message the sources travel in', () => {
    // Not each field on its own: the payload is one string, and the scan runs over the whole of it.
    // Punctuation between fields must not create a shape that neither field carried.
    const sources = articles.map((article) => ({
      kb_id: kbIdOf(article.canonical_key, article.id),
      excerpt: article.body,
    }));
    const message = JSON.stringify({ enquiry: 'What does the policy say about this?', sources });

    const pass = redact(message, []);
    assert.equal(pass.text, message, 'the redactor found something in a message of clean sources');
    assert.deepEqual(pass.counts, CLEAN);
  });

  it('keeps every authored fixture phrase out of the knowledge base', () => {
    // Phrase uniqueness, extended from the tickets to the corpus. A fixture is selected by a phrase
    // appearing in the message the model would receive, and that message now carries the excerpts.
    // A phrase that also lives in an article would answer for whichever ticket happened to retrieve
    // that article — a demonstration producing one beat's verdict on another beat's ticket.
    const phrases = [...DATASET.triage_fixtures, ...DATASET.draft_fixtures].map((entry) => entry.match);
    assert.ok(phrases.length > 0, 'the dataset authors no fixtures, so this checks nothing');

    for (const article of articles) {
      const text = `${article.title}\n${article.body}`;
      for (const phrase of phrases) {
        assert.ok(
          !text.includes(phrase),
          `${article.canonical_key} contains '${phrase}', so that fixture would answer for any ticket retrieving it`,
        );
      }
    }
  });

  it('keeps every test marker out of the knowledge base as well', () => {
    // The markers are the tests' own, and they fire on a body containing them. An article carrying
    // one would turn every ticket that retrieved it into a pinned outcome.
    const markers = [
      'TRIAGE-FIXTURE-',
      'DRAFT-FIXTURE-',
      'VALIDATE-FIXTURE-',
    ];
    for (const article of articles) {
      const text = `${article.title}\n${article.body}`;
      for (const marker of markers) {
        assert.ok(!text.includes(marker), `${article.canonical_key} contains the marker prefix ${marker}`);
      }
    }
  });

});
