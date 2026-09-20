import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateCheckpoint, checkpointFailureMarker} from '../../tests/intake/ui/diagnostic_checkpoint.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runPattern = /^intake-extraction-\d{4}-\d{2}-\d{2}[tT][0-9-]+[zZ]-[a-f0-9]{8}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const commandPattern = /^[0-9]{3,6}-command\.json$/;
const inputStatuses = new Set(['present', 'absent', 'invalid', 'truncated']);
const integer = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const boolean = n => typeof n === 'boolean' ? n : null;
const pollScript = "const f=require('fs');const p='/work/output/admin-request.json';process.stdout.write(f.existsSync(p)?f.readFileSync(p):'null')";
const replyScript = "const f=require('fs'),c=require('crypto'),id=process.argv[1],n=Number(process.argv[2]),h=process.argv[3];" +
  "if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(n)||n<0||n>8388608||!/^[a-f0-9]{64}$/.test(h))throw Error('ADMIN_REPLY_SCOPE');" +
  "const p='/work/output/admin-response-'+id,b=f.readFileSync(p+'.pending');" +
  "if(b.length!==n||c.createHash('sha256').update(b).digest('hex')!==h||f.existsSync(p+'.json'))throw Error('ADMIN_REPLY_INTEGRITY');" +
  "f.renameSync(p+'.pending',p+'.json');";
const reply = Buffer.from('{"ok":true}');
const equal = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
const docker = c => c && ['docker', 'docker.exe'].includes(c.program) && Array.isArray(c.args);
const succeeded = c => c.code === 0 && c.signal === null && (c.reason === undefined || c.reason === null);

// Read only named members, rejecting symlinked ancestors as well as the member.
// No worker, browser, object-store or directory enumeration is performed here.
async function member(directory, name, limit) {
  try {
    if (!['source-manifest.json', 'runtime-inspect.json', 'runtime-state.json', 'runtime/workspace-checkpoints.json'].includes(name))
      return {status: 'invalid'};
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) return {status: 'invalid'};
    const parts = name.split('/'); let file = directory;
    for (let i = 0; i < parts.length; i++) {
      file = path.join(file, parts[i]); const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return {status: 'invalid'};
      if (i === parts.length - 1 && stat.size > limit) return {status: 'truncated'};
    }
    const handle = await fs.open(file, 'r');
    try {
      const bytes = Buffer.alloc(limit + 1); let length = 0;
      while (length < bytes.length) {const r = await handle.read(bytes, length, bytes.length - length, null); if (!r.bytesRead) break; length += r.bytesRead;}
      if (length > limit) return {status: 'truncated'};
      const retained = bytes.subarray(0, length);
      return {status: 'present', value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(retained)), sha256: hash(retained)};
    } finally {await handle.close();}
  } catch (error) {return {status: error.code === 'ENOENT' ? 'absent' : 'invalid'};}
}

function runtimeIdentity(m, inspection) {
  if (m.group !== 'extraction') return null;
  if (!Array.isArray(inspection) || inspection.length !== 1) throw Error('WORKSPACE_RUNTIME_ASSOCIATION');
  const i = inspection[0], env = i?.Config?.Env;
  if (!Array.isArray(env)) throw Error('WORKSPACE_RUNTIME_ASSOCIATION');
  const selected = env.filter(e => typeof e === 'string' && e.startsWith('LEDGERDESK_PREPARATION_CASES='));
  if (selected.length === 0 || selected.length === 1 && selected[0] !== 'LEDGERDESK_PREPARATION_CASES=ui-protection') return null;
  if (selected.length !== 1 || env.filter(e => typeof e === 'string' && e.startsWith('LEDGERDESK_EXTRACTION_CASES=')).length !== 1 ||
      !env.includes('LEDGERDESK_EXTRACTION_CASES=preparation')) throw Error('WORKSPACE_RUNTIME_ASSOCIATION');
  const name = typeof i.Name === 'string' ? i.Name.slice(1) : '', match = /^ld-i03-t02-([a-f0-9]{8})-runtime$/.exec(name);
  const owned = m.resources?.filter(r => r.type === 'container' && r.name === name);
  if (!match || i.Name !== '/' + name || !/^[a-f0-9]{64}$/.test(i.Id) || owned?.length !== 1 || owned[0].id !== i.Id ||
      i.Config.Labels?.['intake.t02.run'] !== 'ld-i03-t02-' + match[1] || i.Config.Entrypoint !== null ||
      !equal(i.Config.Cmd, ['node', '--experimental-strip-types', '--test', '--test-concurrency=1', 'tests/intake/t02/test_runtime.mjs']))
    throw Error('WORKSPACE_RUNTIME_ASSOCIATION');
  return name;
}

function capture(c) {
  if (typeof c.stdout !== 'string' || typeof c.stderr !== 'string' || integer(c.stdoutBytes) === null ||
      integer(c.stdoutRetainedBytes) === null || integer(c.stderrBytes) === null || integer(c.stderrRetainedBytes) === null ||
      typeof c.stdoutEncodingError !== 'boolean' || typeof c.stderrEncodingError !== 'boolean' || typeof c.stderrTruncated !== 'boolean') return 'invalid';
  if (c.stdoutEncodingError || c.stderrEncodingError) return 'invalid';
  if (Buffer.byteLength(c.stdout) !== c.stdoutRetainedBytes || Buffer.byteLength(c.stderr) !== c.stderrRetainedBytes ||
      c.stdoutBytes < c.stdoutRetainedBytes || c.stderrBytes < c.stderrRetainedBytes) return 'invalid';
  return c.stdoutBytes !== c.stdoutRetainedBytes || c.stderrBytes !== c.stderrRetainedBytes || c.stderrTruncated ? 'truncated' : 'present';
}

function tapProjection(stdout, completeCapture) {
  const result = {complete: false};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...stdout.matchAll(new RegExp('^# ' + key + ' ([0-9]+)\\r?$', 'gm'))];
    if (matches.length === 1 && integer(Number(matches[0][1])) !== null) result[key] = Number(matches[0][1]);
  }
  result.complete = completeCapture && ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(k => k in result) &&
    /^# duration_ms [0-9.]+\r?$/m.test(stdout);
  return result;
}

// Only a Node diagnostic block immediately following a failed TAP result can
// establish the fixed timeout classification. Product error text is not parsed.
function tapFailures(stdout) {
  const lines = stdout.split(/\r?\n/), failures = [];
  const types = new Set(['testTimeoutFailure', 'cancelledByParent', 'testCodeFailure', 'subtestsFailed']);
  const codes = new Set(['ERR_ASSERTION', 'ERR_TEST_FAILURE']);
  for (let i = 0; i < lines.length; i++) {
    const start = /^([ ]*)not ok [0-9]+ - [^\r\n]*$/.exec(lines[i]);
    if (!start) continue;
    const indent = start[1] + '  ', values = {code: [], failureType: []}; let ended = false, consumed = i;
    if (lines[i + 1] === indent + '---') for (let j = i + 2; j < lines.length; j++) {
      if (lines[j] === indent + '...') {ended = true; consumed = j; break;}
      if (lines[j].trim() && !lines[j].startsWith(indent)) break;
      consumed = j;
      const field = new RegExp('^' + indent + "(code|failureType): '([^']*)'$").exec(lines[j]);
      if (field) values[field[1]].push(field[2]);
    }
    const code = ended && values.code.length === 1 && codes.has(values.code[0]) ? values.code[0] : null;
    const failureType = ended && values.failureType.length === 1 && types.has(values.failureType[0]) ? values.failureType[0] : null;
    failures.push({status: code || failureType ? 'observed' : 'unknown', code, failureType});
    // A diagnostic's literal error/stack can contain a complete-looking TAP
    // result. It is data inside this block, never another reported test.
    i = consumed;
  }
  return failures;
}

function completionProjection(commands, name) {
  const unknown = {request: 'unknown', replyPublished: 'unknown', requestOrdinal: null, copyOrdinal: null, publicationOrdinal: null};
  const requests = []; let unavailable = null;
  for (const [index, c] of commands.entries()) {
    if (!docker(c) || !equal(c.args, ['exec', name, 'node', '-e', pollScript]) || !succeeded(c)) continue;
    const status = capture(c);
    if (status !== 'present') {unavailable = status; continue;}
    try {const r = JSON.parse(c.stdout); if (r?.action === 'complete') requests.push({r, index});}
    catch {unavailable = 'invalid';}
  }
  if (!requests.length) return {status: unavailable ?? 'absent', value: unknown};
  if (requests.length !== 1) return {status: 'invalid', value: unknown};
  const {r, index} = requests[0];
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.id) || r.body?.scope !== 'runtime-cleanup') return {status: 'invalid', value: unknown};
  const copies = commands.flatMap((c, j) => j > index && docker(c) && c.args.length === 3 && c.args[0] === 'cp' &&
    c.args[2] === name + ':/work/output/admin-response-' + r.id + '.pending' && succeeded(c) ? [j] : []);
  const publishes = commands.flatMap((c, j) => j > index && docker(c) && equal(c.args,
    ['exec', name, 'node', '-e', replyScript, r.id, String(reply.length), hash(reply)]) && succeeded(c) ? [j] : []);
  if (copies.length > 1 || publishes.length > 1 || publishes.length === 1 && (copies.length !== 1 || copies[0] >= publishes[0]))
    return {status: 'invalid', value: unknown};
  return {status: 'present', value: {...unknown, request: 'observed', requestOrdinal: index + 1,
    ...(copies.length === 1 ? {copyOrdinal: copies[0] + 1} : {}),
    ...(publishes.length === 1 ? {replyPublished: 'observed', publicationOrdinal: publishes[0] + 1} : {})}};
}

// Inputs are retained local evidence, not authenticated claims from a worker.
// Identity and closed construction prevent unrelated commands acquiring meaning.
export function projectWorkspaceDiagnostic({manifest: m, manifestSha256, source, inspection, commands, state, checkpoints}) {
  if (!runPattern.test(m.runId) || !shaPattern.test(manifestSha256) || !Array.isArray(m.commands) || m.commands.length > 10000 ||
      m.commands.length !== commands.length || new Set(m.commands.map(c => c.file)).size !== commands.length ||
      m.commands.some((c, i) => !commandPattern.test(c.file) || c.code !== commands[i]?.code || (c.reason ?? null) !== (commands[i]?.reason ?? null)))
    throw Error('WORKSPACE_COMMAND_ASSOCIATION');
  const name = runtimeIdentity(m, inspection);
  if (!name) return null;
  if (source.status !== 'present' || !shaPattern.test(source.sha256) || source.sha256 !== m.sourceManifestSha256 ||
      source.value?.runId !== m.runId || source.value.profile !== 'intake-t02-source/1') throw Error('WORKSPACE_SOURCE_ASSOCIATION');
  const selected = commands.flatMap((c, i) => docker(c) && equal(c.args, ['start', '-a', name]) ? [{c, ordinal: i + 1}] : []);
  let runtimeStatus = selected.length ? 'invalid' : 'absent', runtime = null, tap = {complete: false}, stdout = '';
  if (selected.length === 1) {
    const {c, ordinal} = selected[0]; runtimeStatus = capture(c);
    const captureComplete = runtimeStatus === 'present' && (c.reason === undefined || c.reason === null) && c.signal === null;
    stdout = runtimeStatus === 'invalid' ? '' : c.stdout;
    const failures = tapFailures(stdout);
    runtime = {ordinal, exitCode: Number.isSafeInteger(c.code) ? c.code : null, durationMs: integer(c.milliseconds),
      termination: c.reason === 'worker_timeout' ? 'worker_timeout' : c.reason ? 'other' : c.signal ? 'other' : 'none',
      captureComplete, innerTimeout: failures.some(f => f.failureType === 'testTimeoutFailure') ? 'observed' : captureComplete ? 'not_observed_in_complete_capture' : 'unknown',
      firstTestFailure: failures[0] ?? {status: captureComplete ? 'not_observed_in_complete_capture' : 'unknown', code: null, failureType: null}};
    tap = tapProjection(stdout, captureComplete);
  }
  let checkpointStatus = inputStatuses.has(checkpoints.status) ? checkpoints.status : 'invalid', checkpoint = null;
  if (checkpointStatus === 'present') {
    try {checkpoint = validateCheckpoint(checkpoints.value); if (checkpoint.overflow) checkpointStatus = 'truncated';}
    catch {checkpointStatus = 'invalid';}
  }
  if (stdout.split(/\r?\n/).some(line => line === '# ' + checkpointFailureMarker || line === checkpointFailureMarker)) {
    checkpointStatus = 'invalid'; checkpoint = null;
  }
  let container = null, stateStatus = inputStatuses.has(state.status) ? state.status : 'invalid';
  if (stateStatus === 'present') {
    const s = state.value;
    if (!s || ['Running', 'OOMKilled', 'Restarting', 'Dead'].some(k => boolean(s[k]) === null) || integer(s.ExitCode) === null) stateStatus = 'invalid';
    else container = {running: s.Running, exitCode: s.ExitCode, oomKilled: s.OOMKilled, restarting: s.Restarting, dead: s.Dead};
  }
  const completion = completionProjection(commands, name);
  const lines = new Set(stdout.split(/\r?\n/));
  return {profile: 'intake-workspace-diagnostic/1', runId: m.runId, manifestSha256, sourceManifestSha256: source.sha256, group: 'ui-protection',
    inputs: {runtimeCommand: runtimeStatus, runtimeState: stateStatus, checkpoints: checkpointStatus, completion: completion.status},
    runtime, tap, checkpoints: checkpoint, completion: completion.value, container,
    cleanupMarkers: Object.fromEntries(['INTAKE_WORKSPACE_CLEANED', 'INTAKE_T02_RUNTIME_CLEANED', 'ACCESS_PG_CLEANED']
      .map(k => [k, lines.has(k) || lines.has('# ' + k) ? 'observed' : 'unknown']))};
}

export async function readWorkspaceDiagnostic(directory, manifest, manifestSha256, commands) {
  if (manifest.group !== 'extraction') return null;
  const inspection = await member(directory, 'runtime-inspect.json', 1048576);
  if (inspection.status === 'absent') return null;
  if (inspection.status !== 'present') throw Error('WORKSPACE_RUNTIME_ASSOCIATION');
  if (!runtimeIdentity(manifest, inspection.value)) return null;
  if (path.basename(directory) !== manifest.runId) throw Error('WORKSPACE_RUN_ASSOCIATION');
  return projectWorkspaceDiagnostic({manifest, manifestSha256, commands, inspection: inspection.value,
    source: await member(directory, 'source-manifest.json', 8388608),
    state: await member(directory, 'runtime-state.json', 65536),
    checkpoints: await member(directory, 'runtime/workspace-checkpoints.json', 16384)});
}
