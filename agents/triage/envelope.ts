/**
 * The only reader of `response_text` in this tree.
 *
 * The chokepoint says in its own header that it does not validate the agent envelope, and it is
 * right not to: forcing the check there would put a second, quieter validator in the path and make
 * every agent's contract the gateway's business. What the gateway does read is the single field
 * the ledger has a column for — a top-level `confidence`, and only when it is unambiguous — and
 * that reading is independent of this one on purpose. When an envelope is valid the two agree,
 * because they are reading the same key of the same text. When they would not agree, this file
 * refuses the envelope and there is nothing to agree about.
 *
 * **Strict in both senses.**
 *
 * The parse is strict: `JSON.parse` over the *whole* response text. No fence stripping, no prose
 * trimming, no recovery, no second attempt at a substring that looks like an object. A validator
 * that repairs its input is a validator that decides what the model meant, and the whole reason
 * the verdict is machine-readable is so that nobody has to.
 *
 * The acceptance is stricter than the published schema, and ADR-023 §6 records why in full. The
 * short version: `agents/schemas/agent_io.schema.json` requires `schema_version`, `agent` and
 * `confidence` and does not require the per-agent block, so `{"schema_version":"1.0",
 * "agent":"triage","confidence":0.9}` is schema-valid — and satisfies, word for word, the guard
 * the state machine publishes on `NEW → TRIAGED`: "triage returned a schema-valid object carrying
 * its confidence". A ticket would reach TRIAGED with its category, severity and sentiment empty.
 * Three conditions close that:
 *
 *   1. `agent` must be `triage`;
 *   2. the `triage` block must be present and complete;
 *   3. a `draft` or `validate` block must be absent.
 *
 * Hardening only ever narrows: everything this function rejects, it rejects for a reason the
 * schema either states or leaves open, and it accepts nothing the schema refuses.
 *
 * **Nothing that failed travels with the failure.** `detail` names the key, the type it had and
 * the block that was foreign. It never carries the envelope or any fragment of it: a model that
 * echoed a customer's address into its answer would otherwise have that address copied into every
 * log line the refusal touches, by way of the validator that refused it.
 */

import { AgentError } from './errors.ts';

/** Severity as the ticket record carries it. Declared here rather than imported: the path is
 *  `app → agents → gateway → provider`, and an agent module that reached into the application's
 *  algorithm would be an arrow pointing the wrong way through the seam. */
export type TriageSeverity = 1 | 2 | 3 | 4;

export type TriageBlock = {
  category: string;
  severity: TriageSeverity;
  sentiment: number;
};

export type TriageEnvelope = {
  schema_version: '1.0';
  agent: 'triage';
  /** The root-level confidence, which is also the field the ledger column records. */
  confidence: number;
  triage: TriageBlock;
};

const SCHEMA_VERSION = '1.0';
const ROOT_KEYS = new Set(['schema_version', 'agent', 'confidence', 'triage', 'draft', 'validate']);
const TRIAGE_KEYS = new Set(['category', 'severity', 'sentiment']);
const FOREIGN_BLOCKS = ['draft', 'validate'] as const;
const CATEGORY_MAX = 64;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new AgentError('E_SCHEMA', message, detail);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * The response text as a triage verdict, or `E_SCHEMA`.
 *
 * There is no lenient variant of this function and there is not meant to be one. A caller that
 * wanted to accept a little more would be a caller writing a second contract.
 */
export function parseTriageEnvelope(text: string): TriageEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The length travels because "the model answered with 4 kB of prose" and "the model answered
    // with nothing" are different operational facts; the text itself does not.
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

  // Condition 1. An envelope from another agent may be perfectly well-formed and is still not a
  // triage verdict; consuming it would attribute one agent's answer to another's columns.
  if (envelope.agent !== 'triage') {
    refuse('the envelope was not written by the triage agent', {
      agent: typeof envelope.agent === 'string' ? envelope.agent : null,
      agent_type: kindOf(envelope.agent),
    });
  }

  // Condition 3, checked before the triage block so that an envelope carrying two agents' work is
  // refused as what it is rather than as a partially usable one.
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

  // Condition 2. This is the hole in the published `required` and this is where it closes.
  if (!('triage' in envelope)) {
    refuse('the envelope carries no triage block, so it decides nothing about the ticket', {
      missing_block: 'triage',
    });
  }
  const block = envelope.triage;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    refuse('the triage block is not an object', { triage_type: kindOf(block) });
  }
  const triage = block as Record<string, unknown>;

  for (const key of Object.keys(triage)) {
    if (!TRIAGE_KEYS.has(key)) {
      refuse('the triage block carries a key the contract does not publish', { key });
    }
  }
  for (const key of TRIAGE_KEYS) {
    if (!(key in triage)) {
      refuse('the triage block is incomplete', { missing_key: key });
    }
  }

  const { category, severity, sentiment } = triage;

  if (typeof category !== 'string' || category.length === 0 || category.length > CATEGORY_MAX) {
    refuse('the category is not a non-empty string within the published length', {
      category_type: kindOf(category),
      category_length: typeof category === 'string' ? category.length : null,
      maximum: CATEGORY_MAX,
    });
  }
  if (!isSeverity(severity)) {
    refuse('the severity is not one of the four levels the record carries', {
      severity_type: kindOf(severity),
      severity: typeof severity === 'number' ? severity : null,
    });
  }
  if (typeof sentiment !== 'number' || !Number.isFinite(sentiment)) {
    refuse('the sentiment is not a number', { sentiment_type: kindOf(sentiment) });
  }
  if (sentiment < -1 || sentiment > 1) {
    refuse('the sentiment is outside [-1, 1]', { sentiment });
  }

  return {
    schema_version: SCHEMA_VERSION,
    agent: 'triage',
    confidence,
    triage: { category, severity, sentiment },
  };
}

export function isSeverity(value: unknown): value is TriageSeverity {
  return value === 1 || value === 2 || value === 3 || value === 4;
}
