import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, prepareReading } from '../../src/server/reading/policy.ts';
import { PROBLEMS, validateDetailResponse, validateListResponse } from '../../src/contracts/material_reading.ts';

const context = Object.freeze({
  deploymentId: 'inc01-synthetic', scopeId: 'inc01-material', subjectId: 'synthetic-reader',
  surface: 'material-reader', purpose: 'synthetic-reading-trial', generation: 'generation-one',
});
const original = '  Regla: café\r\nExcepto los domingos.\nCafe\u0301 😀 <script>no()</script>  ';
const now = 100;
const exact = (unit_id = 'unit-one', version_id = 'version-one') =>
  ({ kind: 'exact', reference: { unit_id, version_id } });
const list = { kind: 'list' };
const reference = { unit_id: 'unit-one', version_id: 'version-one' };
function row(action, maximum = 'CONTENT', patch = {}) {
  const binding = { ...context, action };
  return { binding, evaluation: 'GRANT', grant: {
    binding, maximum, metadata: ['title', 'editorial_state', 'reading_conditions'],
    fragmentIds: ['rule', 'exception'], fragmentLocatorIds: [], validFrom: 0, validUntil: 200,
    ...patch,
  } };
}
function material(maximum = 'CONTENT') {
  return {
    deploymentId: context.deploymentId, scopeId: context.scopeId, reference: { ...reference },
    originalLanguage: 'es', originalText: original,
    metadata: { title: '  Política\r\n', editorial_state: 'PUBLISHED', reading_conditions: ['Exact synthetic original.'],
      locator: 'private-locator' },
    fragments: [
      { fragment_id: 'rule', text: 'Regla: café', locator: 'private-rule-locator' },
      { fragment_id: 'exception', text: 'Excepto los domingos.' },
    ],
    requirements: {
      REFERENCE: { metadata: ['title'] },
      EXCERPT: { metadata: ['title'], fragmentIds: ['rule', 'exception'] },
      CONTENT: { metadata: ['title'] },
    },
    policy: { unit: [row('list', maximum), row('exact', maximum)], inherited: [], general: [] },
  };
}
const response = (records, operation = exact(), at = now, ctx = context) =>
  prepareReading(records, ctx, operation, at).response;
function freeze(value) {
  Object.freeze(value);
  for (const item of Object.values(value)) if (item && typeof item === 'object' && !Object.isFrozen(item)) freeze(item);
  return value;
}

test('each server-context axis and action is an exact policy binding', async (t) => {
  for (const key of ['deploymentId', 'scopeId', 'subjectId', 'surface', 'purpose', 'generation']) {
    await t.test(key, () => {
      const m = material();
      assert.deepEqual(response([m], exact(), now, { ...context, [key]: `different-${key}` }), PROBLEMS[404]);
    });
  }
  await t.test('list permission is not detail permission', () => {
    const m = material(); m.policy.unit = [row('list')];
    assert.equal(response([m], list).items.length, 1);
    assert.deepEqual(response([m]), PROBLEMS[404]);
  });
  await t.test('detail permission is not list permission', () => {
    const m = material(); m.policy.unit = [row('exact')];
    assert.equal(response([m], list).items.length, 0);
    assert.equal(response([m]).projection.kind, 'CONTENT');
  });
});

test('precedence only falls through a missing applicable tier', async (t) => {
  for (const evaluation of ['DENY', 'INDETERMINATE']) {
    await t.test(evaluation, () => {
      const m = material(); m.policy.unit[1] = { binding: { ...context, action: 'exact' }, evaluation };
      m.policy.inherited = [row('exact')]; m.policy.general = [row('exact')];
      assert.deepEqual(response([m]), PROBLEMS[404]);
    });
  }
  await t.test('inherited explicit denial stops general grant', () => {
    const m = material(); m.policy.unit = [];
    m.policy.inherited = [{ binding: { ...context, action: 'exact' }, evaluation: 'DENY' }];
    m.policy.general = [row('exact')]; assert.deepEqual(response([m]), PROBLEMS[404]);
  });
  for (const tier of ['unit', 'inherited', 'general']) {
    await t.test(`explicit ${tier} grant`, () => {
      const m = material(); m.policy = { unit: [], inherited: [], general: [] };
      m.policy[tier] = [row('exact', 'REFERENCE')];
      assert.equal(response([m]).projection.kind, 'REFERENCE');
    });
  }
  await t.test('ambiguous rows refuse instead of combining grants', () => {
    const m = material(); m.policy.unit.push(row('exact', 'REFERENCE'));
    const result = prepareReading([m], context, exact(), now);
    assert.deepEqual(result.response, PROBLEMS[404]); assert.equal(result.decisions[0].cause, 'INDETERMINATE');
  });
  await t.test('no policy has no implicit public access', () => {
    const m = material(); m.policy.unit = []; assert.deepEqual(response([m]), PROBLEMS[404]);
  });
});

test('five disclosure levels have closed, independently expected shapes', async (t) => {
  for (const level of ['NONE', 'EXISTENCE', 'REFERENCE', 'EXCERPT', 'CONTENT']) {
    await t.test(level, () => {
      const m = material(level); const a = response([m], list); const b = response([m]);
      assert.equal(validateListResponse(a).ok, true);
      const identifiable = !['NONE', 'EXISTENCE'].includes(level);
      assert.equal(a.items.length, Number(identifiable));
      assert.equal(a.existence_signal, level === 'EXISTENCE');
      assert.equal(JSON.stringify(a).includes('Regla:'), false);
      if (!identifiable) { assert.deepEqual(b, PROBLEMS[404]); return; }
      assert.equal(validateDetailResponse(b).ok, true);
      assert.equal(b.projection.kind, level);
      assert.deepEqual(b.projection.reference, reference);
      assert.equal(b.projection.metadata.title, m.metadata.title);
      assert.equal('locator' in b.projection.metadata, false);
      assert.equal('original_text' in b.projection, level === 'CONTENT');
      assert.equal('fragments' in b.projection, level === 'EXCERPT');
      if (level === 'CONTENT') assert.equal(b.projection.original_text, original);
      if (level === 'EXCERPT') assert.deepEqual(b.projection.fragments, [
        { fragment_id: 'rule', text: 'Regla: café' },
        { fragment_id: 'exception', text: 'Excepto los domingos.' },
      ]);
    });
  }
});

test('absent, hidden, indeterminate, existence-only and unfaithful detail share the public problem', () => {
  const worlds = [[], [material('NONE')], [material('EXISTENCE')]];
  const unknown = material(); unknown.policy.unit[1].evaluation = 'INDETERMINATE'; worlds.push([unknown]);
  const incomplete = material(); incomplete.requirements = {}; worlds.push([incomplete]);
  for (const world of worlds) assert.deepEqual(response(world), PROBLEMS[404]);
});

test('hidden and locally indeterminate population does not alter visible list, slots or signal', () => {
  const visible = material('REFERENCE'); const expected = response([visible], list);
  const hidden = material('NONE'); hidden.reference = { unit_id: 'a-hidden', version_id: 'private-version' };
  hidden.originalText = 'do not expose'; hidden.metadata.title = 'x'.repeat(9999);
  const unknown = material(); unknown.reference = { unit_id: 'unknown', version_id: 'unknown' };
  unknown.policy.unit[0].evaluation = 'INDETERMINATE';
  assert.deepEqual(response([hidden, visible, unknown], list), expected);
  assert.deepEqual(response([visible, ...Array.from({ length: 32 }, () => structuredClone(hidden))], list), expected);
  const result = prepareReading([unknown, visible], context, list, now);
  assert.equal(result.decisions[0].cause, 'INDETERMINATE');
  assert.equal(JSON.stringify(result.response).includes('unknown'), false);
});

test('several existence-only objects emit a single unidentifiable signal', () => {
  const a = material('EXISTENCE'), b = material('EXISTENCE'); b.reference.unit_id = 'other';
  assert.deepEqual(response([a, b], list), { contract: 'reading/1', items: [], existence_signal: true });
});

test('visible order is ordinal over exact pairs, independent of storage order', () => {
  const records = ['z', 'A', 'á'].map((id) => { const m = material('REFERENCE'); m.reference.unit_id = id; return m; });
  assert.deepEqual(response(records, list).items.map((item) => item.reference.unit_id), ['A', 'z', 'á']);
  assert.deepEqual(response(records.toReversed(), list), response(records, list));
});

test('crossed pairs and unknown versions never redirect to the newest version', () => {
  const old = material(), next = material(); next.reference.version_id = 'version-two'; next.originalText = 'New';
  assert.equal(response([next, old]).projection.original_text, original);
  assert.deepEqual(response([old], exact('other', 'version-one')), PROBLEMS[404]);
  assert.deepEqual(response([old], exact('unit-one', 'version-two')), PROBLEMS[404]);
});

test('projection requirements permit only an explicitly faithful downgrade', () => {
  const m = material('EXCERPT'); m.policy.unit[1].grant.fragmentIds = ['rule'];
  assert.equal(response([m]).projection.kind, 'REFERENCE');
  delete m.requirements.REFERENCE; assert.deepEqual(response([m]), PROBLEMS[404]);
  m.requirements.REFERENCE = { metadata: ['locator'] }; assert.deepEqual(response([m]), PROBLEMS[404]);
});

test('a malformed visible excerpt is not replaced with a convenient success', () => {
  const m = material('EXCERPT'); m.fragments[0].text = 'A generated paraphrase';
  assert.deepEqual(response([m]), PROBLEMS[503]);
  assert.deepEqual(response([m], exact('absent')), PROBLEMS[503]);
  m.fragments[0].text = ''; assert.deepEqual(response([m]), PROBLEMS[503]);
});

test('historical state and specific conditions must be disclosed together', async (t) => {
  for (const state of ['CANDIDATE', 'REJECTED', 'APPROVED_UNPUBLISHED', 'SUSPENDED', 'SUPERSEDED', 'WITHDRAWN']) {
    await t.test(state, () => {
      const m = material(); m.metadata.editorial_state = state;
      assert.equal(response([m]).projection.metadata.editorial_state, state);
      m.policy.unit[1].grant.metadata = ['title', 'editorial_state'];
      assert.deepEqual(response([m]), PROBLEMS[404]);
    });
  }
});

test('validity is half-open and every preparation resolves it again', () => {
  const m = material(); m.policy.unit[1].grant.validFrom = 50;
  assert.deepEqual(response([m], exact(), 49), PROBLEMS[404]);
  assert.equal(response([m], exact(), 50).projection.kind, 'CONTENT');
  assert.equal(response([m], exact(), 199).projection.kind, 'CONTENT');
  assert.deepEqual(response([m], exact(), 200), PROBLEMS[404]);
  assert.equal(prepareReading([m], context, exact(), 199).earliestExpiry, 200);
  m.policy.unit[1].evaluation = 'DENY'; assert.deepEqual(response([m], exact(), 199), PROBLEMS[404]);
});

test('unrelated or existence-only expirations do not become a detail-identity oracle', () => {
  const exists = material('EXISTENCE');
  assert.equal(prepareReading([exists], context, exact(), now).earliestExpiry, null);
  assert.equal(prepareReading([exists], context, list, now).earliestExpiry, 200);
  assert.equal(prepareReading([material()], context, exact('absent'), now).earliestExpiry, null);
});

test('malformed local policy and empty indispensable conditions fail closed without inheritance', () => {
  const m = material(); m.policy.unit = [{ binding: null }];
  m.policy.general = [row('exact')]; assert.deepEqual(response([m]), PROBLEMS[404]);
  const required = material(); required.requirements = { CONTENT: { metadata: ['reading_conditions'] } };
  required.metadata.reading_conditions = []; assert.deepEqual(response([required]), PROBLEMS[404]);
});

test('non-finite or incoherent validity and mismatched grant bindings refuse', async (t) => {
  const variants = [
    { validFrom: NaN }, { validUntil: Infinity }, { validFrom: 10, validUntil: 10 },
    { maximum: 'ADMIN' }, { binding: { ...context, action: 'exact', subjectId: 'other' } },
  ];
  for (const [index, patch] of variants.entries()) await t.test(String(index), () => {
    const m = material(); Object.assign(m.policy.unit[1].grant, patch);
    assert.equal(evaluatePolicy(m.policy, context, 'exact', now).cause, 'INDETERMINATE');
  });
  assert.deepEqual(response([material()], exact(), NaN), PROBLEMS[404]);
});

test('visible profile overflow fails independently of requested identity, without truncating', () => {
  const m = material(); m.originalText = '😀'.repeat(100000);
  assert.equal([...response([m]).projection.original_text].length, 100000);
  m.originalText += 'a';
  assert.deepEqual(response([m]), PROBLEMS[503]);
  assert.deepEqual(response([m], exact('absent')), PROBLEMS[503]);
  const many = Array.from({ length: 17 }, (_, i) => { const record = material('REFERENCE'); record.reference.unit_id = `id-${i}`; return record; });
  assert.deepEqual(response(many, list), PROBLEMS[503]);
  assert.equal(response(many.slice(0, 16), list).items.length, 16);
});

test('duplicate visible pairs are rejected without affecting hidden-population parity', () => {
  assert.deepEqual(response([material(), material()]), PROBLEMS[503]);
  assert.deepEqual(response([material('NONE'), material('NONE')]), PROBLEMS[404]);
});

test('public DTO is detached, exact and whitelist-only; private decisions stay separate', () => {
  const m = material(); m.metadata.secret = 'private-metadata'; m.successor = { unit_id: 'private-successor' };
  const expected = structuredClone(m); const result = prepareReading([freeze(m)], context, exact(), now);
  assert.deepEqual(m, expected); assert.equal(result.response.projection.original_text, original);
  const json = JSON.stringify(result.response);
  for (const token of ['private-metadata', 'private-successor', 'subjectId', 'decisions', 'earliestExpiry', 'offset']) {
    assert.equal(json.includes(token), false);
  }
  result.response.projection.metadata.reading_conditions.push('caller mutation');
  assert.equal(m.metadata.reading_conditions.length, 1);
});
