import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {chromium} from 'playwright';
import {lookupBodyObserver} from './lookup_body.mjs';

const id = '12345678-1234-4234-8234-123456789abc', foreignId = '12345678-1234-4234-8234-123456789abd';
const representation = 'application/vnd.ledgerdesk.intake-workspace+json';
const source = readFileSync(new URL('../../../src/components/intake/client.ts', import.meta.url), 'utf8');
const boundedJs = stripTypeScriptTypes(source.slice(source.indexOf('async function boundedBytes('), source.indexOf('/** Every protected result')));
const value = {offers: [], reception: {id}, note: 'Exact synthetic response.'};
const bytes = Buffer.from(JSON.stringify(value));

test('the reception observer uses the exact bounded native-consumed response', {timeout: 60000}, async t => {
  let mode = 'complete', browser;
  const timers = new Set(), requests = [];
  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {res.writeHead(204, {'access-control-allow-headers': 'accept'});res.end();return;}
    if (!req.url.startsWith('/api/')) {res.end('<!doctype html><title>Native body control</title>');return;}
    const scenario = mode;
    requests.push({method: req.method, path: req.url, accept: req.headers.accept});
    if (mode === 'network-error') {req.socket.destroy();return;}
    const foreign = req.method !== 'GET' || req.url !== '/api/intake/receptions/' + id || req.headers.accept !== representation || req.headers.host.startsWith('127.0.0.2:');
    const body = mode === 'invalid-json' ? Buffer.from('{invalid') : mode === 'invalid-utf8' ? Buffer.from([0xc3, 0x28]) :
      mode === 'oversized' ? Buffer.from(JSON.stringify({text: 'x'.repeat(65536)})) : foreign ? Buffer.from(JSON.stringify({foreign: true})) : bytes;
    res.writeHead(200, {'content-type': mode === 'wrong-response-type' ? 'application/json' : representation,
      ...(mode === 'unbounded-oversized' ? {} : {'content-length': body.length})});
    if (['truncated', 'cancelled'].includes(mode)) {
      res.write(body.subarray(0, 8));
      const timer = setTimeout(() => {timers.delete(timer);if (scenario === 'truncated') res.destroy();else res.end(body.subarray(8));}, 75);timers.add(timer);
    } else if (mode === 'unbounded-oversized') res.end(Buffer.from(JSON.stringify({text: 'x'.repeat(65536)})));
    else res.end(body);
  });
  try {
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    const port = server.address().port, origin = 'http://127.0.0.1:' + port, foreignOrigin = 'http://127.0.0.2:' + port;
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext(), observer = await lookupBodyObserver(context, {origin, maximum: 8454144});
    const page = await context.newPage();
    const consume = async (overrides = {}) => page.evaluate(async ({origin, id, representation, boundedJs, mode, ...override}) => {
      const controller = new AbortController(), boundedBytes = new Function(boundedJs + '; return boundedBytes;')();
      const method = override.method ?? 'GET';
      try {
        const response = await fetch((override.origin ?? origin) + '/api/intake/receptions/' + (override.id ?? id) + (override.suffix ?? ''),
          {method, headers: {accept: override.representation ?? representation}, signal: controller.signal, ...(method === 'POST' ? {body: '{}'} : {})});
        if (mode === 'cancelled') {const reader = response.body.getReader();await reader.read();await reader.cancel();reader.releaseLock();return {complete: false};}
        if (mode === 'headers-only') return {complete: false, status: response.status};
        const body = await boundedBytes(response, 65536);
        const result = {complete: true, status: response.status, bytes: Array.from(body), value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body))};
        if (mode === 'abort-after-complete') controller.abort();
        return result;
      } catch (error) {return {complete: false, name: error.name};}
    }, {origin, id, representation, boundedJs, mode, ...overrides});
    const modes = ['complete', 'abort-after-complete', 'truncated', 'cancelled', 'network-error', 'invalid-json', 'invalid-utf8',
      'oversized', 'unbounded-oversized', 'wrong-response-type', 'headers-only',
      'foreign-id', 'foreign-origin', 'foreign-method', 'foreign-representation', 'foreign-query', 'devtools-reread-rejected'];
    for (const selected of modes) await t.test(selected, async () => {
      mode = selected;await page.goto(origin);
      const ticket = await observer.armReception(page, id), outcome = ticket.result.then(body => ({ok: true, ...body}), error => ({ok: false, code: error.code}));
      try {
        if (selected.startsWith('foreign-')) {
          const variants = {'foreign-id': {id: foreignId}, 'foreign-origin': {origin: foreignOrigin}, 'foreign-method': {method: 'POST'},
            'foreign-representation': {representation: 'application/json'}, 'foreign-query': {suffix: '?unrelated=1'}};
          assert.equal((await consume(variants[selected])).complete, true);
          let settled = false;void outcome.then(() => {settled = true;});await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 25)));
          assert.equal(settled, false, 'A foreign request must not claim the observation.');
        }
        const responsePromise = selected === 'devtools-reread-rejected' ? page.waitForResponse(r => r.url() === origin + '/api/intake/receptions/' + id) : null;
        let response, refusal;
        if (responsePromise) refusal = responsePromise.then(r => {
          response = r;
          // Directed refusal of only Playwright's secondary body retrieval. No browser fetch or application read is mocked.
          r.body = async () => {throw Error('INJECTED_SECONDARY_BODY_REFUSAL');};
        });
        const app = await consume();
        if (selected === 'headers-only') {
          let settled = false;void outcome.then(() => {settled = true;});await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 25)));
          assert.equal(settled, false);await ticket.dispose();
        }
        const observed = await outcome;
        const succeeds = ['complete', 'abort-after-complete', 'devtools-reread-rejected'].includes(selected) || selected.startsWith('foreign-');
        assert.equal(observed.ok, succeeds);
        if (succeeds) {
          assert.equal(app.complete, true);assert.equal(observed.status, 200);assert.deepEqual(observed.bytes, bytes);
          assert.deepEqual(observed.value, value);assert.deepEqual(Buffer.from(app.bytes), bytes);
          assert.equal(observed.request.url, origin + '/api/intake/receptions/' + id);assert.equal(observed.request.method, 'GET');
          if (refusal) {await refusal;await assert.rejects(() => response.json(), /INJECTED_SECONDARY_BODY_REFUSAL/);}
        } else assert.equal(observed.code, 'ERR_RESPONSE_BODY_REJECTED');
      } finally {await ticket.dispose();}
    });
    assert(requests.length >= modes.length);
    console.log(JSON.stringify({node: process.version, browser: browser.version(), scenarios: modes.length, scope: 'Actual native HTTP consumption; secondary DevTools refusal is an injected discriminator, not a historical cause.'}));
  } finally {
    await browser?.close();for (const timer of timers) clearTimeout(timer);server.closeAllConnections();await new Promise(resolve => server.close(resolve));
  }
});
