import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseWorkflow,verifyWiring} from '../../../ci/intake_ci_check.mjs';
import {readingPassed,readingDependencies} from '../../../ci/reading_result_gate.mjs';
import {workspaceGuard} from '../../../ci/intake_workspace_guards.mjs';
import {qualifyExtractionGuard} from '../../../ci/intake_extraction_guard_checks.mjs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWorkspaceCheckpoint, validateCheckpoint,preparationTestNames} from './diagnostic_checkpoint.mjs';
import {preparationParticipants} from '../../../ci/intake/workspace_participants.mjs';
import {projectWorkspaceDiagnostic, readWorkspaceDiagnostic, projectPreparationWaits} from '../../../ci/intake/workspace_diagnostic.mjs';
import {exportExtractionEvidence, extractionPublicSummary} from '../../../ci/intake_extraction_artifacts.mjs';

test('whole-journey selector rejects combinations outside the mounted preparation profile before runtime', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const args of [[], ['--group', 'units'], ['--group', 'extraction', '--extraction-cases', 'preparation', '--preparation-cases', 'ui-protection']]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'ci/intake_t02_check.mjs', ...args, '--whole-journey'],
      {cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 65536});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Error: WHOLE_JOURNEY_SCOPE/);
    assert.equal(result.stdout, '');
  }
});

test('both workspace jobs and every finite command are mandatory alongside retained producers',async()=>{
  const workflow=parseWorkflow(await fs.readFile(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8'));
  assert.equal(verifyWiring(workflow),true);
  const needs=Object.fromEntries(readingDependencies.map(name=>[name,{result:'success'}]));
  assert.equal(readingPassed(needs,'success'),true);
  for(const name of ['intake-workspace-behavior','intake-workspace-admission']){
    for(const result of ['failure','cancelled','skipped'])assert.equal(readingPassed({...needs,[name]:{result}},'success'),false);
    const absent=structuredClone(needs);delete absent[name];assert.equal(readingPassed(absent,'success'),false);
    for(let i=0;i<workflow.jobs[name].steps.length;i++){
      const step=workflow.jobs[name].steps[i];if(!step.run)continue;
      const removed=structuredClone(workflow);removed.jobs[name].steps.splice(i,1);assert.throws(()=>verifyWiring(removed));
      if(step.run==='node ci/intake_extraction_artifacts.mjs')continue;
      const skipped=structuredClone(workflow);skipped.jobs[name].steps[i].if='false';assert.throws(()=>verifyWiring(skipped));
      const advisory=structuredClone(workflow);advisory.jobs[name].steps[i]['continue-on-error']=true;assert.throws(()=>verifyWiring(advisory));
    }
  }
});

test('the response-adoption mutation requires its own assertion, exact fault and cleanup',()=>{
  const manifest={completed:false,failure:{message:'T02_RUNTIME_FAILED'},resources:[{removed:true}]};
  const source={files:[{fault:workspaceGuard.name}]};
  const log=`    not ok 1 - ${workspaceGuard.tests[0]}\n      code: 'ERR_ASSERTION'\nACCESS_PG_CLEANED\nINTAKE_T02_RUNTIME_CLEANED\n# cancelled 0`;
  assert.equal(qualifyExtractionGuard(workspaceGuard,manifest,source,log),true);
  for(const changed of [log.replace('ERR_ASSERTION','ETIMEDOUT'),log.replace(workspaceGuard.tests[0],'unrelated check'),
    log.replace('INTAKE_T02_RUNTIME_CLEANED',''),log+'\ntestTimeoutFailure'])
    assert.throws(()=>qualifyExtractionGuard(workspaceGuard,manifest,source,changed));
  assert.throws(()=>qualifyExtractionGuard(workspaceGuard,manifest,{files:[{fault:'another-fault'}]},log));
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const runId = 'intake-extraction-2026-09-20T02-41-00-074Z-1234abcd';
const name = 'ld-i03-t02-1234abcd-runtime', id = 'a'.repeat(64);
const requestId = '12345678-1234-1234-1234-123456789abc';
const poll = "const f=require('fs');const p='/work/output/admin-request.json';process.stdout.write(f.existsSync(p)?f.readFileSync(p):'null')";
const publish = "const f=require('fs'),c=require('crypto'),id=process.argv[1],n=Number(process.argv[2]),h=process.argv[3];" +
  "if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(n)||n<0||n>8388608||!/^[a-f0-9]{64}$/.test(h))throw Error('ADMIN_REPLY_SCOPE');" +
  "const p='/work/output/admin-response-'+id,b=f.readFileSync(p+'.pending');" +
  "if(b.length!==n||c.createHash('sha256').update(b).digest('hex')!==h||f.existsSync(p+'.json'))throw Error('ADMIN_REPLY_INTEGRITY');" +
  "f.renameSync(p+'.pending',p+'.json');";
const finalTap = '# tests 13\n# pass 13\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 35000\n';
function command(args, stdout = '') {
  return {program: 'docker', args, code: 0, signal: null, milliseconds: 1, stdout, stderr: '',
    stdoutBytes: Buffer.byteLength(stdout), stdoutRetainedBytes: Buffer.byteLength(stdout), stderrBytes: 0, stderrRetainedBytes: 0,
    stdoutEncodingError: false, stderrEncodingError: false, stderrTruncated: false};
}
function fixture() {
  const source = {profile: 'intake-t02-source/1', runId, files: []}, bytes = JSON.stringify(source);
  const commands = [command(['exec', name, 'node', '-e', poll], JSON.stringify({id: requestId, action: 'complete', body: {scope: 'runtime-cleanup'}})),
    command(['cp', '/private/admin/' + requestId + '/response.json', name + ':/work/output/admin-response-' + requestId + '.pending']),
    command(['exec', name, 'node', '-e', publish, requestId, '11', digest('{"ok":true}')]),
    command(['start', '-a', name], '# INTAKE_WORKSPACE_CLEANED\n# ACCESS_PG_CLEANED\n# INTAKE_T02_RUNTIME_CLEANED\n' + finalTap),
    command(['logs', name], "not ok 1 - unrelated\n  ---\n  failureType: 'testTimeoutFailure'\n  ...\n")];
  const manifest = {runId, group: 'extraction', completed: true, sourceManifestSha256: digest(bytes),
    commands: commands.map((c, i) => ({file: String(i + 1).padStart(3, '0') + '-command.json', code: c.code, reason: c.reason ?? null})),
    resources: [{type: 'container', name, id, removed: true}]};
  return {manifest, manifestSha256: 'b'.repeat(64), source: {status: 'present', value: source, sha256: digest(bytes)}, commands,
    inspection: [{Id: id, Name: '/' + name, Config: {Entrypoint: null,
      Cmd: ['node', '--experimental-strip-types', '--test', '--test-concurrency=1', 'tests/intake/t02/test_runtime.mjs'],
      Env: ['LEDGERDESK_PREPARATION_CASES=ui-protection', 'LEDGERDESK_EXTRACTION_CASES=preparation'], Labels: {'intake.t02.run': 'ld-i03-t02-1234abcd'}}}],
    state: {status: 'present', value: {Running: false, ExitCode: 0, OOMKilled: false, Restarting: false, Dead: false}},
    checkpoints: {status: 'absent'}};
}
function replaceRuntime(f, stdout, extra = {}) {
  f.commands[3] = {...command(['start', '-a', name], stdout), ...extra};
  f.manifest.commands[3] = {...f.manifest.commands[3], code: f.commands[3].code, reason: f.commands[3].reason ?? null};
  return f;
}
const trace = events => ({profile: 'intake-workspace-checkpoints/1', group: 'ui-protection',
  events: events.map(([caseId, stage], i) => ({seq: i + 1, caseId, stage})), overflow: 0});

test('workspace projection selects the owned attached runtime, not logs or prerequisite counts', () => {
  const f = fixture(), result = projectWorkspaceDiagnostic(f);
  assert.deepEqual(result, {profile: 'intake-workspace-diagnostic/1', runId, manifestSha256: 'b'.repeat(64),
    sourceManifestSha256: f.source.sha256, group: 'ui-protection',
    inputs: {runtimeCommand: 'present', runtimeState: 'present', checkpoints: 'absent', completion: 'present'},
    runtime: {ordinal: 4, exitCode: 0, durationMs: 1, termination: 'none', captureComplete: true,
      innerTimeout: 'not_observed_in_complete_capture', firstTestFailure: {status: 'not_observed_in_complete_capture', code: null, failureType: null}},
    tap: {complete: true, tests: 13, pass: 13, fail: 0, cancelled: 0, skipped: 0, todo: 0}, checkpoints: null,
    completion: {request: 'observed', replyPublished: 'observed', requestOrdinal: 1, copyOrdinal: 2, publicationOrdinal: 3},
    container: {running: false, exitCode: 0, oomKilled: false, restarting: false, dead: false},
    cleanupMarkers: {INTAKE_WORKSPACE_CLEANED: 'observed', INTAKE_T02_RUNTIME_CLEANED: 'observed', ACCESS_PG_CLEANED: 'observed'}});
});

test('fixed pending segment, inner cancellation and outer timeout remain distinct observations', () => {
  const f = replaceRuntime(fixture(), "    not ok 1 - protected case\n      ---\n      failureType: 'testTimeoutFailure'\n      code: 'ERR_TEST_FAILURE'\n      ...\n", {code: 1, reason: 'worker_timeout', milliseconds: 240019});
  f.manifest.completed = false;
  f.checkpoints = {status: 'present', value: trace([[null, 'workspace_enter'], [null, 'app_prepare_enter'], [null, 'chromium_launch_enter'],
    ['W01', 'action_started'], ['W01', 'action_returned'], ['W01', 'observer_settled'], [null, 'protection_enter'], ['W14-prepared', 'action_started']])};
  const out = projectWorkspaceDiagnostic(f);
  assert.deepEqual(out.runtime, {ordinal: 4, exitCode: 1, durationMs: 240019, termination: 'worker_timeout', captureComplete: false,
    innerTimeout: 'observed', firstTestFailure: {status: 'observed', code: 'ERR_TEST_FAILURE', failureType: 'testTimeoutFailure'}});
  assert.deepEqual(out.checkpoints.events.at(-1), {seq: 8, caseId: 'W14-prepared', stage: 'action_started'});
  assert.equal(out.tap.complete, false); assert.equal(out.completion.replyPublished, 'observed');
  assert.equal(extractionPublicSummary(f.manifest, f.manifestSha256, f.commands).completed, false);
  f.checkpoints.value.events.push({seq: 9, caseId: null, stage: 'context_close_enter'});
  assert.equal(projectWorkspaceDiagnostic(f).checkpoints.events.at(-1).stage, 'context_close_enter');
});

test('only the first reported failed TAP block supplies a closed classification; canaries do not', () => {
  const canary = 'PRIVATE_COOKIE_TOKEN_PATH_75832';
  const decoys = `# INTAKE_DIAGNOSTIC {"code":"ERR_ASSERTION","message":"${canary}"}\n` +
    "# not ok 1 - fake\n#   ---\n#   failureType: 'testTimeoutFailure'\n#   ...\n";
  const positive = projectWorkspaceDiagnostic(replaceRuntime(fixture(), decoys + finalTap));
  assert.equal(positive.runtime.firstTestFailure.status, 'not_observed_in_complete_capture');
  assert.equal(positive.runtime.innerTimeout, 'not_observed_in_complete_capture');
  assert.equal(JSON.stringify(positive).includes(canary), false);
  const failed = "not ok 1 - case\n  ---\n  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n  error: |-\n    code: 'ERR_TEST_FAILURE'\n    failureType: 'testTimeoutFailure'\n  ...\n";
  const out = projectWorkspaceDiagnostic(replaceRuntime(fixture(), decoys + failed, {code: 1}));
  assert.deepEqual(out.runtime.firstTestFailure, {status: 'observed', code: 'ERR_ASSERTION', failureType: 'testCodeFailure'});
  assert.equal(out.runtime.innerTimeout, 'not_observed_in_complete_capture');
  const embedded = "not ok 1 - real assertion\n  ---\n  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n  error: |-\n" +
    "    not ok 99 - text inside the error\n      ---\n      failureType: 'testTimeoutFailure'\n      code: 'ERR_TEST_FAILURE'\n      ...\n  ...\n";
  const nested = projectWorkspaceDiagnostic(replaceRuntime(fixture(), embedded, {code: 1}));
  assert.deepEqual({first: nested.runtime.firstTestFailure, innerTimeout: nested.runtime.innerTimeout},
    {first: {status: 'observed', code: 'ERR_ASSERTION', failureType: 'testCodeFailure'}, innerTimeout: 'not_observed_in_complete_capture'});
  const later = projectWorkspaceDiagnostic(replaceRuntime(fixture(), embedded +
    "not ok 2 - actual timeout\n  ---\n  failureType: 'testTimeoutFailure'\n  code: 'ERR_TEST_FAILURE'\n  ...\n", {code: 1}));
  assert.deepEqual(later.runtime.firstTestFailure, nested.runtime.firstTestFailure);
  assert.equal(later.runtime.innerTimeout, 'observed');
  for (const raw of ["not ok 1 - case\n  ---\n  code: 'NEW_PRIVATE_CODE'\n  ...\n",
    "not ok 1 - case\n  ---\n  code: 'ERR_TEST_FAILURE'\n", "not ok 1 - case\n"]) {
    assert.deepEqual(projectWorkspaceDiagnostic(replaceRuntime(fixture(), raw, {code: 1})).runtime.firstTestFailure,
      {status: 'unknown', code: null, failureType: null});
  }
});

test('missing, malformed, duplicate and truncated evidence cannot manufacture success or association', () => {
  const f = fixture(); f.commands[3].args[2] = 'another-container';
  let out = projectWorkspaceDiagnostic(f); assert.equal(out.inputs.runtimeCommand, 'absent'); assert.equal(out.runtime, null);
  const duplicate = fixture(); duplicate.commands[4] = structuredClone(duplicate.commands[3]);
  out = projectWorkspaceDiagnostic(duplicate); assert.equal(out.inputs.runtimeCommand, 'invalid'); assert.equal(out.runtime, null);
  const partial = replaceRuntime(fixture(), '# tests 13\n', {reason: 'worker_timeout', code: 1, stdoutBytes: 999});
  out = projectWorkspaceDiagnostic(partial); assert.equal(out.inputs.runtimeCommand, 'truncated');
  assert.equal(out.runtime.firstTestFailure.status, 'unknown'); assert.equal(out.runtime.innerTimeout, 'unknown'); assert.equal(out.tap.complete, false);
  const invalid = fixture(); invalid.commands[3].stdoutEncodingError = true;
  out = projectWorkspaceDiagnostic(invalid); assert.equal(out.inputs.runtimeCommand, 'invalid'); assert.equal(out.runtime.captureComplete, false);
  invalid.checkpoints.status = invalid.state.status = 'PRIVATE_STATUS';
  out = projectWorkspaceDiagnostic(invalid); assert.equal(out.inputs.checkpoints, 'invalid'); assert.equal(out.inputs.runtimeState, 'invalid');
  assert.equal(JSON.stringify(out).includes('PRIVATE_STATUS'), false);
  for (const change of [v => v.inspection[0].Id = 'c'.repeat(64), v => v.inspection[0].Config.Cmd[4] = 'unrelated.mjs',
    v => v.inspection[0].Config.Labels['intake.t02.run'] = 'foreign', v => v.source.sha256 = 'd'.repeat(64),
    v => v.manifest.commands[1].file = '../private.json', v => v.manifest.commands[1].file = v.manifest.commands[0].file]) {
    const row = fixture(); change(row); assert.throws(() => projectWorkspaceDiagnostic(row), /WORKSPACE_/);
  }
});

test('completion requires the same runtime, request, verified reply and order; publication is not receipt', () => {
  for (const change of [v => v.commands[2].args[5] = '00000000-0000-0000-0000-000000000000',
    v => v.commands[2].args[1] = 'other-runtime', v => v.commands[2].args[7] = 'f'.repeat(64),
    v => v.commands[2].args[4] = "console.log('ok')", v => v.commands[1].args[2] = 'foreign:/reply',
    v => {v.commands[2].code = 1; v.manifest.commands[2].code = 1;}]) {
    const f = fixture(); change(f); const out = projectWorkspaceDiagnostic(f);
    assert.equal(out.completion.replyPublished, 'unknown');
  }
  const f = fixture(); f.commands[0].stdout = 'null'; f.commands[0].stdoutBytes = f.commands[0].stdoutRetainedBytes = 4;
  const out = projectWorkspaceDiagnostic(f); assert.equal(out.completion.request, 'unknown'); assert.equal(out.completion.replyPublished, 'unknown');
  assert.equal('received' in projectWorkspaceDiagnostic(fixture()).completion, false);
  const truncated = fixture(); truncated.commands[0].stdoutBytes++;
  const partial = projectWorkspaceDiagnostic(truncated); assert.equal(partial.inputs.completion, 'truncated');
  assert.equal(partial.completion.request, 'unknown'); assert.equal(partial.completion.replyPublished, 'unknown');
});

test('checkpoint wrapper records a pending action before waiting and preserves one execution and result identity', async () => {
  let retained, release, count = 0; const result = {same: true};
  const pending = new Promise(resolve => {release = resolve;});
  const checkpoint = createWorkspaceCheckpoint('unused', {persist: (_, bytes) => {retained = JSON.parse(bytes);}});
  checkpoint.mark('app_prepare_enter'); checkpoint.mark('chromium_launch_enter'); checkpoint.mark('protection_enter');
  const observer = {mark() {}, async run(_name, action) {return await action();}};
  const call = checkpoint.wrap(observer).run('W15', async () => {count++; await pending; return result;});
  assert.deepEqual(retained.events.at(-1), {seq: 5, caseId: 'W15', stage: 'action_started'});
  release(); assert.equal(await call, result); assert.equal(count, 1);
  assert.deepEqual(retained.events.slice(-3).map(e => e.stage), ['action_started', 'action_returned', 'observer_settled']);
  let observerRelease; const settle = new Promise(resolve => {observerRelease = resolve;});
  const delayed = checkpoint.wrap({async run(_name, action) {try {return await action();} finally {await settle;}}});
  const second = delayed.run('W16', async () => result); await new Promise(resolve => setImmediate(resolve));
  assert.equal(retained.events.at(-1).stage, 'action_returned'); observerRelease(); assert.equal(await second, result);
  assert.equal(retained.events.at(-1).stage, 'observer_settled');
});

test('checkpoint I/O, cancellation and observer errors never replace the original action outcome', async () => {
  const error = new Error('original'), cancellation = new Error('cancelled'), messages = []; let calls = 0;
  const checkpoint = createWorkspaceCheckpoint('unused', {persist() {throw Error('private path');}, report: message => messages.push(message)});
  const observer = {async run(_name, action) {return action();}};
  assert.equal(await checkpoint.wrap(observer).run('W15', async () => {calls++; return 7;}), 7);
  await assert.rejects(checkpoint.wrap(observer).run('W16', async () => {calls++; throw error;}), actual => actual === error);
  const controller = new AbortController();
  const cancelled = checkpoint.wrap(observer).run('W18', () => {calls++; return new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(cancellation), {once: true}));});
  controller.abort(); await assert.rejects(cancelled, actual => actual === cancellation);
  await assert.rejects(checkpoint.wrap({async run() {throw cancellation;}}).run('W20', () => {calls++;}), actual => actual === cancellation);
  assert.equal(calls, 3); assert.deepEqual(messages, ['INTAKE_WORKSPACE_CHECKPOINT_WRITE_FAILED']);
  const f = replaceRuntime(fixture(), '# INTAKE_WORKSPACE_CHECKPOINT_WRITE_FAILED\n' + finalTap);
  f.checkpoints = {status: 'present', value: trace([[null, 'workspace_enter']])};
  const out = projectWorkspaceDiagnostic(f); assert.equal(out.inputs.checkpoints, 'invalid'); assert.equal(out.checkpoints, null);
});

test('checkpoint bounds and strict fields disclose no unbounded or arbitrary strings', () => {
  let retained, length;
  const checkpoint = createWorkspaceCheckpoint('unused', {persist: (_, bytes) => {retained = JSON.parse(bytes); length = bytes.length;}});
  for (let i = 0; i < 70; i++) checkpoint.mark('context_close_enter');
  assert.equal(retained.events.length, 64); assert.equal(retained.overflow, 7); assert.ok(length <= 16384);
  const f = fixture(); f.checkpoints = {status: 'present', value: retained};
  assert.equal(projectWorkspaceDiagnostic(f).inputs.checkpoints, 'truncated');
  for (const change of [v => v.extra = 'PRIVATE', v => v.events[0].stage = 'PRIVATE', v => v.events[0].caseId = 'W99',
    v => v.events[0].seq = 2, v => v.events.push({...v.events[0]})]) {
    const value = trace([[null, 'workspace_enter']]); change(value); assert.throws(() => validateCheckpoint(value));
  }
});

test('real atomic checkpoint writes retain only the fixed schema and independently reject an extra field', async () => temporaryWork(async temporary => {
  const checkpoint = createWorkspaceCheckpoint(temporary);
  checkpoint.mark('app_prepare_enter');
  const bytes = await fs.readFile(path.join(temporary, 'workspace-checkpoints.json'));
  assert.ok(bytes.length <= 16384);
  const expected = trace([[null, 'workspace_enter'], [null, 'app_prepare_enter']]);
  assert.deepEqual(JSON.parse(bytes), expected);
  assert.deepEqual((await fs.readdir(temporary)).sort(), ['workspace-checkpoints.json']);
  const f = fixture(); f.checkpoints = {status: 'present', value: {...expected, cookie: 'PRIVATE_CANARY'}};
  const projected = projectWorkspaceDiagnostic(f); assert.equal(projected.inputs.checkpoints, 'invalid');
  assert.equal(projected.checkpoints, null); assert.equal(JSON.stringify(projected).includes('PRIVATE_CANARY'), false);
}));

async function temporaryWork(action) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-diagnostic-'));
  try {return await action(temporary);} finally {
    assert.equal(path.dirname(temporary),path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('workspace-diagnostic-'));
    await fs.rm(temporary, {recursive: true});
  }
}
async function writeFixture(directory, f) {
  await fs.mkdir(directory, {recursive: true});
  for (const [file, value] of [['manifest.json', f.manifest], ['source-manifest.json', f.source.value], ['runtime-inspect.json', f.inspection], ['runtime-state.json', f.state.value]])
    await fs.writeFile(path.join(directory, file), JSON.stringify(value));
  for (let i = 0; i < f.commands.length; i++) await fs.writeFile(path.join(directory, f.manifest.commands[i].file), JSON.stringify(f.commands[i]));
}

test('the real exporter emits a bound companion, preserves the old failed summary and never opens browser data', async () => temporaryWork(async temporary => {
  const input = path.join(temporary, 'input'), directory = path.join(input, runId), output = path.join(temporary, 'output');
  const f = replaceRuntime(fixture(), '# INTAKE_DIAGNOSTIC {"cookie":"PRIVATE_CANARY"}\n', {code: 1, reason: 'worker_timeout'});
  f.manifest.completed = false; f.manifest.private = 'PRIVATE_CANARY'; f.state.value.Error = 'PRIVATE_CANARY';
  await writeFixture(directory, f); await fs.mkdir(path.join(directory, 'runtime/browser-diagnostics'), {recursive: true});
  await fs.writeFile(path.join(directory, 'runtime/browser-diagnostics/unknown.json'), 'not JSON PRIVATE_CANARY');
  assert.equal(await exportExtractionEvidence(input, output), true);
  const files = (await fs.readdir(output)).sort(); assert.deepEqual(files, ['PUBLIC-MANIFEST.json', runId + '-workspace-diagnostic.json', runId + '.json'].sort());
  const bytes = await fs.readFile(path.join(directory, 'manifest.json'));
  const ordinary = JSON.parse(await fs.readFile(path.join(output, runId + '.json')));
  assert.deepEqual(ordinary, extractionPublicSummary(f.manifest, digest(bytes), f.commands)); assert.equal(ordinary.completed, false);
  const companion = JSON.parse(await fs.readFile(path.join(output, runId + '-workspace-diagnostic.json')));
  assert.equal(companion.manifestSha256, ordinary.manifestSha256); assert.equal(companion.inputs.checkpoints, 'absent');
  assert.equal(companion.runtime.termination, 'worker_timeout'); assert.equal('browserCases' in companion, false);
  const texts = await Promise.all(files.map(file => fs.readFile(path.join(output, file), 'utf8')));
  assert.equal(texts.join('').includes('PRIVATE_CANARY'), false);
  f.inspection[0].Config.Env[0] = 'LEDGERDESK_PREPARATION_CASES=ui-reception'; await writeFixture(directory, f);
  const oldOutput = path.join(temporary, 'old-output'); assert.equal(await exportExtractionEvidence(input, oldOutput), true);
  assert.deepEqual((await fs.readdir(oldOutput)).sort(), ['PUBLIC-MANIFEST.json', runId + '.json'].sort());
}));

test('the fixed reader rejects symlinked ancestors, oversized checkpoints, invalid JSON and duplicate events', async () => temporaryWork(async temporary => {
  const directory = path.join(temporary, runId), f = fixture(); await writeFixture(directory, f);
  const read = () => readWorkspaceDiagnostic(directory, f.manifest, f.manifestSha256, f.commands);
  await fs.mkdir(path.join(directory, 'runtime'));
  await fs.writeFile(path.join(directory, 'runtime/workspace-checkpoints.json'), 'x'.repeat(16385));
  assert.equal((await read()).inputs.checkpoints, 'truncated');
  await fs.writeFile(path.join(directory, 'runtime/workspace-checkpoints.json'), '{'); assert.equal((await read()).inputs.checkpoints, 'invalid');
  const duplicate = trace([[null, 'workspace_enter']]); duplicate.events.push({...duplicate.events[0]});
  await fs.writeFile(path.join(directory, 'runtime/workspace-checkpoints.json'), JSON.stringify(duplicate)); assert.equal((await read()).inputs.checkpoints, 'invalid');
  await fs.rename(path.join(directory, 'runtime'), path.join(directory, 'retained-runtime'));
  const outside = path.join(temporary, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'workspace-checkpoints.json'), JSON.stringify(trace([[null, 'workspace_closed']])));
  await fs.symlink(outside, path.join(directory, 'runtime'), 'junction');
  const result = await read(); assert.equal(result.inputs.checkpoints, 'invalid'); assert.equal(result.checkpoints, null);
  await fs.unlink(path.join(directory, 'runtime'));
}));

test('removing the action-start mark loses the independently expected pending-case evidence', async () => temporaryWork(async temporary => {
  const original = await fs.readFile(new URL('./diagnostic_checkpoint.mjs', import.meta.url), 'utf8');
  const target = "mark('action_started', name);"; assert.equal(original.split(target).length, 2);
  const file = path.join(temporary, 'checkpoint-mutant.mjs'); await fs.writeFile(file, original.replace(target, ''));
  const {pathToFileURL} = await import('node:url'), mutant = await import(pathToFileURL(file));
  for (const [factory, detects] of [[createWorkspaceCheckpoint, true], [mutant.createWorkspaceCheckpoint, false]]) {
    let retained, release; const pending = new Promise(resolve => {release = resolve;});
    const checkpoint = factory('unused', {persist: (_, bytes) => {retained = JSON.parse(bytes);}});
    const action = checkpoint.wrap({async run(_name, work) {return work();}}).run('W20', () => pending);
    const assertion = () => assert.deepEqual(retained.events.at(-1), {seq: 2, caseId: 'W20', stage: 'action_started'});
    if (detects) assertion(); else assert.throws(assertion, {code: 'ERR_ASSERTION'});
    release(9); assert.equal(await action, 9);
  }
}));

test('workspace marks precede their exact boundaries without changing the existing 180/240-second controls', async () => {
  const runtime = await fs.readFile(new URL('./runtime_first_slice.mjs', import.meta.url), 'utf8');
  for (const [mark, consumer] of [["createWorkspaceCheckpoint('/work/output',{group:process.env.LEDGERDESK_PREPARATION_CASES})", 'await preparationControl('],
    ["mark('app_prepare_enter')", 'await app.prepare()'], ["mark('chromium_launch_enter')", 'await chromium.launch('],
    ["mark('protection_enter')", 'await workspaceProtection('], ["mark('context_close_enter')", 'await context?.close()'],
    ["mark('browser_close_enter')", 'await browser?.close()'], ["mark('app_close_enter')", 'await app?.close()']]) {
    assert.ok(runtime.includes(mark) && runtime.indexOf(mark) < runtime.indexOf(consumer), mark);
  }
  assert.ok(runtime.indexOf("mark('workspace_closed')") > runtime.indexOf('await app?.close()'));
  assert.match(runtime, /\['ui-protection','ui-preparation'\]\.includes\(process\.env\.LEDGERDESK_PREPARATION_CASES\)\s*\? createWorkspaceCheckpoint/);
  const parent = await fs.readFile(new URL('../t02/test_runtime.mjs', import.meta.url), 'utf8');
  const runner = await fs.readFile(new URL('../../../ci/intake_t02_check.mjs', import.meta.url), 'utf8');
  assert.match(parent, /\?300000:180000/); assert.match(runner, /\?330000:240000/);
});

const jobId='11111111-1111-4111-8111-111111111111',phaseId='22222222-2222-4222-8222-222222222222',
  channelId='33333333-3333-4333-8333-333333333333',preparationRequestId='44444444-4444-4444-8444-444444444444';
async function preparationFixture(){
  const f=fixture();f.inspection[0].Config.Env[0]='LEDGERDESK_PREPARATION_CASES=ui-preparation';
  const c=createWorkspaceCheckpoint('unused',{group:'ui-preparation',persist:(_,bytes)=>{f.checkpoints={status:'present',value:JSON.parse(bytes)};}});
  await c.wrap({run:async(_,action)=>action()}).run('W11-collision',async()=>{
    c.stage('dispatch_enter',jobId);c.stage('phase_committed',jobId,phaseId);c.stage('input_dispatch_enter',jobId);
  });
  const subject={job_id:jobId,attempt_generation:1,channel_id:channelId,binding_sha256:'a'.repeat(64)};
  f.participants={events:{status:'present',value:[{kind:'private-worker-closed',phaseId,subject,parserConfirmed:false,
    termination:{profile:'intake-child-stop/1',requestId:preparationRequestId,workerPid:41,startedAtMs:100,closedAtMs:200,exitCode:null,signal:'SIGKILL',reason:'deadline'},
    failureCode:'EXTRACTION_PRIVATE_FAILURE'}]},bridges:{[channelId]:{
    request:{status:'present',value:{id:preparationRequestId,channel:channelId,subject}},
    completion:{status:'present',value:{requestId:preparationRequestId,subject,closed:false,failed:true,metadata:null}},
  }}};
  return f;
}
test('preparation preserves named failed cases without inferring them from totals or exposing failure text',async()=>{
  const f=await preparationFixture(),bad=`    not ok 3 - ${preparationTestNames.W09}\n      ---\n      code: 'ERR_ASSERTION'\n      failureType: 'testCodeFailure'\n      error: 'PRIVATE_CANARY'\n      ...\n`;
  replaceRuntime(f,bad+`    not ok 5 - ${preparationTestNames['W11-collision']}\n      ---\n      code: 'ERR_TEST_FAILURE'\n      failureType: 'cancelledByParent'\n      ...\n`,{code:1});
  const out=projectWorkspaceDiagnostic(f);
  assert.deepEqual(out.runtime.failedCases.map(x=>[x.caseId,x.failureType]),[['W09','testCodeFailure'],['W11-collision','cancelledByParent']]);
  assert.equal(out.runtime.firstTestFailure.name,preparationTestNames.W09);assert.ok(!JSON.stringify(out).includes('PRIVATE_CANARY'));
  replaceRuntime(f,bad.replace(preparationTestNames.W09,preparationTestNames.W09+' PRIVATE_CANARY'),{code:1});
  assert.equal(projectWorkspaceDiagnostic(f).runtime.firstTestFailure.caseId,null);
});
test('preparation phase, job, request and channel association distinguish relay closure from parser completion',async()=>{
  const f=await preparationFixture(),out=projectWorkspaceDiagnostic(f),observed=out.participants.observations[0];
  assert.equal(out.participants.status,'present');assert.equal(observed.caseId,'W11-collision');
  assert.deepEqual([observed.privateWorker.closed,observed.privateWorker.parserConfirmed,observed.bridge.closed],[true,false,false]);
  assert.equal(observed.privateWorker.reason,'deadline');
  const completed=structuredClone(f);completed.participants.events.value[0].parserConfirmed=true;
  completed.participants.bridges[channelId].completion.value={requestId:preparationRequestId,subject:f.participants.events.value[0].subject,closed:true,failed:false,
    metadata:{channel_id:channelId,exit_code:0,reason:null,private:'PRIVATE_CANARY'}};
  assert.equal(projectWorkspaceDiagnostic(completed).participants.observations[0].bridge.closed,true);
  assert.ok(!JSON.stringify(projectWorkspaceDiagnostic(completed)).includes('PRIVATE_CANARY'));
  for(const alter of [v=>v.events.value[0].subject.job_id=requestId,v=>v.events.value[0].phaseId=requestId]){
    const p=structuredClone(f.participants);alter(p);assert.equal(preparationParticipants(f.checkpoints.value,p).status,'no_correlated_observation');
  }
  for(const alter of [v=>v.bridges[channelId].request.value.id=phaseId,v=>v.bridges[channelId].completion.value.subject={...v.events.value[0].subject,attempt_generation:2}]){
    const p=structuredClone(f.participants);alter(p);const result=preparationParticipants(f.checkpoints.value,p);
    assert.equal(result.observations[0].bridge.completion,'invalid');assert.equal(result.observations[0].bridge.closed,null);
  }
  for(const state of ['absent','invalid','truncated'])assert.equal(preparationParticipants(f.checkpoints.value,{events:{status:state}}).status,state);
  assert.equal(preparationParticipants(f.checkpoints.value).status,'unavailable');
  const acceptance=structuredClone(f.checkpoints.value);
  for(const event of acceptance.events)if(event.stage==='input_dispatch_enter')event.stage='accept_returned';
  acceptance.lastOperation.stage='accept_returned';
  assert.equal(preparationParticipants(acceptance,f.participants).status,'no_correlated_observation');
});
test('preparation checkpoint keeps the latest bounded stage on overflow and validates group-specific cases',async()=>{
  let retained;
  const c=createWorkspaceCheckpoint('unused',{group:'ui-preparation',persist:(_,bytes)=>{assert.ok(bytes.length<=16384);retained=JSON.parse(bytes);}});
  await c.wrap({run:async(_,action)=>action()}).run('W12',async()=>{
    for(let i=0;i<70;i++)c.stage('dispatch_enter',jobId);
  });
  assert.equal(retained.events.length,64);assert.ok(retained.overflow>0);assert.equal(retained.lastEvent.stage,'observer_settled');
  assert.equal(retained.lastOperation.stage,'dispatch_enter');assert.ok(retained.lastOperation.seq>64);
  assert.deepEqual(validateCheckpoint(retained),retained);
  for(const alter of [v=>v.lastEvent.jobId='PRIVATE_CANARY',v=>v.events[1].caseId='W14-prepared',v=>v.lastEvent.secret='PRIVATE_CANARY']){
    const copy=structuredClone(retained);alter(copy);assert.throws(()=>validateCheckpoint(copy));
  }
  const runtime=await fs.readFile(new URL('./runtime_preparation.mjs',import.meta.url),'utf8');
  for(const [mark,action]of [["stage('dispatch_enter'","wait('extractor.dispatch', () => extractor.dispatch("],["stage('accept_enter'","wait('extractor.accept', () => extractor.accept("]])
    assert.ok(runtime.indexOf(mark)>=0&&runtime.indexOf(mark)<runtime.indexOf(action));
  assert.match(runtime,/if\(label==='extraction_phase_committed'\)checkpoint\?\.stage\('phase_committed',event.jobId,event.phaseId\)/);
  await c.wrap({run:async(_,action)=>action()}).run('W13',async()=>{
    c.stage('dispatch_enter',jobId);assert.equal(retained.lastOperation.phaseId,null);
    c.stage('phase_committed',jobId,phaseId);c.stage('input_dispatch_enter',jobId);
    assert.equal(retained.lastOperation.phaseId,phaseId);
    c.stage('accept_enter',jobId);assert.equal(retained.lastOperation.phaseId,null);
  });
});
test('preparation exporter reads only correlated bounded participant evidence and publishes no raw stream',async()=>temporaryWork(async temporary=>{
  const f=await preparationFixture(),input=path.join(temporary,'input'),directory=path.join(input,runId),output=path.join(temporary,'public');
  await writeFixture(directory,f);await fs.mkdir(path.join(directory,'runtime'));
  await fs.writeFile(path.join(directory,'runtime/workspace-checkpoints.json'),JSON.stringify(f.checkpoints.value));
  await fs.mkdir(path.join(directory,'extraction-private'));
  await fs.writeFile(path.join(directory,'extraction-private/events.ndjson'),f.participants.events.value.map(e=>JSON.stringify({...e,body:'PRIVATE_CANARY'})).join('\n'));
  const bridge=path.join(directory,'worker-bridge',channelId);await fs.mkdir(bridge,{recursive:true});
  for(const name of ['request','completion'])await fs.writeFile(path.join(bridge,name+'.json'),JSON.stringify(f.participants.bridges[channelId][name].value));
  assert.equal(await exportExtractionEvidence(input,output),true);
  const out=JSON.parse(await fs.readFile(path.join(output,runId+'-workspace-diagnostic.json')));
  assert.equal(out.group,'ui-preparation');assert.equal(out.participants.observations[0].privateWorker.parserConfirmed,false);
  assert.equal(out.participants.observations[0].bridge.closed,false);
  assert.ok(!JSON.stringify(out).includes('PRIVATE_CANARY'));
  const names=await fs.readdir(output);assert.equal(names.length,3);assert.ok(names.every(n=>n.endsWith('.json')));
  await fs.writeFile(path.join(directory,'extraction-private/events.ndjson'),'broken PRIVATE_CANARY');
  const bad=await readWorkspaceDiagnostic(directory,f.manifest,f.manifestSha256,f.commands);assert.equal(bad.participants.status,'invalid');
}));

const waitLine = (operation, stage, caseId = 'W12', fixture = 'inert.md') =>
  `# PREPARATION_WAIT ${caseId} ${fixture} ${operation} ${stage}\n`;
const acceptedLine = (outcome = 'completed', extra = {}) => '# PREPARATION_ACCEPTED ' + JSON.stringify({
  case: 'W12', fixture: 'inert.md', jobId, resultId: phaseId, effectId: channelId, state: 'accepted', outcome, ...extra,
}) + '\n';

test('preparation waits pair overlapping operations and retain the first throw without exporting error text or identities', () => {
  const trace = acceptedLine() + waitLine('inspect.response', 'entered') + waitLine('inspect.click', 'entered') +
    waitLine('inspect.click', 'returned') + waitLine('inspect.response', 'returned') + waitLine('inspect.response-finished', 'entered');
  const pending = projectPreparationWaits(trace, 'present', true);
  assert.equal(pending.status, 'present'); assert.equal(pending.captureComplete, true);
  assert.deepEqual([pending.entered, pending.returned, pending.threw, pending.unmatchedCount], [3, 2, 0, 1]);
  assert.deepEqual(pending.unmatched[0], {ordinal: 5, caseId: 'W12', fixture: 'inert.md', operation: 'inspect.response-finished', stage: 'entered'});
  assert.deepEqual(pending.accepted, [{caseId: 'W12', fixture: 'inert.md', state: 'accepted', outcome: 'completed'}]);
  const thrown = projectPreparationWaits(trace + waitLine('inspect.response-finished', 'threw') +
    "not ok 1 - case\n  ---\n  error: 'PRIVATE_CANARY'\n    # PREPARATION_WAIT W12 inert.md sql.accepted-result entered\n  ...\n", 'present', true);
  assert.equal(thrown.unmatchedCount, 0); assert.equal(thrown.threw, 1);
  assert.equal(thrown.firstThrow.operation, 'inspect.response-finished'); assert.deepEqual(thrown.lastEvent, thrown.firstThrow);
  for (const secret of ['PRIVATE_CANARY', jobId, phaseId, channelId]) assert.equal(JSON.stringify(thrown).includes(secret), false);
});

test('preparation wait absence, invalid sequences and incomplete capture remain explicit and bounded', () => {
  const valid = waitLine('save.response-json', 'entered') + waitLine('save.response-json', 'returned');
  assert.equal(projectPreparationWaits(finalTap, 'present', true).status, 'absent');
  assert.equal(projectPreparationWaits(valid, 'absent', false).status, 'absent');
  assert.equal(projectPreparationWaits(valid, 'invalid', false).status, 'invalid');
  const partial = projectPreparationWaits(valid, 'truncated', false);
  assert.equal(partial.status, 'truncated'); assert.equal(partial.captureComplete, false); assert.equal(partial.returned, 1);
  assert.equal(projectPreparationWaits(valid, 'present', false).captureComplete, false);
  for (const invalid of [waitLine('PRIVATE_CANARY', 'entered'), waitLine('save.response', 'entered', 'W12', 'PRIVATE_CANARY'),
    waitLine('save.response', 'entered', 'W09', 'inert.md'), waitLine('save.response', 'returned'),
    acceptedLine('PRIVATE_CANARY'), acceptedLine('completed', {body: 'PRIVATE_CANARY'}), acceptedLine() + acceptedLine(),
    acceptedLine('completed', {case: {toString: null}}), acceptedLine('completed', {case: ['W12']}),
    acceptedLine('completed', {fixture: {toString: null}}), acceptedLine('completed', {fixture: ['inert.md']})]) {
    const out = projectPreparationWaits(invalid, 'present', true);
    assert.equal(out.status, 'invalid'); assert.equal(out.captureComplete, false); assert.equal(JSON.stringify(out).includes('PRIVATE_CANARY'), false);
  }
  const pending = projectPreparationWaits(waitLine('inspect.response-finished', 'entered').repeat(9), 'present', true);
  assert.deepEqual([pending.unmatchedCount, pending.unmatched.length, pending.unmatchedOverflow], [9, 8, 1]);
  const overflow = projectPreparationWaits(valid.repeat(2049), 'present', true);
  assert.equal(overflow.status, 'truncated'); assert.equal(overflow.markerLimitReached, true); assert.equal(overflow.captureComplete, false);
  assert.equal(projectPreparationWaits('x'.repeat(1048577), 'present', true).status, 'truncated');
  assert.ok(Buffer.byteLength(JSON.stringify(pending, null, 2)) < 8192);
  const partialWorkbook = projectPreparationWaits(acceptedLine('partial', {fixture: 'unsupported-part.xlsx'}), 'present', true);
  assert.equal(partialWorkbook.accepted[0].outcome, 'partial');
});

test('the current exporter adds only the safe wait projection and preserves failed summary and companion semantics', async () => temporaryWork(async temporary => {
  const f = await preparationFixture(), input = path.join(temporary, 'input'), directory = path.join(input, runId), output = path.join(temporary, 'public');
  replaceRuntime(f, acceptedLine() + waitLine('inspect.response-finished', 'entered') +
    `    not ok 7 - ${preparationTestNames.W12}\n      ---\n      code: 'ERR_TEST_FAILURE'\n      failureType: 'cancelledByParent'\n      error: 'PRIVATE_CANARY'\n      ...\n`, {code: 1});
  f.manifest.completed = false;
  await writeFixture(directory, f);
  assert.equal(await exportExtractionEvidence(input, output), true);
  const ordinary = JSON.parse(await fs.readFile(path.join(output, runId + '.json')));
  assert.equal(ordinary.completed, false);
  assert.deepEqual(ordinary, extractionPublicSummary(f.manifest, digest(await fs.readFile(path.join(directory, 'manifest.json'))), f.commands));
  const companion = JSON.parse(await fs.readFile(path.join(output, runId + '-workspace-diagnostic.json')));
  assert.equal(companion.manifestSha256, ordinary.manifestSha256); assert.equal(companion.waits.unmatchedCount, 1);
  assert.equal(companion.waits.unmatched[0].operation, 'inspect.response-finished');
  assert.equal(companion.runtime.firstTestFailure.caseId, 'W12'); assert.equal(companion.runtime.firstTestFailure.failureType, 'cancelledByParent');
  assert.equal(JSON.stringify(companion).includes('PRIVATE_CANARY'), false);
  assert.deepEqual((await fs.readdir(output)).sort(), ['PUBLIC-MANIFEST.json', runId + '.json', runId + '-workspace-diagnostic.json'].sort());
}));

test('response failures expose only bounded fixed categories and Chromium codes', () => {
  for (const code of ['ERR_RESPONSE_BODY_DEADLINE', 'ERR_RESPONSE_BODY_REJECTED', 'ERR_RESPONSE_REQUEST_FAILED',
    'ERR_RESPONSE_REQUEST_FAILED:net::ERR_CONTENT_LENGTH_MISMATCH']) {
    const f = replaceRuntime(fixture(), "not ok 1 - controlled body\n  ---\n  code: '" + code + "'\n  failureType: 'testCodeFailure'\n  error: 'PRIVATE_CANARY'\n  ...\n", {code: 1});
    const out = projectWorkspaceDiagnostic(f);
    assert.equal(out.runtime.firstTestFailure.code, code);
    assert.equal(JSON.stringify(out).includes('PRIVATE_CANARY'), false);
  }
  for (const code of ['PRIVATE_CANARY', 'ERR_RESPONSE_REQUEST_FAILED:net::private', 'ERR_RESPONSE_REQUEST_FAILED:https://private',
    'ERR_RESPONSE_REQUEST_FAILED:net::' + 'A'.repeat(65), 'ERR_RESPONSE_BODY_REJECTED:PRIVATE_CANARY']) {
    const f = replaceRuntime(fixture(), "not ok 1 - controlled body\n  ---\n  code: '" + code + "'\n  failureType: 'testCodeFailure'\n  ...\n", {code: 1});
    const out = projectWorkspaceDiagnostic(f);
    assert.equal(out.runtime.firstTestFailure.code, null);
    assert.equal(JSON.stringify(out).includes(code), false);
  }
});

test('the existing exporter retains a classified request failure without error prose', async () => temporaryWork(async temporary => {
  const f = fixture(), input = path.join(temporary, 'input'), directory = path.join(input, runId), output = path.join(temporary, 'public');
  const code = 'ERR_RESPONSE_REQUEST_FAILED:net::ERR_CONTENT_LENGTH_MISMATCH';
  replaceRuntime(f, "not ok 1 - controlled body\n  ---\n  code: '" + code + "'\n  failureType: 'testCodeFailure'\n  error: 'PRIVATE_CANARY'\n  ...\n", {code: 1});
  f.manifest.completed = false; await writeFixture(directory, f);
  assert.equal(await exportExtractionEvidence(input, output), true);
  const companion = JSON.parse(await fs.readFile(path.join(output, runId + '-workspace-diagnostic.json')));
  assert.equal(companion.runtime.firstTestFailure.code, code);
  assert.equal(JSON.stringify(companion).includes('PRIVATE_CANARY'), false);
  assert.deepEqual((await fs.readdir(output)).sort(), ['PUBLIC-MANIFEST.json', runId + '.json', runId + '-workspace-diagnostic.json'].sort());
}));
