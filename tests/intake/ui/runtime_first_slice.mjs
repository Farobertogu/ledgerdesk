import assert from 'node:assert/strict';
import https from 'node:https';
import path from 'node:path';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import next from 'next';
import {chromium} from 'playwright';
import {preparationControl} from '../preparation/runtime_control.mjs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {uiOrigin, apiOrigin} from '../../access/journey_environment.mjs';
import {observeBrowser} from '../../reading/browser_diagnostics.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function workspaceFirstSlice(t, {env, intake, client, request, diagnostics, storage, login, post, master, setBarrier, digestSession}) {
  const receptionOnly = process.env.LEDGERDESK_PREPARATION_CASES === 'ui-reception';
  const preparationOnly = process.env.LEDGERDESK_PREPARATION_CASES === 'ui-preparation';
  const controlled = await preparationControl(env, {allFormats: receptionOnly || preparationOnly});
  const original = Buffer.from('AZ-17\nFor procedure AZ-17, receipt Q is required.\nUnder condition Z, receipt R replaces receipt Q.\n', 'utf8');
  const reference = {name: 'first-real-intake.txt', bytes: original.length, sha256: hash(original), text: original.toString('utf8')};
  writeFileSync('/work/output/workspace-reference.json', JSON.stringify(reference, null, 2), {flag: 'wx'});
  const observations = [], errors = [], requests = [];
  let app, server, browser, context, page, receipt, result, lost;
  const beforeEnvironment = Object.fromEntries(['LEDGERDESK_ACCESS_TRIAL', 'LEDGERDESK_ACCESS_UI_ORIGIN', 'LEDGERDESK_ACCESS_API_ORIGIN'].map(k => [k, process.env[k]]));
  Object.assign(process.env, {LEDGERDESK_ACCESS_TRIAL: 'synthetic', LEDGERDESK_ACCESS_UI_ORIGIN: uiOrigin, LEDGERDESK_ACCESS_API_ORIGIN: apiOrigin});
  try {
    app = next({dev: false, dir: path.resolve('tests/access/final-ui'), hostname: 'ui.inc02.test', port: 8443});
    await app.prepare();
    const handler = app.getRequestHandler(); let leakedCookies = 0;
    server = https.createServer(env.tls, (req, res) => {if (req.headers.cookie?.includes('__Host-ledgerdesk')) leakedCookies++; return handler(req, res);});
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(8443, '127.0.0.1', resolve);});
    browser = await chromium.launch({headless: true, args: ['--host-resolver-rules=MAP *.inc02.test 127.0.0.1', '--no-proxy-server']});
    context = await browser.newContext({viewport: {width: 1200, height: 900}});
    const separator = client.cookie.indexOf('=');
    await context.addCookies([{name: client.cookie.slice(0, separator), value: client.cookie.slice(separator + 1),
      url: apiOrigin, secure: true, httpOnly: true, sameSite: 'Strict'}]);
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => {const url = new URL(req.url()); if (url.origin === apiOrigin) requests.push({method: req.method(), path: url.pathname});});
    const observer = observeBrowser(page, '/work/output/browser-diagnostics');
    await t.test('W01 identified real Next route receives an original through HTTPS and durable storage', async () => {
      await observer.run('W01', async () => {
        const response = await page.goto(uiOrigin + '/access/intake');
        assert.equal(response.status(), 200);
        const html = await response.text();
        for (const protectedValue of [reference.text, client.csrf, controlled.account.id, client.cookie]) assert.equal(html.includes(protectedValue), false);
        await page.getByRole('button', {name: 'Choose files', exact: true}).and(page.locator('button')).waitFor();
        await page.getByLabel('Choose files', {exact: true}).setInputFiles({name: reference.name, mimeType: 'text/plain', buffer: original});
        const card = page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]').filter({hasText: reference.name});
        await card.getByRole('button', {name: 'Receive', exact: true}).click();
        await card.getByText('Original received. Extraction and preparation are separate stages.', {exact: true}).waitFor();
        const row = (await env.admin.query(`SELECT r.id AS reception_id,rcp.*,w.id AS job_id FROM intake_trial.reception r
          JOIN intake_trial.receipt rcp ON rcp.reception_id=r.id JOIN intake_trial.work w ON w.receipt_id=rcp.id
          WHERE r.declaration->>'name'=$1`, [reference.name])).rows;
        assert.equal(row.length, 1); receipt = row[0];
        assert.deepEqual({bytes: receipt.bytes, sha256: receipt.sha256}, {bytes: reference.bytes, sha256: reference.sha256});
        assert.equal(leakedCookies, 0); assert.deepEqual(errors, []);
        const delivered = await request('/api/intake/receptions/' + receipt.reception_id + '/original', {client});
        assert.equal(delivered.status, 200); assert.deepEqual(delivered.bytes, original);
        const composition = JSON.parse(readFileSync('tests/access/final-ui/composition.json', 'utf8'));
        assert.ok(composition.files.some(f => f.file === 'src/app/access/intake/page.tsx'));
        assert.ok(composition.files.some(f => f.file === 'src/components/intake/views/IntakeView.tsx'));
        observations.push({case: 'W01', receipt: receipt.id, original: {bytes: receipt.bytes, sha256: receipt.sha256}, composition: composition.sourceSha256});
        await page.screenshot({path: '/work/output/workspace-received.png', fullPage: true});
      });
    });
    if (!receipt) throw Error('WORKSPACE_RECEIPT_PREREQUISITE');
    if (process.env.LEDGERDESK_PREPARATION_CASES === 'ui-adoption-reception') {
      const {workspaceAdoptionReception} = await import('./runtime_adoption_reception.mjs');
      await workspaceAdoptionReception(t, {env, intake, client, page, context, observer, receipt, original, observations, requests, login});
      return;
    }
    if (['ui-adoption-preparation', 'ui-disclosure-navigation'].includes(process.env.LEDGERDESK_PREPARATION_CASES)) {
      const {workspaceAdoptionPreparation} = await import('./runtime_adoption_preparation.mjs');
      await workspaceAdoptionPreparation(t, {env, intake, client, request, page, context, observer, receipt, controlled, observations, requests, login});
      return;
    }
    if (process.env.LEDGERDESK_PREPARATION_CASES === 'ui-resources') {
      const {workspaceResources} = await import('./runtime_resources.mjs');
      await workspaceResources(t, {env, intake, client, request, controlled, page, context, observer, observations, storage, login});
      return;
    }
    if (process.env.LEDGERDESK_PREPARATION_CASES === 'ui-protection') {
      const {workspaceProtection} = await import('./runtime_protection.mjs');
      await workspaceProtection(t, {env, intake, client, request, controlled, page, context, observer,
        receipt, original, observations, requests, errors, storage, login, post, master, setBarrier, digestSession});
      return;
    }
    if (preparationOnly) {
      const {workspacePreparation} = await import('./runtime_preparation.mjs');
      await workspacePreparation(t, {env, intake, client, request, controlled, page, context, observer,
        reference, receipt, original, observations, requests, errors});
      return;
    }
    if (receptionOnly) {
      const {workspaceReception} = await import('./runtime_reception.mjs');
      await workspaceReception(t, {env, intake, client, request, controlled, page, context, observer,
        reference, receipt, original, observations, requests, errors});
      return;
    }
    const extractor = new ExtractionService(intake);
    await extractor.dispatch(receipt.job_id); await extractor.accept(receipt.job_id);
    await t.test('W02 accepted real extraction offers explicit human preparation without default classification', async () => {
      const offered = await request('/api/intake/extractions/' + receipt.job_id, {client,
        headers: {accept: 'application/vnd.ledgerdesk.intake-workspace+json'}});
      assert.deepEqual({status: offered.status, offers: offered.body.offers}, {status: 200, offers: ['prepare']});
      const card = page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]').filter({hasText: reference.name});
      await card.getByRole('button', {name: 'Refresh', exact: true}).click();
      await card.getByRole('button', {name: 'Prepare', exact: true}).click();
      await page.getByRole('heading', {name: 'Human preparation', exact: true}).waitFor();
      const editor = page.getByRole('region', {name: 'Human preparation', exact: true});
      for (const name of ['Function', 'Basis', 'Scope of use']) assert.equal(await editor.getByLabel(name, {exact: true}).inputValue(), '');
      const extracted = await request('/api/intake/extractions/' + receipt.job_id, {client});
      assert.equal(extracted.status, 200); result = extracted.body.result;
      assert.equal(result.content.elements.map(e => e.text).join(''), reference.text);
      for (const checkbox of await editor.locator('section[data-element-id] input[type=checkbox]').all()) await checkbox.check();
      await editor.getByLabel('Function', {exact: true}).selectOption('normative');
      await editor.getByLabel('Basis', {exact: true}).selectOption('non_authoritative_reference');
      await editor.getByLabel('Scope of use', {exact: true}).selectOption('situated');
      const examination = editor.locator('fieldset').filter({has: page.locator('legend', {hasText: /^Examination$/})});
      await examination.getByLabel('Outcome', {exact: true}).selectOption('classifiable');
      await examination.getByLabel('Reason', {exact: true}).fill('An explicit synthetic human classification for this selected source.');
      await editor.getByLabel('Coverage explanation', {exact: true}).fill('All selected statements, without a general completeness claim.');
      observations.push({case: 'W02', extraction: result.effect, originalSha256: receipt.sha256});
    });
    if (!result) throw Error('WORKSPACE_EXTRACTION_PREREQUISITE');
    await t.test('W03 a lost durable reservation recovers from locators without repeating preparation', async () => {
      await observer.run('W03', async () => {
        let probeFailure = null;
        const transportFault = await context.newCDPSession(page);
        transportFault.on('Fetch.requestPaused', async event => {
          if (event.request.method !== 'POST') {
            await transportFault.send('Fetch.continueRequest', {requestId: event.requestId}); return;
          }
          try {
            assert.equal(event.responseStatusCode, 202);
            const response = await transportFault.send('Fetch.getResponseBody', {requestId: event.requestId});
            lost = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
            const retained = (await env.admin.query('SELECT id,operation,reference FROM intake_trial.editorial_effect WHERE id=$1', [lost.operation_id])).rows[0];
            assert.equal(retained.operation, 'reserve_preparation'); assert.deepEqual(retained.reference, lost.effect);
            await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_prepare'", [controlled.account.id]);
            await transportFault.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'ConnectionReset'});
          } catch (error) {probeFailure = error;
            await transportFault.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'Failed'}).catch(() => {});}
        });
        // Fault only the response: Chromium sends the real request directly with
        // its existing resolver and TLS trust. No request replay or fabricated body.
        await transportFault.send('Fetch.enable', {patterns: [{urlPattern: apiOrigin + '/api/intake/preparation-attempts', requestStage: 'Response'}]});
        await page.getByRole('button', {name: 'Save preparation', exact: true}).click();
        await page.getByText('Preparation is not confirmed. Reconcile the retained operation before repeating an effect.', {exact: true}).waitFor();
        if (probeFailure) throw probeFailure;
        assert.ok(lost, JSON.stringify(diagnostics));
        const withdrawn = await request('/api/intake/extractions/' + receipt.job_id, {client,
          headers: {accept: 'application/vnd.ledgerdesk.intake-workspace+json'}});
        assert.deepEqual({status: withdrawn.status, offers: withdrawn.body.offers, effect: withdrawn.body.extraction?.result?.effect},
          {status: 200, offers: [], effect: result.effect});
        const journal = await page.evaluate(() => sessionStorage.getItem('ledgerdesk.intake.locators.v1'));
        assert.ok(journal); for (const secret of [client.cookie, client.csrf, reference.text, reference.name]) assert.equal(journal.includes(secret), false);
        const effects = async () => (await env.admin.query("SELECT count(*)::int AS n FROM intake_trial.editorial_effect WHERE operation='reserve_preparation'")).rows[0].n;
        assert.equal(await effects(), 1);
        await transportFault.send('Fetch.disable'); await transportFault.detach();
        await page.reload();
        await page.getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
        await page.getByText('Retained preparation result: reserved. No operation was repeated.', {exact: true}).waitFor();
        const recoveredCard = page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]');
        assert.equal(await recoveredCard.getByText('Operation recorded', {exact: true}).count(), 1);
        assert.equal(await recoveredCard.getByText('Outcome unconfirmed', {exact: true}).count(), 0);
        assert.equal(await effects(), 1);
        assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/api/intake/preparation-attempts').length, 1);
        const check = await request('/api/intake/operations/lookup', {client,
          headers: {accept: 'application/vnd.ledgerdesk.intake-workspace+json'},
          body: {profile: 'intake-workspace/1', kind: 'preparation_effect', variant: 'reserve_preparation',
            client_key: JSON.parse(journal).entries.find(e => e.operation === 'reserve_preparation').key}});
        assert.equal(check.status, 200); assert.equal(check.body.effect.operation_id, lost.operation_id);
        observations.push({case: 'W03', effect: lost.effect, attempts: 1, effects: await effects(), reserveRequests: 1,
          newPreparationFaculty: 'withdrawn', consultation: 'retained', recoveredEffect: check.body.effect.operation_id});
        await page.screenshot({path: '/work/output/workspace-recovered.png', fullPage: true});
      });
    });
  } finally {
    writeFileSync('/work/output/workspace-observations.json', JSON.stringify({observations, errors, requests}, null, 2), {flag: 'wx'});
    await context?.close(); await browser?.close();
    if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    await app?.close();
    for (const [key, value] of Object.entries(beforeEnvironment)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    console.log('INTAKE_WORKSPACE_CLEANED');
  }
}
