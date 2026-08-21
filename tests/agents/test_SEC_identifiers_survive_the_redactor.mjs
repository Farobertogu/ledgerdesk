// test_SEC_identifiers_survive_the_redactor
//
// An identifier this system mints must contain nothing the redaction dictionary recognises, and
// this is the property rather than the value being checked.
//
// **The failure it exists for was found by a test and is worth stating in full**, because reasoning
// about it in advance is exactly what did not happen.
//
// Article identifiers are not tenant material and are not redacted — correctly, since redacting a
// citation destroys the thing a citation is. The egress scan, meanwhile, searches the WHOLE
// outbound payload for every literal the redactor removed from the material that *is* tenant data.
// Those two facts are individually right and together they have a seam: if a value removed from a
// customer's body happens to be a substring of an identifier that was never theirs, the scan finds
// it, the call aborts with `E_PII_EGRESS`, and the ticket can never be drafted.
//
// It is not hypothetical. A UUID is `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`, whose middle is
// `dddd-dddd-dddd` whenever those groups are digits — the exact shape of a card number in the
// dictionary, and the shape of every identifier this repository seeds by hand. A customer writing a
// reference number like `0000-4000-8000` would have it removed from their body as a card, and the
// scan would then find those fourteen characters inside an article identifier. An operator sees a
// privacy error about a value the customer did type and the system did remove, in a payload that
// leaked nothing at all.
//
// The identifier is minted without separators, and this file checks that shape against the whole
// dictionary rather than against the two identifiers the seed happens to hold.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { redact } from '../../agents/redaction.ts';
import { kbIdOf } from '../../src/alg/retrieval.ts';

/** The published alphabet of a `kb_id`, transcribed from the contract it appears in. */
const KB_ID = /^[A-Za-z0-9:_/-]{1,128}$/;

const KEYS = [
  'billing/duplicate-charge',
  'exports/destinations',
  'exports/schedule',
  'access/password-reset',
  'ops/retention-of-archived-records',
];

describe('test_SEC_identifiers_survive_the_redactor', () => {
  it('mints an identifier inside the published alphabet', () => {
    for (const key of KEYS) {
      const kb_id = kbIdOf(key, randomUUID());
      assert.match(kb_id, KB_ID, `${kb_id} is outside the alphabet a citation may use`);
      assert.ok(kb_id.length <= 128);
    }
  });

  it('leaves no separator inside the identity half', () => {
    const kb_id = kbIdOf('billing/duplicate-charge', 'c0de0001-0000-4000-8000-000000000001');
    assert.equal(kb_id, 'billing/duplicate-charge:c0de0001000040008000000000000001');
    assert.ok(!kb_id.split(':')[1].includes('-'), 'the identity half carries a separator');
  });

  it('is untouched by the redactor, over two thousand random identities', () => {
    // The property, not the value. A UUID is random, so the case that matters is the one nobody
    // wrote down: an identity whose digits happen to line up with a rule.
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const key = KEYS[attempt % KEYS.length];
      const kb_id = kbIdOf(key, randomUUID());
      const pass = redact(kb_id, []);
      assert.equal(pass.text, kb_id, `the redactor altered ${kb_id}`);
      assert.deepEqual(
        pass.counts,
        { literal: 0, email: 0, card: 0, account: 0, phone: 0, id: 0 },
        `the redactor recognised something inside ${kb_id}`,
      );
    }
  });

  it('is untouched inside the JSON message the sources travel in', () => {
    // The identifier does not travel alone: it sits in an object beside an excerpt, and the scan
    // runs over the whole serialised payload. Neighbouring punctuation must not create a shape.
    const sources = KEYS.map((key) => ({
      kb_id: kbIdOf(key, randomUUID()),
      excerpt: 'A published policy sentence with no personal value in it at all.',
    }));
    const message = JSON.stringify({ enquiry: 'What does the policy say?', sources });

    const pass = redact(message, []);
    assert.equal(pass.text, message, 'the redactor found something in a message of identifiers');
  });

  it('is exactly the failure it was written for, shown on the shape it replaced', () => {
    // The old spelling, kept here as a fixture and nowhere else. It demonstrates that the rule the
    // fix is about is real: the same identity WITH its separators is recognised as a card.
    const withSeparators = 'billing/duplicate-charge:c0de0001-0000-4000-8000-000000000001';
    const pass = redact(withSeparators, []);
    assert.notEqual(pass.text, withSeparators, 'the hazard this fix exists for cannot be reproduced');
    assert.equal(pass.counts.card, 1, 'the old identifier shape was not read as a card after all');

    // And the collision that made it a live failure rather than an oddity: a run removed from a
    // customer's body is then searched for in the payload, where the identifier used to carry it.
    const fromABody = redact('Our reference is 0000-4000-8000 on the invoice.', []);
    assert.equal(fromABody.counts.card, 1);
    const removed = fromABody.removed[0].literal;
    assert.ok(
      withSeparators.includes(removed),
      'the old identifier no longer contains what a body would have had removed',
    );
    assert.ok(
      !kbIdOf('billing/duplicate-charge', 'c0de0001-0000-4000-8000-000000000001').includes(removed),
      'the minted identifier still contains a run a body could have removed',
    );
  });
});
