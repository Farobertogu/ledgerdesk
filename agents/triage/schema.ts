/**
 * The published agent input/output contract, and the digest that pins it.
 *
 * **Why the schema is authored here and emitted as a file, rather than read from one.**
 * `prompt_version.schema_hash` is defined by the schema as "sha256 of the output schema this
 * prompt demands", so the digest has to be the digest of the *published artefact* — the bytes in
 * `agents/schemas/agent_io.schema.json` — and not of some re-serialisation of it. Reading that
 * file at run time would make the digest correct and the process fragile: a server bundle does not
 * carry the repository's directory layout, and a schema the process cannot find is a process that
 * cannot register its prompt.
 *
 * So the document is the value below, the file is `JSON.stringify(schema, null, 2)` plus a
 * trailing newline, and `ci/check.sh` regenerates the file and diffs it. A hand-edit and a stale
 * file fail identically, which is the same arrangement `reports/weight_sensitivity.md` lives under
 * — and it makes `AGENT_IO_SCHEMA_SHA256` provably the digest of the committed bytes without any
 * file ever being opened at run time.
 *
 * **The hole in `required`, left in on purpose.** The output envelope requires three keys:
 * `schema_version`, `agent` and `confidence`. It does NOT require the per-agent block. An envelope
 * of exactly those three keys is schema-valid and also satisfies, word for word, the guard the
 * state machine publishes on `NEW → TRIAGED` — "triage returned a schema-valid object carrying its
 * confidence" — while leaving category, severity and sentiment empty. The validator in
 * `envelope.ts` is therefore deliberately stricter than this document, and ADR-023 §6 records the
 * three conditions it adds. Hardening never accepts what the schema rejects, so this stays the
 * outer bound and no other consumer of it is made wrong.
 *
 * **What changing this document costs, and who pays it.** `AGENT_IO_SCHEMA_SHA256` is written into
 * `prompt_version.schema_hash` at registration, and that row is immutable by trigger. So an edit
 * here does not update a registration — it makes the standing one describe a contract this build no
 * longer publishes, and a database that already holds the old row would refuse to start. The
 * mechanism the schema already carries for that is a **generation**: the old row stays exactly as it
 * is, a new one is registered beside it with the new digest and the old one as its parent, and the
 * run that follows names the generation whose contract it actually ran under. ADR-024 records the
 * edit; `prompt.ts` carries the two generations and the historical digest that pins the first.
 */

import { sha256Hex } from '../canonical.ts';
import type { Json } from '../canonical.ts';

/** The `agent_kind` values an envelope may name, in the order the database enum declares them. */
export const AGENT_NAMES = ['triage', 'draft', 'validate', 'evolve'] as const;

/**
 * The longest redacted body an input envelope may carry.
 *
 * Declared residual, named here rather than left to be found: redaction *replaces* values with
 * markers, and a marker can be longer than what it replaced, so a body under this length before
 * redaction can exceed it after. Nothing enforces the bound today; the increment that scores
 * against a corpus is where an oversized envelope would first matter.
 */
export const BODY_REDACTED_MAX = 8192;

/**
 * The longest excerpt a single retrieved source may carry into the envelope.
 *
 * Retrieval decides how much of an article travels, and an unbounded excerpt makes the size of one
 * prompt a property of whatever somebody last admitted into the knowledge base. Four sources at
 * this bound sit inside the body's own allowance, which is the ratio the number was chosen for.
 */
export const EXCERPT_MAX = 2048;

/**
 * The longest answer the drafting agent may produce.
 *
 * A reply to a support enquiry that does not fit in this is not a reply, it is a document, and the
 * console that has to show it to a person before anybody sends it is sized for the former.
 */
export const DRAFT_TEXT_MAX = 4096;

/**
 * What a knowledge-base identifier may be made of, as a contract rather than as a habit.
 *
 * The identifier travels three ways — into the envelope the gateway digests, back out of the model
 * as a citation, and into `response_citation` as half of a composite foreign key — and the third of
 * those is the one that matters: a citation is compared for set membership against the identifiers
 * the call was given, and a value carrying whitespace or punctuation nobody expected makes two
 * spellings of one source. Restricting the alphabet at the border is cheaper than discovering the
 * second spelling in a row that already claims to be grounded.
 */
export const KB_ID_PATTERN = '^[A-Za-z0-9:_/-]{1,128}$';

export const AGENT_IO_SCHEMA: Json = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'ledgerdesk/agents/schemas/agent_io.schema.json',
  title: 'Agent input and output envelopes',
  description:
    'The two envelopes that cross the model chokepoint. The input is what the gateway digests into input_hash; the output is what the agent-layer validator reads and the only place a triage verdict comes from.',
  $defs: {
    agent_input: {
      type: 'object',
      description: 'What the gateway assembles and digests. The raw body never appears in it.',
      required: ['schema_version', 'agent', 'ticket_id', 'body_redacted', 'kb_context', 'locale'],
      additionalProperties: false,
      properties: {
        schema_version: { const: '1.0' },
        agent: { enum: [...AGENT_NAMES] },
        prompt_version_id: { type: 'string' },
        ticket_id: {
          type: ['string', 'null'],
          description:
            'Null for a call that belongs to no ticket, which is how a corpus item is scored.',
        },
        body_redacted: { type: 'string', maxLength: BODY_REDACTED_MAX },
        kb_context: {
          type: 'array',
          description: 'Always present, empty when there is none: a digest needs a total function.',
          items: {
            type: 'object',
            required: ['kb_id', 'excerpt'],
            additionalProperties: false,
            properties: {
              kb_id: { type: 'string', pattern: KB_ID_PATTERN },
              excerpt: { type: 'string', maxLength: EXCERPT_MAX },
            },
          },
        },
        locale: { type: 'string' },
      },
    },
    agent_output: {
      type: 'object',
      description:
        'What an agent answers. confidence is required at the ROOT, which is the one field the ledger has a column for and reads independently of any validator.',
      required: ['schema_version', 'agent', 'confidence'],
      additionalProperties: false,
      properties: {
        schema_version: { const: '1.0' },
        agent: { enum: [...AGENT_NAMES] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        triage: { $ref: '#/$defs/triage_block' },
        draft: { $ref: '#/$defs/draft_block' },
        validate: { $ref: '#/$defs/validate_block' },
      },
    },
    triage_block: {
      type: 'object',
      description:
        'The triage verdict. Its three fields are the only source of the ticket columns of the same names.',
      required: ['category', 'severity', 'sentiment'],
      additionalProperties: false,
      properties: {
        category: { type: 'string', minLength: 1, maxLength: 64 },
        severity: { type: 'integer', minimum: 1, maximum: 4 },
        sentiment: { type: 'number', minimum: -1, maximum: 1 },
      },
    },
    draft_block: {
      type: 'object',
      description:
        'The drafted reply and the sources it stands on. kb_ids has minItems 1 because that is the only place "never a draft without a source" is expressible as a contract rather than as a check somebody remembers to write.',
      required: ['text', 'kb_ids'],
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: DRAFT_TEXT_MAX },
        kb_ids: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', pattern: KB_ID_PATTERN },
        },
      },
    },
    validate_block: {
      type: 'object',
      description:
        "The validator's verdict. grounded is a veto and never a signature: four arithmetic conditions are computed locally over the same sources the gateway digested, and this field can only withhold the fifth. policy_flags is deliberately absent — a policy judgement is the deterministic matcher's and never a model's.",
      required: ['grounded', 'unsupported_claims'],
      additionalProperties: false,
      properties: {
        grounded: { type: 'boolean' },
        unsupported_claims: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

/** The exact bytes of `agents/schemas/agent_io.schema.json`. */
export const AGENT_IO_SCHEMA_TEXT = `${JSON.stringify(AGENT_IO_SCHEMA, null, 2)}\n`;

/** `prompt_version.schema_hash` for every prompt that demands this contract. */
export const AGENT_IO_SCHEMA_SHA256 = sha256Hex(AGENT_IO_SCHEMA_TEXT);

/** Where the published copy lives, relative to the repository root. */
export const AGENT_IO_SCHEMA_PATH = 'agents/schemas/agent_io.schema.json';
