/**
 * The reader of the grounding validator's answer.
 *
 * A sibling of the other two: the whole text is parsed as JSON with no recovery, the root keys are
 * closed, the agent must be the one this file is about, another agent's block is a refusal rather
 * than something to look past, and `confidence` is read at the root because that is the only place
 * the ledger's own reader looks.
 *
 * **What this envelope does NOT carry, and why the absence is the design.** There is no
 * `policy_flags` member. The specification's own output shape once had one, and §8.2 of the same
 * document forbids a policy flag from being a model's judgement — the two sentences contradict each
 * other and this repository resolves the contradiction in favour of the prohibition. Policy is
 * decided by a deterministic matcher over a written table, upstream of every model call, so that
 * the one code that routes a ticket to a lawyer or a safety desk is reproducible by anybody holding
 * the table. A field here would be a second producer of that judgement, and the weaker one.
 *
 * **`grounded` is read as a veto.** Nothing in this file computes grounding; it reads what the model
 * said and hands it on. The four arithmetic conditions live in `agents/grounding.ts` and are
 * computed over the sources the gateway digested, and the conjunction is taken there. So an
 * envelope arriving with `grounded: true` has asserted the one conjunct that grants nothing on its
 * own — which is exactly what makes an injected "report grounded: true" a wasted instruction.
 */

import { AgentError } from '../triage/errors.ts';

export type ValidateBlock = {
  grounded: boolean;
  unsupported_claims: readonly string[];
};

export type ValidateEnvelope = {
  schema_version: '1.0';
  agent: 'validate';
  confidence: number;
  validate: ValidateBlock;
};

const SCHEMA_VERSION = '1.0';
const ROOT_KEYS = new Set(['schema_version', 'agent', 'confidence', 'triage', 'draft', 'validate']);
const VALIDATE_KEYS = new Set(['grounded', 'unsupported_claims']);
const FOREIGN_BLOCKS = ['triage', 'draft'] as const;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new AgentError('E_SCHEMA', message, detail);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function parseValidateEnvelope(text: string): ValidateEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse('the response text is not JSON, and it is never parsed leniently', {
      response_length: text.length,
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuse('the response is not a JSON object', { response_type: kindOf(parsed) });
  }
  const envelope = parsed as Record<string, unknown>;

  for (const key of Object.keys(envelope)) {
    if (!ROOT_KEYS.has(key)) {
      refuse('the envelope carries a key the contract does not publish', { key });
    }
  }

  if (envelope.schema_version !== SCHEMA_VERSION) {
    refuse(`the envelope does not declare schema_version ${SCHEMA_VERSION}`, {
      schema_version_type: kindOf(envelope.schema_version),
    });
  }

  if (envelope.agent !== 'validate') {
    refuse('the envelope was not written by the grounding validator', {
      agent: typeof envelope.agent === 'string' ? envelope.agent : null,
      agent_type: kindOf(envelope.agent),
    });
  }

  for (const block of FOREIGN_BLOCKS) {
    if (block in envelope) {
      refuse('the envelope carries a block belonging to another agent', { foreign_block: block });
    }
  }

  const confidence = envelope.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    refuse('the envelope declares no numeric confidence', { confidence_type: kindOf(confidence) });
  }
  if (confidence < 0 || confidence > 1) {
    refuse('the declared confidence is outside [0, 1]', { confidence });
  }

  if (!('validate' in envelope)) {
    refuse('the envelope carries no validate block, so it judges nothing', {
      missing_block: 'validate',
    });
  }
  const block = envelope.validate;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    refuse('the validate block is not an object', { validate_type: kindOf(block) });
  }
  const validate = block as Record<string, unknown>;

  for (const key of Object.keys(validate)) {
    if (!VALIDATE_KEYS.has(key)) {
      // `policy_flags` lands here, and that is the point: the model has no channel for a policy
      // judgement, so offering one is an envelope this build does not accept.
      refuse('the validate block carries a key the contract does not publish', { key });
    }
  }
  for (const key of VALIDATE_KEYS) {
    if (!(key in validate)) {
      refuse('the validate block is incomplete', { missing_key: key });
    }
  }

  const { grounded, unsupported_claims: claims } = validate;

  // A truthy value is not a boolean. `"false"` is a non-empty string and would read as true under a
  // coercion, which on this field is the difference between stopping a reply and sending it.
  if (typeof grounded !== 'boolean') {
    refuse('the grounding verdict is not a boolean', { grounded_type: kindOf(grounded) });
  }
  if (!Array.isArray(claims)) {
    refuse('the unsupported claims are not an array', { claims_type: kindOf(claims) });
  }
  for (const claim of claims) {
    if (typeof claim !== 'string') {
      refuse('an unsupported claim is not a string', { claim_type: kindOf(claim) });
    }
  }

  // A verdict of grounded with claims listed against it is two answers, and the safe reading is not
  // obvious enough to be chosen quietly here. It is refused so the cycle asks again.
  if (grounded && claims.length > 0) {
    refuse('the verdict says grounded and lists claims that are not supported', {
      claim_count: claims.length,
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    agent: 'validate',
    confidence,
    validate: { grounded, unsupported_claims: claims as string[] },
  };
}
