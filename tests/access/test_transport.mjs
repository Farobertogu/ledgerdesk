import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionTransport, sessionRequest, SESSION_COOKIE } from '../../src/contracts/access_transport.ts';
import { transportEnvelope, csrfMatches, corsHeaders, preflightHeaders, sessionToken, sessionSetCookie } from '../../src/server/access/transport.ts';
const raw = { profile: 'session/1', uiOrigin: 'https://ui.inc02.test:8443', terminalOrigin: 'https://api.inc02.test:9443' };
const config = sessionTransport(raw);
const csrf = 'A'.repeat(43);
const post = { method: 'POST', origin: config.uiOrigin, host: 'api.inc02.test:9443', contentType: 'application/json', csrf };

test('trusted session profile is explicit, closed, canonical and has no HTTP downgrade', () => {
  assert.deepEqual(config, raw); assert.ok(Object.isFrozen(config));
  for (const input of [null, {}, { ...raw, profile: 'reading/1' }, { ...raw, fallback: true }, { ...raw, profile: undefined }]) assert.throws(() => sessionTransport(input), /INVALID_TRANSPORT/);
  for (const value of ['http://ui.inc02.test:8443', 'https://ui.inc02.test:8443/', 'https://ui.inc02.test:08443',
    'https://ui.inc02.test:443', 'https://ui.inc02.test:65536', 'https://ui.other.test:8443',
    'https://ui.inc02.test.evil:8443', 'https://x@ui.inc02.test:8443', 'https://ui.inc02.test:8443?q=x']) {
    assert.throws(() => sessionTransport({ ...raw, uiOrigin: value }), /INVALID_TRANSPORT/);
  }
});
test('credentials, no-store and redirects are fixed by the session profile', () => {
  assert.deepEqual(sessionRequest('GET'), { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error' });
  assert.equal(sessionRequest('POST', csrf).headers['x-ledgerdesk-csrf'], csrf);
  for (const invalid of [undefined, '', 'short', 'A'.repeat(44)]) assert.throws(() => sessionRequest('POST', invalid));
  assert.throws(() => sessionRequest('DELETE', csrf));
});
test('exact host and Origin are independent of the presence of a session cookie', () => {
  assert.equal(transportEnvelope(config, post), true);
  for (const origin of [undefined, 'null', '*', 'https://evil.inc02.test:8443', 'https://ui.inc02.test:8444', config.uiOrigin + '/']) assert.equal(transportEnvelope(config, { ...post, origin }), false);
  for (const host of [undefined, 'api.inc02.test', 'localhost:9443', 'api.inc02.test:9444', 'api.inc02.test:9443,evil']) assert.equal(transportEnvelope(config, { ...post, host }), false);
});
test('bounded preflights do not authorize effects', () => {
  const preflight = { ...post, method: 'OPTIONS', requestedMethod: 'POST', requestedHeaders: 'x-ledgerdesk-csrf, content-type' };
  assert.equal(transportEnvelope(config, preflight), true);
  assert.equal(transportEnvelope(config, { ...preflight, requestedHeaders: 'content-type, x-ledgerdesk-csrf, x-ledgerdesk-intent' }), true);
  for (const requestedHeaders of ['*', '', 'content-type', 'content-type, x-ledgerdesk-csrf, authorization', 'content-type,content-type,x-ledgerdesk-csrf']) assert.equal(transportEnvelope(config, { ...preflight, requestedHeaders }), false);
  assert.equal(transportEnvelope(config, { ...preflight, requestedMethod: 'DELETE' }), false);
  for (const method of ['HEAD', 'PUT', 'DELETE', 'PATCH']) assert.equal(transportEnvelope(config, { ...post, method }), false);
  assert.equal(transportEnvelope(config, { ...post, contentType: 'text/plain' }), false);
});
test('CSRF is independent and exact; a cookie is not CSRF proof', () => {
  assert.equal(csrfMatches(post, csrf), true);
  for (const value of [undefined, 'short', 'B'.repeat(43), csrf + 'x']) assert.equal(csrfMatches({ ...post, csrf: value, cookie: `${SESSION_COOKIE}=${csrf}` }, csrf), false);
  assert.equal(csrfMatches({ ...post, method: 'GET' }, csrf), false);
});
test('duplicate and legacy cookies cannot establish the new session', () => {
  assert.equal(sessionToken(`${SESSION_COOKIE}=${csrf}`), csrf);
  for (const cookie of [undefined, `ld_dev_user=${csrf}`, `${SESSION_COOKIE}=${csrf};${SESSION_COOKIE}=${csrf}`, `${SESSION_COOKIE}=short`, `${SESSION_COOKIE}=${csrf}=`]) assert.equal(sessionToken(cookie), null);
  const output = sessionSetCookie(csrf, 60);
  assert.equal(output, `${SESSION_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=60`);
  assert.equal(output.includes('Domain='), false);
  assert.throws(() => sessionSetCookie(csrf, Infinity));
  assert.throws(() => sessionSetCookie('invalid\r\n', 60));
});
test('credentialed CORS never uses a wildcard and never permits cache reuse', () => {
  const headers = corsHeaders(config);
  assert.equal(headers['access-control-allow-origin'], raw.uiOrigin);
  assert.equal(headers['access-control-allow-credentials'], 'true');
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers.vary, 'Origin');
});

test('shared preflight response has exact methods, headers and finite cache age', () => {
  assert.deepEqual(preflightHeaders(config), {
    ...corsHeaders(config),
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type, x-ledgerdesk-csrf, x-ledgerdesk-intent',
    'access-control-max-age': '60',
  });
  assert.equal(transportEnvelope(config, { ...post, origin: 'https://evil.inc02.test:8443' }), false);
  assert.equal(csrfMatches({ ...post, csrf: 'B'.repeat(43) }, csrf), false);
});
