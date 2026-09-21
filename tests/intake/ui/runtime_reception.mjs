import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {original as fixture, MARKDOWN} from '../extraction/references/cases.mjs';
import {CSV_REFERENCES} from '../extraction/references/csv.mjs';
import {apiOrigin} from '../../access/journey_environment.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function workspaceReception(t, {env, intake, client, request, controlled, page, context, observer,
  reference, receipt, original, observations, requests, errors}) {
  const extractor = new ExtractionService(intake);
  const cards = () => page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]');
  // Independent input facts, fixed before reception or production.
  const sameName = 'same-name.txt';
  const twinBytes = [Buffer.from('  First identity. Cafe\u0301 😀  \n'), Buffer.from([0x41, 0xc3, 0x28, 0x42])];
  const typed = '  Texto exacto: Cafe\u0301 😀\n<script>globalThis.intakeExecuted = true</script>  ';
  const inputReferences = {twins: twinBytes.map(bytes => ({name: sameName, bytes: bytes.length, sha256: digest(bytes)})),
    typed: {name: 'captured-source.txt', text: typed, bytes: Buffer.byteLength(typed), sha256: digest(Buffer.from(typed))}};
  writeFileSync('/work/output/workspace-reception-reference.json', JSON.stringify(inputReferences, null, 2), {flag: 'wx'});
  let twinKeys, twinRows, typedKey;
  const byKey = key => page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${key}"]`);
  const receive = async key => {
    const row = byKey(key);
    await row.getByRole('button', {name: 'Receive', exact: true}).click();
    await row.getByText('Original received. Extraction and preparation are separate stages.', {exact: true}).waitFor();
  };
  const serverRow = async sha => {
    const found = (await env.admin.query(`SELECT r.id AS reception_id, rcp.*, w.id AS job_id FROM intake_trial.reception r
      JOIN intake_trial.receipt rcp ON rcp.reception_id=r.id JOIN intake_trial.work w ON w.receipt_id=rcp.id
      WHERE rcp.sha256=$1`, [sha])).rows;
    assert.equal(found.length, 1); return found[0];
  };
  const extract = async row => {
    await extractor.dispatch(row.job_id); await extractor.accept(row.job_id);
    const response = await request('/api/intake/extractions/' + row.job_id, {client});
    assert.equal(response.status, 200); return response.body.result.content;
  };

  await t.test('W04 equal filenames keep distinct original identities and mixed admission outcomes', async () => {
    await observer.run('W04', async () => {
      await page.getByLabel('Choose files', {exact: true}).setInputFiles(twinBytes.map(buffer => ({name: sameName, mimeType: 'text/plain', buffer})));
      twinKeys = await cards().filter({hasText: sameName}).evaluateAll(rows => rows.map(row => row.dataset.itemKey));
      assert.equal(new Set(twinKeys).size, 2);
      await receive(twinKeys[0]);
      await byKey(twinKeys[1]).getByRole('button', {name: 'Receive', exact: true}).click();
      await byKey(twinKeys[1]).getByText('The service rejected this reception request (415). Earlier recorded work is retained; reconcile its current state.', {exact: true}).waitFor();
      twinRows = [await serverRow(inputReferences.twins[0].sha256)];
      const rejected = (await env.admin.query(`SELECT r.id, count(rcp.id)::int AS receipts FROM intake_trial.reception r
        LEFT JOIN intake_trial.receipt rcp ON rcp.reception_id=r.id WHERE r.declaration->>'sha256'=$1 GROUP BY r.id`,
        [inputReferences.twins[1].sha256])).rows;
      assert.equal(rejected.length, 1); assert.equal(rejected[0].receipts, 0);
      assert.notEqual(twinRows[0].reception_id, rejected[0].id);
      const content = await extract(twinRows[0]);
      await byKey(twinKeys[0]).getByRole('button', {name: 'Refresh', exact: true}).click();
      await byKey(twinKeys[0]).getByText('Extraction observed: completed. Preparation is a separate human act.', {exact: true}).waitFor();
      assert.equal(content.outcome, 'completed');
      assert.equal(content.elements.map(e => e.text).join(''), twinBytes[0].toString('utf8'));
      assert.equal(await byKey(twinKeys[1]).getByRole('button', {name: 'Check recorded outcome', exact: true}).count(), 1);
      assert.deepEqual(await cards().filter({hasText: sameName}).evaluateAll(rows => rows.map(row => row.dataset.itemKey)), twinKeys);
      observations.push({case: 'W04', identities: twinRows.map((r, i) => ({local: twinKeys[i], reception: r.reception_id, sha256: r.sha256})),
        rejected: rejected[0], outcomes: ['completed extraction', 'reception request rejected: 415']});
    });
  });

  await t.test('W05 text capture preserves exact Unicode, the other tab and stable surviving rows', async () => {
    await observer.run('W05', async () => {
      await page.getByRole('button', {name: 'Text', exact: true}).click();
      await page.getByLabel('File name', {exact: true}).fill(inputReferences.typed.name);
      await page.getByLabel('Text to receive', {exact: true}).fill(typed);
      await page.getByRole('button', {name: 'Files', exact: true}).click();
      await page.getByLabel('Choose files', {exact: true}).setInputFiles({name: 'discard-only.txt', mimeType: 'text/plain', buffer: Buffer.from('Not sent.')});
      const discard = cards().filter({hasText: 'discard-only.txt'});
      const discardedKey = await discard.getAttribute('data-item-key');
      await discard.getByRole('button', {name: 'Discard local draft', exact: true}).click();
      assert.equal(await byKey(discardedKey).count(), 0);
      await page.getByRole('button', {name: 'Text', exact: true}).click();
      assert.equal(await page.getByLabel('Text to receive', {exact: true}).inputValue(), typed);
      await page.getByLabel('Control language', {exact: true}).selectOption('es');
      await page.getByLabel('Idioma de los controles', {exact: true}).selectOption('en');
      assert.equal(await page.getByLabel('Text to receive', {exact: true}).inputValue(), typed);
      await page.getByRole('button', {name: 'Receive this text', exact: true}).click();
      typedKey = await cards().filter({hasText: inputReferences.typed.name}).getAttribute('data-item-key');
      await receive(typedKey);
      const row = await serverRow(inputReferences.typed.sha256), content = await extract(row);
      const delivered = await request('/api/intake/receptions/' + row.reception_id + '/original', {client});
      assert.deepEqual({status: delivered.status, bytes: delivered.bytes}, {status: 200, bytes: Buffer.from(typed)});
      assert.equal(content.elements.map(e => e.text).join(''), typed);
      await byKey(typedKey).getByRole('button', {name: 'Refresh', exact: true}).click();
      await byKey(typedKey).getByText('Extraction observed: completed. Preparation is a separate human act.', {exact: true}).waitFor();
      assert.deepEqual(await cards().filter({hasText: sameName}).evaluateAll(rows => rows.map(row => row.dataset.itemKey)), twinKeys);
      assert.equal(await page.getByLabel('Text to receive', {exact: true}).inputValue(), typed);
      assert.equal(await page.evaluate(() => globalThis.intakeExecuted), undefined);
      observations.push({case: 'W05', reception: row.reception_id, original: inputReferences.typed, stableKeys: twinKeys, discardedKey});
    });
  });

  await t.test('W06 real Markdown, CSV and XLSX producers retain their independent reference facts', async () => {
    await observer.run('W06', async () => {
      await page.getByRole('button', {name: 'Files', exact: true}).click();
      for (const [name, media] of [['inert.md', 'text/markdown'], ['table.csv', 'text/csv'], ['unsupported-part.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
        const input = await fixture(name);
        await page.getByLabel('Choose files', {exact: true}).setInputFiles({name, mimeType: media, buffer: input.bytes});
        const key = await cards().filter({hasText: name}).getAttribute('data-item-key');
        await receive(key); const row = await serverRow(digest(input.bytes)), content = await extract(row);
        if (name === 'inert.md') assert.equal(content.elements.map(e => e.text).join(''), MARKDOWN);
        if (name === 'table.csv') assert.deepEqual({headers: content.elements[0].headers, fields: content.elements[0].rows.map(r => r.fields)},
          {headers: CSV_REFERENCES[name].fields[0], fields: CSV_REFERENCES[name].fields});
        if (name.endsWith('.xlsx')) {
          assert.equal(content.outcome, 'partial');
          assert.deepEqual(content.elements.map(e => [e.sheet.name, e.sheet.visibility]), [['Items', 'visible'], ['Conditions', 'hidden']]);
          const cell = address => content.elements[0].cells.find(c => c.address === address);
          assert.deepEqual({formula: cell('D2').formula, cache: cell('D2').cached, code: cell('A2').value},
            {formula: 'B2*C2', cache: {kind: 'number_lexical', lexical: '25.00'}, code: {kind: 'text', lexical: '001'}});
        }
        await byKey(key).getByRole('button', {name: 'Refresh', exact: true}).click();
        await byKey(key).getByText(`Extraction observed: ${content.outcome}. Preparation is a separate human act.`, {exact: true}).waitFor();
        observations.push({case: 'W06', name, original: {bytes: input.bytes.length, sha256: digest(input.bytes)},
          reception: row.reception_id, outcome: content.outcome});
      }
      assert.equal(await page.evaluate(() => globalThis.intakeExecuted), undefined);
      assert.deepEqual(errors, []);
    });
  });

  await t.test('W07 original inspection and download have their own fresh authority without executable source', async () => {
    await observer.run('W07', async () => {
      await byKey(typedKey).getByRole('button', {name: 'Inspect original', exact: true}).click();
      const originalView = page.getByRole('region', {name: 'Original', exact: true});
      await originalView.getByRole('heading', {name: 'Original', exact: true}).waitFor();
      assert.equal(await originalView.locator('pre').textContent(), typed);
      assert.equal(await page.evaluate(() => globalThis.intakeExecuted), undefined);
      const pendingDownload = page.waitForEvent('download');
      await originalView.getByRole('button', {name: 'Download original', exact: true}).click();
      const download = await pendingDownload;
      assert.equal(download.suggestedFilename(), inputReferences.typed.name);
      assert.deepEqual(readFileSync(await download.path()), Buffer.from(typed));
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_original'", [controlled.account.id]);
      const responses = [], delivered = [];
      const observe = response => {if (new URL(response.url()).pathname.endsWith('/original')) responses.push(response.status());};
      const observeDownload = value => delivered.push(value);
      page.on('response', observe); page.on('download', observeDownload);
      await originalView.getByRole('button', {name: 'Download original', exact: true}).click();
      await page.getByRole('alert').filter({hasText: 'This record is unavailable.'}).waitFor();
      page.off('response', observe); page.off('download', observeDownload);
      assert.deepEqual({responses, downloads: delivered.length}, {responses: [404], downloads: 0});
      await originalView.getByRole('button', {name: 'Back', exact: true}).first().click();
      await byKey(typedKey).getByRole('button', {name: 'Refresh', exact: true}).click();
      await byKey(typedKey).getByRole('button', {name: 'Inspect original', exact: true}).waitFor({state: 'detached'});
      await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      await byKey(typedKey).getByRole('button', {name: 'Prepare', exact: true}).waitFor();
      assert.equal(await byKey(typedKey).getByRole('button', {name: 'Inspect original', exact: true}).count(), 0);
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_original'", [controlled.account.id]);
      observations.push({case: 'W07', downloadedSha256: inputReferences.typed.sha256, denied: {responses, downloads: delivered.length}});
    });
  });

  await t.test('W08 lost reception response is reconciled without repeating receipt or upload after reload', async () => {
    await observer.run('W08', async () => {
      const bytes = Buffer.from('A separate uncertain receipt, retained once.\n'), name = 'lost-reception.txt';
      await page.getByLabel('Choose files', {exact: true}).setInputFiles({name, mimeType: 'text/plain', buffer: bytes});
      const key = await cards().filter({hasText: name}).getAttribute('data-item-key');
      let lost = null, fault = null;
      const cdp = await context.newCDPSession(page);
      cdp.on('Fetch.requestPaused', async event => {
        if (event.request.method !== 'POST') {await cdp.send('Fetch.continueRequest', {requestId: event.requestId}); return;}
        try {
          assert.equal(event.responseStatusCode, 200);
          const body = await cdp.send('Fetch.getResponseBody', {requestId: event.requestId});
          lost = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
          assert.equal(lost.state, 'received');
          await cdp.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'ConnectionReset'});
        } catch (error) {fault = error; await cdp.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'Failed'}).catch(() => {});}
      });
      await cdp.send('Fetch.enable', {patterns: [{urlPattern: apiOrigin + '/api/intake/receptions/*/finalize', requestStage: 'Response'}]});
      try {
        await byKey(key).getByRole('button', {name: 'Receive', exact: true}).click();
        await byKey(key).getByText('The result is not confirmed. Reconcile before attempting another effect.', {exact: true}).waitFor();
        if (fault) throw fault;
        assert.ok(lost);
      } finally {await cdp.send('Fetch.disable'); await cdp.detach();}
      const row = await serverRow(digest(bytes));
      const commands = () => requests.filter(r => r.method === 'POST' && r.path !== '/api/intake/operations/lookup');
      const retained = JSON.parse(await page.evaluate(() => sessionStorage.getItem('ledgerdesk.intake.locators.v1')));
      assert.equal(retained.entries.filter(entry => entry.itemKey === key).at(-1).references.receptionId, row.reception_id);
      const receiptPath = '/api/intake/receptions/' + row.reception_id;
      const before = commands().length, beforeQuery = requests.filter(r => r.path === '/api/intake/operations/lookup').length;
      const beforeReceipt = requests.filter(r => r.method === 'GET' && r.path === receiptPath).length;
      await page.reload();
      await byKey(key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
      await byKey(key).getByText('Original received. Extraction and preparation are separate stages.', {exact: true}).waitFor();
      await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      // A known reception is reconciled directly, then refreshed in the workspace
      // representation. The intention lookup is only for a missing reference.
      const observed = {extraCommands: commands().length - before,
        intentionQueries: requests.filter(r => r.path === '/api/intake/operations/lookup').length - beforeQuery,
        receiptQueries: requests.filter(r => r.method === 'GET' && r.path === receiptPath).length - beforeReceipt,
        receipt: (await serverRow(digest(bytes))).id,
        recoveredRows: await byKey(key).getByText('Recovered operation', {exact: true}).count()};
      assert.deepEqual(observed, {extraCommands: 0, intentionQueries: 0, receiptQueries: 2, receipt: row.id, recoveredRows: 1});
      observations.push({case: 'W08', effect: lost.effect, reception: row.reception_id, ...observed});
      await page.screenshot({path: '/work/output/workspace-reception-continuity.png', fullPage: true});
    });
  });
}
