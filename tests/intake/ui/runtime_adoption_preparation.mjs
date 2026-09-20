import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {emptyPreparationDraft, preparationDocument} from '../../../src/components/intake/preparation.ts';
import {IntakeJournal, JOURNAL_KEY} from '../../../src/components/intake/journal.ts';
import {preparationCanonical} from '../../../src/contracts/intake_preparation.ts';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {preparationContext} from '../preparation/runtime_control.mjs';
import {apiOrigin, uiOrigin} from '../../access/journey_environment.mjs';
import {holdResponse, installSession, assertNoAdoption} from './response_hold.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const profile = {profile: 'intake/1', representation: 'intake-preparation/1'};
const pathOf = request => new URL(request.url).pathname;
const command = suffix => request => request.method === 'POST' && pathOf(request).endsWith(suffix);
const query = (kind, variant) => request => request.method === 'POST' && pathOf(request) === '/api/intake/operations/lookup' &&
  JSON.parse(request.postData).kind === kind && (!variant || JSON.parse(request.postData).variant === variant);

export async function workspaceAdoptionPreparation(t, {env, intake, client, request, page, context, observer, receipt, controlled, observations, requests, login}) {
  const baseJournal = await page.evaluate(key => sessionStorage.getItem(key), JOURNAL_KEY), baseKey = JSON.parse(baseJournal).entries[0].itemKey;
  const extraction = new ExtractionService(intake);
  await extraction.dispatch(receipt.job_id); await extraction.accept(receipt.job_id);
  const extracted = await request('/api/intake/extractions/' + receipt.job_id, {client}); assert.equal(extracted.status, 200);
  const replacement = await login('reader@example.test');
  const card = key => page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${key}"]`);
  const ready = () => page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
  const reset = async journal => {
    await installSession(context, client);
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [JOURNAL_KEY, journal]);
    await page.reload(); await page.getByLabel('Choose files', {exact: true}).waitFor();
  };
  const recover = async key => {await card(key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click(); await ready();};
  const inspect = async key => {
    await card(key).getByRole('button', {name: 'Inspect preparation', exact: true}).click();
    await page.getByLabel('Prepared unit', {exact: true}).waitFor(); await ready();
  };
  const draftProposal = async () => {
    await page.getByLabel('Prepared unit', {exact: true}).selectOption('selected-material');
    await page.getByLabel('Target declaration', {exact: true}).fill('A distinct synthetic adoption control.');
    await page.getByLabel('Identity judgment', {exact: true}).selectOption('distinct');
    await page.getByRole('group', {name: 'Candidate proposal', exact: true}).getByLabel('Reason', {exact: true}).fill('The exact retained preparation and condition identify this control.');
  };
  const propose = async () => {
    await page.getByRole('button', {name: 'Prepare exact proposal', exact: true}).click();
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor(); await ready();
  };
  const confirm = async () => {
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).click();
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor({state: 'detached'}); await ready();
  };
  const call = async (path, options) => {
    const response = await request('/api/intake' + path, {...options, client, headers: {accept: 'application/vnd.ledgerdesk.intake-preparation+json'}});
    assert.ok([200, 202].includes(response.status), JSON.stringify(response.body)); return response.body;
  };
  let ordinal = 0;
  const fixture = async (state = 'prepared') => {
    const identity = ++ordinal;
    const draft = {...emptyPreparationDraft(), selected: extracted.body.result.content.elements.map(row => row.id),
      classification: {function: {value: 'normative', reason: ''}, basis: {value: 'non_authoritative_reference', reason: ''}, scope: {value: 'situated', reason: ''}},
      examination: {outcome: 'classifiable', reason: 'Explicit synthetic selection.'},
      coverage: {completeSourceClaim: false, reason: 'Only the examined source is claimed.'},
      conditions: [{id: 'adoption-condition', text: 'Applicable only to adoption control ' + identity, scope: 'AZ-17'}],
      changeReason: 'Record the condition of this independently identified synthetic control.'};
    const built = preparationDocument(extracted.body, draft), bytes = Buffer.from(JSON.stringify(built.document));
    const itemKey = randomUUID(), values = new Map(), journal = new IntakeJournal({getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)},
      {deployment: intake.deployment, uiOrigin, terminalOrigin: apiOrigin});
    const reservationKey = randomUUID(), reservationBody = {...profile, inputs: built.inputs, base: null, selection: built.selection,
      document: {bytes: bytes.length, sha256: hash(bytes)}, context: preparationContext};
    const reserved = await call('/preparation-attempts', {key: reservationKey, body: reservationBody}), attempt = reserved.result;
    journal.retain({id: randomUUID(), itemKey, operation: 'reserve_preparation', profile: 'intake-preparation/1', key: reservationKey,
      fingerprint: hash(preparationCanonical('reserve_preparation', {}, reservationBody, canonicalValue)), references: {attemptId: attempt.attempt_id, document: attempt.document}});
    if (state !== 'reserved') {
      const staged = await call('/preparation-attempts/' + attempt.attempt_id + '/content', {bytes});
      journal.retain({id: randomUUID(), itemKey, operation: 'upload_preparation', profile: 'intake-preparation/1', key: null,
        fingerprint: hash(bytes), references: {attemptId: attempt.attempt_id, document: staged.result.document}});
      if (state === 'prepared') {
        const key = randomUUID(), body = {...profile, expected_revision: attempt.preparation.revision, document: staged.result.document, differences: []};
        const retained = await call('/preparation-attempts/' + attempt.attempt_id + '/finalize', {key, body});
        journal.retain({id: randomUUID(), itemKey, operation: 'finalize_preparation', profile: 'intake-preparation/1', key,
          fingerprint: hash(preparationCanonical('finalize_preparation', {id: attempt.attempt_id}, body, canonicalValue)),
          references: {preparation: retained.result.preparation}});
      }
    }
    return {key: itemKey, journal: values.get(JOURNAL_KEY)};
  };
  const prepared = async () => {const value = await fixture(); await reset(value.journal); await recover(value.key); return value.key;};
  const inspected = async () => {const key = await prepared(); await inspect(key); await draftProposal(); return key;};
  const proposed = async () => {const key = await inspected(); await propose(); return key;};
  const recoverySetup = async state => {const value = await fixture(state); await reset(value.journal); return value.key;};
  const editor = async () => {
    await reset(baseJournal); await recover(baseKey);
    await card(baseKey).getByRole('button', {name: 'Prepare', exact: true}).click();
    const view = page.getByRole('region', {name: 'Human preparation', exact: true}); await view.getByLabel('Function', {exact: true}).waitFor();
    for (const checkbox of await view.locator('section[data-element-id] input[type=checkbox]').all()) await checkbox.check();
    await view.getByLabel('Function', {exact: true}).selectOption('normative');
    await view.getByLabel('Basis', {exact: true}).selectOption('non_authoritative_reference');
    await view.getByLabel('Scope of use', {exact: true}).selectOption('situated');
    const examination = view.locator('fieldset').filter({has: page.locator('legend', {hasText: /^Examination$/})});
    await examination.getByLabel('Outcome', {exact: true}).selectOption('classifiable');
    await examination.getByLabel('Reason', {exact: true}).fill('An explicit bounded human selection.');
    await view.getByLabel('Coverage explanation', {exact: true}).fill('Only the selected source.'); return baseKey;
  };
  const preparedPositive = async key => {await card(key).getByRole('button', {name: 'Inspect preparation', exact: true}).waitFor(); await ready();};
  const proposalPositive = async () => {await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor(); await ready();};
  const effectRecovery = async (constituted = false) => {
    const key = await proposed(); if (constituted) await confirm();
    const journal = await page.evaluate(key => sessionStorage.getItem(key), JOURNAL_KEY); await reset(journal); return key;
  };
  if (process.env.LEDGERDESK_PREPARATION_CASES === 'ui-disclosure-navigation') {
    const {workspaceDisclosureNavigation} = await import('./runtime_disclosure_navigation.mjs');
    await workspaceDisclosureNavigation(t, {env, client, request, controlled, receipt, page, context, observer, observations,
      fixture, reset, recover, inspect, draftProposal, propose, proposed, editor, card, ready, baseKey});
    return;
  }
  const examples = [
    ...[['preparation-reservation', '/preparation-attempts'], ['preparation-upload', '/content'], ['preparation-finalization', '/finalize']]
      .map(([site, suffix]) => ({site, match: command(suffix), setup: editor, act: () => page.getByRole('button', {name: 'Save preparation', exact: true}).click(), positive: preparedPositive})),
    {site: 'preparation-effect-reserved', match: query('preparation_effect', 'reserve_preparation'), setup: () => recoverySetup('reserved'), act: recover,
      positive: key => card(key).getByText('Retained preparation result: reserved. No operation was repeated.', {exact: true}).waitFor()},
    {site: 'preparation-effect-prepared', match: query('preparation_effect', 'finalize_preparation'), setup: () => recoverySetup('prepared'), act: recover, positive: preparedPositive},
    {site: 'preparation-attempt-recovery', match: query('preparation_attempt'), setup: () => recoverySetup('staged'), act: recover,
      positive: key => card(key).getByText('Retained preparation result: staged. No operation was repeated.', {exact: true}).waitFor()},
    {site: 'preparation-continue-finalization', match: command('/finalize'), setup: async () => {const key = await recoverySetup('staged'); await recover(key); return key;},
      act: key => card(key).getByRole('button', {name: 'Continue staged preparation', exact: true}).click(), positive: preparedPositive},
    {site: 'preparation-inspection', match: query('preparation_inspection'), setup: prepared,
      act: key => card(key).getByRole('button', {name: 'Inspect preparation', exact: true}).click(), positive: () => page.getByLabel('Prepared unit', {exact: true}).waitFor()},
    {site: 'proposal-creation', match: command('/proposals'), setup: inspected,
      act: () => page.getByRole('button', {name: 'Prepare exact proposal', exact: true}).click(), positive: proposalPositive},
    {site: 'proposal-inspection-after-creation', match: query('proposal_inspection'), setup: inspected,
      act: () => page.getByRole('button', {name: 'Prepare exact proposal', exact: true}).click(), positive: proposalPositive},
    {site: 'proposal-effect-recovery', match: query('preparation_effect', 'propose'), setup: () => effectRecovery(), act: recover, positive: proposalPositive},
    {site: 'proposal-inspection-after-recovery', match: query('proposal_inspection'), setup: () => effectRecovery(), act: recover, positive: proposalPositive},
    {site: 'proposal-inspection-from-review-action', match: query('proposal_inspection'), setup: async () => {
      const key = await proposed(); await page.getByRole('region', {name: 'Review the exact proposal', exact: true}).getByRole('button', {name: 'Back', exact: true}).first().click(); return key;
    }, act: key => card(key).getByRole('button', {name: 'Review proposal', exact: true}).click(), positive: proposalPositive},
    {site: 'constitution', match: command('/constitutions'), setup: proposed,
      act: () => page.getByRole('button', {name: 'Confirm this proposal', exact: true}).click(),
      positive: () => page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor({state: 'detached'})},
    {site: 'constitution-effect-recovery', match: query('preparation_effect', 'constitute'), setup: () => effectRecovery(true), act: recover,
      positive: key => card(key).getByText('Candidate constituted. It is not approved or published.', {exact: true}).waitFor()},
  ];
  for (const example of examples) await t.test('W24 ' + example.site + ' guards its actual response adoption', async () => observer.run('W24-' + example.site, async () => {
    const controls = [];
    for (const replaced of [false, true]) {
      const key = await example.setup(), held = await holdResponse(context, page, example.match);
      try {
        // Do not await a compound helper that itself waits for the held result.
        const action = example.act === recover ? card(key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click() : example.act(key);
        await action; const actual = await held.wait();
        const dispatched = requests.filter(row => row.path.startsWith('/api/intake/')).length;
        const effects = (await env.admin.query('SELECT count(*)::int n FROM intake_trial.editorial_effect')).rows[0].n;
        if (replaced) await installSession(context, replacement);
        await held.release();
        if (replaced) {
          await assertNoAdoption(page, []);
          assert.equal(requests.filter(row => row.path.startsWith('/api/intake/')).length, dispatched);
          assert.equal((await env.admin.query('SELECT count(*)::int n FROM intake_trial.editorial_effect')).rows[0].n, effects);
        } else {await example.positive(key); await ready();}
        controls.push({...actual, replaced, adopted: !replaced, durableEffectsAtHold: effects});
      } finally {await held.close(); await installSession(context, client);}
    }
    observations.push({case: 'W24', site: example.site, controls});
  }));
}
