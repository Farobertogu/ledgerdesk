import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { Client } from 'pg';
import { startReadingTerminal } from '../../src/server/reading/terminal.ts';
import { PgReadingStore } from '../../src/server/reading/postgres/store.ts';
import { PROBLEMS } from '../../src/contracts/material_reading.ts';
import { createPgTrial } from './pg_trial.mjs';
import { trialContext, trialEnv, treatment, original, policy, seedTrial } from './T04_seed.mjs';
import { captureBuildIdentity, reserveLoopbackPort, startDatabaseTrap, assertNoTrialData } from './harness_guards.mjs';
import { startNextTrial } from './next_trial.mjs';
import { createObserverGates, cleanupSteps } from './lifecycle.mjs';
import { compareTiming, TIMING_PROTOCOL } from './timing_comparison.mjs';
import { observeBrowser } from './browser_diagnostics.mjs';

const detail = id => `/api/v1/material/${encodeURIComponent(id)}/versions/v1`;
const screenshotDir = new URL('../../test-results/reading-integration/', import.meta.url);
const prior = 'Earlier original\r\n  Not the current text.';
const inert = '<script>window.__materialExecuted=true</script>\n<img src="http://127.0.0.1:1/material-must-not-request">\n[link](https://example.invalid/private)';

test('T05 real browser, direct HTTP terminal and exclusive PostgreSQL', { timeout: 240000 }, async t => {
  const verifyBuild = await captureBuildIdentity(new URL('../../.next/BUILD_ID', import.meta.url));
  let stage = 'setup', browser, next, terminal, writer, admin, reservation;
  const gates = createObserverGates(); let observer = () => undefined;
  const trap = await startDatabaseTrap(() => ({ check: stage, activeServerPid: next?.pid ?? null }));
  // Every resource is covered before the next acquisition can fail.
  let trial;
  t.after(async () => {
    gates.releaseAll();
    await cleanupSteps([
      { label: 'browser close', close: () => browser?.close() },
      { label: 'owned Next close', close: () => next?.close() },
      { label: 'terminal close', close: () => terminal?.close() },
      { label: 'writer close', close: () => writer?.end(), timeoutMs: 5000 },
      { label: 'unused port reservation', close: () => reservation?.release() },
      { label: 'owned cluster removal', close: () => trial?.close(), timeoutMs: 90000 },
      { label: 'trap assertion', close: () => trap.assertUntouched() },
      { label: 'trap close', close: () => trap.close() },
      { label: 'final build identity', close: () => verifyBuild('T05 completion') },
    ]);
  });
  t.beforeEach(async child => { stage = child.name; await verifyBuild(stage); next?.assertAlive(); trap.assertUntouched(); });
  t.afterEach(() => { observer = () => undefined; gates.releaseAll(); });
  trial = await createPgTrial(); admin = trial.admin;
  writer = new Client(trial.writerConfig); await writer.connect(); await seedTrial(admin);
  reservation = await reserveLoopbackPort(); const uiOrigin = `http://127.0.0.1:${reservation.port}`;
  const terminalEnv = { ...trialEnv, LEDGERDESK_READING_UI_ORIGIN: uiOrigin };
  const createStore = onLoss => new PgReadingStore(trial.store, onLoss);
  let terminalPort;
  async function restartTerminal(env = terminalEnv) {
    await terminal?.close();
    terminal = await startReadingTerminal({ env, createStore, port: terminalPort,
      observer: (event, prepared) => observer(event, prepared) });
    terminalPort = Number(new URL(terminal.url).port);
  }
  await restartTerminal();
  const nextReservation = reservation; reservation = undefined;
  next = await startNextTrial({ reservation: nextReservation, verifyBuild, trap,
    env: { ...trialEnv, LEDGERDESK_READING_SERVICE_ORIGIN: terminal.url } });
  browser = await chromium.launch({ channel: process.env.READING_BROWSER_CHANNEL || undefined });
  t.diagnostic(JSON.stringify({ environment: 'local-synthetic', nextOrigin: next.url, nextPid: next.pid,
    terminalOrigin: terminal.url, postgresProject: trial.project, postgresVersion: trial.identity.version,
    node: process.version, browser: browser.version(), buildId: (await readFile(new URL('../../.next/BUILD_ID', import.meta.url), 'utf8')).trim() }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const diagnostic = observeBrowser(page, fileURLToPath(new URL('diagnostics/', screenshotDir)));
  t.after(() => diagnostic.close());
  const requests = []; const pageErrors = [];
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  page.on('pageerror', error => pageErrors.push(error.message));
  async function load() {
    await page.goto(next.url + '/material');
    await expect(page.getByRole('button', { name: 'Synthetic content content · v1', exact: true })).toBeVisible();
  }
  const button = (id) => page.getByRole('button', { name: `Synthetic ${id} ${id} · v1`, exact: true });
  async function read(id = 'content') {
    await button(id).click();
    if (id === 'content') await expect(page.getByTestId('original')).toHaveCount(1);
  }
  async function request(path, init = {}) {
    return page.evaluate(async ({ url, init }) => {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', ...init });
      const text = await response.text();
      return { status: response.status, headers: Object.fromEntries(response.headers), text, body: JSON.parse(text) };
    }, { url: terminal.url + path, init });
  }
  const update = (id, hierarchy) => writer.query('SELECT reading_trial.replace_policy($1,$2,$3)',
    [JSON.stringify(id), JSON.stringify('v1'), JSON.stringify(hierarchy)]);
  async function addVersion(id, version, text, metadata, hierarchy = policy('CONTENT')) {
    await admin.query(`INSERT INTO reading_trial.material
      (deployment_id,scope_id,unit_key,version_key,original_value,original_language,metadata,fragments,requirements)
      VALUES ('inc01-synthetic','inc01-material',$1,$2,$3,'en',$4,'[]',$5)`,
    [JSON.stringify(id), JSON.stringify(version), JSON.stringify(text), JSON.stringify(metadata),
      JSON.stringify({ REFERENCE: { metadata: ['title','editorial_state','reading_conditions'] },
        CONTENT: { metadata: ['title','editorial_state','reading_conditions'] } })]);
    await admin.query(`INSERT INTO reading_trial.policy VALUES ('inc01-synthetic','inc01-material',$1,$2,$3)`,
      [JSON.stringify(id), JSON.stringify(version), JSON.stringify(hierarchy)]);
  }

  await t.test('I01 direct browser reads persisted originals; HTML carries destination only', async () => {
    const html = await (await fetch(next.url + '/material')).text();
    assertNoTrialData(html, trialContext); assert.ok(html.includes(terminal.url));
    assert.ok(!html.includes('Synthetic content') && !html.includes('Exact original:'));
    await context.addCookies([{ name: 'ld_dev_user', value: 'forged-legacy-identity', url: uiOrigin }]);
    await load(); const outgoing = page.waitForRequest(terminal.url + detail('content')); await read();
    const outgoingHeaders = await (await outgoing).allHeaders();
    assert.equal(outgoingHeaders.cookie, undefined); assert.equal(outgoingHeaders.authorization, undefined);
    assert.equal(outgoingHeaders.origin, uiOrigin);
    assert.equal(await page.getByTestId('original').textContent(), original);
    const actual = await request(detail('content'));
    assert.equal(actual.status, 200); assert.equal(actual.body.projection.original_text, original);
    assert.equal(actual.headers['cache-control'], 'private, no-store');
    await terminal.idle();
    const rows = (await admin.query('SELECT subject_id, action, result_status FROM reading_trial.access_evidence')).rows;
    assert.ok(rows.some(row => row.action === 'exact' && row.result_status === 200));
    assert.ok(rows.every(row => row.subject_id === trialContext.subjectId));
    const materialRequests = requests.filter(row => new URL(row.url).pathname.startsWith('/api/v1/material'));
    assert.ok(materialRequests.length >= 3);
    assert.ok(materialRequests.every(row => row.url.startsWith(terminal.url + '/') && row.method === 'GET'));
    assert.equal(pageErrors.length, 0);
  });

  await t.test('I02 ES/EN, theme, keyboard and narrow view preserve the decoded original', async () => {
    await load(); await button('content').focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
    assert.equal(await page.getByTestId('original').textContent(), original);
    await page.getByLabel('Control language').selectOption('es');
    await expect(page.getByRole('heading', { name: 'Biblioteca de material' })).toBeVisible();
    assert.equal(await page.getByTestId('original').textContent(), original);
    await page.getByLabel('Cambiar tema de color').click();
    await expect(page.locator('main')).toHaveAttribute('data-theme', 'light');
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('desktop.png', screenshotDir)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByTestId('original').textContent(), original);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: fileURLToPath(new URL('mobile.png', screenshotDir)), fullPage: true });
    await page.getByRole('button', { name: 'Volver a la lista' }).click();
    await expect(button('content')).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await t.test('I03 reference and complete excerpts contain no hidden original or successor', async () => diagnostic.run('I03', async () => {
    diagnostic.mark('load-and-reference');
    await load(); await read('reference');
    await expect(page.getByText('Reference only. No original text was returned.')).toBeVisible();
    assert.equal(await page.getByTestId('original').count(), 0);
    const ref = await request(detail('reference'));
    assert.equal(ref.body.projection.kind, 'REFERENCE');
    assert.equal('original_text' in ref.body.projection, false);
    diagnostic.mark('select-complete-excerpt');
    await read('excerpt'); await expect(page.getByTestId('original')).toHaveCount(2);
    assert.deepEqual(await page.getByTestId('original').allTextContents(), ['Regla.', 'Excepto los domingos.']);
    const restricted = policy('EXCERPT'); restricted.unit.forEach(row => { row.grant.fragmentIds = ['rule']; });
    try {
      diagnostic.mark('restrict-excerpt');
      await update('excerpt', restricted); await load(); await read('excerpt');
      await expect(page.getByText('Reference only. No original text was returned.')).toBeVisible();
      assert.equal(await page.getByTestId('original').count(), 0);
    } finally { await update('excerpt', policy('EXCERPT')); }
  }));

  await t.test('I04 list is complete and unaffected by NONE or local indeterminacy; existence is unidentifiable', async () => {
    await load(); const before = await request('/api/v1/material');
    assert.deepEqual(before.body.items.map(item => item.reference.unit_id), ['content', 'excerpt', 'reference']);
    assert.equal(before.body.existence_signal, true);
    assert.ok(!before.text.includes('hidden') && !before.text.includes('unknown'));
    await addVersion('hidden-added', 'v1', 'Never readable', {
      title: 'Hidden added', editorial_state: 'PUBLISHED', reading_conditions: ['Hidden condition'],
    }, policy('NONE'));
    await update('unknown', { unit: [], inherited: [], general: [] });
    try {
      const after = await request('/api/v1/material'); assert.deepEqual(after, before);
      await update('hidden-added', policy('EXISTENCE'));
      assert.deepEqual(await request('/api/v1/material'), before, 'multiple existences cannot reveal their number');
      await page.getByRole('searchbox').fill('hidden');
      await expect(page.getByText('No received references match this filter.')).toBeVisible();
    } finally { await update('hidden-added', policy('NONE')); }
  });

  await t.test('I05 exact historical pair is not redirected; current metadata cannot leak hidden successor', async () => {
    await addVersion('content', 'v0', prior, { title: 'Prior content', editorial_state: 'SUPERSEDED',
      reading_conditions: ['Historical inspection only; do not apply as current policy.'], successor: 'hidden-added' });
    await load(); const reached = gates.deferred(), resume = gates.deferred();
    observer = async (event, prepared) => {
      if (event === 'committed' && prepared?.response.projection?.reference.version_id === 'v0') {
        reached.resolve(); await resume.promise;
      }
    };
    await page.getByRole('button', { name: 'Prior content content · v0', exact: true }).click(); await reached.promise;
    // Seed a distinct immutable version while the old response is held. This is fixture
    // administration, not a production publication path or a policy invalidator.
    await addVersion('content', 'v2', 'Newer content must not replace the selected version.', {
      title: 'Newer content', editorial_state: 'PUBLISHED', reading_conditions: ['New synthetic version.'],
    });
    resume.resolve();
    await expect(page.getByTestId('original')).toHaveCount(1);
    assert.equal(await page.getByTestId('original').textContent(), prior);
    await expect(page.getByText('Historical inspection only; do not apply as current policy.')).toBeVisible();
    const old = await request('/api/v1/material/content/versions/v0');
    assert.equal(old.body.projection.metadata.editorial_state, 'SUPERSEDED'); assert.ok(!old.text.includes('successor'));
    assert.equal((await request(detail('content'))).body.projection.original_text, original);
    assert.deepEqual((await request('/api/v1/material/reference/versions/v0')).body, PROBLEMS[404]);
  });

  await t.test('I06 invalid public input and all neutral refusal classes retain closed HTTP shape through CORS', async () => {
    for (const path of ['/api/v1/material?subject=forged', '/api/v1/material/content/versiones/v1',
      '/api/v1/material/%ZZ/versions/v1']) assert.deepEqual((await request(path)).body, PROBLEMS[400]);
    const expected = await request(detail('absent'));
    assert.equal(expected.status, 404); assert.deepEqual(expected.body, PROBLEMS[404]);
    for (const id of ['hidden', 'unknown', 'existence']) assert.deepEqual(await request(detail(id)), expected);
    assert.equal(expected.headers.etag, undefined); assert.equal(expected.headers.location, undefined);
    const conditional = await request(detail('content'), { cache: 'no-store' });
    assert.equal(conditional.status, 200); assert.equal(conditional.headers.etag, undefined);
    const rawConditional = await fetch(terminal.url + detail('content'), { headers: { origin: uiOrigin, 'if-none-match': 'invented' } });
    assert.equal(rawConditional.status, 200); assert.equal(rawConditional.headers.get('etag'), null);
    assert.equal((await rawConditional.json()).projection.original_text, original);
  });

  await t.test('I07 repeated browser timing experiment covers the four neutral classes', async child => {
    const groups = await page.evaluate(async ({ base, protocol }) => {
      const ids = ['absent', 'hidden', 'unknown', 'existence']; const groups = Object.fromEntries(ids.map(id => [id, []]));
      for (let round = -protocol.warmupRounds; round < protocol.rounds; round++) {
        for (let position = 0; position < ids.length; position++) {
          const id = ids[((round % ids.length) + ids.length + position) % ids.length];
          const started = performance.now();
          const response = await fetch(`${base}/api/v1/material/${id}/versions/v1`, { credentials: 'omit', cache: 'no-store' });
          const body = await response.json(); const elapsed = performance.now() - started;
          if (response.status !== 404 || body.code !== 'UNAVAILABLE') throw new Error('Non-neutral browser response');
          if (round >= 0) groups[id].push(elapsed);
        }
      }
      return groups;
    }, { base: terminal.url, protocol: TIMING_PROTOCOL });
    const result = compareTiming(groups); child.diagnostic(JSON.stringify(result));
    assert.equal(result.signalDetected, false, 'Exploratory browser timing signal requires investigation, not threshold adjustment');
  });

  await t.test('I08 committed evidence is visible before the browser receives any material bytes', async () => {
    await load(); const reached = gates.deferred(), resume = gates.deferred(); let receipt;
    observer = async (event, prepared) => {
      if (event === 'committed' && prepared?.response.projection?.reference.unit_id === 'content') {
        receipt = prepared.receiptId; reached.resolve(); await resume.promise;
      }
    };
    await button('content').click(); await reached.promise;
    assert.equal(await page.getByTestId('original').count(), 0);
    assert.equal((await admin.query('SELECT result_status FROM reading_trial.access_evidence WHERE receipt_id=$1', [receipt])).rows[0].result_status, 200);
    assert.equal((await admin.query('SELECT count(*)::int n FROM reading_trial.transport_observation WHERE receipt_id=$1', [receipt])).rows[0].n, 0);
    const sql = (await admin.query("SELECT state,xact_start FROM pg_stat_activity WHERE application_name='inc01-reading-terminal'")).rows[0];
    assert.equal(sql.state, 'idle'); assert.equal(sql.xact_start, null);
    resume.resolve(); await expect(page.getByTestId('original')).toHaveCount(1);
    assert.equal(await page.getByTestId('original').textContent(), original); await terminal.idle();
    assert.equal((await admin.query('SELECT outcome FROM reading_trial.transport_observation WHERE receipt_id=$1', [receipt])).rows[0].outcome, 'finished');
  });

  await t.test('I09 committed revocation removes a selected reference and never reuses its old body', async () => {
    await load(); await read();
    await update('content', policy('NONE'));
    try {
      await button('content').click(); await expect(page.locator('main').getByRole('alert')).toContainText('Material is unavailable.');
      assert.equal(await page.getByTestId('original').count(), 0);
      await page.getByRole('button', { name: 'Retry reading' }).click();
      await expect(button('reference')).toBeVisible(); assert.equal(await button('content').count(), 0);
    } finally { await update('content', policy('CONTENT')); }
  });

  await t.test('I10 a real remote writer cannot overtake the admitted browser transfer', async () => {
    await load(); const reached = gates.deferred(), resume = gates.deferred(); const order = [];
    observer = async (event, prepared) => {
      if (prepared?.response.projection?.reference.unit_id !== 'content') return;
      if (event === 'committed') { reached.resolve(); await resume.promise; }
      if (event === 'finished') order.push('finished');
    };
    await button('content').click(); await reached.promise;
    const revoked = update('content', policy('NONE')).then(() => order.push('revoked'));
    try {
      await expect.poll(async () => (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='inc01_writer' AND wait_event_type='Lock'")).rows[0].n).toBeGreaterThan(0);
      assert.equal(await page.getByTestId('original').count(), 0); assert.deepEqual(order, []);
      resume.resolve(); await expect(page.getByTestId('original')).toHaveCount(1);
      assert.equal(await page.getByTestId('original').textContent(), original);
      await terminal.idle(); await revoked; assert.deepEqual(order, ['finished', 'revoked']);
      assert.equal((await request(detail('content'))).status, 404);
    } finally { resume.resolve(); await revoked; await update('content', policy('CONTENT')); }
  });

  await t.test('I11 failed evidence INSERT blocks the browser without fallback or synthetic success', async () => {
    await load(); await admin.query('REVOKE INSERT ON reading_trial.access_evidence FROM inc01_reader');
    try {
      await button('content').click(); await expect(page.locator('main').getByRole('alert')).toContainText('The reading service could not complete this request.');
      assert.equal(await page.getByTestId('original').count(), 0);
      assert.equal((await request(detail('absent'))).status, 503);
    } finally { await admin.query('GRANT INSERT ON reading_trial.access_evidence TO inc01_reader'); }
    await page.getByRole('button', { name: 'Retry reading' }).click(); await expect(button('content')).toBeVisible();
  });

  await t.test('I12 another server-owned subject sees no cached material; no context stays 403', async () => {
    await load(); await read();
    try {
      await restartTerminal({ ...terminalEnv, LEDGERDESK_READING_SUBJECT: 'synthetic-other-reader' });
      await page.reload(); await expect(page.getByText('No readable references were returned.')).toBeVisible();
      assert.equal(await page.getByTestId('original').count(), 0);
      assert.equal((await request(detail('content'))).status, 404);
      await restartTerminal({ LEDGERDESK_READING_UI_ORIGIN: uiOrigin });
      await page.reload(); await expect(page.locator('main').getByRole('alert')).toContainText('Reading access is unavailable.');
      assert.equal((await request(detail('content'))).status, 403);
    } finally { await restartTerminal(); }
  });

  await t.test('I13 material text cannot create scripts, links, images or outbound requests', async () => {
    await addVersion('inert', 'v1', inert, { title: 'Synthetic inert', editorial_state: 'PUBLISHED', reading_conditions: ['Inert original.'] });
    await load(); const start = requests.length; await read('inert');
    await expect(page.getByTestId('original')).toHaveCount(1);
    assert.equal(await page.getByTestId('original').textContent(), inert);
    assert.equal(await page.evaluate(() => window.__materialExecuted), undefined);
    assert.equal(await page.locator('article img, article script, article a').count(), 0);
    assert.ok(!requests.slice(start).some(row => row.url.includes('material-must-not-request') || row.url.includes('example.invalid')));
  });

  await t.test('I14 late processing of an actual A response cannot replace selected B', async () => {
    await load();
    // Delay only delivery of the real fetched Response to Reader; no response or body is fabricated.
    await page.evaluate(() => {
      const actualFetch = window.fetch.bind(window);
      window.__releaseActualResponse = null; window.__actualResponseWaiting = false;
      window.__restoreActualFetch = () => { window.fetch = actualFetch; };
      window.fetch = async (input, init) => {
        const delayed = String(input).endsWith('/content/versions/v1');
        // Model a transport that does not obey cancellation; the sequence guard must still win.
        const response = await actualFetch(input, delayed ? { ...init, signal: undefined } : init);
        if (delayed) {
          // Consume the actual network body before the second selection aborts A's transport.
          await response.clone().arrayBuffer();
          window.__actualResponseWaiting = true;
          await new Promise(resolve => { window.__releaseActualResponse = resolve; });
        }
        return response;
      };
    });
    try {
      await button('content').click(); await page.waitForFunction(() => window.__actualResponseWaiting);
      await read('reference'); await expect(page.getByText('Reference only. No original text was returned.')).toBeVisible();
      await page.evaluate(async () => {
        window.__releaseActualResponse();
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      });
      await expect(page.getByRole('heading', { level: 2 })).toHaveText('Synthetic reference');
      assert.equal(await page.getByTestId('original').count(), 0);
    } finally { await page.evaluate(() => { window.__releaseActualResponse?.(); window.__restoreActualFetch(); }); }
  });

  await t.test('I15 writer-free expiry is measured after the last check, never claimed fully conformant', async child => {
    await load(); let deadline, handedOffAt;
    await update('content', policy('CONTENT', Date.now() + 700));
    observer = (event, prepared) => {
      if (prepared?.response.projection?.reference.unit_id !== 'content') return;
      if (event === 'after-clock' && prepared.earliestExpiry) {
        deadline = prepared.earliestExpiry;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, deadline - Date.now() + 30));
      }
      if (event === 'handoff') handedOffAt = Date.now();
    };
    const result = await request(detail('content')); assert.ok(deadline && handedOffAt >= deadline);
    child.diagnostic(JSON.stringify({ experiment: 'browser-writer-free-expiry', status: result.status,
      materialReceivedAfterDeadline: result.body.projection?.original_text === original, fullTemporalConformity: false }));
    assert.ok([200, 503].includes(result.status));
    assert.equal((await request(detail('content'))).status, 404);
    await update('content', policy('CONTENT'));
  });

  await t.test('I16 SQL loss is a technical failure; service and PG restart preserve exact historical reads', async () => {
    await load(); await read(); await terminal.idle();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='inc01-reading-terminal'");
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('main').getByRole('alert')).toContainText('The reading service could not complete this request.');
    assert.equal(await page.getByTestId('original').count(), 0);
    const receipts = (await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n;
    await terminal.close(); terminal = undefined; await writer.end(); writer = undefined;
    admin = await trial.restart(); writer = new Client(trial.writerConfig); await writer.connect();
    await restartTerminal(); await load(); await read();
    assert.equal(await page.getByTestId('original').textContent(), original);
    assert.equal((await request('/api/v1/material/content/versions/v0')).body.projection.original_text, prior);
    assert.ok((await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n > receipts);
  });

  await t.test('I17 Next endpoints stay closed; unconfigured UI destinations do not fall back', async () => {
    for (const path of ['/api/v1/material', detail('content')]) {
      const response = await page.request.get(next.url + path);
      assert.equal(response.status(), 503); assert.deepEqual(await response.json(), PROBLEMS[503]);
    }
    await next.close(); next = undefined;
    const rejectedReservation = await reserveLoopbackPort();
    next = await startNextTrial({ reservation: rejectedReservation, verifyBuild, trap,
      env: { ...trialEnv, LEDGERDESK_READING_SERVICE_ORIGIN: terminal.url } });
    await terminal.idle();
    const before = (await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n;
    const denied = page.waitForEvent('requestfailed', { predicate: row => row.url() === terminal.url + '/api/v1/material' });
    await page.goto(next.url + '/material');
    assert.ok((await denied).failure(), 'The browser must not receive a readable CORS response');
    const wire = await fetch(terminal.url + '/api/v1/material', { headers: { origin: next.url } });
    assert.equal(wire.status, 403); assert.equal(wire.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await wire.json(), PROBLEMS[403]);
    await expect(page.locator('main').getByRole('alert')).toContainText('The reading service could not complete this request.');
    assert.equal(await page.getByTestId('original').count(), 0);
    const opaque = await page.evaluate(base => new Promise((resolve, reject) => {
      const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
      const timer = setTimeout(() => { frame.remove(); reject(new Error('Opaque-origin response timed out')); }, 5000);
      const receive = event => {
        if (event.source !== frame.contentWindow) return;
        clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(event.data);
      };
      window.addEventListener('message', receive);
      frame.srcdoc = `<script>fetch(${JSON.stringify(base + '/api/v1/material')}, {credentials:'omit'})
        .then(() => parent.postMessage('unexpected-readable','*'))
        .catch(() => parent.postMessage('blocked','*'))<\/script>`;
      document.body.append(frame);
    }), terminal.url);
    assert.equal(opaque, 'blocked'); await terminal.idle();
    assert.equal((await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n, before);
    await next.close(); next = undefined;
    for (const value of ['', 'http://example.invalid:3002']) {
      const reserved = await reserveLoopbackPort();
      next = await startNextTrial({ reservation: reserved, verifyBuild, trap,
        env: { ...trialEnv, LEDGERDESK_READING_SERVICE_ORIGIN: value } });
      const start = requests.length; await page.goto(next.url + '/material');
      await expect(page.getByText('Reading service origin is not configured safely.')).toBeVisible();
      assert.equal(await page.getByRole('button', { name: /Synthetic/ }).count(), 0);
      assert.ok(!requests.slice(start).some(row => row.url.includes('/api/v1/material')));
      await next.close(); next = undefined;
    }
    assert.equal(pageErrors.length, 0); trap.assertUntouched();
  });
});
