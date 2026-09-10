import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_ROUTES, ACCESS_ERRORS, validateAccess, accessSchema, decodeAccess, accessProblem, validateAccessProblem } from '../../src/contracts/access.ts';
import { examples } from './examples.mjs';

test('closed route inventory has exact, unique English method/path pairs', () => {
  assert.equal(Object.keys(ACCESS_ROUTES).length, 20);
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(ACCESS_ROUTES).sort());
  assert.equal(new Set(Object.values(ACCESS_ROUTES).map((r) => `${r.method} ${r.path}`)).size, 20);
  assert.equal(Object.values(ACCESS_ROUTES).some((r) => /execute|investiture|impersonate|register|direct-grant/.test(r.path)), false);
});
for (const [route, pair] of Object.entries(examples)) {
  for (const [index, direction] of ['request', 'response'].entries()) {
    const value = pair[index];
    test(`${route} ${direction}: positive, extra/missing fields, wrong type, exact round trip`, () => {
      const decoded = decodeAccess(new TextEncoder().encode(JSON.stringify(value)));
      assert.deepEqual(decoded, value);
      assert.equal(validateAccess(route, direction, decoded), true);
      assert.equal(validateAccess(route, direction, { ...value, role: 'admin' }), false);
      assert.equal(validateAccess(route, direction, []), false);
      for (const key of Object.keys(value)) {
        const missing = { ...value }; delete missing[key];
        assert.equal(validateAccess(route, direction, missing), false, `Missing ${key}`);
        assert.equal(validateAccess(route, direction, { ...value, [key]: null }), false, `Null ${key}`);
      }
      const schema = accessSchema(route, direction);
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required.sort(), Object.keys(value).sort());
    });
  }
}
test('revisions and intention fields cannot substitute authority', () => {
  const valid = examples.accept_invitation[0];
  for (const expected_revision of [0, -1, -0, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateAccess('accept_invitation', 'request', { ...valid, expected_revision }), false);
  }
  for (const field of ['account_id', 'person_id', 'scope_id', 'role', 'risk', 'authority', 'profile', 'purpose']) {
    assert.equal(validateAccess('accept_invitation', 'request', { ...valid, [field]: 'claimed' }), false);
  }
  assert.equal(validateAccess('grant_directly', 'request', {}), false);
  assert.equal(validateAccess('__proto__', 'request', {}), false);
});
test('nested proposals are closed; exact email, opaque IDs and text are preserved', () => {
  const request = structuredClone(examples.issue_invitation[0]);
  request.grants[0].admin = true;
  assert.equal(validateAccess('issue_invitation', 'request', request), false);
  request.grants = [];
  assert.equal(validateAccess('issue_invitation', 'request', request), false);
  assert.equal(validateAccess('issue_invitation', 'request', { ...examples.issue_invitation[0], family: 'superuser' }), false);
  const source = { ...examples.login[0], password: 'Unicode e\u0301 🧪, not normalized' };
  assert.equal(validateAccess('login', 'request', source), true);
  assert.deepEqual(decodeAccess(new TextEncoder().encode(JSON.stringify(source))), source);
});
test('capability projection is not a single ready flag or promise of future work', () => {
  const base = structuredClone(examples.capabilities[1]);
  assert.equal(validateAccess('capabilities', 'response', base), true);
  base.capabilities[0].executable = 'yes';
  assert.equal(validateAccess('capabilities', 'response', base), false);
  base.capabilities[0].authorized = 'yes'; base.capabilities[0].implemented = false;
  assert.equal(validateAccess('capabilities', 'response', base), false);
  base.capabilities[0].implemented = true;
  base.capabilities[0].explanation = 'available';
  assert.equal(validateAccess('capabilities', 'response', base), true);
  base.capabilities.push({ ...base.capabilities[0] });
  assert.equal(validateAccess('capabilities', 'response', base), false);
});
test('strict wire parser catches duplicate escaped keys, unsafe numbers, UTF-8 and depth', () => {
  const invalid = [
    '{"email":"one","email":"two"}', '{"email":"one","em\\u0061il":"two"}',
    '{"x":{"revision":1,"revision":2}}', '{"expected_revision":1e0}', '{"expected_revision":1.0}',
    '{"expected_revision":-0}', '{"expected_revision":9007199254740992}', '{"x":"\\ud800"}',
    '['.repeat(14) + '0' + ']'.repeat(14), '{', '\uFEFF{}', 'x',
  ];
  for (const input of invalid) assert.throws(() => decodeAccess(new TextEncoder().encode(input)), /JSON|KEY|INTEGER|DEPTH/);
  assert.throws(() => decodeAccess(Uint8Array.from([0x7b, 0xc0, 0xaf, 0x7d])), /INVALID_JSON/);
  assert.throws(() => decodeAccess(new Uint8Array(16385)), /PAYLOAD_LIMIT/);
  assert.deepEqual(decodeAccess(new TextEncoder().encode('{"a":[],"b":{},"c":[true,false,null,"x\\\"y",2]}')), { a: [], b: {}, c: [true, false, null, 'x"y', 2] });
});
for (const code of Object.keys(ACCESS_ERRORS)) {
  test(`problem ${code}: exact HTTP status, media type and closed body`, () => {
    const problem = accessProblem(code);
    assert.equal(validateAccessProblem(problem, problem.status, 'application/problem+json'), true);
    assert.equal(validateAccessProblem(problem, 200, 'application/problem+json'), false);
    assert.equal(validateAccessProblem(problem, problem.status, 'application/json'), false);
    assert.equal(validateAccessProblem({ ...problem, detail: 'secret' }, problem.status, 'application/problem+json'), false);
    assert.equal(validateAccessProblem({ ...problem, title: 'arbitrary' }, problem.status, 'application/problem+json'), false);
  });
}
