import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import next from 'next';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import { sessionTransport, sessionRequest, SESSION_COOKIE } from '../../src/contracts/access_transport.ts';
import { transportEnvelope, csrfMatches, corsHeaders, preflightHeaders, sessionToken, sessionSetCookie, tokenMatches } from '../../src/server/access/transport.ts';

const token = () => randomBytes(32).toString('base64url');
const ui = 'https://ui.inc02.test:8443';
const api = 'https://api.inc02.test:9443';
const config = sessionTransport({ profile: 'session/1', uiOrigin: ui, terminalOrigin: api });

test('isolated production Next / HTTPS terminal / real Chromium transport', { timeout: 120000 }, async (t) => {
  assert.equal(process.env.LEDGERDESK_ACCESS_CONTAINER, '1', 'Run through the owned Docker harness');
  assert.equal(process.platform, 'linux');
  assert.equal(homedir(), '/home/pwuser', 'Never alter host-machine certificate trust');
  const mutation = process.env.LEDGERDESK_ACCESS_MUTATION ?? '';
  assert.ok(['', 'drop-origin'].includes(mutation), 'Unknown transport mutation');
  let admit = transportEnvelope;
  if (mutation === 'drop-origin') {
    const url = new URL('../../src/server/access/transport.ts', import.meta.url);
    const source = readFileSync(url, 'utf8');
    const target = 'request.origin !== config.uiOrigin';
    assert.equal(source.split(target).length, 2, 'Exactly one mutation target');
    const compiled = ts.transpileModule(source.replace(target, 'false'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true,
    });
    assert.equal(compiled.diagnostics.length, 0);
    const js = compiled.outputText.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, specifier) => `from ${quote}${new URL(specifier, url).href}${quote}`);
    admit = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).transportEnvelope;
    t.diagnostic('Behavior mutation enabled: drop-origin; source files remain unchanged');
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'access-transport-'));
  const servers = [];
  let browser;
  let app;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      await app?.close();
      assert.ok(scratch.startsWith(path.join(tmpdir(), 'access-transport-')));
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  const run = (program, args) => execFileSync(program, args, { cwd: scratch, stdio: 'pipe', timeout: 15000 });
  const ca = (name) => run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', `${name}.key`, '-out', `${name}.crt`, '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE']);
  const leaf = (name, names, issuer) => {
    run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${names[0]}`]);
    writeFileSync(path.join(scratch, `${name}.ext`), `subjectAltName=${names.map((s) => `DNS:${s}`).join(',')}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`);
    run('openssl', ['x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.crt`, '-CAkey', `${issuer}.key`,
      '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`]);
    return { key: readFileSync(path.join(scratch, `${name}.key`)), cert: readFileSync(path.join(scratch, `${name}.crt`)) };
  };
  ca('trusted-test-root'); ca('untrusted-test-root');
  const tls = leaf('good', ['ui.inc02.test', 'api.inc02.test', 'evil.inc02.test', 'mail.mailbox.test'], 'trusted-test-root');
  const wrong = leaf('wrong', ['different.inc02.test'], 'trusted-test-root');
  const untrusted = leaf('untrusted', ['api.inc02.test'], 'untrusted-test-root');
  const nss = '/home/pwuser/.pki/nssdb';
  mkdirSync(nss, { recursive: true });
  run('certutil', ['-N', '--empty-password', '-d', `sql:${nss}`]);
  run('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'disposable-access-root', '-t', 'C,,', '-i', path.join(scratch, 'trusted-test-root.crt')]);
  let nextSessionLeaks = 0;
  let alienSessionLeaks = 0;
  let protectedEffects = 0;
  let invalidCertificateRequests = 0;
  let state = null;
  const received = [];
  const listen = async (port, certificates, handler) => {
    const server = https.createServer(certificates, handler);
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.on('tlsClientError', () => {});
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return server;
  };
  app = next({ dev: false, dir: path.resolve('tests/access/ui'), hostname: 'ui.inc02.test', port: 8443 });
  await app.prepare();
  const nextHandler = app.getRequestHandler();
  await listen(8443, tls, (req, res) => {
    if (sessionToken(req.headers.cookie)) nextSessionLeaks++;
    nextHandler(req, res);
  });
  await listen(9443, tls, (req, res) => {
    if (req.url === '/document') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<p>Cookie visibility probe</p>'); return; }
    const envelope = {
      method: req.method, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie,
      csrf: req.headers['x-ledgerdesk-csrf'], contentType: req.headers['content-type'],
      requestedMethod: req.headers['access-control-request-method'], requestedHeaders: req.headers['access-control-request-headers'],
    };
    received.push({ path: req.url, method: req.method, hasSession: sessionToken(req.headers.cookie) !== null, origin: req.headers.origin });
    if (!admit(config, envelope)) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return; }
    const headers = corsHeaders(config);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, preflightHeaders(config)); res.end(); return;
    }
    if (req.method === 'GET' && req.url === '/probe/challenge') {
      state = { phase: 'provisional', credential: token(), csrf: token() };
      res.writeHead(200, { ...headers, 'set-cookie': sessionSetCookie(state.credential, 60), 'content-type': 'application/json' });
      res.end(JSON.stringify({ csrf: state.csrf })); return;
    }
    const credential = sessionToken(req.headers.cookie);
    if (!state || !tokenMatches(credential, state.credential) || (req.url === '/probe/read' && state.phase !== 'session')) { res.writeHead(403, headers); res.end(); return; }
    if (req.method === 'GET' && req.url === '/probe/read' && state.phase === 'session') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end('{"synthetic":true}'); return;
    }
    if (req.method === 'POST' && !csrfMatches(envelope, state.csrf)) { res.writeHead(403, headers); res.end(); return; }
    if (req.method === 'POST' && req.url === '/probe/session' && state.phase === 'provisional') {
      state = { phase: 'session', credential: token(), csrf: token() };
      res.writeHead(200, { ...headers, 'set-cookie': sessionSetCookie(state.credential, 60), 'content-type': 'application/json' });
      res.end(JSON.stringify({ csrf: state.csrf })); return;
    }
    if (req.method === 'POST' && req.url === '/probe/effect' && state.phase === 'session') {
      protectedEffects++; res.writeHead(204, headers); res.end(); return;
    }
    res.writeHead(404, headers); res.end();
  });
  await listen(10443, tls, (req, res) => {
    if (sessionToken(req.headers.cookie)) alienSessionLeaks++;
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<p>Unrelated service</p><a id="activation" href="${ui}/?flow=activation">Activation</a><a id="recovery" href="${ui}/?flow=recovery">Recovery</a>`);
  });
  for (const [port, cert] of [[11443, wrong], [12443, untrusted]]) {
    await listen(port, cert, (_req, res) => { invalidCertificateRequests++; res.end('TLS must reject before HTTP'); });
  }
  browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.inc02.test 127.0.0.1, MAP mail.mailbox.test 127.0.0.1', '--no-proxy-server'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(10000);
  const fetchOn = (surface, route, options) => surface.evaluate(async ({ destination, options }) => {
    try { const response = await fetch(destination, options); return { status: response.status, body: await response.text() }; }
    catch { return { status: 'blocked' }; }
  }, { destination: `${api}${route}`, options });
  const request = (route, options) => fetchOn(page, route, options);
  // Same terminal and trust root, without a browser CORS implementation.
  const directRequest = ({ method, origin, headers = {} }) => new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port: 9443, servername: 'api.inc02.test',
      ca: readFileSync(path.join(scratch, 'trusted-test-root.crt')),
      agent: false, method, path: '/probe/effect', signal: AbortSignal.timeout(5000),
      headers: {
        host: 'api.inc02.test:9443', ...(origin === undefined ? {} : { origin }),
        ...(method === 'POST' ? { 'content-length': '2' } : {}), ...headers,
      },
    }, (res) => {
      res.once('error', reject);
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.once('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
  let csrf;
  let originalCredential;
  await t.test('B01: actual Next shell has no session or material', async () => {
    const response = await page.goto(ui);
    assert.equal(response.status(), 200);
    assert.match(await page.textContent('h1'), /Session transport fixture/);
    assert.equal((await response.text()).includes(SESSION_COOKIE), false);
  });
  await t.test('B02: provisional cookie is host-only, Secure, HttpOnly, Strict', async () => {
    const challenge = await request('/probe/challenge', sessionRequest('GET'));
    assert.equal(challenge.status, 200); csrf = JSON.parse(challenge.body).csrf;
    const cookies = (await context.cookies()).filter((c) => c.name === SESSION_COOKIE);
    assert.equal(cookies.length, 1);
    const cookie = cookies[0]; originalCredential = cookie.value;
    assert.deepEqual([cookie.domain, cookie.path, cookie.secure, cookie.httpOnly, cookie.sameSite], ['api.inc02.test', '/', true, true, 'Strict']);
    const terminalPage = await context.newPage(); await terminalPage.goto(`${api}/document`);
    assert.equal((await terminalPage.evaluate(() => document.cookie)).includes(SESSION_COOKIE), false);
    await terminalPage.close();
  });
  await t.test('B03: provisional/login-like CSRF is required before rotation', async () => {
    const before = received.length;
    assert.equal((await request('/probe/session', { ...sessionRequest('POST', csrf), headers: { 'content-type': 'application/json' } })).status, 'blocked');
    assert.equal(received.slice(before).some((r) => r.method === 'POST'), false, 'Rejected preflight never reaches the operation');
    assert.equal((await request('/probe/session', sessionRequest('POST', token()))).status, 403);
    assert.equal((await request('/probe/read', sessionRequest('GET'))).status, 403);
    const response = await request('/probe/session', sessionRequest('POST', csrf));
    assert.equal(response.status, 200); csrf = JSON.parse(response.body).csrf;
    assert.notEqual((await context.cookies()).find((c) => c.name === SESSION_COOKIE).value, originalCredential);
  });
  await t.test('B04: session-bearing fetch reaches terminal directly; omit mutation fails', async () => {
    const response = await request('/probe/read', sessionRequest('GET'));
    assert.equal(response.status, 200); assert.equal(response.body, '{"synthetic":true}');
    const missing = await request('/probe/read', { ...sessionRequest('GET'), credentials: 'omit' });
    assert.equal(missing.status, 403);
    assert.equal(received.at(-1).hasSession, false);
  });
  await t.test('B05: exact credentialed preflight and real effect; wrong CSRF does not act', async () => {
    const before = protectedEffects;
    assert.equal((await request('/probe/effect', sessionRequest('POST', token()))).status, 403);
    assert.equal(protectedEffects, before);
    assert.equal((await request('/probe/effect', sessionRequest('POST', csrf))).status, 204);
    assert.equal(protectedEffects, before + 1);
    assert.ok(received.some((r) => r.method === 'OPTIONS' && r.path === '/probe/effect'));
  });
  await t.test('B06: Next and unrelated same-site service never receive terminal cookie', async () => {
    await page.goto(`${ui}/?flow=activation`); await page.goto(`${ui}/?flow=recovery`);
    const other = await context.newPage(); await other.goto('https://evil.inc02.test:10443');
    const before = protectedEffects;
    assert.equal((await fetchOn(other, '/probe/effect', sessionRequest('POST', csrf))).status, 'blocked');
    assert.equal(protectedEffects, before); await other.close();
    assert.equal(nextSessionLeaks, 0); assert.equal(alienSessionLeaks, 0);
    assert.equal((await request('/probe/read', sessionRequest('GET'))).status, 200);
  });
  await t.test('B07: browser CORS blocks an opaque frame before a protected effect', async () => {
    const before = protectedEffects;
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.srcdoc = '<p>Opaque</p>'; document.body.appendChild(frame); });
    const frameElement = await page.waitForSelector('iframe');
    const frame = await frameElement.contentFrame(); await frame.waitForSelector('p');
    assert.equal((await fetchOn(frame, '/probe/effect', sessionRequest('POST', csrf))).status, 'blocked');
    assert.equal(protectedEffects, before);
  });
  await t.test('B08: untrusted root and wrong SAN are rejected by the real browser', async () => {
    const control = await context.newPage(); control.setDefaultNavigationTimeout(10000);
    await assert.rejects(control.goto('https://api.inc02.test:11443', { waitUntil: 'commit' }), /ERR_CERT_COMMON_NAME_INVALID/);
    t.diagnostic('Wrong SAN rejected before HTTP');
    await assert.rejects(control.goto('https://api.inc02.test:12443', { waitUntil: 'commit' }), /ERR_CERT_AUTHORITY_INVALID/);
    t.diagnostic('Untrusted CA rejected before HTTP');
    assert.equal(invalidCertificateRequests, 0);
  });
  await t.test('B09: no authority or credential enters SSR after establishing the session', async () => {
    const response = await page.goto(ui);
    const html = await response.text();
    for (const secret of [state.credential, state.csrf, originalCredential]) assert.equal(html.includes(secret), false);
    assert.equal(nextSessionLeaks, 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(protectedEffects, 1);
  });
  await t.test('B10: cross-site activation/recovery links return to the UI without leaking the cookie', async () => {
    for (const flow of ['activation', 'recovery']) {
      await page.goto('https://mail.mailbox.test:10443');
      await Promise.all([page.waitForURL(`${ui}/?flow=${flow}`), page.click(`#${flow}`)]);
      assert.equal((await request('/probe/read', sessionRequest('GET'))).status, 200);
    }
    assert.equal(nextSessionLeaks, 0); assert.equal(alienSessionLeaks, 0);
    assert.equal(protectedEffects, 1);
  });
  await t.test('B11: direct HTTPS proves server Origin admission with valid cookie and CSRF', async () => {
    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    assert.ok(cookie, 'Use the session already established by the browser');
    const headers = { cookie: `${SESSION_COOKIE}=${cookie.value}`, 'x-ledgerdesk-csrf': csrf, 'content-type': 'application/json' };
    const before = protectedEffects;
    assert.equal((await directRequest({ method: 'POST', origin: ui, headers })).status, 204, 'Positive control reaches the same terminal');
    assert.equal(protectedEffects, before + 1, 'Valid credentials and CSRF produce exactly one effect');
    for (const origin of ['https://evil.inc02.test:10443', 'null', undefined]) {
      const denied = await directRequest({ method: 'POST', origin, headers });
      assert.deepEqual({ status: denied.status, effects: protectedEffects }, { status: 403, effects: before + 1 },
        'Server Origin admission rejects the direct request without a protected effect');
    }
    assert.equal((await directRequest({ method: 'POST', origin: ui, headers })).status, 204, 'The same session remains valid after the denials');
    assert.equal(protectedEffects, before + 2);
  });
  await t.test('B12: actual preflight publishes only the shared bounded response', async () => {
    const before = protectedEffects;
    const response = await directRequest({ method: 'OPTIONS', origin: ui, headers: {
      'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-ledgerdesk-csrf, x-ledgerdesk-intent',
    } });
    assert.equal(response.status, 204);
    const expected = {
      'access-control-allow-origin': ui, 'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type, x-ledgerdesk-csrf, x-ledgerdesk-intent',
      'access-control-max-age': '60', 'cache-control': 'no-store', vary: 'Origin',
    };
    for (const [name, value] of Object.entries(expected)) assert.equal(response.headers[name], value, name);
    assert.equal(protectedEffects, before, 'Preflight itself never performs the effect');
  });
  t.diagnostic(`Node ${process.versions.node}; Chromium ${browser.version()}; production Next; isolated NSS trust; no host ports or volumes`);
});
