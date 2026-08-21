// test_AGENT_envelopes_share_a_root_contract
//
// Three agents, three strict validators, one root contract — and the three validators do not share
// a line of code.
//
// That is a deliberate arrangement and this file is what makes it safe. A base class with an
// `agent` parameter would mean that the day somebody loosens one contract is the day all three
// loosen, quietly, in a diff that touches one file and changes what three agents accept. Written as
// siblings, each one can be read on its own and refused on its own — and the risk that replaces the
// shared-code risk is drift: one validator gaining a tolerance the others do not have, discovered
// by an envelope that one agent accepts and another rejects for reasons nobody can reconstruct.
//
// So the agreement is MEASURED rather than assumed. The same battery of malformed envelopes goes
// through all three parsers, and every one of them must be refused by all three with `E_SCHEMA`.
// What each validator adds on top of this — a triage block that must be complete, a citation that
// must have been offered, a verdict that must be a boolean — is its own business and is tested in
// its own file.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDraftEnvelope } from '../../agents/draft/envelope.ts';
import { parseTriageEnvelope } from '../../agents/triage/envelope.ts';
import { parseValidateEnvelope } from '../../agents/validate/envelope.ts';

const SOURCE = { kb_id: 'billing/duplicate-charge:c0de0001000040008000000000000001', excerpt: 'a source' };

/** The three parsers behind one signature, so the battery below does not care which is which. */
const PARSERS = [
  { agent: 'triage', parse: (text) => parseTriageEnvelope(text) },
  { agent: 'draft', parse: (text) => parseDraftEnvelope(text, [SOURCE]) },
  { agent: 'validate', parse: (text) => parseValidateEnvelope(text) },
];

/** A complete, valid envelope for each agent, so that the refusals below are about the wrapping. */
const VALID = {
  triage: {
    schema_version: '1.0',
    agent: 'triage',
    confidence: 0.9,
    triage: { category: 'billing', severity: 2, sentiment: 0.1 },
  },
  draft: {
    schema_version: '1.0',
    agent: 'draft',
    confidence: 0.9,
    draft: { text: 'We are looking into it.', kb_ids: [SOURCE.kb_id] },
  },
  validate: {
    schema_version: '1.0',
    agent: 'validate',
    confidence: 0.9,
    validate: { grounded: true, unsupported_claims: [] },
  },
};

function refusedByAll(text, because) {
  for (const parser of PARSERS) {
    let raised = null;
    try {
      parser.parse(text);
    } catch (error) {
      raised = error;
    }
    assert.ok(raised, `${because}: the ${parser.agent} validator accepted it`);
    assert.equal(raised.code, 'E_SCHEMA', `${because}: the ${parser.agent} validator raised ${raised.code}`);
  }
}

describe('test_AGENT_envelopes_share_a_root_contract', () => {
  it('accepts each agent its own complete envelope', () => {
    // The premise of every refusal below: on its own, each of these is fine.
    assert.equal(parseTriageEnvelope(JSON.stringify(VALID.triage)).agent, 'triage');
    assert.equal(parseDraftEnvelope(JSON.stringify(VALID.draft), [SOURCE]).agent, 'draft');
    assert.equal(parseValidateEnvelope(JSON.stringify(VALID.validate)).agent, 'validate');
  });

  it('refuses anything that is not JSON, in all three', () => {
    refusedByAll('', 'an empty response is not an envelope');
    refusedByAll('not json at all', 'prose is not an envelope');
    refusedByAll('{"schema_version":"1.0",}', 'a trailing comma is not JSON');
    refusedByAll("{'schema_version':'1.0'}", 'single quotes are not JSON');
  });

  it('refuses anything that is not a JSON object, in all three', () => {
    for (const text of ['null', '42', '"answered"', 'true', '[]']) {
      refusedByAll(text, `${text} is not an envelope`);
    }
  });

  it('refuses a fenced or padded envelope, in all three', () => {
    for (const parser of PARSERS) {
      const body = JSON.stringify(VALID[parser.agent]);
      for (const wrapped of [
        '```json\n' + body + '\n```',
        `Here is the answer:\n${body}`,
        `${body}\n\nLet me know if you need anything else.`,
        `${body}\n${body}`,
      ]) {
        assert.throws(
          () => parser.parse(wrapped),
          (error) => error.code === 'E_SCHEMA',
          `the ${parser.agent} validator recovered an envelope from its wrapping`,
        );
      }
    }
  });

  it('refuses a schema version this build does not publish, in all three', () => {
    for (const parser of PARSERS) {
      const envelope = { ...VALID[parser.agent], schema_version: '2.0' };
      assert.throws(
        () => parser.parse(JSON.stringify(envelope)),
        (error) => error.code === 'E_SCHEMA',
        `the ${parser.agent} validator accepted a different contract`,
      );
    }
  });

  it('refuses a root key the contract does not publish, in all three', () => {
    for (const parser of PARSERS) {
      const envelope = { ...VALID[parser.agent], reasoning: 'because it seemed right' };
      let raised = null;
      try {
        parser.parse(JSON.stringify(envelope));
      } catch (error) {
        raised = error;
      }
      assert.equal(raised?.code, 'E_SCHEMA', `the ${parser.agent} validator accepted an unpublished key`);
      assert.equal(raised.detail.key, 'reasoning');
    }
  });

  it("refuses another agent's envelope, and another agent's block, in all three", () => {
    for (const parser of PARSERS) {
      for (const other of PARSERS) {
        if (other.agent === parser.agent) continue;

        // A well-formed envelope from another agent is still not this agent's answer.
        let raised = null;
        try {
          parser.parse(JSON.stringify(VALID[other.agent]));
        } catch (error) {
          raised = error;
        }
        assert.equal(raised?.code, 'E_SCHEMA', `${parser.agent} accepted a ${other.agent} envelope`);

        // And this agent's envelope carrying another agent's block is two agents in one answer.
        const mixed = { ...VALID[parser.agent], [other.agent]: VALID[other.agent][other.agent] };
        let mixedError = null;
        try {
          parser.parse(JSON.stringify(mixed));
        } catch (error) {
          mixedError = error;
        }
        assert.equal(mixedError?.code, 'E_SCHEMA', `${parser.agent} accepted a ${other.agent} block`);
        assert.equal(mixedError.detail.foreign_block, other.agent);
      }
    }
  });

  it('requires a numeric confidence in [0, 1] at the ROOT, in all three', () => {
    for (const parser of PARSERS) {
      for (const confidence of [undefined, null, '0.9', 1.5, -0.1, Number.NaN]) {
        const envelope = { ...VALID[parser.agent] };
        if (confidence === undefined) delete envelope.confidence;
        else envelope.confidence = confidence;

        assert.throws(
          () => parser.parse(JSON.stringify(envelope)),
          (error) => error.code === 'E_SCHEMA',
          `the ${parser.agent} validator accepted confidence ${String(confidence)}`,
        );
      }

      // And it must not be inside the block, which is the mistake that would leave the ledger's own
      // column null on every row while the envelope went on validating.
      const block = { ...VALID[parser.agent] };
      delete block.confidence;
      block[parser.agent] = { ...block[parser.agent], confidence: 0.9 };
      assert.throws(
        () => parser.parse(JSON.stringify(block)),
        (error) => error.code === 'E_SCHEMA',
        `the ${parser.agent} validator read a confidence from inside its block`,
      );
    }
  });

  it('requires its own block to be present, in all three', () => {
    for (const parser of PARSERS) {
      const envelope = { ...VALID[parser.agent] };
      delete envelope[parser.agent];
      let raised = null;
      try {
        parser.parse(JSON.stringify(envelope));
      } catch (error) {
        raised = error;
      }
      assert.equal(raised?.code, 'E_SCHEMA', `the ${parser.agent} validator accepted an empty envelope`);
      assert.equal(raised.detail.missing_block, parser.agent);
    }
  });

  it('never carries the text it refused into the refusal, in all three', () => {
    // The number is invented and is meant to be. This repository is public, and a fixture is one of
    // the easiest places for a real person's contact details to end up somewhere permanent.
    const chatty = 'I cannot help with that. Please call 0400 000 001 for assistance.';
    for (const parser of PARSERS) {
      let raised = null;
      try {
        parser.parse(chatty);
      } catch (error) {
        raised = error;
      }
      assert.equal(raised?.code, 'E_SCHEMA');
      assert.ok(
        !JSON.stringify(raised.detail).includes('0400'),
        `the ${parser.agent} refusal carried the text it was given, which is how a model echoing a phone number puts it in a log`,
      );
      assert.equal(typeof raised.detail.response_length, 'number');
    }
  });
});
