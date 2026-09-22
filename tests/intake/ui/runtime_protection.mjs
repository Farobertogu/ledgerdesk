import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from 'pg';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {ReceptionService} from '../../../src/server/intake/service.ts';
import {selected, phase} from '../../../src/server/intake/reception.ts';
import {sessionToken} from '../../../src/server/access/transport.ts';
import {emptyPreparationDraft, preparationDocument} from '../../../src/components/intake/preparation.ts';
import {IntakeJournal, JOURNAL_KEY} from '../../../src/components/intake/journal.ts';
import {preparationCanonical} from '../../../src/contracts/intake_preparation.ts';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {preparationContext, preparationTreatment} from '../preparation/runtime_control.mjs';
import {apiOrigin, uiOrigin} from '../../access/journey_environment.mjs';
import {holdResponse} from './response_hold.mjs';

const profile = {profile: 'intake/1', representation: 'intake-preparation/1'};
const accept = 'application/vnd.ledgerdesk.intake-preparation+json';
const workspaceAccept = 'application/vnd.ledgerdesk.intake-workspace+json';
const hash = value => createHash('sha256').update(value).digest('hex');
function latch() {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};}
async function bounded(promise, label, ms = 7000, code) {
  let timer; try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => {const error = Error(label); if (code) error.code = code; reject(error);}, ms);})]);}
  finally {clearTimeout(timer);}
}
async function eventually(read, predicate, label) {
  const end = Date.now() + 2000; let value;
  do {value = await read(); if (predicate(value)) return value; await delay(10);} while (Date.now() < end);
  assert.fail(label + ': ' + JSON.stringify(value));
}

/** The journal locators below refer to real public effects. They are recovery
 * input, not seeded authority or prepared output. The browser consumes the
 * actual controller and terminal response throughout the observations. */
export async function workspaceProtection(t, {env, intake, client, request, controlled, page, context, observer, lookupBodies,
  receipt, original, observations, storage, setBarrier, login, digestSession}) {
  let primaryError = null;
  const stop = () => { if (primaryError) throw primaryError; if (t.signal.aborted) throw t.signal.reason; };
  const runCase = async (title, action) => {
    stop();
    await t.test(title, async subtest => {
      try {return await action(subtest);}
      catch (error) {primaryError ??= error; throw primaryError;}
    });
    stop();
  };
  const check = (r, code = 200) => assert.equal(r.status, code, JSON.stringify(r.body));
  const call = (path, options = {}) => request('/api/intake' + path, {client, ...options, headers: {accept, ...options.headers}});
  const extraction = new ExtractionService(intake);
  await extraction.dispatch(receipt.job_id); await extraction.accept(receipt.job_id);
  const source = await request('/api/intake/extractions/' + receipt.job_id, {client}); check(source);
  assert.equal(source.body.result.content.elements.map(e => e.text).join(''), original.toString());
  const draft = {...emptyPreparationDraft(), selected: source.body.result.content.elements.map(e => e.id),
    classification: {function: {value: 'normative', reason: ''}, basis: {value: 'non_authoritative_reference', reason: ''}, scope: {value: 'situated', reason: ''}},
    examination: {outcome: 'classifiable', reason: 'Explicit synthetic human declaration.'},
    coverage: {completeSourceClaim: false, reason: 'Only the selected source; no semantic completeness claim.'},
    conditions: [{id: 'condition-1', text: 'Only under synthetic condition Z.', scope: 'AZ-17'}], changeReason: 'Record an explicit bounded condition.'};
  const built = preparationDocument(source.body, draft), bytes = Buffer.from(JSON.stringify(built.document));
  const reservation = await call('/preparation-attempts', {key: randomUUID(), body: {...profile, inputs: built.inputs, base: null,
    selection: built.selection, document: {bytes: bytes.length, sha256: hash(bytes)}, context: preparationContext}}); check(reservation, 202);
  const attempt = reservation.body.result;
  const staged = await call(`/preparation-attempts/${attempt.attempt_id}/content`, {bytes}); check(staged);
  const finalizeKey = randomUUID(), finalBody = {...profile, expected_revision: attempt.preparation.revision, document: staged.body.result.document, differences: []};
  const finalized = await call(`/preparation-attempts/${attempt.attempt_id}/finalize`, {key: finalizeKey, body: finalBody}); check(finalized);
  const prepared = finalized.body.result.preparation, itemKey = randomUUID();
  const values = new Map(), journal = new IntakeJournal({getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v)},
    {deployment: intake.deployment, uiOrigin, terminalOrigin: apiOrigin});
  journal.retain({id: randomUUID(), itemKey, operation: 'finalize_preparation', profile: 'intake-preparation/1', key: finalizeKey,
    fingerprint: hash(preparationCanonical('finalize_preparation', {id: attempt.attempt_id}, finalBody, canonicalValue)),
    references: {preparation: prepared}});
  const journalText = values.get(JOURNAL_KEY);
  const card = () => page.getByRole('region', {name: 'Add material', exact: true}).locator(`li[data-item-key="${itemKey}"]`);
  const reset = async () => {
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [JOURNAL_KEY, journalText]);
    await page.reload(); await card().getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
    await card().getByRole('button', {name: 'Inspect preparation', exact: true}).waitFor();
    await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
  };
  const lookupResponse = () => page.waitForResponse(r => {
    const url = new URL(r.url());
    if (r.request().method() !== 'POST' || url.origin !== apiOrigin || url.pathname !== '/api/intake/operations/lookup') return false;
    const body = r.request().postDataJSON();
    return body?.kind === 'preparation_inspection' && ['id', 'revision', 'sha256'].every(field => body.preparation?.[field] === prepared[field]);
  });
  const inspect = async () => {const pending = lookupResponse(); await card().getByRole('button', {name: 'Inspect preparation', exact: true}).click(); return pending;};
  const inspectBody = async () => {
    const consumed = await lookupBodies.arm(page, prepared, {signal: t.signal});
    try {
      const response = await inspect(), body = await consumed.result;
      assert.equal(body.status, response.status()); return {response, body: body.value};
    } finally {await consumed.dispose();}
  };
  const waitInspected = () => page.getByRole('region', {name: 'Human preparation', exact: true}).waitFor();
  const grant = async (permission, withdrawn) => {
    const updated = await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=$1 WHERE account_id=$2 AND permission_id=$3', [withdrawn, controlled.account.id, permission]);
    assert.ok(updated.rowCount > 0, 'The directed permission change must affect its real grant.');
  };
  const records = async () => (await env.admin.query('SELECT id,sha256 FROM intake_trial.preparation ORDER BY id')).rows;

  for (const permission of ['intake_prepared_read', 'intake_difference_read']) await runCase('W14 preparation inspection separately requires ' + permission, async () => observer.run(permission === 'intake_prepared_read' ? 'W14-prepared' : 'W14-difference', async () => {
    await reset(); const before = await records(), reads = storage.length; await grant(permission, true);
    try {
      const {response} = await inspectBody(); assert.equal(response.status(), 404);
      await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      assert.deepEqual({views: await page.getByRole('region', {name: 'Human preparation', exact: true}).count(), records: await records(), reads: storage.length},
        {views: 0, records: before, reads});
    } finally {await grant(permission, false);}
    check({status: (await inspect()).status()}); await waitInspected();
    assert.ok((await page.getByRole('region', {name: 'Human preparation', exact: true}).innerText()).includes('Only under synthetic condition Z.'));
    assert.ok(storage.length > reads); observations.push({case: 'W14', permission, denied: 404, protectedReadsWhileDenied: 0, positive: 200});
  }));

  await runCase('W15 query revocation denies disclosure without deleting the historical preparation effect', async () => observer.run('W15', async () => {
    await reset(); const before = await records(); await grant('intake_records', true);
    try {
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/intake/operations/lookup'));
      await card().getByRole('button', {name: 'Check recorded outcome', exact: true}).click();
      assert.equal((await response).status(), 404); await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      assert.deepEqual(await records(), before);
      const direct = await request('/api/intake/operations/lookup', {client, headers: {accept: workspaceAccept}, body: {
        profile: 'intake-workspace/1', kind: 'preparation_effect', variant: 'finalize_preparation', client_key: finalizeKey}});
      assert.equal(direct.status, 404); assert.equal(JSON.stringify(direct.body).includes(prepared.id), false);
    } finally {await grant('intake_records', false);}
    await reset(); observations.push({case: 'W15', status: 404, historicalRecordsPreserved: true});
  }));

  await runCase('W16 the actual browser preparation query has durable evidence and writer-ordered handoff', async () => observer.run('W16', async () => {
    await reset(); const reached = latch(), release = latch(); let paused, delivery, writer, writing, finished = false, response;
    const cdp = await context.newCDPSession(page), ids = new Set(); let receivedBytes = 0, responseHeaders = 0;
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', event => {if (event.request.url.endsWith('/api/intake/operations/lookup') && event.request.postData?.includes('preparation_inspection')) ids.add(event.requestId);});
    cdp.on('Network.responseReceived', event => {if (ids.has(event.requestId)) responseHeaders++;});
    cdp.on('Network.dataReceived', event => {if (ids.has(event.requestId)) receivedBytes += event.dataLength;});
    setBarrier(async (label, event) => {
      if (event.route !== 'lookup_operation') return;
      if (label === 'before_handoff') delivery = {event,
        evidence: (await env.admin.query('SELECT status FROM intake_trial.evidence WHERE id=$1', [event.evidenceId])).rows[0],
        sql: (await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1', [event.backendPid])).rows[0],
        transport: (await env.admin.query('SELECT outcome FROM intake_trial.transport WHERE evidence_id=$1', [event.evidenceId])).rows};
      if (label !== 'after_last_clock' || event.point !== 'workspace-response-handoff' || paused) return;
      paused = event; reached.resolve(); await bounded(release.promise, 'WORKSPACE_HANDOFF_RELEASE');
    });
    const pending = inspect(); pending.catch(() => {});
    try {
      await bounded(reached.promise, 'WORKSPACE_HANDOFF_NOT_REACHED');
      const beforeTransfer = {status: delivery?.evidence?.status, sql: delivery?.sql, transport: delivery?.transport, receivedBytes, responseHeaders,
        views: await page.getByRole('region', {name: 'Human preparation', exact: true}).count()};
      assert.deepEqual(beforeTransfer,
        {status: 200, sql: {state: 'idle', xact_start: null}, transport: [], receivedBytes: 0, responseHeaders: 0, views: 0});
      writer = new Client({...env.admin.connectionParameters, statement_timeout: 5000, lock_timeout: 4000}); await writer.connect();
      const pid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      writing = writer.query('SELECT intake_control.set_treatment($1,1,false)', [preparationTreatment.id]).then(() => {finished = true;}); writing.catch(() => {});
      const wait = await eventually(async () => (await env.admin.query('SELECT wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0],
        value => value?.wait_event === 'advisory' && value.blockers.includes(delivery.event.backendPid), 'WORKSPACE_WRITER_NOT_BLOCKED_BY_ADMISSION');
      assert.equal(finished, false); release.resolve(); response = await bounded(pending, 'WORKSPACE_BROWSER_REPLY');
      assert.equal(response.status(), 200); await waitInspected(); await writing;
      const transport = await eventually(async () => (await env.admin.query('SELECT outcome,bytes FROM intake_trial.transport WHERE evidence_id=$1', [delivery.event.evidenceId])).rows,
        rows => rows.length === 1, 'WORKSPACE_TRANSPORT_MISSING');
      assert.equal(transport[0].outcome, 'handed_off'); assert.ok(transport[0].bytes > 0);
      observations.push({case: 'W16', delivery, paused, wait, beforeTransfer, receivedBytes, transport, writerFinished: finished});
    } finally {release.resolve(); setBarrier(async () => {}); await pending.catch(() => {}); await writing?.catch(() => {}); await writer?.end(); await cdp.detach();
      await env.admin.query('SELECT intake_control.set_treatment($1,1,true)', [preparationTreatment.id]);}
    await reset(); const reads = storage.length; await env.admin.query('SELECT intake_control.set_treatment($1,1,false)', [preparationTreatment.id]);
    try {assert.equal((await inspect()).status(), 404); assert.equal(storage.length, reads);}
    finally {await env.admin.query('SELECT intake_control.set_treatment($1,1,true)', [preparationTreatment.id]);}
    await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
    assert.equal((await inspect()).status(), 200); await waitInspected();
    observations.push({case: 'W16-writer-first', status: 404, protectedReads: 0, reAdmittedPositive: 200});
  }));

  for (const expired of [false, true]) await runCase('W17 workspace delivery ' + (expired ? 'records writer-free expiry without claiming R24 closure' : 'has a nonexpired positive'), async () => observer.run('W17-' + expired, async () => {
    await reset();
    const prior = (await env.admin.query("SELECT id,expires_at FROM access_trial.grant_record WHERE account_id=$1 AND permission_id='intake_prepared_read'", [controlled.account.id])).rows[0];
    const now = async () => Number((await env.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
    const deadline = await now() + 5000;
    await env.admin.query('UPDATE access_trial.grant_record SET expires_at=$1 WHERE id=$2', [deadline, prior.id]);
    const authority = async () => hash(canonicalValue((await env.admin.query('SELECT * FROM access_trial.grant_record ORDER BY id')).rows));
    let pause;
    setBarrier(async (label, event) => {
      if (label !== 'after_last_clock' || event.route !== 'lookup_operation' || event.point !== 'workspace-response-handoff' || pause) return;
      pause = {...event, before: await authority(), observedAtMs: await now()};
      assert.equal(event.deadlineMs, deadline); assert.ok(pause.observedAtMs < deadline);
      if (expired) while (await now() <= deadline + 100) await delay(20);
      pause.releasedAtMs = await now(); pause.after = await authority(); assert.equal(pause.before, pause.after);
    });
    try {
      const {response, body} = await inspectBody(); assert.ok(pause, 'An early denial does not exercise the protected temporal point.');
      if (response.status() === 200) assert.deepEqual(body.preparation?.reference, prepared);
      const delivered = response.status() === 200 && body.preparation?.reference?.id === prepared.id;
      if (!expired) {assert.equal(delivered, true); assert.ok(pause.releasedAtMs < deadline);}
      else assert.ok(pause.releasedAtMs > deadline);
      observations.push({case: 'W17', expired, deadline, pause, status: response.status(), delivered,
        temporalViolation: expired && delivered && pause.releasedAtMs > deadline, universalConformityClaim: false});
    } finally {setBarrier(async () => {}); await env.admin.query('UPDATE access_trial.grant_record SET expires_at=$1 WHERE id=$2', [prior.expires_at, prior.id]);}
  }));

  await runCase('W18 stop is a separately admitted real effect and never erases the original', async subtest => observer.run('W18', async () => {
    await reset(); const name = 'explicit-stop.txt', bytes = Buffer.from('Uncompleted synthetic extraction.\n');
    await page.getByLabel('Choose files', {exact: true}).setInputFiles({name, mimeType: 'text/plain', buffer: bytes});
    const row = page.getByRole('region', {name: 'Add material', exact: true}).locator('li[data-item-key]').filter({hasText: name});
    await row.getByRole('button', {name: 'Receive', exact: true}).click();
    await row.getByText('Original received. Extraction and preparation are separate stages.', {exact: true}).waitFor();
    const received = (await env.admin.query(`SELECT r.id,r.revision,r.declaration,rc.id AS receipt_id,rc.artifact_id,w.id AS job_id FROM intake_trial.reception r JOIN intake_trial.receipt rc ON rc.reception_id=r.id
      JOIN intake_trial.work w ON w.receipt_id=rc.id WHERE r.declaration->>'name'=$1`, [name])).rows[0];
    assert.equal(await row.getByRole('button', {name: 'Stop work', exact: true}).count(), 0, 'An undispatched generation is not offered as a stoppable worker.');
    await extraction.dispatch(received.job_id);
    await row.getByRole('button', {name: 'Refresh', exact: true}).click(); await row.getByRole('button', {name: 'Stop work', exact: true}).waitFor();
    await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
    await grant('intake_load', true);
    try {
      const denied = page.waitForResponse(r => r.url().endsWith('/cancel'));
      await row.getByRole('button', {name: 'Stop work', exact: true}).click(); assert.equal((await denied).status(), 404);
      await row.getByRole('button', {name: 'Check recorded outcome', exact: true}).waitFor(); await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      assert.equal((await env.admin.query('SELECT stopped FROM intake_trial.reception WHERE id=$1', [received.id])).rows[0].stopped, false);
    } finally {await grant('intake_load', false);}
    await row.getByRole('button', {name: 'Check recorded outcome', exact: true}).click(); await row.getByRole('button', {name: 'Stop work', exact: true}).waitFor();
    await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
    const stopped = page.waitForResponse(r => r.url().endsWith('/cancel'));
    await row.getByRole('button', {name: 'Stop work', exact: true}).click(); assert.equal((await stopped).status(), 200);
    await row.getByText('The service recorded a stop. Retained history and the original were not erased.', {exact: true}).waitFor();
    await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
    const state = (await env.admin.query('SELECT state,stopped,declaration FROM intake_trial.reception WHERE id=$1', [received.id])).rows[0];
    const job = (await env.admin.query('SELECT state FROM intake_trial.extraction_job WHERE id=$1', [received.job_id])).rows[0];
    assert.deepEqual({state: state.state, stopped: state.stopped, extraction: job.state, declaration: state.declaration},
      {state: 'stopped', stopped: true, extraction: 'stopped', declaration: received.declaration});
    assert.equal((await env.admin.query("SELECT count(*)::int n FROM intake_trial.intention WHERE reception_id=$1 AND variant='cancel_reception'", [received.id])).rows[0].n, 1);
    const originalView = page.getByRole('region', {name: 'Original', exact: true}), mounted = [], downloads = [], requests = [];
    const recordRequest = r => {const path = new URL(r.url()).pathname; if (path.startsWith('/api/intake/')) requests.push({path, method: r.method()});};
    const recordDownload = d => downloads.push(d);
    page.on('request', recordRequest); page.on('download', recordDownload);
    subtest.after(() => {page.off('request', recordRequest); page.off('download', recordDownload);});
    const effects = async () => ({
      receipts: (await env.admin.query('SELECT id,artifact_id,generation,bytes,sha256 FROM intake_trial.receipt WHERE reception_id=$1 ORDER BY id', [received.id])).rows,
      intentions: (await env.admin.query('SELECT id,variant FROM intake_trial.intention WHERE reception_id=$1 ORDER BY id', [received.id])).rows,
      attempts: (await env.admin.query('SELECT generation,state,actual_bytes,actual_sha256 FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation', [received.id])).rows,
      extractions: (await env.admin.query('SELECT job_id,attempt_generation,claim_id,dispatch_effect FROM intake_trial.extraction_attempt WHERE job_id=$1 ORDER BY attempt_generation', [received.job_id])).rows,
    });
    const stoppedEffects = await effects();
    assert.deepEqual(stoppedEffects.receipts.map(r => ({id: r.id, artifact: r.artifact_id, bytes: r.bytes, sha256: r.sha256})),
      [{id: received.receipt_id, artifact: received.artifact_id, bytes: bytes.length, sha256: hash(bytes)}]);
    const mountedOriginal = async stage => {
      assert.equal(await row.getByRole('button', {name: 'Inspect original', exact: true}).count(), 1, 'F01: the stopped sealed original must be offered by the mounted workspace');
      const inspection = page.waitForResponse(r => r.url().endsWith(`/receptions/${received.id}/original`));
      await row.getByRole('button', {name: 'Inspect original', exact: true}).click(); assert.equal((await inspection).status(), 200);
      await originalView.getByRole('heading', {name: 'Original', exact: true}).waitFor();
      await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      assert.equal(await originalView.locator('pre').textContent(), bytes.toString('utf8'));
      await originalView.locator('details').first().locator('summary').click();
      const text = await originalView.innerText(); assert.ok(text.includes(received.artifact_id)); assert.ok(text.includes(hash(bytes)));
      const ready = page.waitForEvent('download');
      await originalView.getByRole('button', {name: 'Download original', exact: true}).click();
      const download = await ready; assert.equal(download.suggestedFilename(), name);
      assert.deepEqual(readFileSync(await download.path()), bytes);
      await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      mounted.push({stage, reception: received.id, receipt: received.receipt_id, artifact: received.artifact_id, bytes: bytes.length, sha256: hash(bytes), inspected: true, downloaded: true});
      await originalView.getByRole('button', {name: 'Back', exact: true}).first().click();
    };
    await mountedOriginal('after-stop');
    for (const [label, stage] of [['Refresh', 'after-refresh'], ['Check recorded outcome', 'after-reconciliation']]) {
      await row.getByRole('button', {name: label, exact: true}).click();
      await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      await mountedOriginal(stage);
    }
    const originalResult = await request(`/api/intake/receptions/${received.id}/original`, {client}); check(originalResult); assert.deepEqual(originalResult.bytes, bytes);
    const beforeReads = storage.length, beforeDownloads = downloads.length, beforeRequests = requests.length; await grant('intake_original', true);
    let consumed;
    try {
      consumed = await lookupBodies.armReception(page, received.id, {signal: t.signal});
      const projection = page.waitForResponse(r => r.url().endsWith('/api/intake/receptions/' + received.id) && r.request().headers().accept === workspaceAccept);
      await row.getByRole('button', {name: 'Refresh', exact: true}).click();
      const response = await projection; assert.equal(response.status(), 200);
      const observed = await consumed.result; assert.equal(observed.status, response.status()); const body = observed.value;
      await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
      assert.deepEqual({offered: body.offers.includes('inspect_original'), action: await row.getByRole('button', {name: 'Inspect original', exact: true}).count(),
        originalRequests: requests.slice(beforeRequests).filter(r => r.path.endsWith('/original')).length, reads: storage.length, downloads: downloads.length},
        {offered: false, action: 0, originalRequests: 0, reads: beforeReads, downloads: beforeDownloads});
      const denied = await request(`/api/intake/receptions/${received.id}/original`, {client});
      assert.deepEqual({status: denied.status, reads: storage.length}, {status: 404, reads: beforeReads});
    } finally {await consumed?.dispose(); await grant('intake_original', false);}
    await row.getByRole('button', {name: 'Refresh', exact: true}).click();
    await page.getByText('Working…', {exact: true}).waitFor({state: 'hidden'});
    await mountedOriginal('restored-authority');
    const restored = await request(`/api/intake/receptions/${received.id}/original`, {client}); check(restored); assert.deepEqual(restored.bytes, bytes);
    assert.deepEqual({effects: await effects(), commands: requests.filter(r => r.method !== 'GET')}, {effects: stoppedEffects, commands: []});
    const service = new ReceptionService(intake, digestSession, {}, {}), rejectedPhases = [];
    for (const route of ['upload_original', 'finalize_reception']) {
      const input = {route, method: 'POST', parameters: {id: received.id, generation: '1'}, csrf: client.csrf, clientKey: null};
      const admission = await service.authority.open(input, sessionToken(client.cookie), ['intake:reception:' + received.id], () => {});
      const id = randomUUID();
      try {
        await service.authority.beforeMetadata(admission, route);
        const subject = await selected(admission.db, received.id, admission.session.account_id);
        await service.authority.resolve(admission, route, undefined, subject.reception, phase(admission, subject.reception, subject.attempt));
        const evidence = await service.evidence(admission, route, route === 'upload_original' ? 'capture_admission' : 'read_admission',
          {receptionId: received.id, artifactId: subject.attempt.artifact_id, generation: subject.attempt.generation});
        const plan = route === 'upload_original' ? {objects: ['create', 'append']} : {objects: ['read']};
        await assert.rejects(() => admission.db.query('SELECT intake_control.begin_phase($1,$2,$3,$4,$5,$6,$7)',
          [id, intake.namespace, evidence.id, intake.controlSource, intake.incarnation, JSON.stringify(plan), admission.deadline]), {code: '42501'});
        await admission.db.query('ROLLBACK');
        assert.equal((await env.admin.query('SELECT count(*)::int n FROM intake_control.private_phase WHERE id=$1', [id])).rows[0].n, 0);
        rejectedPhases.push({route, code: '42501', registeredPhases: 0});
      } finally {await admission.db.close();}
    }
    const attemptsBefore = (await env.admin.query('SELECT count(*)::int n FROM intake_trial.extraction_attempt WHERE job_id=$1', [received.job_id])).rows[0].n;
    await assert.rejects(() => extraction.dispatch(received.job_id), error => error.status === 404);
    assert.equal((await env.admin.query('SELECT count(*)::int n FROM intake_trial.extraction_attempt WHERE job_id=$1', [received.job_id])).rows[0].n, attemptsBefore);
    observations.push({case: 'W18', reception: received.id, job: received.job_id, stopEffects: 1, originalBytes: bytes.length,
      originalUnchanged: true, independentlyDeniedOriginal: 404, deniedProtectedReads: 0, rejectedPhases, redispatch: 404, addedAttempts: 0,
      mounted, deniedWorkspace: {offered: false, actions: 0, originalRequests: 0, downloads: 0, protectedReads: 0},
      receiptUnchanged: received.receipt_id, mountedCommandsAfterStop: 0, stoppedEffectsUnchanged: true});
  }));

  const cookie = async c => {const split = c.cookie.indexOf('='); await context.addCookies([{name: c.cookie.slice(0, split), value: c.cookie.slice(split + 1),
    url: apiOrigin, secure: true, httpOnly: true, sameSite: 'Strict'}]);};
  const holdInspection = () => holdResponse(context, page, request => {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.origin !== apiOrigin || url.pathname !== '/api/intake/operations/lookup') return false;
    const body = JSON.parse(request.postData);
    return body?.kind === 'preparation_inspection' && ['id', 'revision', 'sha256'].every(key => body.preparation?.[key] === prepared[key]);
  }, {holdMs: 7000});
  for (const [label, email] of [['same-account', 'reader@example.test'], ['other-account', 'master@example.test']])
    await runCase('W19 a replaced ' + label + ' session cannot adopt a retained preparation response', async () => observer.run('W19-' + label, async () => {
      await cookie(client); await reset(); assert.equal((await inspect()).status(), 200); await waitInspected(); await reset();
      const held = await holdInspection();
      try {
        await card().getByRole('button', {name: 'Inspect preparation', exact: true}).click(); assert.equal((await bounded(held.wait(), 'STALE_INSPECTION_NOT_REACHED')).status, 200);
        const replacement = await login(email); await cookie(replacement); await bounded(held.release(), 'STALE_RESPONSE_NOT_RELEASED');
        await page.getByText('The session changed. Refresh and explicitly reconcile retained operations.', {exact: true}).waitFor();
        assert.deepEqual({inspectors: await page.getByRole('region', {name: 'Human preparation', exact: true}).count(), rows: await page.locator('li[data-item-key]').count(),
          text: await page.getByText('Only under synthetic condition Z.', {exact: true}).count()}, {inspectors: 0, rows: 0, text: 0});
        observations.push({case: 'W19', replacement: label, responseStatus: 200, adopted: false, historicalPreparation: prepared});
      } finally {await bounded(held.close(), 'STALE_RESPONSE_NOT_CLOSED'); await cookie(client);}
    }));

  await runCase('W20 a same-session selection change cancels the old preparation adoption', async () => observer.run('W20', async () => {
    await reset(); await page.getByLabel('Choose files', {exact: true}).setInputFiles({name: 'Unsent second item', mimeType: 'text/plain', buffer: Buffer.from('B draft')});
    const target = page.locator('aside li[data-item-key]').filter({hasText: 'Unsent second item'}), targetKey = await target.getAttribute('data-item-key');
    const held = await holdInspection();
    try {
      await card().getByRole('button', {name: 'Inspect preparation', exact: true}).click(); assert.equal((await bounded(held.wait(), 'LOCAL_INSPECTION_NOT_REACHED')).status, 200);
      await target.getByRole('button').click(); await bounded(held.release(), 'LOCAL_RESPONSE_NOT_RELEASED');
      await page.getByRole('region', {name: 'Add material', exact: true}).getByRole('heading', {name: 'Unsent second item', exact: true}).waitFor();
      assert.deepEqual({current: await target.getByRole('button').getAttribute('aria-current'), inspectors: await page.getByRole('region', {name: 'Human preparation', exact: true}).count()},
        {current: 'true', inspectors: 0});
      observations.push({case: 'W20', selectedLocalItem: targetKey, oldPreparationAdopted: false});
    } finally {await bounded(held.close(), 'STALE_RESPONSE_NOT_CLOSED');}
  }));
}
