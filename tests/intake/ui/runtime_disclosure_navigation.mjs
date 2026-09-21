import assert from 'node:assert/strict';
import {JOURNAL_KEY} from '../../../src/components/intake/journal.ts';
import {WORKSPACE_ACCEPT, validateWorkspaceResponse} from '../../../src/contracts/intake_workspace.ts';
import {holdResponse} from './response_hold.mjs';

export async function workspaceDisclosureNavigation(t, {env, client, request, controlled, receipt, page, context, observer, observations,
  fixture, reset, recover, inspect, draftProposal, propose, proposed, editor, card, ready, baseKey}) {
  const get = path => request('/api/intake' + path, {client, headers: {accept: WORKSPACE_ACCEPT}});
  const lookup = body => request('/api/intake/operations/lookup', {client, headers: {accept: WORKSPACE_ACCEPT}, body: {profile: 'intake-workspace/1', ...body}});
  const storedJournal = () => page.evaluate(key => sessionStorage.getItem(key), JOURNAL_KEY);
  const counts = async () => (await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_trial.preparation) preparations,
    (SELECT count(*)::int FROM intake_trial.candidate) candidates,(SELECT count(*)::int FROM intake_trial.editorial_effect) effects`)).rows[0];
  const withoutGrant = async (permission, run) => {
    const updated = await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id=$2', [controlled.account.id, permission]);
    assert.ok(updated.rowCount > 0);
    try {return await run();} finally {await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id=$2', [controlled.account.id, permission]);}
  };
  const check = (response, kind) => {assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(validateWorkspaceResponse(kind, response.body), true); return response.body;};
  await t.test('W25 context and object offers are omitted in actual JSON under their own authority', async () => observer.run('W25', async () => {
    const contextBody = check(await get('/profiles'), 'context'); assert.deepEqual(contextBody.offers, ['receive']);
    await withoutGrant('intake_profiles', async () => {
      const denied = await get('/profiles'); assert.equal(denied.status, 404);
      for (const key of ['context', 'availability', 'offers', 'deployment']) assert.equal(Object.hasOwn(denied.body, key), false);
    });
    await withoutGrant('intake_load', async () => {const denied = check(await get('/profiles'), 'context'); assert.deepEqual(denied.offers, []);
      assert.deepEqual(denied, {...contextBody, offers: []});});
    const changed = await env.admin.query("UPDATE intake_control.profile SET revealable=false WHERE format='text-utf8/1'"); assert.equal(changed.rowCount, 1);
    try {
      const hidden = check(await get('/profiles'), 'context');
      assert.equal(hidden.availability.profiles.some(row => row.format_profile === 'text-utf8/1'), false);
      assert.equal(JSON.stringify(hidden).includes('revealable'), false);
      assert.equal(JSON.stringify(hidden).includes('hidden_count'), false);
    } finally {await env.admin.query("UPDATE intake_control.profile SET revealable=true WHERE format='text-utf8/1'");}
    const receiptBody = check(await get('/receptions/' + receipt.reception_id), 'reception'); assert.ok(receiptBody.offers.includes('inspect_original'));
    await withoutGrant('intake_original', async () => {const denied = check(await get('/receptions/' + receipt.reception_id), 'reception');
      assert.deepEqual(denied, {...receiptBody, offers: receiptBody.offers.filter(x => x !== 'inspect_original')});});
    const extracted = check(await get('/extractions/' + receipt.job_id), 'extraction'); assert.deepEqual(extracted.offers, ['prepare']);
    await withoutGrant('intake_prepare', async () => {assert.deepEqual(check(await get('/extractions/' + receipt.job_id), 'extraction'), {...extracted, offers: []});});
    const prepared = await fixture(), journal = JSON.parse(prepared.journal), preparation = journal.entries.at(-1).references.preparation;
    const inspected = check(await lookup({kind: 'preparation_inspection', preparation}), 'preparation_inspection'); assert.deepEqual(inspected.offers, ['propose']);
    await withoutGrant('intake_prepare', async () => {assert.deepEqual(check(await lookup({kind: 'preparation_inspection', preparation}), 'preparation_inspection'), {...inspected, offers: []});});
    await reset(prepared.journal); await recover(prepared.key); await inspect(prepared.key); await draftProposal(); await propose();
    const proposal = JSON.parse(await storedJournal()).entries.at(-1).references.proposal;
    const confirmed = check(await lookup({kind: 'proposal_inspection', proposal}), 'proposal_inspection'); assert.deepEqual(confirmed.offers, ['constitute']);
    await withoutGrant('intake_constitute', async () => {assert.deepEqual(check(await lookup({kind: 'proposal_inspection', proposal}), 'proposal_inspection'), {...confirmed, offers: []});});
    const staged = await fixture('staged'), entry = JSON.parse(staged.journal).entries.at(-1);
    const body = {kind: 'preparation_attempt', attempt_id: entry.references.attemptId, document: entry.references.document};
    const attempt = check(await lookup(body), 'preparation_attempt'); assert.deepEqual(attempt.offers, ['finalize_preparation']);
    await withoutGrant('intake_prepare', async () => {assert.deepEqual(check(await lookup(body), 'preparation_attempt'), {...attempt, offers: []});});
    observations.push({case: 'W25', deniedContext: 404, hiddenProfileRows: 0, omittedOffers: ['receive', 'inspect_original', 'prepare', 'propose', 'constitute', 'finalize_preparation'],
      comparisons: 'Actual JSON, exact positive except the independently denied offer; no internal explanation field.'});
  }));

  await t.test('W26 a late proposal A cannot replace confirmation B within the same session', async () => observer.run('W26', async () => {
    const aKey = await proposed(), a = JSON.parse(await storedJournal()), aRef = a.entries.at(-1).references.proposal;
    const bKey = await proposed(), b = JSON.parse(await storedJournal()), bRef = b.entries.at(-1).references.proposal;
    assert.notEqual(aRef.id, bRef.id);
    await reset(JSON.stringify({...a, entries: [...a.entries, ...b.entries]})); await recover(bKey);
    let view = page.getByRole('region', {name: 'Review the exact proposal', exact: true});
    assert.ok((await view.textContent()).includes(bRef.sha256));
    await view.getByRole('button', {name: 'Back', exact: true}).first().click();
    const held = await holdResponse(context, page, request => request.method === 'POST' &&
      new URL(request.url).pathname === '/api/intake/operations/lookup' && JSON.parse(request.postData).kind === 'proposal_inspection' && JSON.parse(request.postData).proposal.id === aRef.id);
    try {
      await card(aKey).getByRole('button', {name: 'Check recorded outcome', exact: true}).click(); await held.wait();
      await page.locator(`aside li[data-item-key="${bKey}"] button`).click();
      await card(bKey).getByRole('button', {name: 'Review proposal', exact: true}).click();
      await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor(); await ready();
      await held.release();
      view = page.getByRole('region', {name: 'Review the exact proposal', exact: true});
      assert.deepEqual({b: (await view.textContent()).includes(bRef.sha256), a: (await view.textContent()).includes(aRef.sha256),
        selected: await page.locator(`aside li[data-item-key="${bKey}"] button`).getAttribute('aria-current')}, {b: true, a: false, selected: 'true'});
      observations.push({case: 'W26', a: aRef, b: bRef, sameSession: true, lateAAdopted: false, confirmationRemainsB: true});
    } finally {await held.close();}
  }));

  await t.test('W27 preparation discard is local and mounted editor/confirmation return focus logically', async () => observer.run('W27', async () => {
    await editor();
    const before = await counts(), journalBefore = await storedJournal();
    await page.getByRole('button', {name: 'Discard local draft', exact: true}).click();
    await card(baseKey).getByRole('button', {name: 'Prepare', exact: true}).click();
    const heading = page.getByRole('heading', {name: 'Human preparation', exact: true});
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
    assert.equal(await heading.evaluate(element => element === document.activeElement), true);
    const view = page.getByRole('region', {name: 'Human preparation', exact: true});
    assert.deepEqual(await Promise.all(['Function', 'Basis', 'Scope of use'].map(name => view.getByLabel(name, {exact: true}).inputValue())), ['', '', '']);
    assert.deepEqual({persisted: await counts(), journal: await storedJournal()}, {persisted: before, journal: journalBefore});
    await view.getByRole('button', {name: 'Back', exact: true}).first().click();
    const filterId = await page.getByLabel('Filter current work', {exact: true}).getAttribute('id');
    await page.waitForFunction(id => document.activeElement?.id === id, filterId);
    // Select a real origin row before entering, so Back has that concrete target.
    const row = page.locator(`aside li[data-item-key="${baseKey}"] button`); await row.click();
    await card(baseKey).getByRole('button', {name: 'Prepare', exact: true}).click();
    await page.getByRole('region', {name: 'Human preparation', exact: true}).getByRole('button', {name: 'Back', exact: true}).first().click();
    await page.waitForFunction(key => document.activeElement?.closest('li')?.getAttribute('data-item-key') === key, baseKey);
    const p = await fixture(); await reset(p.journal); await recover(p.key);
    const proposalRow = page.locator(`aside li[data-item-key="${p.key}"] button`); await proposalRow.click();
    await inspect(p.key); await draftProposal(); await propose();
    const confirmation = page.getByRole('region', {name: 'Review the exact proposal', exact: true});
    assert.equal(await confirmation.getByRole('heading', {name: 'Review the exact proposal', exact: true}).evaluate(element => element === document.activeElement), true);
    const beforeBack = await counts(); await confirmation.getByRole('button', {name: 'Back', exact: true}).first().click();
    await page.waitForFunction(key => document.activeElement?.closest('li')?.getAttribute('data-item-key') === key, p.key);
    assert.deepEqual(await counts(), beforeBack);
    observations.push({case: 'W27', draftDiscardPersistedEffects: 0, classificationCleared: true,
      focus: ['editor heading', 'origin row after editor Back', 'confirmation heading', 'origin row after confirmation Back'], backConstitutions: 0});
  }));
}
