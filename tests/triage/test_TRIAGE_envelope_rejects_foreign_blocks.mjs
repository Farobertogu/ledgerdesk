// test_TRIAGE_envelope_rejects_foreign_blocks
//
// An envelope carrying another agent's work is refused rather than partially consumed.
//
// The tempting alternative is to read the triage block and ignore the rest, and it is wrong in a
// way that only shows up later. The blocks are separate contracts with separate validators and
// separate writers; a triage response that also carries a draft means either the prompt is not the
// prompt anybody thinks it is, or the model has been asked two questions and answered them in one
// envelope. Consuming half of it makes the ledger row say a triage happened and leaves the other
// half unrecorded — and the drafting agent, when it arrives, would have no way to know that its
// block had been produced already and discarded.
//
// The other half of the rule is the agent name itself: an envelope from another agent may be
// perfectly well-formed and is still not a triage verdict.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTriageEnvelope } from '../../agents/triage/envelope.ts';
import { AGENT_IO_SCHEMA } from '../../agents/triage/schema.ts';

const TRIAGE = { category: 'billing', severity: 2, sentiment: 0.1 };

function refused(envelope, because) {
  try {
    parseTriageEnvelope(JSON.stringify(envelope));
  } catch (error) {
    assert.equal(error.code, 'E_SCHEMA', because);
    return error;
  }
  return assert.fail(`${because}: the envelope was accepted`);
}

describe('test_TRIAGE_envelope_rejects_foreign_blocks', () => {
  it('refuses an envelope carrying a draft block', () => {
    const error = refused(
      {
        schema_version: '1.0',
        agent: 'triage',
        confidence: 0.9,
        triage: TRIAGE,
        draft: { answer: 'We will look into it.', citations: [] },
      },
      'a triage envelope carrying a draft is two agents in one answer',
    );
    assert.equal(error.detail.foreign_block, 'draft');
  });

  it('refuses an envelope carrying a validate block', () => {
    const error = refused(
      {
        schema_version: '1.0',
        agent: 'triage',
        confidence: 0.9,
        triage: TRIAGE,
        validate: { grounded: true, unsupported_claims: [] },
      },
      'a triage envelope carrying a validation is two agents in one answer',
    );
    assert.equal(error.detail.foreign_block, 'validate');
  });

  it('refuses the foreign block even when it is empty or null', () => {
    // The check is on the key's presence and not on its contents: a key carrying null is still an
    // envelope that has an opinion about another agent's block.
    refused(
      { schema_version: '1.0', agent: 'triage', confidence: 0.9, triage: TRIAGE, draft: null },
      'a null draft block is still a draft block',
    );
    refused(
      { schema_version: '1.0', agent: 'triage', confidence: 0.9, triage: TRIAGE, validate: {} },
      'an empty validate block is still a validate block',
    );
  });

  it('refuses an envelope written by another agent', () => {
    for (const agent of ['draft', 'validate', 'evolve']) {
      const error = refused(
        { schema_version: '1.0', agent, confidence: 0.9, triage: TRIAGE },
        `an envelope from the ${agent} agent is not a triage verdict`,
      );
      assert.equal(error.detail.agent, agent);
    }
  });

  it('refuses an envelope whose agent is not a name the contract publishes', () => {
    refused(
      { schema_version: '1.0', agent: 'triage-v2', confidence: 0.9, triage: TRIAGE },
      'the agent names are a closed set',
    );
    refused(
      { schema_version: '1.0', agent: null, confidence: 0.9, triage: TRIAGE },
      'an envelope with no agent names nobody',
    );
  });

  it('refuses a key that is not published at the root at all', () => {
    const error = refused(
      {
        schema_version: '1.0',
        agent: 'triage',
        confidence: 0.9,
        triage: TRIAGE,
        reasoning: 'because the invoice is duplicated',
      },
      'the contract publishes the keys of the envelope, and this is not one of them',
    );
    assert.equal(error.detail.key, 'reasoning');
  });

  it('refuses the two blocks the schema reserves but nothing writes yet', () => {
    // The reserved blocks exist in the published document so that the agents that will write them
    // do not each invent a shape. Their presence in a TRIAGE envelope is still a refusal today.
    assert.ok(AGENT_IO_SCHEMA.$defs.draft_block, 'the schema no longer reserves a draft block');
    assert.ok(AGENT_IO_SCHEMA.$defs.validate_block, 'the schema no longer reserves a validate block');
  });
});
