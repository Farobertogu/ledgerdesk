import test from 'node:test';
import assert from 'node:assert/strict';
import { readLoopbackOrigin } from '../../src/contracts/reading_origin.ts';
import { Reader } from '../../src/components/reading/reader.ts';
import { startReadingTerminal } from '../../src/server/reading/terminal.ts';
import { PROBLEMS } from '../../src/contracts/material_reading.ts';
import { trialEnv, trialContext } from './T04_seed.mjs';

const origin = 'http://127.0.0.1:3180';
test('T05 origin spelling is explicit, canonical, loopback-only and has no URL suffix', () => {
  for (const value of [origin, 'http://127.0.0.1:1024', 'http://127.0.0.1:65535']) assert.equal(readLoopbackOrigin(value), value);
  for (const value of [undefined, '', 'null', '*', 'https://127.0.0.1:3180', 'http://localhost:3180',
    'http://127.1:3180', 'http://2130706433:3180', 'http://[::1]:3180', 'http://example.com:3180',
    origin + '/', origin + '/api', origin + '?x=1', origin + '#a', ' ' + origin, origin + '\n',
    'http://user@127.0.0.1:3180', 'http://127.0.0.1:03180', 'http://127.0.0.1:80',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536']) assert.equal(readLoopbackOrigin(value), null, String(value));
});

test('T05 controller targets only the supplied origin and omits credentials, storage and redirects', async () => {
  let call;
  const reader = new Reader(async (url, init) => {
    call = { url, init };
    return new Response(JSON.stringify(PROBLEMS[503]), { status: 503, headers: { 'content-type': 'application/problem+json' } });
  }, origin);
  await reader.reload();
  assert.equal(call.url, origin + '/api/v1/material');
  assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.redirect, 'error'); assert.equal(call.init.headers, undefined);
  assert.throws(() => new Reader(undefined, 'http://example.com:3180'), /Invalid reading origin/);
  assert.throws(() => new Reader(undefined, ''), /Invalid reading origin/);
});

test('T05 exact-origin HTTP policy is separate from reading authority', async t => {
  let creates = 0, reads = 0, receivedContext, outcome = PROBLEMS[404];
  const createStore = () => {
    creates++;
    return {
      async connect() {}, async acquire() {}, async release() {}, async close() {}, async observe() {}, available: () => true,
      async prepare(context) { reads++; receivedContext = context; return { receiptId: 'synthetic', revision: '1', earliestExpiry: null, response: outcome }; },
    };
  };
  await assert.rejects(startReadingTerminal({ env: { ...trialEnv, LEDGERDESK_READING_UI_ORIGIN: '*' }, createStore }), /Invalid reading UI origin/);
  assert.equal(creates, 0, 'invalid configuration must fail before connecting');
  const server = await startReadingTerminal({ env: { ...trialEnv, LEDGERDESK_READING_UI_ORIGIN: origin }, createStore });
  t.after(() => server.close());
  for (const bad of ['null', 'http://127.0.0.1:3181', origin + '/', 'http://localhost:3180', origin + ', http://evil.test']) {
    const response = await fetch(server.url + '/api/v1/material', { headers: { origin: bad } });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await response.json(), PROBLEMS[403]);
  }
  assert.equal(reads, 0);
  for (const status of [404, 503]) {
    outcome = PROBLEMS[status];
    const response = await fetch(server.url + '/api/v1/material', { headers: { origin,
      cookie: 'ld_dev_user=forged', authorization: 'Bearer forged', 'x-subject': 'synthetic-other' } });
    assert.equal(response.status, status); assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(receivedContext, trialContext);
  }
  const before = reads;
  for (const init of [{ method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } },
    { headers: { origin } }]) {
    const response = await fetch(server.url + '/api/v1/material?subject=forged', init);
    assert.equal(response.status, 400); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
  assert.equal(reads, before);
  const disabled = await startReadingTerminal({ env: { LEDGERDESK_READING_UI_ORIGIN: origin }, createStore });
  t.after(() => disabled.close());
  const response = await fetch(disabled.url + '/api/v1/material', { headers: { origin } });
  assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(creates, 1, 'CORS cannot turn a disabled trial into a store');
});

test('T05 a terminal without UI configuration refuses Origin but retains non-browser synthetic checks', async t => {
  const terminal = await startReadingTerminal({ env: {}, createStore: () => { throw new Error('must not connect'); } });
  t.after(() => terminal.close());
  for (const headers of [{ origin }, {}]) {
    const response = await fetch(terminal.url + '/api/v1/material', { headers });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});
