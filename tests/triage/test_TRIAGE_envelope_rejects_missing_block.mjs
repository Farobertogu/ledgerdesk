// test_TRIAGE_envelope_rejects_missing_block
//
// The hole, and the thing that closes it.
//
// `agents/schemas/agent_io.schema.json` requires three keys of an output envelope —
// `schema_version`, `agent`, `confidence` — and does NOT require the per-agent block. So
// `{"schema_version":"1.0","agent":"triage","confidence":0.9}` is schema-valid. It also satisfies,
// word for word, the guard the state machine publishes on `NEW → TRIAGED`: "triage returned a
// schema-valid object carrying its confidence". A ticket would move to TRIAGED with its category,
// severity and sentiment empty, no rule would have been broken, and the queue would show a triaged
// ticket that nothing had triaged.
//
// This test asserts both halves: that the published schema really does leave the block optional —
// so that the hardening is measured against the document rather than against a memory of it — and
// that the validator refuses the envelope anyway.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTriageEnvelope } from '../../agents/triage/envelope.ts';
import { AGENT_ERROR_CODES } from '../../agents/triage/errors.ts';
import { AGENT_IO_SCHEMA } from '../../agents/triage/schema.ts';

/** Asserts the text is refused with E_SCHEMA, and returns the refusal. */
function refused(text, because) {
  try {
    parseTriageEnvelope(text);
  } catch (error) {
    assert.equal(error.name, 'AgentError', `${because}: expected an AgentError, got ${error.name}`);
    assert.equal(error.code, 'E_SCHEMA', because);
    return error;
  }
  return assert.fail(`${because}: the envelope was accepted`);
}

describe('test_TRIAGE_envelope_rejects_missing_block', () => {
  it('confirms the published schema leaves the triage block optional', () => {
    const output = AGENT_IO_SCHEMA.$defs.agent_output;
    assert.deepEqual(output.required, ['schema_version', 'agent', 'confidence']);
    assert.ok(
      !output.required.includes('triage'),
      'the schema now requires the triage block, so this test no longer measures the hardening it was written for',
    );
    assert.ok(output.properties.triage, 'the schema no longer publishes a triage block at all');
  });

  it('refuses the minimal envelope the schema would accept', () => {
    const bare = JSON.stringify({ schema_version: '1.0', agent: 'triage', confidence: 0.9 });
    const error = refused(bare, 'an envelope with no triage block decides nothing about the ticket');
    assert.equal(error.detail.missing_block, 'triage');
  });

  it('refuses a triage block that is present and incomplete, key by key', () => {
    const complete = { category: 'billing', severity: 2, sentiment: 0.1 };

    for (const missing of ['category', 'severity', 'sentiment']) {
      const triage = { ...complete };
      delete triage[missing];
      const error = refused(
        JSON.stringify({ schema_version: '1.0', agent: 'triage', confidence: 0.9, triage }),
        `a triage block without ${missing} is incomplete`,
      );
      assert.equal(error.detail.missing_key, missing);
    }
  });

  it('refuses a triage block that is not an object', () => {
    for (const triage of [null, 'billing', 42, [], true]) {
      refused(
        JSON.stringify({ schema_version: '1.0', agent: 'triage', confidence: 0.9, triage }),
        `a triage block of ${JSON.stringify(triage)} is not a verdict`,
      );
    }
  });

  it('refuses a triage block carrying a key the contract does not publish', () => {
    const error = refused(
      JSON.stringify({
        schema_version: '1.0',
        agent: 'triage',
        confidence: 0.9,
        triage: { category: 'billing', severity: 2, sentiment: 0.1, escalate: true },
      }),
      'the model does not decide whether to escalate; the rule does',
    );
    assert.equal(error.detail.key, 'escalate');
  });

  it('accepts the complete envelope, and reads exactly the four fields', () => {
    const envelope = parseTriageEnvelope(
      JSON.stringify({
        schema_version: '1.0',
        agent: 'triage',
        confidence: 0.875,
        triage: { category: 'billing', severity: 3, sentiment: -0.42 },
      }),
    );

    assert.deepEqual(envelope, {
      schema_version: '1.0',
      agent: 'triage',
      confidence: 0.875,
      triage: { category: 'billing', severity: 3, sentiment: -0.42 },
    });
  });

  it('carries no part of the envelope in the refusal', () => {
    const secret = 'Case reference 44 Wattle Street, Pyrmont';
    const error = refused(
      JSON.stringify({ schema_version: '1.0', agent: 'triage', confidence: 0.9, triage: secret }),
      'a triage block that is a string is not a verdict',
    );
    assert.ok(
      !JSON.stringify(error.detail).includes('Wattle'),
      'the refusal quoted the value it caught, which is how a refusal spreads what it stopped',
    );
    assert.ok(!error.message.includes('Wattle'));
  });

  it('raises a code the agent-layer register publishes', () => {
    assert.ok(AGENT_ERROR_CODES.includes('E_SCHEMA'));
  });
});
