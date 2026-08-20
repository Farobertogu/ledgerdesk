// ci/schema_check.mjs — test_SPLITS_schema_accepts_and_rejects
//
// The sealed-manifest schema is a frozen path with no executable cover otherwise: nothing checked
// that it accepts what the contract says it must accept and rejects what it must reject.
//
// The validator below implements only the keywords that splits.schema.json actually uses and
// THROWS on any keyword it does not implement. That is the point: a hand-written validator that
// silently ignored a keyword would let a fixture pass for the wrong reason, which is worse than
// having no test. Keeping it dependency-free is what lets the structure gate run anywhere.

import { readFileSync } from 'node:fs';

const ANNOTATIONS = new Set(['$id', '$schema', 'title', 'description', 'format', '$comment', '$defs']);
const APPLICATORS = new Set([
  'type', 'const', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'uniqueItems', 'pattern', 'minimum', '$ref', 'allOf', 'if', 'then',
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

  if ('pattern' in schema && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: '${value}' does not match ${schema.pattern}`);
  }

  if ('minimum' in schema && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
  }

  if (kindOf(value) === 'array') {
    if ('items' in schema) value.forEach((v, i) => validate(schema.items, v, root, `${path}[${i}]`, errors));
    if ('minItems' in schema && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} items is below minItems ${schema.minItems}`);
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

// --------------------------------------------------------------------------- fixtures

const schema = JSON.parse(readFileSync(new URL('../quality/schemas/splits.schema.json', import.meta.url), 'utf8'));
const hex = (c) => c.repeat(64);
const clone = (o) => JSON.parse(JSON.stringify(o));

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

const cases = [
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

let failures = 0;
for (const [name, doc, shouldPass] of cases) {
  const errors = isValid(schema, doc);
  const passed = errors.length === 0;
  if (passed !== shouldPass) {
    failures += 1;
    process.stderr.write(`test_SPLITS_schema_accepts_and_rejects: ${name} — expected ${shouldPass ? 'accept' : 'reject'}, got ${passed ? 'accept' : `reject (${errors.join('; ')})`}\n`);
  }
}

if (failures > 0) process.exit(1);
process.stdout.write('test_SPLITS_schema_accepts_and_rejects OK\n');
