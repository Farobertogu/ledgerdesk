/**
 * The reader of a drafting agent's answer.
 *
 * It is a sibling of `agents/triage/envelope.ts` and not a generalisation of it: the parse is
 * strict in the same two senses, the acceptance is narrower than the published schema in the same
 * three ways, and the refusals carry the same kind of detail. What is deliberately not shared is
 * the code — a base class with an `agent` parameter would make the day someone loosens one contract
 * the day all three loosen. `test_AGENT_envelopes_share_a_root_contract` runs the same battery
 * against all three parsers, which measures the agreement instead of assuming it.
 *
 * ## The two conditions this agent has that no other agent has
 *
 * Both of them need something the envelope does not contain: the sources this very call was given.
 * That is why the function takes them, and why there is no one-argument form to reach for.
 *
 * **Containment.** Every `kb_id` the answer cites must be one of the `kb_id`s that went out with
 * the call. `minItems: 1` in the schema makes "a draft with no source" a schema violation; this
 * makes "a draft with a source nobody gave it" a grounding violation. They are different failures
 * and they are answered differently: a model that returned an empty array may return a full one on
 * the next attempt, and a model that named a document that does not exist will name a different
 * one. The first is retried; the second is not.
 *
 * **The uncited verbatim run.** A stretch of at least sixty-four characters copied out of an
 * excerpt that the answer does not cite is refused. The reasoning is worth stating because the
 * check looks like a plagiarism detector and is not one: the excerpts are material the tenant
 * admitted, the draft goes to a customer, and a passage that travelled from a source into a reply
 * *without* the reply naming that source is a passage the audit trail cannot account for. If it is
 * quotable it is citable; a run it does not cite is a leak, not a quotation.
 *
 * Sixty-four characters, and the number is a trade rather than a round figure. Shorter, and
 * ordinary shared phrasing collides — "please let us know if you have any further questions" is
 * fifty-two characters and appears in half the support corpus ever written. Longer, and a
 * paragraph-sized lift from a document survives. Whitespace is normalised on both sides before the
 * comparison, which only ever widens what is caught: a model that reflowed the passage is a model
 * that reproduced it.
 *
 * **Nothing that failed travels with the failure.** `detail` names the identifier that was not
 * offered, or the source a run came from, and never the run itself and never the answer. A draft
 * that echoed a customer's words would otherwise have them copied into every log line the refusal
 * touches, by way of the validator that refused it.
 */

import { AgentError } from '../triage/errors.ts';
import { DRAFT_TEXT_MAX } from '../triage/schema.ts';

/** One source as it travelled: the identifier, and the excerpt after redaction. */
export type DraftSource = {
  kb_id: string;
  excerpt: string;
};

export type DraftBlock = {
  text: string;
  kb_ids: readonly string[];
};

export type DraftEnvelope = {
  schema_version: '1.0';
  agent: 'draft';
  /** The root-level confidence, which is also the field the ledger column records. */
  confidence: number;
  draft: DraftBlock;
};

const SCHEMA_VERSION = '1.0';
const ROOT_KEYS = new Set(['schema_version', 'agent', 'confidence', 'triage', 'draft', 'validate']);
const DRAFT_KEYS = new Set(['text', 'kb_ids']);
const FOREIGN_BLOCKS = ['triage', 'validate'] as const;

/** The published alphabet of a knowledge-base identifier, as a matcher. */
const KB_ID = /^[A-Za-z0-9:_/-]{1,128}$/;

/** The shortest copied run that is refused when it is not cited. See the header for the trade. */
export const VERBATIM_RUN_MIN = 64;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new AgentError('E_SCHEMA', message, detail);
}

function refuseGrounding(message: string, detail: Record<string, unknown> = {}): never {
  throw new AgentError('E_NO_GROUNDING', message, detail);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Whitespace collapsed to single spaces, so a reflowed passage is still the passage. */
export function normaliseRun(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whether `haystack` contains any run of `VERBATIM_RUN_MIN` characters taken from `needle`.
 *
 * Every window of exactly that length is tried rather than the longest common substring being
 * computed, because the question is a boolean and the windows answer it in a pass over the shorter
 * of the two strings. At the sizes the contract bounds — an excerpt of 2048 and an answer of 4096 —
 * that is a few thousand substring searches and no allocation worth naming.
 */
export function sharesVerbatimRun(haystack: string, needle: string, minimum = VERBATIM_RUN_MIN): boolean {
  const from = normaliseRun(needle);
  const into = normaliseRun(haystack);
  if (from.length < minimum || into.length < minimum) return false;

  for (let start = 0; start + minimum <= from.length; start += 1) {
    if (into.includes(from.slice(start, start + minimum))) return true;
  }
  return false;
}

/**
 * The response text as a drafted reply, or a typed refusal.
 *
 * `sources` is the `kb_context` **as it travelled** — the redacted array the gateway digested into
 * `input_hash` — and not the one retrieval produced. The model saw the redacted excerpts, so the
 * comparisons here are against the redacted excerpts; running them against the originals would be
 * comparing the answer to something the model was never shown.
 */
export function parseDraftEnvelope(text: string, sources: readonly DraftSource[]): DraftEnvelope {
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

  if (envelope.agent !== 'draft') {
    refuse('the envelope was not written by the drafting agent', {
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

  if (!('draft' in envelope)) {
    refuse('the envelope carries no draft block, so it answers nothing', { missing_block: 'draft' });
  }
  const block = envelope.draft;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    refuse('the draft block is not an object', { draft_type: kindOf(block) });
  }
  const draft = block as Record<string, unknown>;

  for (const key of Object.keys(draft)) {
    if (!DRAFT_KEYS.has(key)) {
      refuse('the draft block carries a key the contract does not publish', { key });
    }
  }
  for (const key of DRAFT_KEYS) {
    if (!(key in draft)) {
      refuse('the draft block is incomplete', { missing_key: key });
    }
  }

  const { text: reply, kb_ids: cited } = draft;

  if (typeof reply !== 'string' || reply.trim().length === 0 || reply.length > DRAFT_TEXT_MAX) {
    refuse('the reply is not a non-empty string within the published length', {
      text_type: kindOf(reply),
      text_length: typeof reply === 'string' ? reply.length : null,
      maximum: DRAFT_TEXT_MAX,
    });
  }

  // `minItems: 1` is the schema's, and this is where it becomes a refusal rather than a note in a
  // document: an empty array is a draft with no source, which is the thing the contract exists to
  // make unrepresentable.
  if (!Array.isArray(cited) || cited.length === 0) {
    refuse('the draft cites no source, and the contract requires at least one', {
      kb_ids_type: kindOf(cited),
      kb_ids_length: Array.isArray(cited) ? cited.length : null,
    });
  }
  for (const value of cited) {
    if (typeof value !== 'string' || !KB_ID.test(value)) {
      refuse('a cited identifier is not of the published form', {
        kb_id_type: kindOf(value),
        kb_id_length: typeof value === 'string' ? value.length : null,
      });
    }
  }

  const kb_ids = [...new Set(cited as string[])];
  const offered = new Set(sources.map((source) => source.kb_id));

  // Containment. Not a schema violation: the envelope is well formed and the identifier is of the
  // published shape. It is a claim to stand on something that was never handed over.
  for (const kb_id of kb_ids) {
    if (!offered.has(kb_id)) {
      refuseGrounding('the draft cites a source this call was not given', {
        kb_id,
        offered: [...offered],
      });
    }
  }

  const cites = new Set(kb_ids);
  for (const source of sources) {
    if (cites.has(source.kb_id)) continue;
    if (sharesVerbatimRun(reply, source.excerpt)) {
      refuseGrounding('the draft reproduces a source it does not cite', {
        kb_id: source.kb_id,
        run_minimum: VERBATIM_RUN_MIN,
      });
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    agent: 'draft',
    confidence,
    draft: { text: reply, kb_ids },
  };
}
