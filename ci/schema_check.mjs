// ci/schema_check.mjs — test_SPLITS_schema_accepts_and_rejects
//                       test_GAP_channel_schema_accepts_and_rejects
//
// The published schemas are frozen paths with no executable cover otherwise: nothing checked that
// they accept what the contract says they must accept and reject what it must reject.
//
// The validator below implements only the keywords the covered schemas actually use and THROWS on
// any keyword it does not implement. That is the point: a hand-written validator that silently
// ignored a keyword would let a fixture pass for the wrong reason, which is worse than having no
// test. Keeping it dependency-free is what lets the structure gate run anywhere.
//
// **Two schemas now, and the second is the reason three keywords were added.** `enum`, `maxLength`
// and `maxItems` are implemented below because the gap channel's document uses all three, and the
// throw above means implementing them was not optional: a schema added to these cases without them
// fails the run rather than passing it quietly. That is the arrangement working as designed, and it
// is why adding the file to this list is the step that makes the keywords load-bearing.
//
// **`maxLength` is code points here and BYTES at the receiver, deliberately.** JSON Schema defines
// the keyword over characters, so that is what this implements — `[...value].length`, not
// `value.length`, which counts UTF-16 units and would disagree on anything outside the basic plane.
// The channel's own receiver measures the same fields in bytes and is therefore the stricter of the
// two. They are not in competition: the document says what shape a record has, and the receiver
// says how much of it may arrive. A note of 512 CJK characters satisfies this file and is refused
// there, which is the case the two bounds exist to tell apart.
//
// **`format` is ignored on purpose and is not a hole.** Every field that carries one also carries a
// `pattern`, and the pattern is the keyword that decides. A schema whose strictness depended on
// which validator happened to read it would be a schema with two meanings.

import { readFileSync } from 'node:fs';

const ANNOTATIONS = new Set(['$id', '$schema', 'title', 'description', 'format', '$comment', '$defs']);
const APPLICATORS = new Set([
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'maxLength', 'minimum', '$ref',
  'allOf', 'if', 'then',
]);

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validate(schema, value, root, path, errors) {
  for (const keyword of Object.keys(schema)) {
    if (ANNOTATIONS.has(keyword) || APPLICATORS.has(keyword)) continue;
    throw new Error(`schema uses keyword '${keyword}' at ${path}, which this validator does not implement`);
  }

  if ('$ref' in schema) {
    const ref = schema.$ref;
    if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported $ref '${ref}' at ${path}`);
    const target = root.$defs[ref.slice('#/$defs/'.length)];
    if (target === undefined) throw new Error(`unresolved $ref '${ref}' at ${path}`);
    validate(target, value, root, path, errors);
  }

  if ('type' in schema) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = kindOf(value);
    const ok = allowed.some((t) => (t === 'integer'
      ? actual === 'number' && Number.isInteger(value)
      : t === actual));
    if (!ok) errors.push(`${path}: type ${actual} is not ${allowed.join('|')}`);
  }

  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not the const ${JSON.stringify(schema.const)}`);
  }

  // A closed set of permitted values. Compared by value, so a member that is an object or an array
  // is compared as one rather than by identity.
  if ('enum' in schema && !schema.enum.some((member) => deepEqual(member, value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is outside the enum`);
  }

  if ('pattern' in schema && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: '${value}' does not match ${schema.pattern}`);
  }

  // Code points, not UTF-16 units: see the header for why the difference is the whole point of
  // having a second bound at the receiver.
  if ('maxLength' in schema && typeof value === 'string' && [...value].length > schema.maxLength) {
    errors.push(`${path}: ${[...value].length} characters is above maxLength ${schema.maxLength}`);
  }

  if ('minimum' in schema && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
  }

  if (kindOf(value) === 'array') {
    if ('items' in schema) value.forEach((v, i) => validate(schema.items, v, root, `${path}[${i}]`, errors));
    if ('minItems' in schema && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} items is below minItems ${schema.minItems}`);
    }
    if ('maxItems' in schema && value.length > schema.maxItems) {
      errors.push(`${path}: ${value.length} items is above maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: items are not unique`);
    }
  }

  if (kindOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required '${key}'`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(sub, value[key], root, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${path}: unexpected property '${key}'`);
      }
    }
  }

  for (const sub of schema.allOf ?? []) validate(sub, value, root, path, errors);

  if ('if' in schema) {
    const probe = [];
    validate(schema.if, value, root, path, probe);
    if (probe.length === 0 && 'then' in schema) validate(schema.then, value, root, path, errors);
  }
}

function isValid(schema, doc) {
  const errors = [];
  validate(schema, doc, schema, '$', errors);
  return errors;
}

const read = (relative) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
const hex = (c) => c.repeat(64);
const clone = (o) => JSON.parse(JSON.stringify(o));

// --------------------------------------------------------------------- the sealed split manifest

const splits = read('quality/schemas/splits.schema.json');

const sealed = {
  schema_version: '1.1',
  run_id: '006c9d14-9b5e-5195-aad5-efd1dec8f0f3',
  built_at: '2026-08-21T00:00:00.000Z',
  builder_version: 'corpus.ts/1.0.0',
  input_path: 'quality/templates',
  input_sha256: hex('a'),
  canonical_order: 'sorted_by_item_id_then_shuffled',
  seed: 20260821,
  kinds: {
    selection: { n: 2, item_ids: ['I-aaaa', 'I-bbbb'], content_sha256: hex('b') },
    report: { n: 2, item_ids: null, content_sha256: hex('c') },
    ood: { n: 1, item_ids: ['I-cccc'], content_sha256: hex('d') },
    blind_label: { n: 2, item_ids: ['I-dddd', 'I-eeee'], content_sha256: hex('e') },
  },
  commitment: {
    algo: 'HMAC-SHA256',
    salt_commitment: hex('f'),
    member_hmac: hex('0'),
    cardinality: 7,
    sealed_hash: hex('1'),
    sealed_at: '2026-08-21T00:00:00.000Z',
    revealed_at: null,
  },
};

const withoutKey = (key) => { const m = clone(sealed); delete m[key]; return m; };

const splitCases = [
  ['a complete sealed manifest validates', sealed, true],
  ['report keeps item_ids null until it is revealed', sealed, true],
  ['blind_label with item_ids null is rejected',
    (() => { const m = clone(sealed); m.kinds.blind_label.item_ids = null; return m; })(), false],
  ['a manifest without seed is rejected', withoutKey('seed'), false],
  ['a manifest declaring schema_version 1.0 is rejected',
    (() => { const m = clone(sealed); m.schema_version = '1.0'; return m; })(), false],
  ['blind_label with duplicate item_ids is rejected',
    (() => { const m = clone(sealed); m.kinds.blind_label.item_ids = ['I-dddd', 'I-dddd']; return m; })(), false],
];

// ------------------------------------------------------------------- the typed gap channel record

const channel = read('quality/schemas/gap_channel.schema.json');

const uuid = (n) => `${n}0000000-0000-4000-8000-00000000000${n}`;

const emitted = {
  gap_id: '9a000010-0000-4000-8000-00000000000a',
  canonical_key_sha256: hex('b'),
  query_sha256: hex('c'),
  kb_snapshot: 'kb-2026-08-01',
  owner_id: '1a000000-0000-4000-8000-000000000003',
  committed_date: '2026-08-29',
  state: 'OPEN',
  divergent_kb_ids: [],
  note: 'The corpus at this snapshot matched nothing for this enquiry.',
};

const channelWithout = (key) => { const m = clone(emitted); delete m[key]; return m; };
const channelWith = (key, value) => { const m = clone(emitted); m[key] = value; return m; };

const channelCases = [
  ['an emitted record validates', emitted, true],
  ['a record naming four diverging sources validates',
    channelWith('divergent_kb_ids', [uuid(1), uuid(2), uuid(3), uuid(4)]), true],
  ['a record without its commitment date is rejected', channelWithout('committed_date'), false],
  ['a record without its owner is rejected', channelWithout('owner_id'), false],
  ['an owner that is not an identity is rejected', channelWith('owner_id', 'the support lead'), false],
  ['a digest that is not sixty-four hex is rejected', channelWith('query_sha256', 'deadbeef'), false],
  ['a committed date written the other way round is rejected',
    channelWith('committed_date', '29-08-2026'), false],
  ['a state outside the declared set is rejected', channelWith('state', 'REOPENED'), false],
  ['a fifth diverging source is rejected',
    channelWith('divergent_kb_ids', [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]), false],
  ['a note above the cap is rejected', channelWith('note', 'x'.repeat(513)), false],
  ['a note at the cap validates', channelWith('note', 'x'.repeat(512)), true],
  ['a field this channel does not publish is rejected',
    channelWith('query_terms', 'who can view the audit trail'), false],
  ['a snapshot label carrying a quote is rejected',
    channelWith('kb_snapshot', "kb-2026-08-01' or true"), false],
];

// --------------------------------------------------------------------------------------- the run

let failures = 0;

function run(testName, schema, cases) {
  for (const [name, doc, shouldPass] of cases) {
    const errors = isValid(schema, doc);
    const passed = errors.length === 0;
    if (passed !== shouldPass) {
      failures += 1;
      process.stderr.write(
        `${testName}: ${name} — expected ${shouldPass ? 'accept' : 'reject'}, got ${passed ? 'accept' : `reject (${errors.join('; ')})`}\n`,
      );
    }
  }
  if (failures === 0) process.stdout.write(`${testName} OK (${cases.length} cases)\n`);
}

run('test_SPLITS_schema_accepts_and_rejects', splits, splitCases);
run('test_GAP_channel_schema_accepts_and_rejects', channel, channelCases);

if (failures > 0) process.exit(1);
