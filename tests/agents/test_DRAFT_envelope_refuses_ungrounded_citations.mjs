// test_DRAFT_envelope_refuses_ungrounded_citations
//
// The two conditions the drafting agent has that no other agent has, and the partition of failures
// they belong to.
//
// A draft can fail to stand on its sources in three different ways and they are answered
// differently, which is the whole reason the partition exists rather than one code for all of them:
//
//   · **no citations at all** is a SCHEMA violation, because `minItems: 1` is in the published
//     contract. It is retried, on the ordinary ground that a model which answered badly may answer
//     well;
//   · **a citation that was never offered** is `E_NO_GROUNDING`, and it is NOT retried. A model
//     that invented a reference will invent a different one under another seed;
//   · **a long passage lifted out of a source the draft does not cite** is also `E_NO_GROUNDING`.
//     Nothing about the answer is malformed. It reproduces material whose provenance the record
//     would not carry, which is a leak rather than a quotation.
//
// The last one is the one that looks like a plagiarism check and is not. The excerpts are material
// the tenant admitted; the draft goes to a customer; a passage that travelled from a source into a
// reply without the reply naming that source is a passage nobody can account for afterwards. If it
// is quotable, it is citable.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDraftEnvelope, sharesVerbatimRun, VERBATIM_RUN_MIN } from '../../agents/draft/envelope.ts';
import { DRAFT_TEXT_MAX } from '../../agents/triage/schema.ts';

const FIRST = {
  kb_id: 'billing/duplicate-charge:c0de0001000040008000000000000001',
  excerpt:
    'A duplicate charge is refunded to the original payment method within five business days of confirmation.',
};

const SECOND = {
  kb_id: 'exports/schedule:c0de0004000040008000000000000001',
  excerpt:
    'The nightly export window can be moved by an account owner from the scheduling screen, and the new time applies from the following night.',
};

function envelope(draft, confidence = 0.9) {
  return JSON.stringify({ schema_version: '1.0', agent: 'draft', confidence, draft });
}

function refusedWith(code, text, sources, because) {
  let raised = null;
  try {
    parseDraftEnvelope(text, sources);
  } catch (error) {
    raised = error;
  }
  assert.ok(raised, `${because}: the envelope was accepted`);
  assert.equal(raised.code, code, `${because}: raised ${raised.code}`);
  return raised;
}

describe('test_DRAFT_envelope_refuses_ungrounded_citations', () => {
  it('accepts a reply that cites a source it was given', () => {
    const parsed = parseDraftEnvelope(
      envelope({ text: 'We will refund the duplicate charge.', kb_ids: [FIRST.kb_id] }),
      [FIRST, SECOND],
    );
    assert.deepEqual(parsed.draft.kb_ids, [FIRST.kb_id]);
    assert.equal(parsed.confidence, 0.9);
  });

  it('does not require every source to be cited', () => {
    // Retrieval hands over what it found; a draft cites what it used. Requiring all of them would
    // push a model towards citing things it did not rely on, which is the failure the overlap
    // conjunct exists to catch — introduced here by the contract instead.
    const parsed = parseDraftEnvelope(
      envelope({ text: 'We will refund the duplicate charge.', kb_ids: [FIRST.kb_id] }),
      [FIRST, SECOND],
    );
    assert.equal(parsed.draft.kb_ids.length, 1);
  });

  it('refuses an empty citation list as a SCHEMA violation, which is retryable', () => {
    const error = refusedWith(
      'E_SCHEMA',
      envelope({ text: 'Everything appears to be in order.', kb_ids: [] }),
      [FIRST],
      'a draft with no source is what minItems 1 forbids',
    );
    assert.equal(error.detail.kb_ids_length, 0);
  });

  it('refuses a citation list that is not a list', () => {
    for (const kb_ids of [null, 'billing/duplicate-charge', {}, 7]) {
      refusedWith('E_SCHEMA', envelope({ text: 'A reply.', kb_ids }), [FIRST], 'citations are an array');
    }
  });

  it('refuses an identifier outside the published alphabet', () => {
    for (const kb_id of ['has a space', 'has\na newline', '', 'x'.repeat(129), 7, null]) {
      refusedWith(
        'E_SCHEMA',
        envelope({ text: 'A reply.', kb_ids: [kb_id] }),
        [FIRST],
        `'${String(kb_id).slice(0, 20)}' is not of the published form`,
      );
    }
  });

  it('refuses a reply that is empty, or longer than the contract admits', () => {
    refusedWith('E_SCHEMA', envelope({ text: '', kb_ids: [FIRST.kb_id] }), [FIRST], 'an empty reply');
    refusedWith('E_SCHEMA', envelope({ text: '   ', kb_ids: [FIRST.kb_id] }), [FIRST], 'whitespace is empty');
    refusedWith(
      'E_SCHEMA',
      envelope({ text: 'x'.repeat(DRAFT_TEXT_MAX + 1), kb_ids: [FIRST.kb_id] }),
      [FIRST],
      'a reply past the published maximum',
    );
  });

  it('refuses a source that was never handed over, and does not call it a schema violation', () => {
    const error = refusedWith(
      'E_NO_GROUNDING',
      envelope({
        text: 'Our published policy covers this in full.',
        kb_ids: ['policy/invented:00000000000040008000000000000000'],
      }),
      [FIRST],
      'the draft cites a document this call was not given',
    );
    assert.equal(error.detail.kb_id, 'policy/invented:00000000000040008000000000000000');
    // The identifiers that WERE offered travel, because an operator reading this needs to see what
    // the model had to choose from. The excerpts do not.
    assert.deepEqual(error.detail.offered, [FIRST.kb_id]);
    assert.ok(
      !JSON.stringify(error.detail).includes('duplicate charge is refunded'),
      'the refusal carried an excerpt',
    );
  });

  it('refuses a long run copied out of a source the draft does not cite', () => {
    // Every word of this reply comes from SECOND, and it cites FIRST.
    const lifted = `Thank you for asking. ${SECOND.excerpt}`;
    assert.ok(lifted.length > VERBATIM_RUN_MIN, 'the fixture is not long enough to be a leak');

    const error = refusedWith(
      'E_NO_GROUNDING',
      envelope({ text: lifted, kb_ids: [FIRST.kb_id] }),
      [FIRST, SECOND],
      'a passage travelled from a source the record does not connect it to',
    );
    assert.equal(error.detail.kb_id, SECOND.kb_id);
    assert.equal(error.detail.run_minimum, VERBATIM_RUN_MIN);
  });

  it('accepts the same passage the moment the source it came from is cited', () => {
    // The rule is about provenance, not about copying. Citing it makes it a quotation.
    const parsed = parseDraftEnvelope(
      envelope({ text: `Thank you for asking. ${SECOND.excerpt}`, kb_ids: [FIRST.kb_id, SECOND.kb_id] }),
      [FIRST, SECOND],
    );
    assert.equal(parsed.draft.kb_ids.length, 2);
  });

  it('does not fire on a short phrase two documents would share anyway', () => {
    const shared = 'Thank you for getting in touch with us about this.';
    assert.ok(shared.length < VERBATIM_RUN_MIN, 'the fixture is longer than the threshold');
    const parsed = parseDraftEnvelope(envelope({ text: shared, kb_ids: [FIRST.kb_id] }), [FIRST, SECOND]);
    assert.equal(parsed.draft.text, shared);
  });

  it('sees through reflowed whitespace, which only ever widens what is caught', () => {
    const reflowed = SECOND.excerpt.replace(/ /g, '\n   ');
    assert.ok(sharesVerbatimRun(reflowed, SECOND.excerpt), 'a reflowed passage stopped being the passage');
    assert.ok(!sharesVerbatimRun('nothing in common here at all', SECOND.excerpt));
  });

  it('collapses a repeated citation rather than counting it twice', () => {
    const parsed = parseDraftEnvelope(
      envelope({ text: 'We will refund it.', kb_ids: [FIRST.kb_id, FIRST.kb_id] }),
      [FIRST],
    );
    assert.deepEqual(parsed.draft.kb_ids, [FIRST.kb_id]);
  });

  it('refuses a draft block carrying a key the contract does not publish', () => {
    const error = refusedWith(
      'E_SCHEMA',
      envelope({ text: 'A reply.', kb_ids: [FIRST.kb_id], sources_used: 1 }),
      [FIRST],
      'the draft block publishes two keys',
    );
    assert.equal(error.detail.key, 'sources_used');
  });
});
