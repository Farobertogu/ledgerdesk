import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PasswordVerifier,
  PasswordBusy,
} from '../../src/server/access/password.ts';
import { startupAllowed } from '../../src/server/access/service.ts';
import { validateAccess } from '../../src/contracts/access.ts';
import { accessSourceViolations } from '../../ci/access_boundary_check.mjs';
import { accessCookieHeaders } from '../../src/server/access/terminal.ts';

test('reception is a closed support treatment, not account or authority creation', () => {
  assert.equal(validateAccess('reception', 'request', {}), true);
  assert.equal(
    validateAccess('reception', 'response', { csrf_token: 'A'.repeat(43) }),
    true,
  );
  for (const response of [
    { csrf_token: 'x' },
    { csrf_token: 'A'.repeat(43), account_id: 'x' },
  ])
    assert.equal(validateAccess('reception', 'response', response), false);
});
test('bounded verifier checks parameters before expensive work and unknown addresses never authenticate', async () => {
  const p = new PasswordVerifier();
  await p.initialize();
  const encoded = await p.create('synthetic correct password');
  assert.equal(p.valid(encoded), true);
  assert.equal(await p.matches(encoded, 'synthetic correct password'), true);
  assert.equal(await p.matches(encoded, 'incorrect password'), false);
  assert.equal(await p.matches(null, 'incorrect password'), false);
  for (const bad of [
    encoded.replace('65536', '1073741824'),
    encoded.replace('argon2id', 'argon2i'),
    'x'.repeat(5000),
  ])
    assert.equal(await p.matches(bad, 'pw'), false);
  await assert.rejects(p.create('a'.repeat(1025)), /PASSWORD_BOUND/);
  const requests = [p.create('one'), p.create('two'), p.create('three')];
  const result = await Promise.allSettled(requests);
  assert.equal(
    result.filter(
      (r) => r.status === 'rejected' && r.reason instanceof PasswordBusy,
    ).length,
    1,
  );
});
test('no declaration or a nominal admin flag establishes startup authority', () => {
  for (const c of [
    null,
    {},
    { active: true, admin: true },
    {
      active: true,
      deployment_id: 'inc02-synthetic',
      master_email: 'a@b.test',
      root: {},
      reception: {},
    },
  ])
    assert.equal(startupAllowed(c, Date.now()), false);
});
test('only the exact runtime adapters gain dependencies; UI and contracts remain isolated', () => {
  assert.deepEqual(
    accessSourceViolations(
      'src/server/access/postgres/store.ts',
      "import {Client} from 'pg'",
    ),
    [],
  );
  assert.ok(
    accessSourceViolations(
      'src/server/access/service.ts',
      "import {Client} from 'pg'",
    ).length,
  );
  assert.ok(
    accessSourceViolations(
      'src/components/access/AccessPanel.tsx',
      "import x from '../../server/access/service'",
    ).length,
  );
  assert.ok(
    accessSourceViolations('src/contracts/access.ts', "import x from 'react'")
      .length,
  );
  assert.ok(
    accessSourceViolations(
      'src/app/portal/page.tsx',
      "import x from '@/server/access/service'",
    ).length,
  );
});

test('cookie projection preserves both fields, independent lifetimes and session deletion', () => {
  const now = 1000000;
  const output = {
    status: 200,
    body: {},
    sessionCookie: 'S'.repeat(43),
    flowCookie: 'F'.repeat(43),
    credentialExpiresAt: now + 1800000,
    expiresAt: now + 300000,
  };
  const session = `__Host-ledgerdesk-session=${'S'.repeat(43)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800`;
  const flow = `__Host-ledgerdesk-flow=${'F'.repeat(43)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`;
  assert.deepEqual(accessCookieHeaders(output, now), [session, flow]);
  assert.deepEqual(accessCookieHeaders({ ...output, sessionCookie: '' }, now), [
    '__Host-ledgerdesk-session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0',
    flow,
  ]);
  assert.deepEqual(
    accessCookieHeaders({ ...output, flowCookie: undefined }, now),
    [session],
  );
  assert.deepEqual(
    accessCookieHeaders({ ...output, sessionCookie: undefined }, now),
    [flow],
  );
  assert.deepEqual(accessCookieHeaders({ status: 403, body: {} }, now), []);
});
