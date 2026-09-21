import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {JOURNAL_KEY} from '../../../src/components/intake/journal.ts';
import {holdResponse, installSession, assertNoAdoption} from './response_hold.mjs';

const workspace = 'application/vnd.ledgerdesk.intake-workspace+json';
const pathOf = request => new URL(request.url).pathname;
const acceptOf = request => Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'accept')?.[1];
const byPath = (method, pattern, representation) => request => request.method === method && pattern.test(pathOf(request)) &&
  (!representation || acceptOf(request) === representation);

/** Each adoption site receives a real positive and the same successful response
 * delayed across a replacement session. Server effects remain historical facts;
 * replacing the session must prevent UI adoption and further chained requests. */
export async function workspaceAdoptionReception(t, {env, intake, client, page, context, observer, receipt, original, observations, requests, login}) {
  const baseJournal = await page.evaluate(key => sessionStorage.getItem(key), JOURNAL_KEY);
  const baseEntries = JSON.parse(baseJournal), baseKey = baseEntries.entries[0].itemKey;
  const extractor = new ExtractionService(intake);
  await extractor.dispatch(receipt.job_id); await extractor.accept(receipt.job_id);
  // Two real sessions suffice to isolate adoption; repeated login attempts would
  // exercise the independent rate limit instead of the response guard.
  const replacement = await login('reader@example.test');
  const card = key => page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${key}"]`);
  const ready = () => page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
  const reset = async (journal = baseJournal) => {
    await installSession(context, client);
    await page.evaluate(([key, value]) => {if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);}, [JOURNAL_KEY, journal]);
    await page.reload(); await page.getByLabel('Choose files', {exact: true}).waitFor(); await ready();
  };
  const recover = async () => {
    await card(baseKey).getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
    await card(baseKey).getByRole('button', {name: 'Prepare', exact: true}).waitFor(); await ready();
  };
  const received = async key => {
    await card(key).getByText('Original received. Extraction and preparation are separate stages.', {exact: true}).waitFor(); await ready();
  };
  const fresh = async name => {
    await reset(null);
    await page.getByLabel('Choose files', {exact: true}).setInputFiles({name, mimeType: 'text/plain', buffer: Buffer.from('A finite adoption control.\n')});
  };
  const examples = [
    {site: 'startup-session', match: byPath('GET', /^\/api\/access\/v1\/session$/), setup: () => reset(null),
      act: () => page.locator('header').getByRole('button', {name: 'Refresh', exact: true}).click(),
      positive: () => page.getByLabel('Choose files', {exact: true}).waitFor()},
    {site: 'context-profile', match: byPath('GET', /^\/api\/intake\/profiles$/), setup: () => reset(null),
      act: () => page.locator('header').getByRole('button', {name: 'Refresh', exact: true}).click(),
      positive: () => page.getByLabel('Choose files', {exact: true}).waitFor()},
    ...[
      ['reception-reservation', 'POST', /^\/api\/intake\/receptions$/],
      ['original-upload', 'POST', /^\/api\/intake\/receptions\/[^/]+\/attempts\/\d+\/original$/],
      ['staged-reception-query', 'GET', /^\/api\/intake\/receptions\/[^/]+$/, 'application/vnd.ledgerdesk.intake.v2+json'],
      ['reception-finalization', 'POST', /^\/api\/intake\/receptions\/[^/]+\/finalize$/],
    ].map(([site, method, pattern, representation]) => ({site, match: byPath(method, pattern, representation),
      setup: async suffix => {
        const name = `${site}-${suffix}.txt`; await fresh(name);
        return page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]').filter({hasText: name}).getAttribute('data-item-key');
      }, act: key => card(key).getByRole('button', {name: 'Receive', exact: true}).click(), positive: received})),
    {site: 'reception-refresh', match: byPath('GET', /^\/api\/intake\/receptions\/[^/]+$/, workspace),
      setup: async () => {await reset(); await recover(); return baseKey;},
      act: key => card(key).getByRole('button', {name: 'Refresh', exact: true}).click(), positive: async key => {await ready(); assert.equal(await card(key).getByRole('button', {name: 'Prepare', exact: true}).count(), 1);}},
    {site: 'extraction-refresh', match: byPath('GET', /^\/api\/intake\/extractions\/[^/]+$/, workspace),
      setup: async () => {await reset(); await recover(); return baseKey;},
      act: key => card(key).getByRole('button', {name: 'Refresh', exact: true}).click(), positive: async key => {await ready(); assert.equal(await card(key).getByRole('button', {name: 'Prepare', exact: true}).count(), 1);}},
    {site: 'reception-stop', match: byPath('POST', /^\/api\/intake\/receptions\/[^/]+\/cancel$/),
      setup: async suffix => {
        const name = `stop-adoption-${suffix}.txt`; await fresh(name);
        const key = await page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]').filter({hasText: name}).getAttribute('data-item-key');
        await card(key).getByRole('button', {name: 'Receive', exact: true}).click(); await received(key);
        const job = (await env.admin.query(`SELECT w.id FROM intake_trial.reception r JOIN intake_trial.receipt p ON p.reception_id=r.id
          JOIN intake_trial.work w ON w.receipt_id=p.id WHERE r.declaration->>'name'=$1`, [name])).rows;
        assert.equal(job.length, 1); await extractor.dispatch(job[0].id);
        await card(key).getByRole('button', {name: 'Refresh', exact: true}).click(); await ready(); return key;
      }, act: key => card(key).getByRole('button', {name: 'Stop work', exact: true}).click(),
      positive: key => card(key).getByText('The service recorded a stop. Retained history and the original were not erased.', {exact: true}).waitFor()},
    {site: 'reception-recovery-by-reference', match: byPath('GET', /^\/api\/intake\/receptions\/[^/]+$/, 'application/vnd.ledgerdesk.intake.v2+json'),
      setup: async () => {await reset(); return baseKey;}, act: key => card(key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click(),
      positive: async key => {await card(key).getByRole('button', {name: 'Prepare', exact: true}).waitFor(); await ready();}},
    {site: 'reception-recovery-by-intention', match: request => request.method === 'POST' && pathOf(request) === '/api/intake/operations/lookup' && JSON.parse(request.postData).by === 'intention',
      setup: async () => {
        const selected = structuredClone(baseEntries), entry = selected.entries.find(row => row.operation === 'reserve_reception');
        assert.ok(entry?.key); entry.references = {}; selected.entries = [entry];
        await reset(JSON.stringify(selected)); return baseKey;
      }, act: key => card(key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click(),
      positive: async key => {await card(key).getByRole('button', {name: 'Prepare', exact: true}).waitFor(); await ready();}},
    {site: 'original-inspection', match: byPath('GET', /^\/api\/intake\/receptions\/[^/]+\/original$/),
      setup: async () => {await reset(); await recover(); return baseKey;},
      act: key => card(key).getByRole('button', {name: 'Inspect original', exact: true}).click(),
      positive: async () => {const view = page.getByRole('region', {name: 'Original', exact: true}); await view.waitFor(); assert.equal(await view.locator('pre').textContent(), original.toString());}},
    {site: 'original-download', match: byPath('GET', /^\/api\/intake\/receptions\/[^/]+\/original$/),
      setup: async () => {await reset(); await recover(); await card(baseKey).getByRole('button', {name: 'Inspect original', exact: true}).click(); await page.getByRole('region', {name: 'Original', exact: true}).waitFor(); await ready();},
      act: () => page.getByRole('button', {name: 'Download original', exact: true}).click(),
      positive: async () => {await ready();}},
  ];
  const selected = process.env.LEDGERDESK_UI_ADOPTION_SITE;
  if (selected) assert.equal(examples.filter(example => example.site === selected).length, 1);
  for (const example of examples.filter(example => !selected || example.site === selected)) await t.test('W23 ' + example.site + ' guards its actual response adoption', async () => observer.run('W23-' + example.site, async () => {
    const controls = [];
    for (const replaced of [false, true]) {
      const key = await example.setup(replaced ? 'replaced' : 'unchanged');
      const held = await holdResponse(context, page, example.match), downloads = [];
      const download = value => downloads.push(value); page.on('download', download);
      const delivered = !replaced && example.site === 'original-download' ? page.waitForEvent('download') : null;
      void delivered?.catch(() => {});
      try {
        await example.act(key); const actual = await held.wait();
        const dispatched = requests.filter(row => row.path.startsWith('/api/intake/')).length;
        if (replaced) await installSession(context, replacement);
        await held.release();
        if (replaced) {
          await assertNoAdoption(page, downloads);
          assert.equal(requests.filter(row => row.path.startsWith('/api/intake/')).length, dispatched, 'No dependent intake request may follow the old response.');
        } else {
          await example.positive(key); await ready();
          if (delivered) {const actualDownload = await delivered; assert.equal(downloads.length, 1); assert.deepEqual(readFileSync(await actualDownload.path()), original);}
          assert.equal(await page.getByText('The session changed. Refresh and explicitly reconcile retained operations.', {exact: true}).count(), 0);
        }
        controls.push({...actual, replaced, adopted: !replaced, additionalDownloads: downloads.length});
      } finally {page.off('download', download); await held.close(); await installSession(context, client);}
    }
    observations.push({case: 'W23', site: example.site, controls});
  }));
}
