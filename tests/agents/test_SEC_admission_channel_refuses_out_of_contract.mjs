// test_SEC_admission_channel_refuses_out_of_contract
//
// The fourth declared channel, field by field. Out of contract is **refused whole**, never truncated
// and never filled in — which is the published rule and is the one a receiver breaks by being
// helpful.
//
// **The case this file exists for is the byte one.** Every cap on this channel is written in bytes,
// and the difference between bytes and what the language calls length only shows up where it
// matters: 512 characters of CJK are 1 536 bytes. A receiver counting UTF-16 units would admit three
// times the payload the contract declares, on exactly the inputs a producer would choose if it
// wanted to. The published JSON document counts code points, so it accepts that note; the receiver
// does not, and the two disagreeing is the design rather than a defect.
//
// **And the one that is not a cap.** The channel carries no term of the enquiry in clear. That is
// the property that makes it safe to have at all, and it is held by the field list being closed
// rather than by anybody remembering — so it is measured as a closed list and as a refusal of
// anything outside it.
//
// It needs no database, no server and no model: a contract is a function of a value.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  GAP_CHANNEL_BYTES,
  GAP_CHANNEL_EMISSION_STATE,
  GAP_CHANNEL_FIELDS,
  GAP_CHANNEL_MAX_DIVERGENT,
  GAP_CHANNEL_OPEN_CONTENT_MAX_BYTES,
  GAP_CHANNEL_RECORD_MAX_BYTES,
  GAP_CHANNEL_STATES,
  GAP_CHANNEL_TOTAL_BYTES,
  byteLength,
  canonicalQueryForm,
  gapChannelRecordBytes,
  validateGapChannelRecord,
} from '../../src/alg/gap_channel.ts';

const hex64 = (c) => c.repeat(64);
const uuid = (n) => `${n}0000000-0000-4000-8000-00000000000${n}`;
const sha256Of = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A record that satisfies every field, from which each case breaks exactly one. */
function emitted(overrides = {}) {
  return {
    gap_id: uuid(9),
    canonical_key_sha256: hex64('b'),
    query_sha256: hex64('c'),
    kb_snapshot: 'kb-2026-08-01',
    owner_id: uuid(1),
    committed_date: '2026-08-29',
    state: GAP_CHANNEL_EMISSION_STATE,
    divergent_kb_ids: [],
    note: 'The corpus at this snapshot matched nothing for this enquiry.',
    ...overrides,
  };
}

const fieldsOf = (violations) => violations.map((entry) => entry.field);

describe('test_SEC_admission_channel_refuses_out_of_contract', () => {
  it('accepts a record that satisfies the contract', () => {
    assert.deepEqual(validateGapChannelRecord(emitted()), []);
  });

  it('publishes nine fields and refuses anything outside them', () => {
    assert.equal(GAP_CHANNEL_FIELDS.length, 9);

    // The property that makes the channel safe: not one term of the enquiry travels on it. Held by
    // the list being closed, so a field carrying the question cannot be added without this failing.
    for (const forbidden of ['query_terms', 'subject', 'body', 'excerpt', 'zero_match']) {
      const violations = validateGapChannelRecord(
        emitted({ [forbidden]: 'who can view the audit trail of a shipment' }),
      );
      assert.ok(
        fieldsOf(violations).includes(forbidden),
        `'${forbidden}' reached the receiver without being refused`,
      );
    }
  });

  it('refuses each field for its own reason, one case per field', () => {
    const cases = [
      ['gap_id', { gap_id: 'not-an-identity' }],
      ['gap_id', { gap_id: undefined }],
      ['canonical_key_sha256', { canonical_key_sha256: 'deadbeef' }],
      ['query_sha256', { query_sha256: hex64('C') }], // upper case is not the published alphabet
      ['kb_snapshot', { kb_snapshot: "kb-2026-08-01'; drop" }],
      ['owner_id', { owner_id: 'the support supervisor' }],
      ['owner_id', { owner_id: undefined }],
      ['committed_date', { committed_date: '29-08-2026' }],
      ['committed_date', { committed_date: undefined }],
      ['state', { state: 'REOPENED' }],
      ['divergent_kb_ids', { divergent_kb_ids: 'none' }],
      ['divergent_kb_ids', { divergent_kb_ids: Array(GAP_CHANNEL_MAX_DIVERGENT + 1).fill(uuid(2)) }],
      ['note', { note: 42 }],
    ];

    for (const [field, override] of cases) {
      const violations = validateGapChannelRecord(emitted(override));
      assert.ok(violations.length > 0, `${field}: ${JSON.stringify(override)} was accepted`);
      assert.ok(
        fieldsOf(violations).some((named) => named.startsWith(field)),
        `${field}: refused, but the refusal named ${fieldsOf(violations).join(', ')} instead`,
      );
    }
  });

  it('measures the note in bytes, which is what separates it from a length', () => {
    // 512 of the cheapest characters there are: exactly at the cap, and accepted.
    const atTheCap = 'x'.repeat(GAP_CHANNEL_BYTES.note);
    assert.equal(byteLength(atTheCap), GAP_CHANNEL_BYTES.note);
    assert.deepEqual(validateGapChannelRecord(emitted({ note: atTheCap })), []);

    // One more, and it is refused.
    assert.ok(validateGapChannelRecord(emitted({ note: `${atTheCap}x` })).length > 0);

    // And the case the cap is written in bytes FOR: 512 CJK characters. A receiver counting UTF-16
    // units would see 512 and admit it; it is 1 536 bytes, three times what the contract declares.
    const cjk = '文'.repeat(512);
    assert.equal(cjk.length, 512, 'this case is not testing what it says it is');
    assert.equal(byteLength(cjk), 1536);
    const violations = validateGapChannelRecord(emitted({ note: cjk }));
    assert.ok(
      fieldsOf(violations).includes('note'),
      'a note of 512 CJK characters was accepted, so the cap is being counted in the wrong unit',
    );
    assert.match(violations[0].detail, /1536 bytes/);
  });

  it('reports every violation rather than the first', () => {
    const violations = validateGapChannelRecord(
      emitted({ owner_id: 'nobody', committed_date: 'soon', state: 'CLOSED-ish' }),
    );
    const named = fieldsOf(violations);
    for (const field of ['owner_id', 'committed_date', 'state']) {
      assert.ok(named.includes(field), `${field} was not reported: ${named.join(', ')}`);
    }
  });

  it('keeps the sum of the published caps inside the declared bound', () => {
    // The contract publishes «≤ 1024 B per record» and does not say what the bytes are measured
    // over. Fixed as the sum of the per-field caps, so the bound is respected by construction rather
    // than by a check somebody has to remember to run at the border.
    const summed = GAP_CHANNEL_FIELDS.reduce((total, field) => total + GAP_CHANNEL_BYTES[field], 0);
    assert.equal(summed, GAP_CHANNEL_TOTAL_BYTES);
    assert.ok(
      GAP_CHANNEL_TOTAL_BYTES <= GAP_CHANNEL_RECORD_MAX_BYTES,
      `the caps sum to ${GAP_CHANNEL_TOTAL_BYTES}, above the declared ${GAP_CHANNEL_RECORD_MAX_BYTES}`,
    );

    // At most 512 of those bytes are content the producer chose. Eight of the nine fields are
    // identifiers, digests, dates and enumerated values — zero bytes of the producer's choosing.
    assert.equal(GAP_CHANNEL_OPEN_CONTENT_MAX_BYTES, GAP_CHANNEL_BYTES.note);
    assert.ok(GAP_CHANNEL_OPEN_CONTENT_MAX_BYTES * 2 <= GAP_CHANNEL_RECORD_MAX_BYTES);

    // A record built at every cap really does fit, measured rather than reasoned about.
    const largest = emitted({
      kb_snapshot: 'k'.repeat(GAP_CHANNEL_BYTES.kb_snapshot),
      divergent_kb_ids: Array(GAP_CHANNEL_MAX_DIVERGENT).fill(uuid(3)),
      note: 'x'.repeat(GAP_CHANNEL_BYTES.note),
    });
    assert.deepEqual(validateGapChannelRecord(largest), []);
    assert.ok(gapChannelRecordBytes(largest) <= GAP_CHANNEL_RECORD_MAX_BYTES);
  });

  it('emits in one state and mirrors three', () => {
    // The field mirrors the record's own column, so all three values are shapes a record can carry.
    // Only one of them may be EMITTED, and that check belongs to the receiver rather than to the
    // shape: a record born closed would close a gap through the channel.
    assert.deepEqual([...GAP_CHANNEL_STATES], ['OPEN', 'NOT_DOCUMENTABLE', 'CLOSED']);
    assert.equal(GAP_CHANNEL_EMISSION_STATE, 'OPEN');
    for (const state of GAP_CHANNEL_STATES) {
      assert.deepEqual(validateGapChannelRecord(emitted({ state })), [], `${state} is not a valid shape`);
    }
  });

  it('holds the canonicalisation to fixed vectors, because the database cannot recompute it', () => {
    // **Why fixed vectors and not just properties.** The canonical form of a question is computed in
    // one language and stored, hashed, in another: the digest travels into `kb_gap.question_sha256`,
    // where a partial unique index decides whether a re-asked question is the same episode or a new
    // one. PostgreSQL cannot recompute it to check. So a change to the normaliser — a different
    // Unicode form, a stripped character that used to survive, a collapse that used to not happen —
    // would silently re-partition every record already written, and nothing anywhere would notice.
    //
    // These pin it. A drift in `canonicalQueryForm` is a red build here rather than a queue that
    // quietly grows a second record per question.
    const vectors = [
      ['Who can view the audit trail?', 'who can view the audit trail?'],
      ['  Two   spaces\nand a newline  ', 'two spaces and a newline'],
      // Compatibility normalisation, which is the step a reader is least likely to predict.
      ['ﬁle ①', 'file 1'],
      // Diacritics survive: NFKC composes, it does not strip accents, and a system that folded them
      // would call two different words one question.
      ['¿Cuándo caduca la etiqueta?', '¿cuándo caduca la etiqueta?'],
      // And a script where a character is one code point and three bytes.
      ['配送ラベルの再発行', '配送ラベルの再発行'],
    ];

    for (const [input, expected] of vectors) {
      assert.equal(
        canonicalQueryForm(input),
        expected,
        `the canonical form of ${JSON.stringify(input)} moved`,
      );
    }

    // And the digest of one of them, spelled out, so the whole pipeline from text to stored identity
    // is pinned and not only its first half.
    const digest = createHash('sha256')
      .update(canonicalQueryForm('Who can view the audit trail?'), 'utf8')
      .digest('hex');
    assert.equal(digest, sha256Of('who can view the audit trail?'));
    assert.match(digest, /^[a-f0-9]{64}$/);
  });

  it('canonicalises a question the same way whatever spelling it arrives in', () => {
    // The digest of this form is the identity of a gap ACROSS corpora, so two spellings of one
    // question must not be two questions.
    const forms = [
      'Who can view the AUDIT trail?',
      'who can view the audit   trail?',
      'Who can view the audit\ntrail?',
      '  Who can view the audit trail?  ',
    ];
    const canonical = forms.map(canonicalQueryForm);
    for (const form of canonical) {
      assert.equal(form, canonical[0], `'${form}' is not the same question as '${canonical[0]}'`);
    }
    assert.notEqual(canonicalQueryForm('who can view the shipment'), canonical[0]);
  });
});
