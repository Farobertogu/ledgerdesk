// test_VALIDATE_envelope_rejects_a_policy_judgement
//
// The specification contradicts itself about this envelope. §8.2 states that a policy flag may
// never be a model's judgement; §9.1 puts `policy_flags` in the model's output block. ADR-024 §3
// resolves it in favour of the prohibition, and this file is where the resolution stops being a
// paragraph and becomes a refusal.
//
// The reason §8.2 governs is worth restating, because "the model could also mention it, and we
// could ignore it" sounds harmless: `POLICY` is the highest precedence in the escalation rule and
// the only reason no published column can reconstruct — the flags are deliberately never stored, so
// that the criterion the precedence was published under stays true. If a model decided it, the one
// code that routes a ticket to a lawyer or a safety desk would be the one code nobody could re-run.
// A channel that exists and is ignored is a channel the next person wires up.
//
// The rest of the file is the two things this validator has that its siblings do not: a verdict
// that must be an actual boolean, and a refusal to accept an envelope that says both things at once.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseValidateEnvelope } from '../../agents/validate/envelope.ts';
import { AGENT_IO_SCHEMA } from '../../agents/triage/schema.ts';

function envelope(validate, confidence = 0.9) {
  return JSON.stringify({ schema_version: '1.0', agent: 'validate', confidence, validate });
}

function refused(text, because) {
  let raised = null;
  try {
    parseValidateEnvelope(text);
  } catch (error) {
    raised = error;
  }
  assert.ok(raised, `${because}: the envelope was accepted`);
  assert.equal(raised.code, 'E_SCHEMA', `${because}: raised ${raised.code}`);
  return raised;
}

describe('test_VALIDATE_envelope_rejects_a_policy_judgement', () => {
  it('accepts the verdict the contract publishes', () => {
    const parsed = parseValidateEnvelope(envelope({ grounded: true, unsupported_claims: [] }));
    assert.equal(parsed.validate.grounded, true);
    assert.deepEqual(parsed.validate.unsupported_claims, []);

    const refusedVerdict = parseValidateEnvelope(
      envelope({ grounded: false, unsupported_claims: ['a timeframe no source states'] }),
    );
    assert.equal(refusedVerdict.validate.grounded, false);
    assert.equal(refusedVerdict.validate.unsupported_claims.length, 1);
  });

  it('refuses a policy judgement, whatever it carries', () => {
    for (const policy_flags of [[], ['legal'], ['refund', 'complaint'], null]) {
      const error = refused(
        envelope({ grounded: true, unsupported_claims: [], policy_flags }),
        'a policy flag is the deterministic matcher’s and never a model’s',
      );
      assert.equal(error.detail.key, 'policy_flags');
    }
  });

  it('publishes no policy member in the schema either, so the two agree', () => {
    // Belt and braces on the same decision from the other side: the contract itself must not offer
    // the field, or an envelope this validator refuses would be one the published document invites.
    const block = AGENT_IO_SCHEMA.$defs.validate_block;
    assert.deepEqual(Object.keys(block.properties).sort(), ['grounded', 'unsupported_claims']);
    assert.deepEqual(block.required.sort(), ['grounded', 'unsupported_claims']);
    assert.equal(block.additionalProperties, false);
  });

  it('requires an actual boolean, because a truthy value is not a verdict', () => {
    // `"false"` is a non-empty string and would read as TRUE under a coercion. On this field that
    // is the difference between stopping a reply and sending it.
    for (const grounded of ['false', 'true', 1, 0, null, undefined, {}]) {
      const validate = { grounded, unsupported_claims: [] };
      if (grounded === undefined) delete validate.grounded;
      refused(envelope(validate), `grounded as ${String(grounded)} is not a boolean`);
    }
  });

  it('requires the claims to be a list of strings', () => {
    for (const unsupported_claims of [null, 'a claim', 7, [7], [null], {}]) {
      refused(
        envelope({ grounded: false, unsupported_claims }),
        `claims as ${JSON.stringify(unsupported_claims)} is not a list of strings`,
      );
    }
  });

  it('refuses a verdict that says grounded and lists what is not supported', () => {
    // Two answers in one envelope. The safe reading is not obvious enough to be chosen quietly
    // here, so the cycle is made to ask again rather than to guess which half the model meant.
    const error = refused(
      envelope({ grounded: true, unsupported_claims: ['the refund window'] }),
      'a grounded verdict listing unsupported claims is two verdicts',
    );
    assert.equal(error.detail.claim_count, 1);
  });

  it('carries no quoted claim into a refusal', () => {
    const error = refused(
      envelope({ grounded: 'yes', unsupported_claims: ['the customer at 0400 000 001 is owed a refund'] }),
      'the verdict is not a boolean',
    );
    assert.ok(
      !JSON.stringify(error.detail).includes('0400'),
      'the refusal carried a claim, which is how a quoted line ends up in a log',
    );
  });
});
