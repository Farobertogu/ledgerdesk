import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {original as fixture, MARKDOWN} from '../extraction/references/cases.mjs';
import {CSV_REFERENCES} from '../extraction/references/csv.mjs';
import {apiOrigin} from '../../access/journey_environment.mjs';

// Test-only lifecycle helpers. A timeout is a failure, never a successful close.
export async function withDeadline(operation, label, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {const error = new Error(`${label} exceeded ${timeoutMs} ms`); if (code) error.code = code; reject(error);}, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}


const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const condition = 'Under condition Z, receipt R replaces receipt Q.';
const cause = 'Explicit human preparation retains the source and declares its applicable condition.';
export async function workspacePreparation(t, {env, intake, client, request, controlled, page, context, observer, lookupBodies,
  reference, receipt, original, observations, requests, errors,checkpoint}) {
  let activeCase = 'W09', activeFixture = 'first-real-intake.txt', primaryError = null;
  const catalogue = new Set(['first-real-intake.txt', 'identity-relationship.txt', 'identity-collision.txt',
    'inert.md', 'table.csv', 'cache-discrepant.xlsx', 'unsupported-part.xlsx', 'staging-recovery.txt']);
  const stop = () => { if (primaryError) throw primaryError; if (t.signal.aborted) throw t.signal.reason; };
  const setFixture = name => { stop(); assert.ok(catalogue.has(name)); activeFixture = name; };
  const wait = async (label, operation, unbounded = false, deadlineCode) => {
    stop();
    const name = activeCase, fixtureName = activeFixture;
    const mark = stage => {
      observer.mark(fixtureName + '.' + label + '.' + stage);
      console.log('PREPARATION_WAIT ' + name + ' ' + fixtureName + ' ' + label + ' ' + stage);
    };
    mark('entered');
    try {
      // This race cannot cancel operation. runCase stops before another case starts.
      const value = unbounded ? await withDeadline(operation, name + ' ' + fixtureName + ' ' + label, 15000, deadlineCode) : await operation();
      mark('returned'); return value;
    } catch (error) { primaryError ??= error; mark('threw'); throw error; }
  };
  const runCase = async (name, fixtureName, title, action) => {
    stop(); activeCase = name; setFixture(fixtureName);
    await t.test(title, async () => {
      try {
        return await observer.run(name, async () => {
          try { return await action(); }
          catch (error) { primaryError ??= error; throw error; }
        });
      } catch (error) { primaryError ??= error; throw primaryError; }
    });
    stop();
  };
  const extractor = new ExtractionService(intake,{barrier:async(label,event)=>{
    if(label==='extraction_phase_committed')checkpoint?.stage('phase_committed',event.jobId,event.phaseId);
    if(label==='before_extraction_input_dispatch')checkpoint?.stage('input_dispatch_enter',event.jobId);
    if(label==='after_extraction_launch')checkpoint?.stage('parser_launch_observed',event.jobId,event.phaseId);
  }}), rows = () => page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]');
  const byKey = key => page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${key}"]`);
  const ready = () => wait('browser.ready', () => page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'}));
  const back = async () => {await wait('browser.back', () => page.getByRole('button', {name: 'Back', exact: true}).first().click()); await ready();};
  const effectCount = async operation => (await wait('sql.effect-count', () => env.admin.query('SELECT count(*)::int AS n FROM intake_trial.editorial_effect WHERE operation=$1', [operation]), true)).rows[0].n;
  const candidateCount = async () => (await wait('sql.candidate-count', () => env.admin.query('SELECT count(*)::int AS n FROM intake_trial.candidate'), true)).rows[0].n;
  const lookup = async body => wait('http.lookup', () => request('/api/intake/operations/lookup', {client,
    headers: {accept: 'application/vnd.ledgerdesk.intake-workspace+json'}, body: {profile: 'intake-workspace/1', ...body}}));
  const responseTo = (method, suffix, operation) => wait(operation + '.response', () => page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname.endsWith(suffix)));
  const queryResponse = preparation => wait('inspect.response', () => page.waitForResponse(r => {
    const url = new URL(r.url());
    if (r.request().method() !== 'POST' || url.origin !== apiOrigin || url.pathname !== '/api/intake/operations/lookup') return false;
    const body = r.request().postDataJSON();
    return body?.kind === 'preparation_inspection' && ['id', 'revision', 'sha256'].every(field => body.preparation?.[field] === preparation[field]);
  }));
  const observedJson = async (response, operation) => {
    // Reading the body rejects transport failure; Playwright finished() can remain pending after requestfailed.
    try {return await wait(operation + '.response-json', () => response.json(), true, 'ERR_RESPONSE_BODY_DEADLINE');}
    catch (error) {
      const classified = error instanceof Error ? error : new Error('Response body rejected.', {cause: error});
      if (classified.code !== 'ERR_RESPONSE_BODY_DEADLINE') {
        const failure = response.request().failure()?.errorText;
        const network = typeof failure === 'string' && /^net::[A-Z0-9_]{1,64}$/.test(failure) ? ':' + failure : '';
        classified.code = failure ? 'ERR_RESPONSE_REQUEST_FAILED' + network : 'ERR_RESPONSE_BODY_REJECTED';
      }
      throw classified;
    }
  };
  const addSource = async (name, bytes, mime = 'text/plain') => {
    await ready();
    if (!await wait('add.choose-count', () => page.getByLabel('Choose files', {exact: true}).count(), true)) await wait('add.open', () => page.getByRole('button', {name: 'Add material', exact: true}).click());
    await wait('add.files', () => page.getByLabel('Choose files', {exact: true}).setInputFiles({name, mimeType: mime, buffer: bytes}));
    const card = rows().filter({hasText: name}); const key = await wait('add.item-key', () => card.getAttribute('data-item-key'));
    await wait('add.receive', () => card.getByRole('button', {name: 'Receive', exact: true}).click());
    await wait('add.received', () => card.getByText('Original received. Extraction and preparation are separate stages.', {exact: true}).waitFor());
    const found = (await wait('sql.add-source', () => env.admin.query(`SELECT r.id AS reception_id,rcp.*,w.id AS job_id FROM intake_trial.reception r
      JOIN intake_trial.receipt rcp ON rcp.reception_id=r.id JOIN intake_trial.work w ON w.receipt_id=rcp.id
      WHERE r.declaration->>'name'=$1`, [name]), true)).rows;
    assert.equal(found.length, 1); assert.equal(found[0].sha256, hash(bytes));
    return {key, receipt: found[0]};
  };
  const edit = async (source, {withCondition = true, correction = false, dependency = false} = {}) => {
    checkpoint?.stage('dispatch_enter',source.receipt.job_id);
    await wait('extractor.dispatch', () => extractor.dispatch(source.receipt.job_id));
    checkpoint?.stage('dispatch_returned',source.receipt.job_id);
    checkpoint?.stage('accept_enter',source.receipt.job_id);
    const accepted = await wait('extractor.accept', () => extractor.accept(source.receipt.job_id));
    checkpoint?.stage('accept_returned',source.receipt.job_id);
    {
      const retained = await wait('sql.accepted-result', () => env.admin.query(`SELECT j.id AS job_id,j.state,r.id AS result_id,r.effect_id,r.outcome
        FROM intake_trial.extraction_job j JOIN intake_trial.extraction_result r ON r.id=j.accepted_result AND r.job_id=j.id
        WHERE j.id=$1 AND r.id=$2 AND r.effect_id=$3`, [source.receipt.job_id,accepted.resultId,accepted.effectId]), true);
      assert.equal(retained.rows.length,1,'The accepted result must match this job and returned effect.');
      const row=retained.rows[0];
      const result={case:activeCase,fixture:activeFixture,jobId:row.job_id,resultId:row.result_id,effectId:row.effect_id,state:row.state,outcome:row.outcome};
      console.log('PREPARATION_ACCEPTED ' + JSON.stringify(result));
      observations.push({...result,stage:'accepted-result'});
      assert.equal(row.state,'accepted');
      assert.ok(['completed','partial','failed'].includes(row.outcome));
      if (activeCase.startsWith('W11-')) assert.equal(row.outcome,'completed','The controlled W11 text requires a completed accepted result before preparation.');
    }
    await wait('edit.refresh', () => byKey(source.key).getByRole('button', {name: 'Refresh', exact: true}).click());
    await wait('edit.prepare-visible', () => byKey(source.key).getByRole('button', {name: 'Prepare', exact: true}).waitFor()); await ready();
    await wait('edit.prepare', () => byKey(source.key).getByRole('button', {name: 'Prepare', exact: true}).click());
    const editor = page.getByRole('region', {name: 'Human preparation', exact: true});
    await wait('edit.function-visible', () => editor.getByLabel('Function', {exact: true}).waitFor());
    assert.deepEqual(await wait('edit.initial-values', () => Promise.all(['Function', 'Basis', 'Scope of use'].map(label => editor.getByLabel(label, {exact: true}).inputValue()))), ['', '', '']);
    for (const checkbox of await wait('edit.checkboxes', () => editor.locator('section[data-element-id] input[type=checkbox]').all(), true)) await wait('edit.checkbox', () => checkbox.check());
    await wait('edit.function', () => editor.getByLabel('Function', {exact: true}).selectOption('normative'));
    await wait('edit.basis', () => editor.getByLabel('Basis', {exact: true}).selectOption('non_authoritative_reference'));
    await wait('edit.scope', () => editor.getByLabel('Scope of use', {exact: true}).selectOption('situated'));
    const examination = editor.locator('fieldset').filter({has: page.locator('legend', {hasText: /^Examination$/})});
    await wait('edit.examination-outcome', () => examination.getByLabel('Outcome', {exact: true}).selectOption('classifiable'));
    await wait('edit.examination-reason', () => examination.getByLabel('Reason', {exact: true}).fill('A bounded, explicit human declaration, not automatic semantic validation.'));
    await wait('edit.coverage', () => editor.getByLabel('Coverage explanation', {exact: true}).fill('Only the examined selection; retained extraction limits still apply.'));
    if (withCondition) {
      await wait('edit.add-condition', () => editor.getByRole('button', {name: 'Add condition', exact: true}).click());
      await wait('edit.condition-text', () => editor.getByLabel('Condition text', {exact: true}).fill(condition));
      await wait('edit.condition-scope', () => editor.getByLabel('Condition scope', {exact: true}).fill('AZ-17'));
    }
    if (correction) {
      const element = editor.locator('section[data-element-id]').first();
      await wait('edit.add-correction', () => element.getByRole('button', {name: 'Add a correction', exact: true}).click());
      const text = await wait('edit.correction-value', () => element.getByLabel('Text correction', {exact: true}).inputValue());
      await wait('edit.correction-text', () => element.getByLabel('Text correction', {exact: true}).fill(text + 'Human annotation: synthetic only.\n'));
    }
    if (dependency) {
      const ids = await wait('dependency.ids', () => editor.locator('section[data-element-id]').evaluateAll(elements => elements.map(e => e.dataset.elementId)), true);
      assert.equal(ids.length, 2);
      await wait('dependency.add', () => editor.getByRole('button', {name: 'Add dependency', exact: true}).click());
      await wait('dependency.from', () => editor.getByLabel('From', {exact: true}).fill(ids[0])); await wait('dependency.to', () => editor.getByLabel('To', {exact: true}).fill(ids[1]));
    }
    if (withCondition || correction || dependency) await wait('edit.reason', () => editor.getByLabel('Reason for this preparation', {exact: true}).fill(cause));
    return editor;
  };
  const save = async key => {
    const response = responseTo('POST', '/finalize', 'save');
    await wait('save.click', () => page.getByRole('button', {name: 'Save preparation', exact: true}).click());
    const received = await response; assert.equal(received.status(), 200); const effect = await observedJson(received, 'save');
    await wait('save.inspection-visible', () => byKey(key).getByRole('button', {name: 'Inspect preparation', exact: true}).waitFor()); await ready();
    return effect;
  };
  const inspect = async (key, preparation) => {
    const consumed = await lookupBodies.arm(page, preparation, {signal: t.signal});
    try {
      const pending = queryResponse(preparation);
      await wait('inspect.click', () => byKey(key).getByRole('button', {name: 'Inspect preparation', exact: true}).click());
      const received = await pending; assert.equal(received.status(), 200);
      const body = await wait('inspect.response-json', () => consumed.result);
      assert.equal(body.status, received.status()); const value = body.value;
      assert.deepEqual(value.preparation.reference, preparation);
      await wait('inspect.prepared-visible', () => page.getByLabel('Prepared unit', {exact: true}).waitFor()); await ready(); return value;
    } finally {await consumed.dispose();}
  };
  const draftProposal = async (target, judgment = 'distinct') => {
    await wait('proposal.unit', () => page.getByLabel('Prepared unit', {exact: true}).selectOption('selected-material'));
    if (target) {
      await wait('proposal.target', () => page.getByLabel('Target', {exact: true}).selectOption('relationship'));
      await wait('proposal.target-id', () => page.getByLabel('Target unit ID', {exact: true}).fill(target.id));
      await wait('proposal.version-id', () => page.getByLabel('Exact target version ID', {exact: true}).fill(target.id));
      await wait('proposal.revision', () => page.getByLabel('Revision', {exact: true}).fill(String(target.revision)));
      await wait('proposal.sha256', () => page.getByLabel('SHA-256', {exact: true}).fill(target.sha256));
      await wait('proposal.comparison', () => page.getByLabel('Use this exact target as comparison evidence', {exact: true}).check());
    }
    await wait('proposal.declaration', () => page.getByLabel('Target declaration', {exact: true}).fill('An explicit synthetic target, not a filename or similarity inference.'));
    await wait('proposal.judgment', () => page.getByLabel('Identity judgment', {exact: true}).selectOption(judgment));
    await wait('proposal.reason', () => page.getByRole('group', {name: 'Candidate proposal', exact: true}).getByLabel('Reason', {exact: true})
      .fill('An explicit comparison of the retained synthetic content and conditions.'));
  };
  const propose = async () => {
    const pending = responseTo('POST', '/proposals', 'propose');
    await wait('propose.click', () => page.getByRole('button', {name: 'Prepare exact proposal', exact: true}).click());
    const response = await pending; assert.equal(response.status(), 200); const value = await observedJson(response, 'propose');
    await wait('propose.confirm-visible', () => page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor()); await ready(); return value;
  };
  const confirm = async () => {
    const pending = responseTo('POST', '/constitutions', 'confirm');
    await wait('confirm.click', () => page.getByRole('button', {name: 'Confirm this proposal', exact: true}).click());
    const response = await pending; assert.equal(response.status(), 200); const value = await observedJson(response, 'confirm');
    await wait('confirm.detached', () => page.getByRole('button', {name: 'Confirm this proposal', exact: true}).waitFor({state: 'detached'})); await ready(); return value;
  };
  const loseResponse = async (suffix, beforeLoss = async () => {}) => {
    const cdp = await wait('loss.session', () => context.newCDPSession(page), true); let captured, failure;
    cdp.on('Fetch.requestPaused', async event => {
      try {
        if (event.request.method !== 'POST') {await wait('loss.continue', () => cdp.send('Fetch.continueRequest', {requestId: event.requestId}), true); return;}
        assert.ok([200, 202].includes(event.responseStatusCode));
        const payload = await wait('loss.body', () => cdp.send('Fetch.getResponseBody', {requestId: event.requestId}), true);
        captured = JSON.parse(payload.base64Encoded ? Buffer.from(payload.body, 'base64').toString('utf8') : payload.body);
        await wait('loss.before', () => beforeLoss(captured), true);
        await wait('loss.reset', () => cdp.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'ConnectionReset'}), true);
      } catch (error) {failure = error; primaryError ??= error; await withDeadline(() => cdp.send('Fetch.failRequest', {requestId: event.requestId, errorReason: 'Failed'}), 'loss.failure-release', 15000).catch(() => {});}
    });
    await wait('loss.enable', () => cdp.send('Fetch.enable', {patterns: [{urlPattern: apiOrigin + suffix, requestStage: 'Response'}]}), true);
    return {finish: async () => {await wait('loss.disable', () => cdp.send('Fetch.disable'), true); await wait('loss.detach', () => cdp.detach(), true); if (failure) throw failure; assert.ok(captured); return captured;}};
  };
  let firstKey = await wait('source.first-item-key', () => rows().filter({hasText: reference.name}).getAttribute('data-item-key')), firstPrepared, firstCandidate;
  writeFileSync('/work/output/workspace-preparation-reference.json', JSON.stringify({source: reference, condition, cause,
    correction: 'Human annotation: synthetic only.\n', expectedEditorialState: 'candidate'}, null, 2), {flag: 'wx'});

  await runCase('W09', 'first-real-intake.txt', 'W09 real human preparation persists exact original provenance, a correction and its difference', async () => {
    await edit({key: firstKey, receipt}, {correction: true});
    const before = await candidateCount(), saved = await save(firstKey), inspected = await inspect(firstKey, saved.result.preparation);
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
    const source = await wait('http.original', () => request('/api/intake/receptions/' + receipt.reception_id + '/original', {client}));
    assert.deepEqual(source.bytes, original);
    await wait('w09.reason-visible', () => page.getByText(cause, {exact: true}).waitFor());
    await wait('w09.screenshot', () => page.screenshot({path: '/work/output/workspace-prepared-differences.png', fullPage: true}));
    observations.push({case: 'W09', preparation: firstPrepared.reference, difference: firstPrepared.differences[0].reference,
      candidateDelta: 0, originalUnchanged: true});
  });
  if (!firstPrepared) throw Error('WORKSPACE_PREPARATION_PREREQUISITE');
  await runCase('W10', 'first-real-intake.txt', 'W10 exact inspected proposal constitutes one candidate and neither approves nor publishes', async () => {
    await draftProposal(); const proposed = await propose();
    const displayed = page.getByRole('region', {name: 'Review the exact proposal', exact: true});
    assert.ok((await wait('proposal.displayed-text', () => displayed.innerText())).includes(proposed.result.proposal.sha256));
    assert.ok((await wait('proposal.displayed-text', () => displayed.innerText())).includes(firstPrepared.reference.sha256));
    assert.ok((await wait('proposal.displayed-text', () => displayed.innerText())).includes(condition));
    const before = await candidateCount(), outcome = await confirm(); firstCandidate = outcome.result.candidates[0];
    assert.equal(outcome.result.outcome, 'constituted'); assert.equal(await candidateCount(), before + 1);
    const saved = (await wait('sql.candidate', () => env.admin.query('SELECT * FROM intake_trial.candidate WHERE unit_id=$1', [firstCandidate.id]), true)).rows[0];
    assert.equal(saved.editorial_state, 'candidate'); assert.deepEqual(saved.provenance.preparation, firstPrepared.reference);
    assert.equal(await wait('candidate.notice-count', () => page.getByText('Candidate constituted. It is not approved or published.', {exact: true}).count(), true), 1);
    observations.push({case: 'W10', proposal: proposed.result.proposal, preparation: firstPrepared.reference, effect: outcome.effect,
      candidate: firstCandidate, editorialState: saved.editorial_state});
    await wait('candidate.screenshot', () => page.screenshot({path: '/work/output/workspace-candidate.png', fullPage: true})); await back();
  });
  if (!firstCandidate) throw Error('WORKSPACE_CANDIDATE_PREREQUISITE');
  for (const [label, change, expected] of [['relationship', false, 'relationship_recorded'], ['collision', true, 'blocked']]) {
    await runCase('W11-' + label, 'identity-' + label + '.txt', 'W11 ' + label + ' is a distinct real disposition without another candidate', async () => {
      const source = await addSource('identity-' + label + '.txt', original);
      const editor = await edit(source, {correction: true});
      if (change) await wait('collision.condition', () => editor.getByLabel('Condition text', {exact: true}).fill('Only applies during a different synthetic interval W.'));
      const saved = await save(source.key); await inspect(source.key, saved.result.preparation); await draftProposal(firstCandidate, 'same_version');
      await propose(); const before = await candidateCount(), result = await confirm();
      assert.deepEqual({outcome: result.result.outcome, candidateDelta: await candidateCount() - before}, {outcome: expected, candidateDelta: 0});
      assert.equal(await wait('confirm.count', () => page.getByRole('button', {name: 'Confirm this proposal', exact: true}).count(), true), 0);
      if (change) assert.equal(result.result.block_kind, 'identity_collision');
      else assert.deepEqual(result.result.relationships[0].version, firstCandidate);
      observations.push({case: 'W11-' + label, effect: result.effect, outcome: result.result.outcome, candidateDelta: 0}); await back();
    });
  }
  await runCase('W12', 'inert.md', 'W12 visible Markdown, CSV and XLSX preserve independent lexical, cache and context facts', async () => {
    for (const name of ['inert.md', 'table.csv', 'cache-discrepant.xlsx', 'unsupported-part.xlsx']) {
      setFixture(name);
      const input = await wait('fixture.read', () => fixture(name), true), workbook = name.endsWith('.xlsx');
      const source = await addSource(name, input.bytes, workbook ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : name.endsWith('.md') ? 'text/markdown' : 'text/csv');
      await edit(source, {withCondition: workbook, dependency: workbook}); const saved = await save(source.key);
      const inspected = await inspect(source.key, saved.result.preparation), region = page.getByRole('region', {name: 'Human preparation', exact: true});
      const payload = inspected.preparation.payload;
      if (workbook) {
        const table = region.locator('section[data-block-id="sheet-1"]');
        const cellRows = await wait('workbook.cells', () => table.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))), true);
        const at = address => cellRows.find(cells => cells[0] === address);
        assert.deepEqual(at('A2').slice(0, 3), ['A2', 'text', '001']);
        const cached = name === 'cache-discrepant.xlsx' ? '24.00' : '25.00';
        assert.deepEqual(at('D2'), ['D2', 'number_lexical', cached, 'B2*C2', 'number_lexical', cached, '0.00']);
        assert.deepEqual(['B3', 'B4', 'B5'].map(address => at(address).slice(1, 3)), [['empty', ''], ['number_lexical', '0'], ['error', '#N/A']]);
        assert.equal(at('A7')[2], 'Amounts are in USD and exclude tax.');
        assert.equal(at('B8')[3], "'Conditions'!B2"); assert.equal(at('B8')[5], condition);
        assert.ok((await wait('workbook.hidden-sheet', () => region.locator('section[data-block-id="sheet-2"]').innerText())).includes('hidden'));
        if (name === 'unsupported-part.xlsx') assert.ok(payload.components.some(c => c.coverage !== 'complete'));
        assert.equal(payload.relations[0].origin, 'prepared');
        if (name === 'unsupported-part.xlsx') assert.ok((await wait('workbook.coverage', () => region.innerText())).includes('Partial'));
        await wait('workbook.screenshot', () => page.screenshot({path: '/work/output/workspace-' + name + '-inspection.png', fullPage: true}));
      } else if (name.endsWith('.md')) {
        assert.equal(payload.elements.map(e => e.text).join(''), MARKDOWN);
        assert.equal((await wait('markdown.text', () => region.getByTestId('intake-exact-text').allTextContents(), true)).join(''), MARKDOWN);
        assert.equal(await wait('markdown.active-count', () => region.locator('script,img,iframe').count(), true), 0);
      } else {
        assert.deepEqual(payload.elements[0].rows.map(r => r.fields), CSV_REFERENCES[name].fields);
        const cells = await wait('csv.cells', () => region.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))), true);
        assert.deepEqual(cells.map(c => c.slice(1)), CSV_REFERENCES[name].fields, 'Exact DOM text retains CRLF and positional duplicate headers.');
        const displayed = await wait('csv.layout', () => region.locator('tbody tr').nth(2).locator('td').nth(4).evaluate(cell => {
          const text = cell.firstChild, lower = cell.textContent.indexOf('Line two');
          const first = document.createRange(), second = document.createRange();
          first.setStart(text, 0); first.setEnd(text, 8); second.setStart(text, lower); second.setEnd(text, lower + 8);
          return {text: cell.textContent, displayedText: cell.innerText, whiteSpace: getComputedStyle(cell).whiteSpace,
            firstTop: first.getBoundingClientRect().top, secondTop: second.getBoundingClientRect().top};
        }), true);
        assert.equal(displayed.whiteSpace, 'pre-wrap');
        assert.equal(displayed.displayedText.replace(/\r\n/g, '\n'), 'Line one\nLine two');
        assert.ok(displayed.secondTop > displayed.firstTop, JSON.stringify(displayed));
        observations.push({case: 'W12-csv-line-layout', ...displayed});
        await wait('csv.screenshot', () => page.screenshot({path: '/work/output/workspace-csv-inspection.png', fullPage: true}));
      }
      observations.push({case: 'W12', name, preparation: inspected.preparation.reference,
        componentObservations: payload.components.map(c => ({id: c.id, coverage: c.coverage, limitations: c.limitations}))}); await back();
    }
  });
  await runCase('W13', 'staging-recovery.txt', 'W13 lost staging reply recovers current staged state and explicitly finalizes without reupload', async () => {
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
    const finalized = responseTo('POST', '/finalize', 'save');
    await byKey(source.key).getByRole('button', {name: 'Continue staged preparation', exact: true}).click();
    const finalizedResponse = await finalized; assert.equal(finalizedResponse.status(), 200);
    const finalizedEffect = await observedJson(finalizedResponse, 'save');
    await byKey(source.key).getByRole('button', {name: 'Inspect preparation', exact: true}).waitFor(); await ready();
    assert.equal(await effectCount('finalize_preparation'), before + 1);
    assert.equal(requests.filter(r => r.method === 'POST' && r.path.endsWith('/content')).length, uploads);
    observations.push({case: 'W13', attempt: lost.result.attempt_id, document: lost.result.document, uploadsRepeated: 0, finalizations: 1});
    const inspected = await inspect(source.key, finalizedEffect.result.preparation); assert.equal(inspected.preparation.reference.id, lost.result.preparation.id);
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
  });
  assert.deepEqual(errors, []);
}
