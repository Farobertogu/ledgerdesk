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
import {createWorkspaceCheckpoint, validateCheckpoint} from './diagnostic_checkpoint.mjs';
import {projectWorkspaceDiagnostic, readWorkspaceDiagnostic} from '../../../ci/intake/workspace_diagnostic.mjs';
import {exportExtractionEvidence, extractionPublicSummary} from '../../../ci/intake_extraction_artifacts.mjs';

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
  for (const [mark, consumer] of [["createWorkspaceCheckpoint('/work/output')", 'await preparationControl('],
    ["mark('app_prepare_enter')", 'await app.prepare()'], ["mark('chromium_launch_enter')", 'await chromium.launch('],
    ["mark('protection_enter')", 'await workspaceProtection('], ["mark('context_close_enter')", 'await context?.close()'],
    ["mark('browser_close_enter')", 'await browser?.close()'], ["mark('app_close_enter')", 'await app?.close()']]) {
    assert.ok(runtime.includes(mark) && runtime.indexOf(mark) < runtime.indexOf(consumer), mark);
  }
  assert.ok(runtime.indexOf("mark('workspace_closed')") > runtime.indexOf('await app?.close()'));
  assert.match(runtime, /process\.env\.LEDGERDESK_PREPARATION_CASES === 'ui-protection'\s*\? createWorkspaceCheckpoint/);
  const parent = await fs.readFile(new URL('../t02/test_runtime.mjs', import.meta.url), 'utf8');
  const runner = await fs.readFile(new URL('../../../ci/intake_t02_check.mjs', import.meta.url), 'utf8');
  assert.match(parent, /\?300000:180000/); assert.match(runner, /\?330000:240000/);
});
