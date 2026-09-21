import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {preparationResourceCases} from '../preparation/runtime_resources.mjs';
import {REFERENCES} from '../preparation/references/cases.mjs';
import {IntakeJournal, JOURNAL_KEY} from '../../../src/components/intake/journal.ts';
import {preparationCanonical} from '../../../src/contracts/intake_preparation.ts';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {apiOrigin, uiOrigin} from '../../access/journey_environment.mjs';
import {holdResponse, installSession, assertNoAdoption} from './response_hold.mjs';

/** Reuse the retained instrumented producer and its independent resource facts.
 * This connects authorized download, not native SVG admission or OCR. */
export async function workspaceResources(t, {env, intake, client, request, controlled, page, context, observer, observations, storage, login}) {
  const accept = 'application/vnd.ledgerdesk.intake-preparation+json', completed = new Map();
  const check = (reply, status) => assert.equal(reply.status, status, JSON.stringify(reply.body));
  const call = async (path, options = {}) => {
    const reply = await request('/api/intake' + path, {client, ...options, headers: {accept, ...options.headers}});
    if (path.endsWith('/finalize') && reply.status === 200) completed.set(reply.body.result.preparation.id,
      {key: options.key, body: options.body, id: path.split('/')[2]});
    return reply;
  };
  const counts = async () => (await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_trial.candidate) AS candidates,
    (SELECT count(*)::int FROM intake_trial.constitution_outcome) AS outcomes,
    (SELECT count(*)::int FROM intake_trial.editorial_effect WHERE operation='constitute') AS effects`)).rows[0];
  const record = (name, value) => observations.push({case: name, ...value});
  await preparationResourceCases(t, {env, intake, client, request, call, check, counts, controlled, storage, record,
    afterPrepared: async prepared => {
      const ref = prepared.reference, effect = completed.get(ref.id); assert.ok(effect);
      const values = new Map(), itemKey = randomUUID();
      const journal = new IntakeJournal({getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v)},
        {deployment: intake.deployment, uiOrigin, terminalOrigin: apiOrigin});
      journal.retain({id: randomUUID(), itemKey, operation: 'finalize_preparation', profile: 'intake-preparation/1', key: effect.key,
        fingerprint: createHash('sha256').update(preparationCanonical('finalize_preparation', {id: effect.id}, effect.body, canonicalValue)).digest('hex'),
        references: {preparation: ref}});
      const reset = async () => {
        await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [JOURNAL_KEY, values.get(JOURNAL_KEY)]);
        await page.reload();
        await page.locator(`aside li[data-item-key="${itemKey}"] button`).click();
        const card = page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${itemKey}"]`);
        await card.getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
        await card.getByRole('button', {name: 'Inspect preparation', exact: true}).click();
        await page.getByRole('button', {name: 'Download resource', exact: true}).waitFor();
        await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      };
      const resourceReads = () => storage.filter(e => e.origin === 'prepared-resource-boundary').length;
      await t.test('W21 the real inspector downloads only its admitted exact resource, never the whole container', async () => observer.run('W21', async () => {
        await reset(); const before = resourceReads();
        const downloaded = page.waitForEvent('download'); await page.getByRole('button', {name: 'Download resource', exact: true}).click();
        const download = await downloaded, bytes = await readFile(await download.path());
        assert.equal(download.suggestedFilename(), 'resource-R-1');
        assert.deepEqual(bytes, Buffer.from(REFERENCES['F-R'].az17.utf8));
        assert.equal(bytes.includes(Buffer.from('AZ-18')), false); assert.ok(resourceReads() > before);
        assert.equal(await page.locator('[data-block-id] svg, [data-block-id] iframe, [data-block-id] img').count(), 0);
        let downloads = 0; const countDownload = () => {downloads++;}; page.on('download', countDownload);
        const changed = await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_resource_read'", [controlled.account.id]);
        assert.ok(changed.rowCount > 0); const deniedReads = resourceReads();
        try {
          const response = page.waitForResponse(r => r.url().endsWith('/resources/R-1'));
          await page.getByRole('button', {name: 'Download resource', exact: true}).click(); assert.equal((await response).status(), 404);
          await page.getByText('This record is unavailable. Its absence does not establish that an earlier effect did not occur.', {exact: true}).waitFor();
          assert.deepEqual({downloads, reads: resourceReads()}, {downloads: 0, reads: deniedReads});
          // Refreshing the actual preparation query omits the no-longer-offered action.
          await page.reload();
          await page.locator(`aside li[data-item-key="${itemKey}"] button`).click();
          const card = page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${itemKey}"]`);
          await card.getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
          await card.getByRole('button', {name: 'Inspect preparation', exact: true}).click();
          await page.getByRole('region', {name: 'Human preparation', exact: true}).waitFor();
          assert.equal(await page.getByRole('button', {name: 'Download resource', exact: true}).count(), 0);
        } finally {
          page.off('download', countDownload);
          await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_resource_read'", [controlled.account.id]);
        }
        await reset(); await page.screenshot({path: '/work/output/workspace-resource.png', fullPage: true});
        record('W21', {preparation: ref, resource: 'A-17/g7', bytes: bytes.length, denied: 404, deniedReads: 0,
          deniedDownloads: 0, otherResourceDelivered: false, producer: 'existing instrumented resource case, not native SVG extraction'});
      }));
      await t.test('W28 an old resource response cannot download under a replacement session', async () => observer.run('W28', async () => {
        // W21 is the actual exact-byte positive for this same retained resource.
        await reset(); const replacement = await login('reader@example.test'), downloads = [];
        const listen = value => downloads.push(value); page.on('download', listen);
        const held = await holdResponse(context, page, request => request.method === 'GET' && new URL(request.url).pathname.endsWith('/resources/R-1'));
        try {
          await page.getByRole('button', {name: 'Download resource', exact: true}).click(); const actual = await held.wait();
          await installSession(context, replacement); await held.release(); await assertNoAdoption(page, downloads);
          record('W28', {...actual, positive: 'W21', sameAccountReplacement: true, downloads: 0, adopted: false});
        } finally {page.off('download', listen); await held.close(); await installSession(context, client);}
      }));
      await t.test('W22 narrow mounted views preserve literal content, theme and keyboard focus', async () => observer.run('W22', async () => {
        await page.setViewportSize({width: 390, height: 844}); await reset();
        const heading = page.getByRole('heading', {name: 'Human preparation', exact: true});
        await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
        assert.equal(await heading.evaluate(e => e === document.activeElement), true);
        const literal = await page.getByTestId('intake-exact-text').allTextContents();
        assert.ok(literal.includes(REFERENCES['F-R'].az17.caption));
        await page.getByLabel('Control language', {exact: true}).selectOption('es');
        assert.deepEqual(await page.getByTestId('intake-exact-text').allTextContents(), literal);
        await page.getByLabel('Tema de color', {exact: true}).selectOption('light');
        assert.equal(await page.locator('main').getAttribute('data-theme'), 'light');
        await page.getByLabel('Idioma de los controles', {exact: true}).selectOption('en');
        assert.deepEqual(await page.getByTestId('intake-exact-text').allTextContents(), literal);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({path: '/work/output/workspace-resource-narrow.png', fullPage: true});
        const region = page.getByRole('region', {name: 'Human preparation', exact: true});
        await region.getByRole('button', {name: 'Back', exact: true}).first().click();
        const rowButton = page.locator(`aside li[data-item-key="${itemKey}"] button`);
        await page.waitForFunction(key => document.activeElement?.closest('li')?.getAttribute('data-item-key') === key, itemKey);
        assert.equal(await rowButton.evaluate(e => e === document.activeElement), true);
        await rowButton.focus(); await page.keyboard.press('Enter');
        const fileButton = page.getByRole('button', {name: 'Choose files', exact: true}).and(page.locator('button'));
        await page.waitForFunction(() => document.activeElement?.textContent === 'Choose files');
        assert.equal(await fileButton.evaluate(e => e === document.activeElement), true);
        const before = await counts(), priorJournal = await page.evaluate(k => sessionStorage.getItem(k), JOURNAL_KEY);
        await page.getByLabel('Choose files', {exact: true}).setInputFiles({name: 'Unsent discard.txt', mimeType: 'text/plain', buffer: Buffer.from('A local draft only')});
        // Adding the file selects its new stable row directly; the narrow list
        // is not simultaneously interactive with that mounted detail.
        const localCard = page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]').filter({hasText: 'Unsent discard.txt'});
        await localCard.getByRole('button', {name: 'Discard local draft', exact: true}).click();
        assert.deepEqual({localRows: await page.locator('li[data-item-key]').filter({hasText: 'Unsent discard.txt'}).count(),
          persisted: await counts(), journal: await page.evaluate(k => sessionStorage.getItem(k), JOURNAL_KEY)},
          {localRows: 0, persisted: before, journal: priorJournal});
        record('W22', {viewport: {width: 390, height: 844}, literalAcrossLanguages: literal, theme: 'light', overflow: false,
          focus: ['mounted inspector heading', 'originating list row after Back', 'file control after keyboard entry'], localDiscardEffects: 0});
        await page.setViewportSize({width: 1280, height: 900});
      }));
    }});
}
