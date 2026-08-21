// test_TRIAGE_envelope_never_lenient
//
// The parse is over the WHOLE response text, and there is no recovery of any kind.
//
// Every case below is a shape a language model really produces: a fenced code block, a sentence of
// introduction, a closing remark, two objects, a trailing comma. Every one of them contains a
// perfectly good envelope that a lenient parser could find, and finding it is exactly what must
// not happen. A validator that strips fences has decided the fence was not part of the answer; a
// validator that scans for the first `{` has decided which of two objects the model meant. Both
// are the validator forming an opinion about a model's intent, which is the one thing the whole
// machine-readable contract exists to avoid — and both fail silently the day the model puts the
// real answer second.
//
// The cost of strictness is a retry, which the cycle already has: a failed parse increments the
// counter, moves the seed, and asks again. The cost of leniency is a verdict nobody can reproduce.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTriageEnvelope } from '../../agents/triage/envelope.ts';

const VALID = '{"agent":"triage","confidence":0.9,"schema_version":"1.0","triage":{"category":"billing","severity":2,"sentiment":0.1}}';

function refused(text, because) {
  try {
    parseTriageEnvelope(text);
  } catch (error) {
    assert.equal(error.code, 'E_SCHEMA', because);
    return error;
  }
  return assert.fail(`${because}: the text was accepted`);
}

describe('test_TRIAGE_envelope_never_lenient', () => {
  it('accepts the envelope on its own, so the refusals below are about the wrapping', () => {
    const envelope = parseTriageEnvelope(VALID);
    assert.equal(envelope.triage.category, 'billing');
  });

  it('refuses a fenced envelope', () => {
    refused('```json\n' + VALID + '\n```', 'a fence is part of the response text');
    refused('```\n' + VALID + '\n```', 'an unlabelled fence is a fence');
  });

  it('refuses an envelope with prose in front of it', () => {
    refused(`Here is the triage you asked for:\n${VALID}`, 'the preamble is part of the response');
  });

  it('refuses an envelope with prose after it', () => {
    refused(`${VALID}\n\nLet me know if you need anything else.`, 'the sign-off is part of the response');
  });

  it('refuses two envelopes, however good either one is', () => {
    refused(`${VALID}\n${VALID}`, 'two answers are not one answer');
  });

  it('refuses JSON that is nearly JSON', () => {
    refused('{"schema_version":"1.0","agent":"triage","confidence":0.9,}', 'a trailing comma is not JSON');
    refused("{'schema_version':'1.0','agent':'triage'}", 'single quotes are not JSON');
    refused('{schema_version: "1.0", agent: "triage"}', 'unquoted keys are not JSON');
  });

  it('refuses a response that is not an object', () => {
    for (const text of ['null', '42', '"triaged"', 'true', `[${VALID}]`]) {
      const error = refused(text, `${text} is not an envelope`);
      assert.ok(typeof error.detail.response_type === 'string');
    }
  });

  it('refuses an empty response, and says how long it was rather than what it said', () => {
    const error = refused('', 'an empty response is not an envelope');
    assert.equal(error.detail.response_length, 0);

    // The number is invented and is meant to be. This repository is public, and a fixture is one
    // of the easiest places for a real person's contact details to end up somewhere permanent.
    const chatty = refused(
      'I am sorry, I cannot help with that. Please contact 0400 000 001 for assistance.',
      'a refusal in prose is still not an envelope',
    );
    assert.equal(typeof chatty.detail.response_length, 'number');
    assert.ok(
      !JSON.stringify(chatty.detail).includes('0400'),
      'the refusal carried the text it was given, which is how a model echoing a phone number puts it in a log',
    );
  });

  it('refuses leading and trailing whitespace nowhere else and everywhere here', () => {
    // JSON.parse itself tolerates surrounding whitespace, and that is the standard's decision
    // rather than this validator's: whitespace carries no content and no opinion about it.
    const padded = parseTriageEnvelope(`\n  ${VALID}\t\n`);
    assert.equal(padded.agent, 'triage');
  });

  it('refuses values outside the ranges the columns declare', () => {
    const withConfidence = (confidence) =>
      JSON.stringify({
        schema_version: '1.0',
        agent: 'triage',
        confidence,
        triage: { category: 'billing', severity: 2, sentiment: 0.1 },
      });

    refused(withConfidence(1.5), 'confidence above 1 does not fit numeric(4,3) with its check');
    refused(withConfidence(-0.1), 'confidence below 0 does not fit either');
    refused(withConfidence('0.9'), 'a confidence as a string is not a number');

    const withTriage = (triage) =>
      JSON.stringify({ schema_version: '1.0', agent: 'triage', confidence: 0.9, triage });

    refused(withTriage({ category: 'billing', severity: 5, sentiment: 0 }), 'severity is 1 to 4');
    refused(withTriage({ category: 'billing', severity: 0, sentiment: 0 }), 'severity is 1 to 4');
    refused(withTriage({ category: 'billing', severity: 2.5, sentiment: 0 }), 'severity is an integer');
    refused(withTriage({ category: 'billing', severity: 2, sentiment: -1.2 }), 'sentiment is −1 to 1');
    refused(withTriage({ category: '', severity: 2, sentiment: 0 }), 'a category of nothing is not a category');
    refused(
      withTriage({ category: 'x'.repeat(65), severity: 2, sentiment: 0 }),
      'a category longer than the published maximum',
    );
  });

  it('refuses an envelope declaring a schema version this build does not publish', () => {
    refused(
      JSON.stringify({
        schema_version: '2.0',
        agent: 'triage',
        confidence: 0.9,
        triage: { category: 'billing', severity: 2, sentiment: 0.1 },
      }),
      'a different contract is a different contract',
    );
  });
});
