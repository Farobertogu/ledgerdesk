import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalValue,
  canonicalIntent,
  scalarOrder,
  resolveAccessPath,
  accessPath,
} from '../../src/contracts/access_canonical.ts';
import { decodeAccess } from '../../src/contracts/access.ts';

test('fixed canonical vectors preserve Unicode, absence, null, arrays and exact numbers', () => {
  const vectors = [
    [{ b: 1, a: 'x' }, '{"a":"x","b":1}'],
    [{ z: { b: 2, a: 1 } }, '{"z":{"a":1,"b":2}}'],
    [{ a: null }, '{"a":null}'],
    [{}, '{}'],
    [[true, null, 0, 'é'], '[true,null,0,"é"]'],
    [{ '𐀀': 1, '\uE000': 2 }, '{"":2,"𐀀":1}'],
  ];
  for (const [input, expected] of vectors)
    assert.equal(canonicalValue(input), expected);
  assert.notEqual(canonicalValue('é'), canonicalValue('e\u0301'));
  assert.notEqual(canonicalValue('x'), canonicalValue(' x'));
  assert.notEqual(canonicalValue([1, 2]), canonicalValue([2, 1]));
  assert.ok(scalarOrder('\uE000', '𐀀') < 0);
  for (const v of [
    undefined,
    NaN,
    Infinity,
    -0,
    1.5,
    -1,
    '\uD800',
    new Date(),
    { x: undefined },
  ])
    assert.throws(() => canonicalValue(v));
});
test('canonical intention includes path and revision; nested key order is insignificant', () => {
  const grant = {
    permission_id: 'ask',
    exercise_or_grant: 'exercise',
    scope_ref: 'team',
    support_ref: 'domain',
  };
  const a = canonicalIntent(
    'amend_invitation',
    { invitation_id: 'inv-one' },
    { expected_revision: 1, grants: [grant] },
  );
  const reordered = Object.fromEntries(Object.entries(grant).reverse());
  assert.equal(
    a,
    canonicalIntent(
      'amend_invitation',
      { invitation_id: 'inv-one' },
      { grants: [reordered], expected_revision: 1 },
    ),
  );
  assert.notEqual(
    a,
    canonicalIntent(
      'amend_invitation',
      { invitation_id: 'inv-two' },
      { expected_revision: 1, grants: [grant] },
    ),
  );
  assert.notEqual(
    a,
    canonicalIntent(
      'amend_invitation',
      { invitation_id: 'inv-one' },
      { expected_revision: 2, grants: [grant] },
    ),
  );
  assert.ok(a.includes('"profile":"canon_m09_1"'));
  for (const raw of [
    '{"expected_revision":1.0}',
    '{"expected_revision":1e0}',
    '{"a":1,"a":1}',
  ])
    assert.throws(() => decodeAccess(new TextEncoder().encode(raw)));
});
test('typed route matching opens the ten T03 routes without aliases or future consumers', () => {
  assert.deepEqual(
    resolveAccessPath('/api/access/v1/invitations/inv-one/amend'),
    { route: 'amend_invitation', parameters: { invitation_id: 'inv-one' } },
  );
  for (const suffix of [
    '/people',
    '/invitations/x/accept/',
    '/invitations/%78',
    '/invitations/x?role=admin',
    '/invitations/x#y',
    '/invitations/../accept',
    '/invitations/x\\amend',
  ])
    assert.equal(resolveAccessPath('/api/access/v1' + suffix), null, suffix);
  assert.equal(
    accessPath('accept_invitation', { invitation_id: 'a:b' }),
    '/api/access/v1/invitations/a:b/accept',
  );
  assert.throws(() =>
    accessPath('accept_invitation', { invitation_id: 'x', role: 'admin' }),
  );
});
