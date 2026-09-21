import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {original as fixture, MARKDOWN} from '../extraction/references/cases.mjs';
import {CSV_REFERENCES} from '../extraction/references/csv.mjs';
import {apiOrigin} from '../../access/journey_environment.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const condition = 'Under condition Z, receipt R replaces receipt Q.';
const cause = 'Explicit human preparation retains the source and declares its applicable condition.';
export async function workspacePreparation(t, {env, intake, client, request, controlled, page, context, observer,
  reference, receipt, original, observations, requests, errors,checkpoint}) {
  const extractor = new ExtractionService(intake,{barrier:async(label,event)=>{
    if(label==='extraction_phase_committed')checkpoint?.stage('phase_committed',event.jobId,event.phaseId);
    if(label==='before_extraction_input_dispatch')checkpoint?.stage('input_dispatch_enter',event.jobId);
    if(label==='after_extraction_launch')checkpoint?.stage('parser_launch_observed',event.jobId,event.phaseId);
  }}), rows = () => page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]');
  const byKey = key => page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${key}"]`);
  const ready = () => page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
  const back = async () => {await page.getByRole('button', {name: 'Back', exact: true}).first().click(); await ready();};
  const effectCount = async operation => (await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.editorial_effect WHERE operation=$1', [operation])).rows[0].n;
  const candidateCount = async () => (await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.candidate')).rows[0].n;
  const lookup = async body => request('/api/intake/operations/lookup', {client,
    headers: {accept: 'application/vnd.ledgerdesk.intake-workspace+json'}, body: {profile: 'intake-workspace/1', ...body}});
  const responseTo = (method, suffix) => page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname.endsWith(suffix));
  const queryResponse = kind => page.waitForResponse(r => r.request().method() === 'POST' &&
    new URL(r.url()).pathname === '/api/intake/operations/lookup' && r.request().postDataJSON()?.kind === kind);
  const observedJson = async response => {
    const failure = await response.finished();
    assert.equal(failure, null, 'The observed response must finish before reading its body.');
    return response.json();
  };
  const addSource = async (name, bytes, mime = 'text/plain') => {
    await ready();
    if (!await page.getByLabel('Choose files', {exact: true}).count()) await page.getByRole('button', {name: 'Add material', exact: true}).click();
    await page.getByLabel('Choose files', {exact: true}).setInputFiles({name, mimeType: mime, buffer: bytes});
    const card = rows().filter({hasText: name}); const key = await card.getAttribute('data-item-key');
    await card.getByRole('button', {name: 'Receive', exact: true}).click();
    await card.getByText('Original received. Extraction and preparation are separate stages.', {exact: true}).waitFor();
    const found = (await env.admin.query(`SELECT r.id AS reception_id,rcp.*,w.id AS job_id FROM intake_trial.reception r
      JOIN intake_trial.receipt rcp ON rcp.reception_id=r.id JOIN intake_trial.work w ON w.receipt_id=rcp.id
      WHERE r.declaration->>'name'=$1`, [name])).rows;
    assert.equal(found.length, 1); assert.equal(found[0].sha256, hash(bytes));
    return {key, receipt: found[0]};
  };
  const edit = async (source, {withCondition = true, correction = false, dependency = false} = {}) => {
    checkpoint?.stage('dispatch_enter',source.receipt.job_id);
    await extractor.dispatch(source.receipt.job_id);
    checkpoint?.stage('dispatch_returned',source.receipt.job_id);
    checkpoint?.stage('accept_enter',source.receipt.job_id);
    await extractor.accept(source.receipt.job_id);
    checkpoint?.stage('accept_returned',source.receipt.job_id);
    await byKey(source.key).getByRole('button', {name: 'Refresh', exact: true}).click();
    await byKey(source.key).getByRole('button', {name: 'Prepare', exact: true}).waitFor(); await ready();
    await byKey(source.key).getByRole('button', {name: 'Prepare', exact: true}).click();
    const editor = page.getByRole('region', {name: 'Human preparation', exact: true});
    await editor.getByLabel('Function', {exact: true}).waitFor();
    assert.deepEqual(await Promise.all(['Function', 'Basis', 'Scope of use'].map(label => editor.getByLabel(label, {exact: true}).inputValue())), ['', '', '']);
    for (const checkbox of await editor.locator('section[data-element-id] input[type=checkbox]').all()) await checkbox.check();
    await editor.getByLabel('Function', {exact: true}).selectOption('normative');
    await editor.getByLabel('Basis', {exact: true}).selectOption('non_authoritative_reference');
    await editor.getByLabel('Scope of use', {exact: true}).selectOption('situated');
    const examination = editor.locator('fieldset').filter({has: page.locator('legend', {hasText: /^Examination$/})});
    await examination.getByLabel('Outcome', {exact: true}).selectOption('classifiable');
    await examination.getByLabel('Reason', {exact: true}).fill('A bounded, explicit human declaration, not automatic semantic validation.');
    await editor.getByLabel('Coverage explanation', {exact: true}).fill('Only the examined selection; retained extraction limits still apply.');
    if (withCondition) {
      await editor.getByRole('button', {name: 'Add condition', exact: true}).click();
      await editor.getByLabel('Condition text', {exact: true}).fill(condition);
      await editor.getByLabel('Condition scope', {exact: true}).fill('AZ-17');
    }
    if (correction) {
      const element = editor.locator('section[data-element-id]').first();
      await element.getByRole('button', {name: 'Add a correction', exact: true}).click();
      const text = await element.getByLabel('Text correction', {exact: true}).inputValue();
      await element.getByLabel('Text correction', {exact: true}).fill(text + 'Human annotation: synthetic only.\n');
    }
    if (dependency) {
      const ids = await editor.locator('section[data-element-id]').evaluateAll(elements => elements.map(e => e.dataset.elementId));
      assert.equal(ids.length, 2);
      await editor.getByRole('button', {name: 'Add dependency', exact: true}).click();
      await editor.getByLabel('From', {exact: true}).fill(ids[0]); await editor.getByLabel('To', {exact: true}).fill(ids[1]);
    }
    if (withCondition || correction || dependency) await editor.getByLabel('Reason for this preparation', {exact: true}).fill(cause);
    return editor;
  };
  const save = async key => {
    const response = responseTo('POST', '/finalize');
    await page.getByRole('button', {name: 'Save preparation', exact: true}).click();
    const received = await response; assert.equal(received.status(), 200); const effect = await observedJson(received);
    await byKey(key).getByRole('button', {name: 'Inspect preparation', exact: true}).waitFor(); await ready();
    return effect;
  };
  const inspect = async key => {
    const pending = queryResponse('preparation_inspection');
    await byKey(key).getByRole('button', {name: 'Inspect preparation', exact: true}).click();
    const received = await pending; assert.equal(received.status(), 200); const value = await observedJson(received);
    await page.getByLabel('Prepared unit', {exact: true}).waitFor(); await ready(); return value;
  };
  const draftProposal = async (target, judgment = 'distinct') => {
    await page.getByLabel('Prepared unit', {exact: true}).selectOption('selected-material');
    if (target) {
      await page.getByLabel('Target', {exact: true}).selectOption('relationship');
      await page.getByLabel('Target unit ID', {exact: true}).fill(target.id);
      await page.getByLabel('Exact target version ID', {exact: true}).fill(target.id);
      await page.getByLabel('Revision', {exact: true}).fill(String(target.revision));
      await page.getByLabel('SHA-256', {exact: true}).fill(target.sha256);
      await page.getByLabel('Use this exact target as comparison evidence', {exact: true}).check();
    }
    await page.getByLabel('Target declaration', {exact: true}).fill('An explicit synthetic target, not a filename or similarity inference.');
    await page.getByLabel('Identity judgment', {exact: true}).selectOption(judgment);
    await page.getByRole('group', {name: 'Candidate proposal', exact: true}).getByLabel('Reason', {exact: true})
      .fill('An explicit comparison of the retained synthetic content and conditions.');
  };
  const propose = async () => {
    const pending = responseTo('POST', '/proposals');
    await page.getByRole('button', {name: 'Prepare exact proposal', exact: true}).click();
    const response = await pending; assert.equal(response.status(), 200); const value = await observedJson(response);
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor(); await ready(); return value;
  };
  const confirm = async () => {
    const pending = responseTo('POST', '/constitutions');
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).click();
    const response = await pending; assert.equal(response.status(), 200); const value = await observedJson(response);
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor({state: 'detached'}); await ready(); return value;
  };
  const loseResponse = async (suffix, beforeLoss = async () => {}) => {
    const cdp = await context.newCDPSession(page); let captured, failure;
    cdp.on('Fetch.requestPaused', async event => {
      try {
        if (event.request.method !== 'POST') {await cdp.send('Fetch.continueRequest', {requestId: event.requestId}); return;}
        assert.ok([200, 202].includes(event.responseStatusCode));
        const payload = await cdp.send('Fetch.getResponseBody', {requestId: event.requestId});
        captured = JSON.parse(payload.base64Encoded ? Buffer.from(payload.body, 'base64').toString('utf8') : payload.body);
        await beforeLoss(captured);
        await cdp.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'ConnectionReset'});
      } catch (error) {failure = error; await cdp.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'Failed'}).catch(() => {});}
    });
    await cdp.send('Fetch.enable', {patterns: [{urlPattern: apiOrigin + suffix, requestStage: 'Response'}]});
    return {finish: async () => {await cdp.send('Fetch.disable'); await cdp.detach(); if (failure) throw failure; assert.ok(captured); return captured;}};
  };
  let firstKey = await rows().filter({hasText: reference.name}).getAttribute('data-item-key'), firstPrepared, firstCandidate;
  writeFileSync('/work/output/workspace-preparation-reference.json', JSON.stringify({source: reference, condition, cause,
    correction: 'Human annotation: synthetic only.\n', expectedEditorialState: 'candidate'}, null, 2), {flag: 'wx'});

  await t.test('W09 real human preparation persists exact original provenance, a correction and its difference', async () => observer.run('W09', async () => {
    await edit({key: firstKey, receipt}, {correction: true});
    const before = await candidateCount(), saved = await save(firstKey), inspected = await inspect(firstKey);
    firstPrepared = inspected.preparation;
    assert.deepEqual(firstPrepared.reference, saved.result.preparation);
    assert.equal(firstPrepared.payload.elements.map(e => e.text).join(''),
      'AZ-17\nHuman annotation: synthetic only.\nFor procedure AZ-17, receipt Q is required.\nUnder condition Z, receipt R replaces receipt Q.\n');
    assert.equal(firstPrepared.payload.conditions[0].text, condition);
    assert.equal(firstPrepared.payload.inputs[0].original.sha256, reference.sha256);
    assert.equal(firstPrepared.differences[0].body.reason, cause);
    assert.equal(firstPrepared.differences[0].body.actor, controlled.account.id);
    assert.equal(firstPrepared.differences[0].body.after.id, firstPrepared.reference.id);
    assert.equal(await candidateCount(), before);
    const source = await request('/api/intake/receptions/' + receipt.reception_id + '/original', {client});
    assert.deepEqual(source.bytes, original);
    await page.getByText(cause, {exact: true}).waitFor();
    await page.screenshot({path: '/work/output/workspace-prepared-differences.png', fullPage: true});
    observations.push({case: 'W09', preparation: firstPrepared.reference, difference: firstPrepared.differences[0].reference,
      candidateDelta: 0, originalUnchanged: true});
  }));
  if (!firstPrepared) throw Error('WORKSPACE_PREPARATION_PREREQUISITE');
  await t.test('W10 exact inspected proposal constitutes one candidate and neither approves nor publishes', async () => observer.run('W10', async () => {
    await draftProposal(); const proposed = await propose();
    const displayed = page.getByRole('region', {name: 'Review the exact proposal', exact: true});
    assert.ok((await displayed.innerText()).includes(proposed.result.proposal.sha256));
    assert.ok((await displayed.innerText()).includes(firstPrepared.reference.sha256));
    assert.ok((await displayed.innerText()).includes(condition));
    const before = await candidateCount(), outcome = await confirm(); firstCandidate = outcome.result.candidates[0];
    assert.equal(outcome.result.outcome, 'constituted'); assert.equal(await candidateCount(), before + 1);
    const saved = (await env.admin.query('SELECT * FROM intake_trial.candidate WHERE unit_id=$1', [firstCandidate.id])).rows[0];
    assert.equal(saved.editorial_state, 'candidate'); assert.deepEqual(saved.provenance.preparation, firstPrepared.reference);
    assert.equal(await page.getByText('Candidate constituted. It is not approved or published.', {exact: true}).count(), 1);
    observations.push({case: 'W10', proposal: proposed.result.proposal, preparation: firstPrepared.reference, effect: outcome.effect,
      candidate: firstCandidate, editorialState: saved.editorial_state});
    await page.screenshot({path: '/work/output/workspace-candidate.png', fullPage: true}); await back();
  }));
  if (!firstCandidate) throw Error('WORKSPACE_CANDIDATE_PREREQUISITE');
  for (const [label, change, expected] of [['relationship', false, 'relationship_recorded'], ['collision', true, 'blocked']])
    await t.test('W11 ' + label + ' is a distinct real disposition without another candidate', async () => observer.run('W11-' + label, async () => {
      const source = await addSource('identity-' + label + '.txt', original);
      const editor = await edit(source, {correction: true});
      if (change) await editor.getByLabel('Condition text', {exact: true}).fill('Only applies during a different synthetic interval W.');
      await save(source.key); await inspect(source.key); await draftProposal(firstCandidate, 'same_version');
      await propose(); const before = await candidateCount(), result = await confirm();
      assert.deepEqual({outcome: result.result.outcome, candidateDelta: await candidateCount() - before}, {outcome: expected, candidateDelta: 0});
      assert.equal(await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).count(), 0);
      if (change) assert.equal(result.result.block_kind, 'identity_collision');
      else assert.deepEqual(result.result.relationships[0].version, firstCandidate);
      observations.push({case: 'W11-' + label, effect: result.effect, outcome: result.result.outcome, candidateDelta: 0}); await back();
    }));
  await t.test('W12 visible Markdown, CSV and XLSX preserve independent lexical, cache and context facts', async () => observer.run('W12', async () => {
    for (const name of ['inert.md', 'table.csv', 'cache-discrepant.xlsx', 'unsupported-part.xlsx']) {
      const input = await fixture(name), workbook = name.endsWith('.xlsx');
      const source = await addSource(name, input.bytes, workbook ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : name.endsWith('.md') ? 'text/markdown' : 'text/csv');
      await edit(source, {withCondition: workbook, dependency: workbook}); await save(source.key);
      const inspected = await inspect(source.key), region = page.getByRole('region', {name: 'Human preparation', exact: true});
      const payload = inspected.preparation.payload;
      if (workbook) {
        const table = region.locator('section[data-block-id="sheet-1"]');
        const cellRows = await table.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent)));
        const at = address => cellRows.find(cells => cells[0] === address);
        assert.deepEqual(at('A2').slice(0, 3), ['A2', 'text', '001']);
        const cached = name === 'cache-discrepant.xlsx' ? '24.00' : '25.00';
        assert.deepEqual(at('D2'), ['D2', 'number_lexical', cached, 'B2*C2', 'number_lexical', cached, '0.00']);
        assert.deepEqual(['B3', 'B4', 'B5'].map(address => at(address).slice(1, 3)), [['empty', ''], ['number_lexical', '0'], ['error', '#N/A']]);
        assert.equal(at('A7')[2], 'Amounts are in USD and exclude tax.');
        assert.equal(at('B8')[3], "'Conditions'!B2"); assert.equal(at('B8')[5], condition);
        assert.ok((await region.locator('section[data-block-id="sheet-2"]').innerText()).includes('hidden'));
        if (name === 'unsupported-part.xlsx') assert.ok(payload.components.some(c => c.coverage !== 'complete'));
        assert.equal(payload.relations[0].origin, 'prepared');
        if (name === 'unsupported-part.xlsx') assert.ok((await region.innerText()).includes('Partial'));
        await page.screenshot({path: '/work/output/workspace-' + name + '-inspection.png', fullPage: true});
      } else if (name.endsWith('.md')) {
        assert.equal(payload.elements.map(e => e.text).join(''), MARKDOWN);
        assert.equal((await region.getByTestId('intake-exact-text').allTextContents()).join(''), MARKDOWN);
        assert.equal(await region.locator('script,img,iframe').count(), 0);
      } else {
        assert.deepEqual(payload.elements[0].rows.map(r => r.fields), CSV_REFERENCES[name].fields);
        const cells = await region.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent)));
        assert.deepEqual(cells.map(c => c.slice(1)), CSV_REFERENCES[name].fields, 'Exact DOM text retains CRLF and positional duplicate headers.');
        const displayed = await region.locator('tbody tr').nth(2).locator('td').nth(4).evaluate(cell => {
          const text = cell.firstChild, lower = cell.textContent.indexOf('Line two');
          const first = document.createRange(), second = document.createRange();
          first.setStart(text, 0); first.setEnd(text, 8); second.setStart(text, lower); second.setEnd(text, lower + 8);
          return {text: cell.textContent, displayedText: cell.innerText, whiteSpace: getComputedStyle(cell).whiteSpace,
            firstTop: first.getBoundingClientRect().top, secondTop: second.getBoundingClientRect().top};
        });
        assert.equal(displayed.whiteSpace, 'pre-wrap');
        assert.equal(displayed.displayedText.replace(/\r\n/g, '\n'), 'Line one\nLine two');
        assert.ok(displayed.secondTop > displayed.firstTop, JSON.stringify(displayed));
        observations.push({case: 'W12-csv-line-layout', ...displayed});
        await page.screenshot({path: '/work/output/workspace-csv-inspection.png', fullPage: true});
      }
      observations.push({case: 'W12', name, preparation: inspected.preparation.reference,
        componentObservations: payload.components.map(c => ({id: c.id, coverage: c.coverage, limitations: c.limitations}))}); await back();
    }
  }));
  await t.test('W13 lost staging reply recovers current staged state and explicitly finalizes without reupload', async () => observer.run('W13', async () => {
    const source = await addSource('staging-recovery.txt', original); await edit(source);
    const fault = await loseResponse('/api/intake/preparation-attempts/*/content');
    const before = await effectCount('finalize_preparation');
    await page.getByRole('button', {name: 'Save preparation', exact: true}).click();
    await byKey(source.key).getByText('Preparation is not confirmed. Reconcile the retained operation before repeating an effect.', {exact: true}).waitFor();
    const lost = await fault.finish(); assert.equal(lost.result.state, 'staged');
    const uploads = requests.filter(r => r.method === 'POST' && r.path.endsWith('/content')).length;
    await page.reload(); await byKey(source.key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
    await byKey(source.key).getByRole('button', {name: 'Continue staged preparation', exact: true}).waitFor(); await ready();
    assert.equal(await effectCount('finalize_preparation'), before);
    await byKey(source.key).getByRole('button', {name: 'Continue staged preparation', exact: true}).click();
    await byKey(source.key).getByRole('button', {name: 'Inspect preparation', exact: true}).waitFor(); await ready();
    assert.equal(await effectCount('finalize_preparation'), before + 1);
    assert.equal(requests.filter(r => r.method === 'POST' && r.path.endsWith('/content')).length, uploads);
    observations.push({case: 'W13', attempt: lost.result.attempt_id, document: lost.result.document, uploadsRepeated: 0, finalizations: 1});
    const inspected = await inspect(source.key); assert.equal(inspected.preparation.reference.id, lost.result.preparation.id);
    await draftProposal();
    const proposalFault = await loseResponse('/api/intake/preparations/*/revisions/*/proposals');
    const proposedBefore = await effectCount('propose');
    await page.getByRole('button', {name: 'Prepare exact proposal', exact: true}).click();
    await page.getByRole('button', {name: 'Prepare exact proposal', exact: true}).waitFor({state: 'detached'});
    const proposalLost = await proposalFault.finish(); await page.reload();
    await byKey(source.key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor(); await ready();
    assert.equal(await effectCount('propose'), proposedBefore + 1);
    assert.ok((await page.getByRole('region', {name: 'Review the exact proposal', exact: true}).innerText()).includes(proposalLost.result.proposal.sha256));
    observations.push({case: 'W13-proposal', recoveredProposal: proposalLost.result.proposal, repeatedProposalEffects: 0});
    const constitutionFault = await loseResponse('/api/intake/constitutions', async value => {
      const recorded = (await env.admin.query('SELECT reference FROM intake_trial.editorial_effect WHERE id=$1', [value.operation_id])).rows[0];
      assert.deepEqual(recorded.reference, value.effect);
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_constitute'", [controlled.account.id]);
    });
    const constitutedBefore = await effectCount('constitute');
    await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).click(); await ready();
    const constitutionLost = await constitutionFault.finish(); await page.reload();
    await byKey(source.key).getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
    await byKey(source.key).getByText('Candidate constituted. It is not approved or published.', {exact: true}).waitFor(); await ready();
    assert.equal(await effectCount('constitute'), constitutedBefore + 1);
    const journal = JSON.parse(await page.evaluate(() => sessionStorage.getItem('ledgerdesk.intake.locators.v1')));
    const entry = journal.entries.find(e => e.itemKey === source.key && e.operation === 'constitute');
    const restored = await lookup({kind: 'preparation_effect', variant: 'constitute', client_key: entry.key});
    assert.equal(restored.status, 200); assert.deepEqual(restored.body.effect.effect, constitutionLost.effect);
    observations.push({case: 'W13-constitution', effect: constitutionLost.effect, recoveredEffect: restored.body.effect.effect,
      newConstitutionFaculty: 'withdrawn', query: 'retained', repeatedConstitutionEffects: 0});
  }));
  assert.deepEqual(errors, []);
}
