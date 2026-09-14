import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { counters, validateArmed, validateTermination, referenceCase, referenceFailure, L03_REFERENCE } from '../../../ci/intake_l03_reference.mjs';
import { qualifyReferenceHost, sliceCreateCommand, startAttached, linuxReferencePorts } from '../../../ci/intake_l03_linux.mjs';

// Independent literal observations. These are synthetic port/decision tests,
// never evidence that this machine performed a physical cgroup OOM.
const zero = () => ({ max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0 });
function specimen(mode = 'memory') {
  const id = '1'.repeat(64), reference = 'system-ldl03' + '2'.repeat(32) + '.slice';
  const before = { path: '/system.slice/' + reference, identity: '29:1001', invocation: '3'.repeat(32),
    processes: [], children: [], memoryMax: 'max', events: zero(), localEvents: zero(), active: 'active' };
  const child = { name: 'docker-' + id + '.scope', identity: '29:1002', processes: [2345], children: [],
    memoryMax: '536870912', swapMax: '0', cpuMax: '100000 100000', pidsMax: '64', events: zero() };
  return { profile: L03_REFERENCE, reference, image: 'sha256:' + '4'.repeat(64), before,
    armed: { ...structuredClone(before), children: [child] }, probeMatchesSource: true,
    container: { id, pid: 2345, startTicks: '900123', membership: before.path + '/' + child.name,
      parent: reference, restartCount: 0, restartPolicy: 'no', image: 'sha256:' + '4'.repeat(64), memory: 536870912, memorySwap: 536870912 },
    after: { ...structuredClone(before), events: mode === 'memory' ? { max: 42, oom: 1, oom_kill: 1, oom_group_kill: 0 } : zero() },
    outcome: { id, running: false, restartCount: 0, exit: 137, clientCode: 137, clientClosed: true,
      encodingError: false, reason: mode === 'watchdog' ? 'worker_timeout' : null,
      intervention: mode === 'memory' ? null : mode, dockerOOMKilled: mode === 'memory' } };
}

test('L03-R01: exact case reference accepts limit pressure and one OOM victim with either Docker flag', () => {
  for (const flag of [true, false]) {
    const record = specimen(); record.outcome.dockerOOMKilled = flag;
    assert.equal(validateArmed(record), true);
    assert.deepEqual(validateTermination(record, 'memory'), { mode: 'memory', limitBytes: 536870912,
      memoryEvents: { max: 42, oom: 1, oom_kill: 1, oom_group_kill: 0 }, dockerOOMKilled: flag, acceptedAsOOM: true });
  }
});
for (const mode of ['external', 'watchdog']) test('L03-R02: ' + mode + ' exit137 is observed but is never credited as OOM', () => {
  const record = specimen(mode);
  assert.equal(validateTermination(record, mode).acceptedAsOOM, false);
  assert.throws(() => validateTermination(record, 'memory'));
  record.outcome.dockerOOMKilled = true;
  assert.throws(() => validateTermination(record, 'memory'));
});

const negatives = [
  ['exit137 alone', r => { r.after.events = zero(); }],
  ['OOM without measured cgroup pressure', r => { r.after.events.max = 0; r.after.events.oom = 0; }],
  ['limit pressure without an OOM victim', r => { r.after.events.oom_kill = 0; }],
  ['more than one victim', r => { r.after.events.oom_kill = 2; }],
  ['group kill rather than single case', r => { r.after.events.oom_group_kill = 1; }],
  ['supervisor intervened despite counters', r => { r.outcome.reason = 'worker_timeout'; }],
  ['external intervention despite counters', r => { r.outcome.intervention = 'external'; }],
  ['lost terminal evidence', r => { delete r.after; }],
  ['missing counter', r => { delete r.after.events.oom; }],
  ['removed reference', r => { r.after.active = 'inactive'; }],
  ['replaced reference inode', r => { r.after.identity = '29:1009'; }],
  ['restarted slice', r => { r.after.invocation = '5'.repeat(32); }],
  ['foreign sibling', r => { r.armed.children.push({ ...r.armed.children[0], name: 'other.scope' }); }],
  ['foreign PID', r => { r.armed.children[0].processes.push(3456); }],
  ['foreign direct ancestor process', r => { r.armed.processes = [3456]; }],
  ['previous occupant', r => { r.before.events.oom_kill = 1; }],
  ['process in another group', r => { r.container.membership = '/other.scope'; }],
  ['wrong native bytes', r => { r.probeMatchesSource = false; }],
  ['memory bound changed', r => { r.armed.children[0].memoryMax = '1073741824'; }],
  ['swap added', r => { r.armed.children[0].swapMax = '536870912'; }],
  ['competing ancestor limit', r => { r.armed.memoryMax = '536870912'; }],
  ['event local to ancestor, not its case', r => { r.after.localEvents.oom = 1; }],
  ['foreign terminal child', r => { r.after.children = [{ ...r.armed.children[0], name: 'other.scope', processes: [] }]; }],
  ['client not closed', r => { r.outcome.clientClosed = false; }],
  ['unexpected restart', r => { r.outcome.restartCount = 1; }],
  ['wrong container result', r => { r.outcome.id = '9'.repeat(64); }],
];
for (const [label, mutate] of negatives) test('L03-R03: reject ' + label, () => {
  assert.equal(validateTermination(specimen(), 'memory').acceptedAsOOM, true);
  const negative = specimen(); mutate(negative);
  assert.throws(() => validateTermination(negative, 'memory'));
});

test('L03-R04: counter parser requires complete unambiguous integers, not default zero', () => {
  const raw = 'low 0\nhigh 0\nmax 42\noom 1\noom_kill 1\noom_group_kill 0\n';
  assert.equal(counters(raw).oom_kill, 1);
  for (const changed of [undefined, '', raw + 'oom 1\n', raw.replace('oom 1\n', ''), raw.replace('oom 1', 'oom -1'), raw.replace('oom 1', 'oom 1.0'), raw.replace('oom 1', 'oom 9007199254740992')]) assert.throws(() => counters(changed));
});

function ports(mode = 'memory', fault) {
  const record = specimen(mode), order = [], saved = [];
  const io = {
    async prepare() { order.push('prepare'); if (fault === 'prepare') throw Error('PREPARE_FAILURE'); return { reference: record.reference, image: record.image, before: record.before }; },
    async arm() { order.push('arm'); const value = { armed: record.armed, container: record.container, probeMatchesSource: true }; if (fault === 'foreign') value.armed.children[0].processes.push(9999); return value; },
    async execute() { order.push('release'); if (fault === 'execute') throw Error('PRIMARY_EXECUTION_FAILURE'); return record.outcome; },
    async readAfter() { order.push('read-after'); if (fault === 'missing') throw Error('REFERENCE_DISAPPEARED'); return record.after; },
    async cleanup() { order.push('cleanup'); if (fault === 'cleanup') throw Error('CLEANUP_FAILURE'); return { confirmed: fault !== 'unconfirmed' }; },
    async persist(phase, value) { order.push('save-' + phase); if (fault === 'export' && phase === 'armed') throw Error('EXPORT_FAILURE'); saved.push({ phase, record: structuredClone(value) }); },
  };
  return { io, order, saved };
}
for (const mode of ['memory', 'external', 'watchdog']) test('L03-R05: actual composition ' + mode + ' retains reference through read/export and then cleans it', async () => {
  const p = ports(mode), result = await referenceCase(p.io, mode);
  assert.equal(result.cleanup.confirmed, true);
  assert.deepEqual(p.order, ['prepare', 'save-before', 'arm', 'save-armed', 'release', 'read-after', 'save-after', 'cleanup', 'save-result']);
  assert.equal(p.order.filter(value => value === 'release').length, 1);
});
for (const fault of ['prepare', 'foreign', 'execute', 'missing', 'cleanup', 'unconfirmed', 'export']) test('L03-R06: actual composition preserves failure and own cleanup: ' + fault, async () => {
  const p = ports('memory', fault);
  await assert.rejects(referenceCase(p.io, 'memory'));
  assert.equal(p.order.filter(value => value === 'cleanup').length, 1);
  assert.equal(p.order.filter(value => value === 'release').length, ['prepare', 'foreign', 'export'].includes(fault) ? 0 : 1);
  assert.ok(p.saved.at(-1).record.failure);
});

const host = { platform: 'linux', actions: 'true', environment: 'github-hosted', driver: 'systemd', version: '2',
  sameNamespace: true, sameKernel: true, rootless: false, localEvents: false,
  socket: 'unix:///var/run/docker.sock', contextSocket: 'unix:///var/run/docker.sock', hostOverride: null };
test('L03-R07: host qualification cannot silently switch driver, namespace or shared/local environment', () => {
  assert.equal(qualifyReferenceHost(host), true);
  for (const delta of [{ platform: 'win32' }, { environment: 'self-hosted' }, { actions: undefined }, { driver: 'cgroupfs' }, { sameNamespace: false }, { sameKernel: false }, { localEvents: true }, { rootless: true }, { version: '1' }, { contextSocket: 'tcp://elsewhere' }, { hostOverride: 'default' }]) assert.throws(() => qualifyReferenceHost({ ...host, ...delta }));
  const args = sliceCreateCommand('system-ldl03' + '2'.repeat(32) + '.slice', 'case');
  assert.deepEqual(args.slice(0, 6), ['-n', '/usr/bin/timeout', '--signal=KILL', '5s', '/usr/bin/busctl', 'call']);
  assert.ok(args.includes('StartTransientUnit')); assert.ok(args.includes('StopWhenUnneeded'));
  for (const name of ['system.slice', '../../other', 'docker.service']) assert.throws(() => sliceCreateCommand(name, 'case'));
});

test('L03-R08: actual attached client waits for the gate and has one release (synthetic process, no memory load)', async () => {
  let launches = 0;
  const transport = startAttached('1'.repeat(64), { launch(bin, args, options) {
    launches++; assert.equal(bin, 'docker'); assert.deepEqual(args, ['--host', 'unix:///var/run/docker.sock', 'start', '-a', '-i', '1'.repeat(64)]);
    return spawn(process.execPath, ['-e', "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.exit(s==='run\\n'?137:2));process.stdout.write('L03_READY\\n');"], options);
  } });
  try {
    await transport.ready; transport.release(); assert.throws(() => transport.release());
    const result = await transport.done;
    assert.deepEqual({ code: result.code, closed: result.closed, reason: result.reason, launches }, { code: 137, closed: true, reason: undefined, launches: 1 });
  } finally { await transport.close(); }
});

test('L03-R09: synthetic attached timeout is retained, not recast as an OOM', async () => {
  const transport = startAttached('1'.repeat(64), { milliseconds: 500, launch(bin, args, options) {
    return spawn(process.execPath, ['-e', "process.stdout.write('L03_READY\\n');process.stdin.resume();setInterval(()=>{},1000);"], options);
  } });
  try { await transport.ready; transport.release(); await transport.expired; const result = await transport.close(); assert.equal(result.reason, 'worker_timeout'); }
  finally { await transport.close(); }
});

test('L03-R10: runner invokes the actual reference path with retained bounds; historical comparison remains pinned', () => {
  const source = fs.readFileSync(new URL('../../../ci/intake_t01_check.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("await check('L03','Native allocation reaches cgroup limit, not only JS heap',()=>checkNativeMemory({image:parserImage,flags:parserFlags,sourceRoot,save,exec,openReferenceRecovery,registerReference}))"));
  for (const value of ['--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only']) assert.ok(source.includes(value));
  const probe = fs.readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8');
  assert.ok(probe.includes("else if(kind==='memory'){const chunks=[];while(true){const b=Buffer.alloc(16*1024*1024,1);chunks.push(b);}}"));
  const loader = fs.readFileSync(new URL('./l03_gate.mjs', import.meta.url), 'utf8');
  assert.ok(loader.indexOf("process.stdin.on('end'") < loader.indexOf("await import('./probe.mjs')"));
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/l03-profile-comparison.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("github.event.before == 'ad466b40cbd41c418199b8f2cd5d9894198d58c3'"));
});

test('L03-B02: final export preserves the original error object and accumulated terminal record', async () => {
  const primary = Error('ORIGINAL_EXECUTION_FAILURE'), secondary = Error('RESULT_EXPORT_FAILURE');
  let caught, cleanups = 0;
  try {
    await referenceCase({ prepare: async () => { throw primary; },
      cleanup: async () => { cleanups++; return { confirmed: true }; },
      persist: async phase => { assert.equal(phase, 'result'); throw secondary; } }, 'memory');
  } catch (error) { caught = error; }
  assert.equal(caught, primary);
  assert.equal(cleanups, 1);
  const terminal = referenceFailure(caught);
  assert.equal(terminal.secondaryErrors[0], secondary);
  assert.deepEqual(terminal.record.errors.map(e => [e.phase, e.message]), [
    ['execution', 'ORIGINAL_EXECUTION_FAILURE'], ['result-export', 'RESULT_EXPORT_FAILURE']]);
  assert.equal(terminal.record.cleanup.confirmed, true);
});

test('L03-B02: an export-only failure fails the case without discarding its successful observations', async () => {
  const p = ports(), secondary = Error('ONLY_RESULT_EXPORT_FAILURE');
  const save = p.io.persist;
  p.io.persist = async (phase, record) => { if (phase === 'result') throw secondary; await save(phase, record); };
  let caught;
  try { await referenceCase(p.io, 'memory'); } catch (error) { caught = error; }
  assert.equal(caught, secondary);
  const retained = referenceFailure(caught);
  assert.deepEqual(retained.secondaryErrors, []);
  assert.equal(retained.record.verdict.acceptedAsOOM, true);
  assert.equal(retained.record.cleanup.confirmed, true);
  assert.equal(retained.record.failure.message, secondary.message);
});

test('L03-B02/B03: failed exports do not delay cleanup or erase terminal observations and secondary errors', async () => {
  const p = ports(), primary = Error('ATTACHED_EXPORT_FAILED'), postmortem = Error('POSTMORTEM_EXPORT_FAILED'), final = Error('FINAL_EXPORT_FAILED');
  const expected = specimen();
  p.io.execute = async (mode, observe) => { observe({ outcome: expected.outcome }); throw primary; };
  p.io.recoverTerminal = async observe => { observe({ after: expected.after }); return []; };
  const save = p.io.persist;
  p.io.persist = async (phase, record) => {
    if (phase === 'postmortem') throw postmortem;
    if (phase === 'result') throw final;
    await save(phase, record);
  };
  let caught;
  try { await referenceCase(p.io, 'memory'); } catch (error) { caught = error; }
  assert.equal(caught, primary);
  assert.equal(p.order.filter(phase => phase === 'cleanup').length, 1);
  const retained = referenceFailure(caught);
  assert.deepEqual(retained.secondaryErrors, [postmortem, final]);
  assert.deepEqual({ outcome: retained.record.outcome, after: retained.record.after, cleanup: retained.record.cleanup },
    { outcome: expected.outcome, after: expected.after, cleanup: { confirmed: true } });
  assert.equal(retained.record.verdict, undefined, 'Available facts do not turn an export failure into an accepted case');
});
