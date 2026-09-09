// Real Next build/start HTTP checks; no PostgreSQL, provider or external network.
// Run after next build. All child processes bind loopback and are terminated by this harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readTrialConfig } from '../../src/server/reading/config.mjs';
import { assertNoTrialData, captureBuildIdentity, reserveLoopbackPort, startDatabaseTrap } from './harness_guards.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const verifyBuild = await captureBuildIdentity(new URL('../../.next/BUILD_ID', import.meta.url));
let currentCheck = 'harness startup';
let activeServerPid = null;
const trap = await startDatabaseTrap(() => ({ check: currentCheck, activeServerPid }));
const trapPort = trap.port;
const enabled = {
  LEDGERDESK_READING_TRIAL: '1', LEDGERDESK_READING_ENVIRONMENT: 'local-synthetic',
  LEDGERDESK_READING_SUBJECT: 'synthetic-http-harness-33bf5297fca145e0',
  LEDGERDESK_READING_GENERATION: 'http-harness-generation-33bf5297fca145e0',
};
let checks = 0;

async function withNext(configuration, run, shouldStart = true) {
  currentCheck = shouldStart ? 'server launch' : 'invalid configuration launch';
  await verifyBuild(currentCheck);
  const reservation = await reserveLoopbackPort();
  const port = reservation.port;
  await reservation.release();
  // The reservation must be released for Next to bind. A competing bind after release
  // must make this exact-port child fail; readiness is read from this child, never HTTP.
  const child = spawn(process.execPath, ['ci/reading_start.mjs', String(port)], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      LEDGERDESK_READING_TRIAL: '0', LEDGERDESK_READING_ENVIRONMENT: '',
      LEDGERDESK_READING_SUBJECT: '', LEDGERDESK_READING_GENERATION: '',
      LEDGERDESK_DEV_IDENTITY: '0',
      LEDGERDESK_READING_SERVICE_ORIGIN: `http://127.0.0.1:${port}`,
      // Overrides .env files. A legacy DB query hits a counter, never an existing database.
      DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:${trapPort}/never_connect`,
      ...configuration,
    },
  });
  activeServerPid = child.pid;
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && child.exitCode === null && !output.includes('Ready in')) await delay(40);
    if (!shouldStart) {
      assert.ok(!output.includes('Ready in'), 'incompatible trial became ready');
      assert.notEqual(child.exitCode, null, 'incompatible startup did not exit');
      assert.notEqual(child.exitCode, 0);
      assert.match(output, /Invalid isolated reading trial configuration/);
      checks++;
      return;
    }
    assert.ok(output.includes('Ready in') && child.exitCode === null && !output.includes('EADDRINUSE'),
      `Owned Next child failed to bind its port: ${output.slice(-1500)}`);
    await verifyBuild('server ready');
    await run(`http://127.0.0.1:${port}`);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    activeServerPid = null;
    await verifyBuild('after server exit');
  }
}

async function expectProblem(base, path, status, headers = {}) {
  currentCheck = `GET ${path}; expected ${status}; ${Object.keys(headers).length ? 'forged headers' : 'baseline'}`;
  await verifyBuild(currentCheck);
  const response = await fetch(base + path, { headers, redirect: 'manual' });
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('location'), null);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'status', 'title', 'type']);
  assert.equal(body.status, status);
  checks++;
  return { body, headers: Object.fromEntries(response.headers) };
}

try {
  await withNext({ LEDGERDESK_DEV_IDENTITY: '1' }, async base => {
    const malicious = { cookie: 'ld_dev_user=11111111-1111-4111-8111-111111111111',
      'x-subject': 'synthetic-reader-a', 'x-role': 'supervisor', authorization: 'Bearer invented' };
    const absent = await expectProblem(base, '/api/v1/material', 403);
    const forged = await expectProblem(base, '/api/v1/material/hidden/versions/v1', 403, malicious);
    assert.deepEqual(absent.body, forged.body);
    await expectProblem(base, '/api/v1/material?subject=synthetic-reader-a', 400);
    await expectProblem(base, '/api/v1/material/u/versions/v?role=owner', 400);
    await expectProblem(base, '/api/v1/material/%ZZ/versions/v', 400);
    currentCheck = 'disabled material page with forged identity';
    const page = await fetch(base + '/material', { headers: malicious });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Trial is disabled/);
    assert.doesNotMatch(html, /Choose a session|Customer portal|Acting as|11111111-1111/);
    checks++;
    trap.assertUntouched();
  });
  await withNext(enabled, async base => {
    const malicious = {
      cookie: 'ld_dev_user=11111111-1111-4111-8111-111111111111',
      authorization: 'Bearer invented', 'x-subject': 'synthetic-other', 'x-role': 'owner',
    };
    for (const path of ['/api/v1/material', '/api/v1/material/u/versions/v']) {
      const baseline = await expectProblem(base, path, 503);
      const forged = await expectProblem(base, path, 503, malicious);
      assert.deepEqual(forged.body, baseline.body);
      for (const header of ['cache-control', 'content-type', 'etag', 'location']) {
        assert.equal(forged.headers[header], baseline.headers[header]);
      }
    }
    currentCheck = 'HEAD material';
    const head = await fetch(base + '/api/v1/material', { method: 'HEAD' });
    assert.equal(head.status, 400);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('cache-control'), 'private, no-store');
    checks++;
    // Fetch refuses this framing header; use an ordinary, complete chunked HTTP request.
    currentCheck = 'GET material with chunked framing';
    const transfer = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(base + '/api/v1/material', {
        method: 'GET', headers: { 'Transfer-Encoding': 'chunked' }, agent: false,
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => resolve({
          status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      outgoing.setTimeout(4000, () => outgoing.destroy(new Error('Local framing check timed out')));
      outgoing.once('error', reject);
      outgoing.end();
    });
    assert.equal(transfer.status, 400);
    assert.equal(transfer.headers['cache-control'], 'private, no-store');
    assert.deepEqual(JSON.parse(transfer.body), {
      type: 'about:blank', title: 'Invalid request', status: 400, code: 'REQUEST_NOT_ADMITTED',
    });
    checks++;
    await expectProblem(base, '/api/v1/material/u/versiones/v', 400);
    currentCheck = 'enabled material page without serialized trial context';
    const page = await fetch(base + '/material');
    const html = await page.text();
    assert.match(html, /Material library/);
    assertNoTrialData(html, readTrialConfig(enabled));
    checks++;
    // URLs retained, legacy identity disabled. No DB: this verifies the unauthenticated shells,
    // not the five authenticated SQL readers (those belong to the isolated T04 suite).
    for (const path of ['/', '/session', '/portal', '/queue', '/supervisor', '/promotion', '/tickets/11111111-1111-4111-8111-111111111111']) {
      currentCheck = `retained legacy page ${path}`;
      await verifyBuild(currentCheck);
      const response = await fetch(base + path, { redirect: 'manual' });
      assert.equal(response.status, 200, `legacy URL changed: ${path}`);
      assert.match(await response.text(), /Customer portal/);
      checks++;
    }
  });
  await withNext({ ...enabled, LEDGERDESK_READING_ENVIRONMENT: 'not-a-trial' }, null, false);
  await verifyBuild('harness completion');
  trap.assertUntouched();
  console.log(`T01 real Next HTTP: ${checks} checks passed; legacy DB connections: ${trap.count()}; build identity unchanged.`);
  console.log('No successful material response, DB persistence, authorization policy, UI viewer or temporal guarantee is claimed.');
} finally {
  await trap.close();
}
