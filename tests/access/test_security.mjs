import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { hash, verify, parseOptions } from '@node-rs/argon2';
import { accessSecurity, invitationExpiryAllowed, TRIAL_PASSWORD_OPTIONS } from '../../src/contracts/access_security.ts';

export const trial = {
  profile: 'access-trial/1', sessionSeconds: 1800, proofSeconds: 300, invitationSeconds: 86400, proofAttempts: 5,
  loginAttempts: 5, attemptWindowSeconds: 300, bodyBytes: 16384, resendSeconds: 30, resendLimit: 3, retryLimit: 2,
};
test('security configuration requires every finite bound and rejects unknown fields', () => {
  assert.deepEqual(accessSecurity(trial), trial);
  assert.ok(Object.isFrozen(accessSecurity(trial)));
  for (const key of Object.keys(trial)) {
    const missing = { ...trial }; delete missing[key];
    assert.throws(() => accessSecurity(missing), /INVALID_SECURITY_CONFIG/);
    if (key === 'profile') continue;
    for (const bad of [NaN, Infinity, -1, '5', 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => accessSecurity({ ...trial, [key]: bad }));
  }
  for (const value of [null, {}, { ...trial, production: true }, { ...trial, proofSeconds: 2000 }, { ...trial, resendSeconds: 301 }]) assert.throws(() => accessSecurity(value));
});

test('invitation lifetime configuration is explicit and independently bounded', () => {
  for (const invitationSeconds of [1, 604800]) assert.equal(accessSecurity({ ...trial, invitationSeconds }).invitationSeconds, invitationSeconds);
  for (const invitationSeconds of [0, 604801]) assert.throws(() => accessSecurity({ ...trial, invitationSeconds }), /INVALID_SECURITY_CONFIG/);
});

test('invitation issuance checks absolute milliseconds against the configured duration', () => {
  const config = accessSecurity(trial);
  const issuedAt = 1800000000000;
  const limit = issuedAt + config.invitationSeconds * 1000;
  for (const expiry of [issuedAt + 1, limit - 1, limit]) assert.equal(invitationExpiryAllowed(config, issuedAt, expiry), true);
  for (const expiry of [issuedAt - 1, issuedAt, limit + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1800000000001', limit + 0.5]) {
    assert.equal(invitationExpiryAllowed(config, issuedAt, expiry), false);
  }
  for (const start of [-1, NaN, Infinity, issuedAt + 0.5, '1800000000000']) assert.equal(invitationExpiryAllowed(config, start, limit), false);
  assert.equal(invitationExpiryAllowed(config, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER), true);
  assert.equal(invitationExpiryAllowed(config, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(invitationExpiryAllowed(accessSecurity({ ...trial, invitationSeconds: 1 }), issuedAt, issuedAt + 1000), true);
  assert.equal(invitationExpiryAllowed(accessSecurity({ ...trial, invitationSeconds: 1 }), issuedAt, issuedAt + 1001), false);
  for (const invitationSeconds of [undefined, 0, 604801, Infinity]) assert.equal(invitationExpiryAllowed({ ...config, invitationSeconds }, issuedAt, issuedAt + 1), false);
});

test('selected Argon2id realization: salt uniqueness, exact password, bounded parameters', { timeout: 30000 }, async (t) => {
  const password = `Synthetic-${randomBytes(24).toString('base64url')}-e\u0301`;
  const times = [];
  let first;
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const encoded = await hash(password, TRIAL_PASSWORD_OPTIONS);
    times.push(performance.now() - start);
    assert.ok(encoded.startsWith('$argon2id$v=19$m=65536,t=3,p=1$'), 'Encoded PHC algorithm, version and cost parameters are fixed independently of the library parser');
    const options = parseOptions(encoded);
    assert.deepEqual(options, { ...TRIAL_PASSWORD_OPTIONS, saltLen: 16 });
    assert.equal(await verify(encoded, password), true);
    assert.equal(await verify(encoded, password + 'wrong'), false);
    assert.equal(await verify(encoded, password.normalize('NFC')), false);
    if (first) assert.notEqual(first, encoded, 'Fresh 16-byte salt per verifier');
    first = encoded;
  }
  times.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.versions.node, algorithm: 'argon2id-v19', memoryKiB: 65536, passes: 3, parallelism: 1, hashRuns: 5, minMs: +times[0].toFixed(2), medianMs: +times[2].toFixed(2), maxMs: +times[4].toFixed(2) }));
});
