/**
 * The fourth declared channel: the typed knowledge-gap record.
 *
 * Three channels have crossed the boundary since the seam was written — the drafted answer, the
 * closed alphabet of escalation codes, and the promotion gate's one bit — and the property the
 * sentence protects is not the number: it is that the set is **closed and declared**. This is the
 * fourth, and it lands with the increment that emits gap records rather than with the decision that
 * authorised it, because a check expecting four channels against code that exposes three fails the
 * build for a reason that is not its own.
 *
 * ## What a channel is for, and why this one carries no terms
 *
 * A channel transports what only the producer knows. The receiver supplies, from its own knowledge,
 * what it already holds — and the receiver here is the component that mediated the retrieval, so it
 * does not have to be told what it searched for. `query_terms`, `zero_match`, `null_rule`,
 * `ticket_id` and `org_id` are the receiver's and never travel; the enquiry's words never cross.
 * What crosses is the **commitment** (who owns closing this gap and by when), two digests that only
 * TIE, the snapshot repeated so it can be tied, the state, the sources that diverged, and one
 * bounded note.
 *
 * **The receiver validates; it never supplies.** An `owner_id` the receiver invented would be a row
 * naming a person who agreed to nothing, and a digest the receiver recomputed *for* the producer
 * would be one producer of one value pretending to be two. Every field has exactly one origin, and
 * the other side either ties it or checks that it resolves.
 *
 * ## Bytes, never string length
 *
 * Every bound below is measured with `Buffer.byteLength(value, 'utf8')`. The alternative is the
 * mistake this file exists to make impossible: 512 characters of CJK are 1 536 bytes, and a cap
 * enforced on `String.length` — which counts UTF-16 units — admits three times the payload the
 * contract declares on exactly the inputs where the difference matters. The published JSON document
 * carries `maxLength` as well, and that keyword is defined over code points, so the schema is the
 * weaker of the two bounds and the receiver is the binding one. They are not in competition: the
 * document says what shape a record has, and the receiver says how much of it may arrive.
 *
 * ## The declared total
 *
 * The contract publishes «≤ 1024 B per record» and does not say what the bytes are measured over.
 * It is fixed here as **the sum of the per-field caps**, which is a precision of the contract and
 * not a change to it: the nine caps sum to `GAP_CHANNEL_TOTAL_BYTES` and therefore respect the
 * declared bound by construction rather than by a check that could be forgotten. Of that total, at
 * most 512 B are open content — the single free field is `note`, and its cap is what separates a
 * typed channel with bounded open content from a text channel.
 *
 * ## Why the document is authored here and emitted as a file
 *
 * The published copy is a frozen path and its directory has no reader at run time; a server bundle
 * does not carry the repository's directory layout, so a receiver that opened a file to learn its
 * own contract would be a receiver that cannot start. The value below is the contract, the file is
 * its serialisation, and CI regenerates and diffs the two — a hand-edit and a stale file fail
 * identically. That is the arrangement the published agent envelope already lives under.
 *
 * This module imports nothing outside `src/alg/`: it is a contract and a pure function of a value,
 * so it is readable by a check with no database, no bundler and no model. The two digests it
 * describes are taken where the digesting belongs, at the receiver.
 */

/** The three states the field mirrors, in the order the database enum declares them. */
export const GAP_CHANNEL_STATES = ['OPEN', 'NOT_DOCUMENTABLE', 'CLOSED'] as const;

export type GapChannelState = (typeof GAP_CHANNEL_STATES)[number];

/**
 * The only state a record may be born in.
 *
 * A record arriving `CLOSED` would close a gap through the channel, which is the one thing the
 * closure requirement forbids: a gap closes when the original query, re-run against the snapshot in
 * force, comes back grounded on the admitted source, and never because somebody sent a message
 * saying so. The other two values exist because the field mirrors the record's own column.
 */
export const GAP_CHANNEL_EMISSION_STATE: GapChannelState = 'OPEN';

/**
 * How many diverging sources a record may name.
 *
 * Four, and not a number of its own: the divergence is computed over what the retrieval returned,
 * and the retrieval returns at most `TOP_K`. A cap larger than the producer can populate is a cap
 * that describes nothing.
 */
export const GAP_CHANNEL_MAX_DIVERGENT = 4;

/** The nine fields, in the order the contract publishes them. */
export const GAP_CHANNEL_FIELDS = [
  'gap_id',
  'canonical_key_sha256',
  'query_sha256',
  'kb_snapshot',
  'owner_id',
  'committed_date',
  'state',
  'divergent_kb_ids',
  'note',
] as const;

export type GapChannelField = (typeof GAP_CHANNEL_FIELDS)[number];

/**
 * The cap on each field, in BYTES.
 *
 * Eight of the nine are identifiers, digests, dates or enumerated values — zero bytes chosen by the
 * producer — and `note` is the one field whose content the producer writes.
 */
export const GAP_CHANNEL_BYTES: Readonly<Record<GapChannelField, number>> = {
  gap_id: 36,
  canonical_key_sha256: 64,
  query_sha256: 64,
  kb_snapshot: 64,
  owner_id: 36,
  committed_date: 10,
  state: 16,
  divergent_kb_ids: GAP_CHANNEL_MAX_DIVERGENT * 36,
  note: 512,
};

/** The declared bound of the record, from the contract. */
export const GAP_CHANNEL_RECORD_MAX_BYTES = 1024;

/** At most this much of a record is content the producer chose. */
export const GAP_CHANNEL_OPEN_CONTENT_MAX_BYTES = GAP_CHANNEL_BYTES.note;

/** The sum of the nine caps — the reading this module fixes for «≤ 1024 B per record». */
export const GAP_CHANNEL_TOTAL_BYTES = GAP_CHANNEL_FIELDS.reduce(
  (total, field) => total + GAP_CHANNEL_BYTES[field],
  0,
);

export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const SHA256_PATTERN = '^[a-f0-9]{64}$';
export const ISO_DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

/**
 * What a snapshot label may be made of.
 *
 * The label travels into `state_hash` and into the composite reference a citation carries, so a
 * label carrying whitespace or a quote would be a label with two spellings. The alphabet is
 * restricted at the border, exactly as the knowledge-base identifier's is.
 */
export const SNAPSHOT_PATTERN = '^[A-Za-z0-9:._-]{1,64}$';

/** The record as it crosses. */
export type GapChannelRecord = {
  gap_id: string;
  /** The digest of the question's canonical form — the key, hashed, never a term in clear. */
  canonical_key_sha256: string;
  /** `sha256(query_terms ‖ kb_snapshot)`, which is what makes the re-run identical rather than similar. */
  query_sha256: string;
  kb_snapshot: string;
  owner_id: string;
  committed_date: string;
  state: GapChannelState;
  divergent_kb_ids: readonly string[];
  note: string;
};

type SchemaValue = string | number | boolean | null | SchemaValue[] | { [key: string]: SchemaValue };

/**
 * The published document, built out of the constants above so that the two cannot disagree.
 *
 * `format` is annotation only — the validator that covers this file ignores it by design and the
 * dates and identifiers are checked by `pattern`, which is the keyword that actually decides. A
 * schema that leaned on `format` would be a schema whose strictness depended on which validator
 * happened to read it.
 */
export const GAP_CHANNEL_SCHEMA: SchemaValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'ledgerdesk/quality/schemas/gap_channel.schema.json',
  title: 'Knowledge-gap channel record',
  description:
    'The fourth declared channel. It carries the commitment a human made in advance, two digests that only tie, and the sources that diverged. It never carries a term of the enquiry in clear: the receiver mediated the query and supplies those fields itself.',
  type: 'object',
  required: [...GAP_CHANNEL_FIELDS],
  additionalProperties: false,
  properties: {
    gap_id: {
      type: 'string',
      format: 'uuid',
      pattern: UUID_PATTERN,
      maxLength: GAP_CHANNEL_BYTES.gap_id,
      description: 'The identity the record is minted under, so a retry names the same gap.',
    },
    canonical_key_sha256: {
      type: 'string',
      pattern: SHA256_PATTERN,
      maxLength: GAP_CHANNEL_BYTES.canonical_key_sha256,
      description:
        'The canonical key of the question, hashed. It ties: the receiver recomputes it from the terms it searched with and compares.',
    },
    query_sha256: {
      type: 'string',
      pattern: SHA256_PATTERN,
      maxLength: GAP_CHANNEL_BYTES.query_sha256,
      description:
        'sha256(query_terms || kb_snapshot). It ties, and it is what makes the re-run identical by construction.',
    },
    kb_snapshot: {
      type: 'string',
      pattern: SNAPSHOT_PATTERN,
      maxLength: GAP_CHANNEL_BYTES.kb_snapshot,
      description: 'Repeated by the channel only so that the digest above can be tied to it.',
    },
    owner_id: {
      type: 'string',
      format: 'uuid',
      pattern: UUID_PATTERN,
      maxLength: GAP_CHANNEL_BYTES.owner_id,
      description:
        'Carried by the channel. The receiver validates that it resolves to a live user of the same organisation, and never invents one.',
    },
    committed_date: {
      type: 'string',
      format: 'date',
      pattern: ISO_DATE_PATTERN,
      maxLength: GAP_CHANNEL_BYTES.committed_date,
      description: 'The commitment half: by when. Carried, validated, never supplied.',
    },
    state: {
      enum: [...GAP_CHANNEL_STATES],
      maxLength: GAP_CHANNEL_BYTES.state,
      description:
        'On emission the receiver accepts only OPEN. The other two exist because the field mirrors the record column.',
    },
    divergent_kb_ids: {
      type: 'array',
      maxItems: GAP_CHANNEL_MAX_DIVERGENT,
      items: { type: 'string', format: 'uuid', pattern: UUID_PATTERN },
      description: 'Empty unless the gap was born of two sources that disagree.',
    },
    note: {
      type: 'string',
      maxLength: GAP_CHANNEL_BYTES.note,
      description:
        'The only open content of the record. Its cap is what separates a typed channel with bounded open content from a text channel.',
    },
  },
};

/** The exact bytes of the published copy. */
export const GAP_CHANNEL_SCHEMA_TEXT = `${JSON.stringify(GAP_CHANNEL_SCHEMA, null, 2)}\n`;

/**
 * Where the published copy lives, relative to the repository root.
 *
 * A path, not an import: nothing in the application ever opens it. CI regenerates the file from the
 * value above and diffs it, which is the whole of its role.
 */
export const GAP_CHANNEL_SCHEMA_PATH = ['quality', 'schemas', 'gap_channel.schema.json'].join('/');

/** How a record failed the contract, in a form a caller can turn into one typed refusal. */
export type GapChannelViolation = {
  field: string;
  detail: string;
};

/** The byte length of a value, which is the unit every cap in this module is written in. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * The canonical form of a question.
 *
 * Compatibility-normalised, lower-cased and whitespace-collapsed — the same normalisation the
 * policy matcher's input goes through, and for the same reason: two spellings of one question must
 * not be two questions. The digest of this form is the identity of the gap **across corpora**,
 * where the digest of the terms and the snapshot together is its identity **under one corpus**.
 * The pair is what lets a re-run under a new corpus be recognised as the same question asked again
 * rather than as a question nobody had asked before.
 */
export function canonicalQueryForm(terms: string): string {
  return terms.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(
  value: unknown,
  field: GapChannelField,
  pattern: string,
  out: GapChannelViolation[],
): string | null {
  if (typeof value !== 'string') {
    out.push({ field, detail: `${field} is ${value === undefined ? 'absent' : typeof value}, not a string` });
    return null;
  }
  const bytes = byteLength(value);
  if (bytes > GAP_CHANNEL_BYTES[field]) {
    out.push({
      field,
      detail: `${field} is ${bytes} bytes and the contract caps it at ${GAP_CHANNEL_BYTES[field]}`,
    });
    return null;
  }
  if (pattern !== '' && !new RegExp(pattern).test(value)) {
    out.push({ field, detail: `${field} does not match ${pattern}` });
    return null;
  }
  return value;
}

/**
 * Every way one value fails the published contract, as a list rather than as a throw.
 *
 * A list, because the layer that owns the typed refusal is the application surface and not the
 * algorithm: this module computes, and the caller decides what the failure is called. Every
 * violation is reported rather than the first one, so a producer that is wrong about three fields
 * learns about three fields.
 *
 * **Nothing is truncated and nothing is repaired.** A record out of contract is refused whole. A
 * receiver that trimmed an over-long note would be storing a sentence its author did not write, and
 * a receiver that filled in an absent owner would be inventing the commitment the field exists to
 * carry.
 */
export function validateGapChannelRecord(value: unknown): GapChannelViolation[] {
  const violations: GapChannelViolation[] = [];

  if (!isRecordObject(value)) {
    return [{ field: '$', detail: 'a channel record is a JSON object' }];
  }

  for (const key of Object.keys(value)) {
    if (!(GAP_CHANNEL_FIELDS as readonly string[]).includes(key)) {
      violations.push({ field: key, detail: `${key} is not a field of this channel` });
    }
  }

  checkString(value.gap_id, 'gap_id', UUID_PATTERN, violations);
  checkString(value.canonical_key_sha256, 'canonical_key_sha256', SHA256_PATTERN, violations);
  checkString(value.query_sha256, 'query_sha256', SHA256_PATTERN, violations);
  checkString(value.kb_snapshot, 'kb_snapshot', SNAPSHOT_PATTERN, violations);
  checkString(value.owner_id, 'owner_id', UUID_PATTERN, violations);
  checkString(value.committed_date, 'committed_date', ISO_DATE_PATTERN, violations);
  checkString(value.note, 'note', '', violations);

  const state = checkString(value.state, 'state', '', violations);
  if (state !== null && !(GAP_CHANNEL_STATES as readonly string[]).includes(state)) {
    violations.push({ field: 'state', detail: `state '${state}' is outside the declared set` });
  }

  const divergent = value.divergent_kb_ids;
  if (!Array.isArray(divergent)) {
    violations.push({ field: 'divergent_kb_ids', detail: 'divergent_kb_ids is a list, empty when there is none' });
  } else {
    if (divergent.length > GAP_CHANNEL_MAX_DIVERGENT) {
      violations.push({
        field: 'divergent_kb_ids',
        detail: `divergent_kb_ids names ${divergent.length} sources and the contract caps it at ${GAP_CHANNEL_MAX_DIVERGENT}`,
      });
    }
    for (const [index, entry] of divergent.entries()) {
      if (typeof entry !== 'string' || !new RegExp(UUID_PATTERN).test(entry)) {
        violations.push({ field: `divergent_kb_ids[${index}]`, detail: 'a diverging source is named by its identity' });
      }
    }
  }

  return violations;
}

/**
 * The record's own size, measured the way the cap is written.
 *
 * The array is measured by its contents rather than by its serialisation, because the cap is a
 * statement about how much a producer may say and not about how many brackets a serialiser emits.
 */
export function gapChannelRecordBytes(record: GapChannelRecord): number {
  return (
    byteLength(record.gap_id) +
    byteLength(record.canonical_key_sha256) +
    byteLength(record.query_sha256) +
    byteLength(record.kb_snapshot) +
    byteLength(record.owner_id) +
    byteLength(record.committed_date) +
    byteLength(record.state) +
    record.divergent_kb_ids.reduce((total, id) => total + byteLength(id), 0) +
    byteLength(record.note)
  );
}
