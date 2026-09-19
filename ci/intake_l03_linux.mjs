import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { collectProcessOutput } from '../tests/intake/t01/reviewed/process-output.mjs';
import { captureClient, tarMemberIdentity } from './intake_l03_observer.mjs';
import { counters, referenceCase, t03ProbeArgs } from './intake_l03_reference.mjs';

const socket = 'unix:///var/run/docker.sock';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = name => assert.match(name, /^system-ldl03[a-f0-9]{32}\.slice$/);

async function text(file, bytes = 4096) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    assert.ok(bytesRead <= bytes, 'KERNEL_FILE_LIMIT');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)).trim();
  } finally { await handle.close(); }
}
const pids = value => value === '' ? [] : value.split('\n').map(value => {
  assert.match(value, /^[1-9][0-9]*$/); const number = Number(value);
  assert.ok(Number.isSafeInteger(number)); return number;
}).sort((a, b) => a - b);
const identity = stat => String(stat.dev) + ':' + String(stat.ino);

export function qualifyReferenceHost(facts) {
  assert.deepEqual({ platform: facts.platform, actions: facts.actions, environment: facts.environment,
    driver: facts.driver, version: facts.version, namespace: facts.sameNamespace,
    kernel: facts.sameKernel, rootless: facts.rootless, localEvents: facts.localEvents },
  { platform: 'linux', actions: 'true', environment: 'github-hosted', driver: 'systemd', version: '2',
    namespace: true, kernel: true, rootless: false, localEvents: false }, 'EXCLUSIVE_REFERENCE_HOST_REQUIRED');
  assert.ok(facts.socket === socket && facts.contextSocket === socket && !facts.hostOverride, 'LOCAL_DAEMON_REQUIRED');
  return true;
}

export function sliceCreateCommand(name, description) {
  safeName(name);
  return ['-n', '/usr/bin/timeout', '--signal=KILL', '5s', '/usr/bin/busctl',
    'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
    name, 'fail', '3', 'Description', 's', description,
    'MemoryAccounting', 'b', 'true', 'StopWhenUnneeded', 'b', 'false', '0'];
}

// The attached client is a single launch. The gate is released only after the
// reference, PID and exact executable files have been checked and exported.
export function startAttached(id, { launch = spawn, milliseconds = 10000 } = {}) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const args = ['--host', socket, 'start', '-a', '-i', id];
  const child = launch('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let readyResolve, readyReject, readyText = '', released = false, closed = false, expiredResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A cleanup path may encounter a rejected gate before awaiting readiness.
  ready.catch(() => {});
  const expired = new Promise(resolve => { expiredResolve = resolve; });
  const collector = collectProcessOutput(child.stdout, child.stderr, {
    outputBytes: 8388608, diagnosticBytes: 8192, stop: () => expiredResolve(),
  });
  child.stdin.on('error', error => readyReject(error));
  child.stdout.on('data', bytes => {
    if (released) return;
    readyText += bytes.toString('ascii');
    if (readyText === 'L03_READY\n') readyResolve();
    else if (readyText.length >= 10) readyReject(Error('GATE_OUTPUT'));
  });
  const timer = setTimeout(() => collector.terminate('worker_timeout'), milliseconds);
  const gateTimer = setTimeout(() => readyReject(Error('GATE_READINESS_TIMEOUT')), 2000);
  const done = new Promise(resolve => {
    let spawnError;
    child.on('error', error => { spawnError = error.code; readyReject(error); });
    child.on('close', (code, signal) => {
      closed = true; clearTimeout(timer); clearTimeout(gateTimer);
      readyReject(Error('GATE_CLIENT_CLOSED'));
      resolve({ code, signal, closed, spawnError, ...collector.finish() });
    });
  });
  return { ready: ready.finally(() => clearTimeout(gateTimer)), done, expired,
    release() { assert.equal(released, false); assert.equal(closed, false); released = true; child.stdin.end('run\n'); },
    async close() {
      clearTimeout(timer); clearTimeout(gateTimer);
      if (closed) return done;
      child.stdin.destroy(); child.kill('SIGKILL');
      let closeTimer; const limit = new Promise((_, reject) => { closeTimer = setTimeout(() => reject(Error('ATTACHED_CLEANUP_TIMEOUT')), 1000); });
      try { return await Promise.race([done, limit]); } finally { clearTimeout(closeTimer); }
    } };
}

export function nativeProbeLaunch({image,flags,executionProfile},mode) {
  if (executionProfile === undefined) return [...flags,'--network=none',image,
    'node','--max-old-space-size=128','/work/l03_gate.mjs',mode==='memory'?'memory':'cpu'];
  assert.equal(executionProfile,'t03-init-probe/1','EXECUTION_PROFILE');
  return [...flags,'--network=none','--entrypoint','node',image,...t03ProbeArgs(mode)];
}

export async function observeT03Setup({row,sources,command,readText,snapshot}) {
  const paths=['/input/original','/work/l03_gate.mjs','/work/probe.mjs'];
  assert.deepEqual(sources.map(file=>file.destination),paths,'T03_SOURCE_SELECTION');
  const mounts=row.Mounts.map(mount=>({destination:mount.Destination,type:mount.Type,
    readOnly:mount.RW===false,matchesSource:sources.some(source=>source.destination===mount.Destination&&source.path===mount.Source)}))
    .sort((a,b)=>a.destination.localeCompare(b.destination));
  assert.deepEqual(mounts,paths.map(destination=>({destination,type:'bind',readOnly:true,matchesSource:true})),'T03_MOUNTS');
  // Only fixed trusted paths and effective controls; no user body or environment.
  const script="const f=require('fs'),c=require('crypto');const files=['/input/original','/work/l03_gate.mjs','/work/probe.mjs'].map(destination=>{const b=f.readFileSync(destination);return {destination,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}});const s=f.readFileSync('/proc/self/status','utf8'),l=f.readFileSync('/proc/self/limits','utf8').match(/Max open files\\s+(\\d+)\\s+(\\d+)/),v=n=>f.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim();process.stdout.write(JSON.stringify({files,effective:{uid:process.getuid(),gid:process.getgid(),node:process.version,seccomp:s.match(/^Seccomp:\\s*(\\d+)/m)?.[1],cap:s.match(/^CapEff:\\s*(\\S+)/m)?.[1],nnp:s.match(/^NoNewPrivs:\\s*(\\d+)/m)?.[1],memory:v('memory.max'),swap:v('memory.swap.max'),cpu:v('cpu.max'),pids:v('pids.max'),nofileSoft:Number(l?.[1]),nofileHard:Number(l?.[2])}}));";
  const observed=JSON.parse(await command(['exec','--user','1000:1000',row.Id,'node','-e',script]));
  assert.deepEqual(observed.files.map(file=>file.destination),paths,'T03_FILE_OBSERVATION');
  const files=sources.map((source,index)=>({destination:source.destination,
    expected:{bytes:source.bytes,sha256:source.sha256},observed:{bytes:observed.files[index].bytes,sha256:observed.files[index].sha256}}));
  for(const file of files)assert.deepEqual(file.observed,file.expected,'T03_ACTUAL_FILE_BYTES');
  const initial=await snapshot();
  assert.equal(initial.children.length,1,'T03_SCOPE');
  const processIds=initial.children[0].processes;
  assert.equal(processIds.length,2,'T03_PARTICIPANTS');
  assert.ok(processIds.includes(row.State.Pid),'T03_INIT_PID');
  async function participant(pid){
    const stat=await readText('/proc/'+pid+'/stat');
    const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    const membership=(await readText('/proc/'+pid+'/cgroup')).match(/^0::(.+)$/m)?.[1];
    const argv=(await readText('/proc/'+pid+'/cmdline',8192)).split('\0');
    assert.equal(argv.pop(),'','T03_COMMAND_TERMINATOR');
    return {pid,ppid:Number(fields[1]),startTicks:fields[19],membership,argv};
  }
  const ids=[row.State.Pid,processIds.find(pid=>pid!==row.State.Pid)];
  const participants=[];for(const pid of ids)participants.push(await participant(pid));
  const confirmedParticipants=[];for(const pid of ids)confirmedParticipants.push(await participant(pid));
  assert.deepEqual(participants,confirmedParticipants,'T03_PROCESS_CHANGED');
  const armed=await snapshot();
  const host=row.HostConfig;
  return {armed,t03:{files,mounts,effective:observed.effective,participants,confirmedParticipants,
    configuration:{init:host.Init,user:row.Config.User,readOnly:host.ReadonlyRootfs,network:host.NetworkMode,
      capDrop:host.CapDrop,securityOpt:host.SecurityOpt,nanoCpus:host.NanoCpus,pidsLimit:host.PidsLimit,
      nofile:{soft:host.Ulimits?.find(value=>value.Name==='nofile')?.Soft,hard:host.Ulimits?.find(value=>value.Name==='nofile')?.Hard},
      entrypoint:row.Config.Entrypoint,cmd:row.Config.Cmd,tmpfs:host.Tmpfs}}};
}

export async function linuxReferencePorts({ image, flags, sourceRoot, save, exec, openReferenceRecovery, registerReference, executionProfile, probeSources }, mode) {
  const nonce = randomUUID().replaceAll('-', ''), reference = 'system-ldl03' + nonce + '.slice';
  const name = 'ld-l03-' + nonce, owner = 'L03 reference ' + nonce;
  const base = '/sys/fs/cgroup/system.slice/' + reference;
  let attempted = false, created = false, id, client, initialIdentity, initialInvocation;
  let recovery, attachedResult, intervention = null;
  const resource = { type: 'l03-reference', reference, name, nonce, owner, base, attempted: false, created: false };
  const persist = (phase, value) => save('L03-' + mode + '-' + phase + '.json', value,
    { terminal: phase === 'postmortem' || phase === 'result' });
  const command = async (bin, args, recovering = false) => {
    const run = recovering ? (recovery ??= openReferenceRecovery()) : exec;
    const result = await run(bin, args, { timeout: 6000, limit: 65536, diagnostic: 8192 });
    assert.equal(result.code, 0, 'REFERENCE_COMMAND_FAILED: ' + (result.commandRecord ?? bin));
    assert.equal(result.reason, undefined); assert.equal(result.stdoutEncodingError, false);
    assert.equal(result.stderrEncodingError, false); return result.stdout.trim();
  };
  async function namespaces() {
    // Read self in this Node process, never in the privileged helper.
    const originator = await fs.readlink('/proc/self/ns/cgroup');
    assert.match(originator, /^cgroup:\[[1-9][0-9]*\]$/, 'ORIGINATOR_NAMESPACE_MALFORMED');
    const result = await exec('/usr/bin/sudo', ['-n', '/usr/bin/timeout', '--signal=KILL', '5s',
      '/usr/bin/readlink', '--verbose', '--', '/proc/1/ns/cgroup'],
    { timeout: 6000, limit: 128, diagnostic: 1024 });
    // The command record retains exit status and stderr, including access denial.
    assert.equal(result.code, 0, 'NAMESPACE_COMMAND_FAILED: ' + result.commandRecord);
    assert.equal(result.reason, undefined, 'NAMESPACE_COMMAND_INCOMPLETE');
    assert.equal(result.stdoutEncodingError || result.stderrEncodingError, false, 'NAMESPACE_ENCODING_ERROR');
    assert.notEqual(result.stdout, '', 'NAMESPACE_OUTPUT_MISSING');
    assert.match(result.stdout, /^cgroup:\[[1-9][0-9]*\]\n$/, 'NAMESPACE_OUTPUT_MALFORMED');
    const init = result.stdout.slice(0, -1);
    const observed = { originatorPid: process.pid, originator, init, commandRecord: result.commandRecord };
    await persist('namespace', observed);
    return originator === init;
  }
  const docker = (args, recovering = false) => command('docker', ['--host', socket, ...args], recovering);
  const unitInventory = (recovering = false) => command('/usr/bin/systemctl', ['list-units', '--all', '--full', '--plain', '--no-legend', '--no-pager', reference], recovering);
  async function properties(recovering = false) {
    const output = await command('/usr/bin/systemctl', ['show', reference,
      '--property=LoadState,ActiveState,ControlGroup,InvocationID,Description,StopWhenUnneeded'], recovering);
    return Object.fromEntries(output.split('\n').map(line => {
      const at = line.indexOf('='); assert.ok(at > 0); return [line.slice(0, at), line.slice(at + 1)];
    }));
  }
  async function inspect(recovering = false) {
    const rows = JSON.parse(await docker(['inspect', id ?? name], recovering));
    assert.equal(rows.length, 1); const row = rows[0];
    assert.equal(row.Config.Labels?.['l03.reference'], nonce, 'CONTAINER_OWNER');
    assert.equal(row.Name, '/' + name, 'CONTAINER_NAME');
    if (id) assert.equal(row.Id, id, 'CONTAINER_REPLACED');
    return row;
  }
  async function nodeSnapshot(directory, depth = 0) {
    assert.ok(directory === base || directory.startsWith(base + '/'), 'CGROUP_SCOPE');
    const stat = await fs.lstat(directory); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    const children = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory());
    assert.ok(children.length <= 1 && (depth === 0 || children.length === 0), 'FOREIGN_OR_NESTED_CGROUP');
    const result = { name: path.posix.basename(directory), identity: identity(stat),
      processes: pids(await text(directory + '/cgroup.procs')),
      children: [], events: counters(await text(directory + '/memory.events')),
      localEvents: counters(await text(directory + '/memory.events.local')),
      memoryMax: await text(directory + '/memory.max') };
    // Before the container exists, the new slice need not yet have CPU/PID
    // controllers enabled. The actual child's limits remain mandatory.
    if (depth === 1) Object.assign(result, { swapMax: await text(directory + '/memory.swap.max'),
      cpuMax: await text(directory + '/cpu.max'), pidsMax: await text(directory + '/pids.max') });
    for (const entry of children) result.children.push(await nodeSnapshot(directory + '/' + entry.name, depth + 1));
    return result;
  }
  async function snapshot(recovering = false) {
    const unit = await properties(recovering);
    assert.equal(unit.Description, owner, 'SLICE_OWNER');
    assert.equal(unit.ControlGroup, '/system.slice/' + reference, 'SLICE_PATH');
    assert.equal(unit.StopWhenUnneeded, 'no', 'SLICE_LIFETIME');
    const result = { ...await nodeSnapshot(base), path: unit.ControlGroup,
      invocation: unit.InvocationID, active: unit.ActiveState };
    if (initialIdentity) assert.equal(result.identity, initialIdentity, 'SLICE_REPLACED');
    if (initialInvocation) assert.equal(result.invocation, initialInvocation, 'SLICE_RESTARTED');
    return result;
  }
  async function probeIdentity() {
    for (const file of ['probe.mjs', 'l03_gate.mjs']) {
      const result = await captureClient('docker', ['--host', socket, 'cp', id + ':/work/' + file, '-'], { timeoutMs: 2000, bytes: 131072 }).done;
      assert.equal(result.code, 0); assert.equal(result.reason, null); assert.equal(result.closed, true);
      const actual = tarMemberIdentity(result.stdout, file);
      const expected = hash(await fs.readFile(path.join(sourceRoot, 'tests/intake/t01', file)));
      await persist(file.replace('.mjs', '-identity'), { expected, actual });
      assert.equal(actual.sha256, expected, 'ACTUAL_PROBE_BYTES');
    }
    return true;
  }
  const outcome = row => ({ id, running: row.State.Running, restartCount: row.RestartCount,
    exit: row.State.ExitCode, dockerOOMKilled: row.State.OOMKilled,
    clientCode: attachedResult.code, clientClosed: attachedResult.closed, reason: attachedResult.reason ?? null,
    encodingError: attachedResult.stdoutEncodingError || attachedResult.stderrEncodingError, intervention });
  async function cleanup({ reconcile = false } = {}) {
    if (reconcile) recovery = openReferenceRecovery();
    const errors = [], removed = [];
    // Both local cleanup and final reconciliation use the exact reservation,
    // never a widened run label or a name without its ownership checks.
    if (created) try {
      const found = (await docker(['ps', '-a', '--no-trunc', '--filter', 'label=l03.reference=' + nonce, '--format', '{{.ID}}'], true)).split('\n').filter(Boolean);
      assert.ok(found.length <= 1, 'AMBIGUOUS_OWNED_CONTAINER');
      if (found.length) {
        if (id) assert.equal(found[0], id);
        id = found[0]; resource.id = id;
        await inspect(true); await docker(['rm', '-f', id], true);
      }
      assert.equal(await docker(['ps', '-a', '--filter', 'label=l03.reference=' + nonce, '--format', '{{.ID}}'], true), '');
      if (id) removed.push(id);
    } catch (error) { errors.push(error.message); }
    if (client) try { await client.close(); } catch (error) { errors.push(error.message); }
    if (attempted) try {
      const present = await fs.lstat(base).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (present) {
        const current = await snapshot(true);
        assert.deepEqual(current.processes, [], 'CLEANUP_SLICE_OCCUPIED');
        assert.deepEqual(current.children, [], 'CLEANUP_SLICE_HAS_CHILDREN');
        await command('/usr/bin/sudo', ['-n', '/usr/bin/timeout', '--signal=KILL', '5s', '/usr/bin/systemctl', 'stop', reference], true);
        assert.equal(await fs.lstat(base).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'SLICE_CLEANUP_UNCONFIRMED');
      } else assert.equal(await unitInventory(true), '', 'SLICE_ABSENCE_UNCONFIRMED');
      removed.push(reference);
    } catch (error) { errors.push(error.message); }
    const result = { confirmed: errors.length === 0, removed, errors };
    resource.cleanup = result;
    return result;
  }
  return {
    persist,
    async prepare() {
      assert.equal(process.platform, 'linux', 'LINUX_REFERENCE_REQUIRED');
      assert.equal(process.env.GITHUB_ACTIONS, 'true', 'HOSTED_REFERENCE_REQUIRED');
      assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'HOSTED_REFERENCE_REQUIRED');
      const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
      const context = JSON.parse(await command('docker', ['context', 'inspect']))[0];
      const mount = (await text('/proc/self/mountinfo', 131072)).split('\n').filter(line => line.split(' ')[4] === '/sys/fs/cgroup');
      assert.equal(mount.length, 1); assert.ok(mount[0].includes(' - cgroup2 '), 'CGROUP_V2_MOUNT');
      const facts = { platform: process.platform, actions: process.env.GITHUB_ACTIONS,
        environment: process.env.RUNNER_ENVIRONMENT, driver: info.CgroupDriver, version: info.CgroupVersion,
        sameNamespace: await namespaces(),
        sameKernel: info.KernelVersion === os.release(), rootless: info.SecurityOptions?.some(value => value.includes('rootless')) ?? true,
        localEvents: mount[0].includes('memory_localevents'), socket,
        contextSocket: context.Endpoints?.docker?.Host, hostOverride: process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || null };
      qualifyReferenceHost(facts); await persist('host', facts);
      assert.equal(await fs.lstat(base).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'SLICE_ALREADY_EXISTS');
      // Unlike show/LoadUnit, listing must not synthesize this named slice
      // before StartTransientUnit gets the opportunity to create it.
      assert.equal(await unitInventory(), '', 'UNIT_ALREADY_EXISTS');
      await persist('reservation', { reference, name, nonce, owner, base });
      registerReference(resource, () => cleanup({ reconcile: true }));
      attempted = resource.attempted = true;
      await command('/usr/bin/sudo', sliceCreateCommand(reference, owner));
      // Wait only for this single start job; never rerun it or a workload.
      for (let i = 0; i < 20; i++) { if ((await properties()).ActiveState === 'active') break; if (i === 19) throw Error('SLICE_START_UNCONFIRMED'); await sleep(25); }
      const before = await snapshot(); initialIdentity = before.identity; initialInvocation = before.invocation;
      Object.assign(resource, { identity: initialIdentity, invocation: initialInvocation });
      return { reference, image, before, ...(executionProfile===undefined?{}:{executionProfile,host:facts}) };
    },
    async arm(record) {
      created = resource.created = true;
      id = await docker(['create', '--name', name, '--label', 'l03.reference=' + nonce,
        '--cgroup-parent=' + reference, '--interactive',
        ...nativeProbeLaunch({image,flags,executionProfile},mode)]);
      assert.match(id, /^[a-f0-9]{64}$/);
      resource.id = id;
      let probeMatchesSource = executionProfile===undefined ? await probeIdentity() : false;
      client = startAttached(id);
      await client.ready;
      const row = await inspect(); assert.equal(row.State.Running, true, 'GATED_PROCESS_NOT_RUNNING');
      const pid = row.State.Pid;
      const membership = (await text('/proc/' + pid + '/cgroup')).match(/^0::(.+)$/m)?.[1];
      const stat = await text('/proc/' + pid + '/stat'); const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      let armed,t03;
      if(executionProfile!==undefined){
        assert.equal(executionProfile,'t03-init-probe/1','EXECUTION_PROFILE');
        ({armed,t03}=await observeT03Setup({row,sources:probeSources,command:docker,readText:text,snapshot}));
        probeMatchesSource=true;
      }else armed=await snapshot();
      return { probeMatchesSource, armed, ...(t03?{t03}:{}), container: { id, pid, membership, startTicks,
        parent: row.HostConfig.CgroupParent, memory: row.HostConfig.Memory, memorySwap: row.HostConfig.MemorySwap,
        restartCount: row.RestartCount, restartPolicy: row.HostConfig.RestartPolicy.Name, image: row.Image } };
    },
    async execute(selectedMode, observe) {
      client.release();
      if (mode === 'external') { intervention = 'external'; await docker(['kill', '--signal=KILL', id]); }
      const raced = await Promise.race([client.done.then(result => ({ result })), client.expired.then(() => ({ expired: true }))]);
      if (raced.expired) { intervention = mode === 'watchdog' ? 'watchdog' : 'supervisor'; await docker(['kill', '--signal=KILL', id]); }
      let closeTimer;
      const result = raced.result ?? await Promise.race([client.done, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(Error('ATTACHED_CLIENT_CLOSE_TIMEOUT')), 1000); })]).finally(() => clearTimeout(closeTimer));
      attachedResult = result;
      observe({ attachedCommand: result });
      const row = await inspect();
      const observed = outcome(row);
      observe({ outcome: observed });
      await persist('attached-command', result);
      return observed;
    },
    readAfter: snapshot,
    async recoverTerminal(observe) {
      const failures = [];
      if (!attachedResult) return failures;
      observe({ attachedCommand: attachedResult });
      try { observe({ outcome: outcome(await inspect(true)) }); }
      catch (error) { failures.push({ phase: 'terminal-inspection', error }); }
      try { observe({ after: await snapshot(true) }); }
      catch (error) { failures.push({ phase: 'terminal-counters', error }); }
      return failures;
    },
    cleanup,
  };
}

export async function checkNativeMemory(context) {
  const records = [];
  for (const mode of ['memory', 'external', 'watchdog']) {
    const ports = await linuxReferencePorts(context, mode);
    records.push(await referenceCase(ports, mode));
  }
  return records.map(record => ({ ...record.verdict, reference: record.reference, cleanup: record.cleanup }));
}
