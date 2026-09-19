import {spawn} from 'node:child_process';
import path from 'node:path';
import {stat, realpath} from 'node:fs/promises';
import {collectProcessOutput} from './collector.mjs';
import {WORKER_REQUEST_V3, EXTRACTION_BOUNDS, readWorkerReply, workerBindingMatches} from '../../../src/contracts/intake_extraction.ts';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
/** Bounded Docker control only; no shell expansion or caller-selected executable. */
export function dockerCommand(args, {timeout = 15000, limit = 1048576, input} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
    const collector = collectProcessOutput(child.stdout, child.stderr, {outputBytes: limit, stop: () => child.kill()});
    const timer = setTimeout(() => collector.terminate('control_timeout'), timeout);
    let spawnError;
    child.once('error', error => {spawnError = error;});
    if (input !== undefined) {child.stdin.on('error', () => {}); child.stdin.end(input);}
    child.once('close', (code, signal) => {
      clearTimeout(timer); const observed = {...collector.finish(), code, signal};
      if (spawnError) reject(spawnError);
      else if (code !== 0 || observed.reason) reject(Object.assign(Error('EXTRACTION_DOCKER_CONTROL'), {observed, args}));
      else resolve(observed);
    });
  });
}
const inspect = async id => JSON.parse((await dockerCommand(['inspect', id])).stdout)[0];
async function inspectOptional(id) {
  try {return await inspect(id);} catch(error) {
    if(error.observed?.code===1&&/no such (object|container)/i.test(error.observed.stderr))return null;
    throw error;
  }
}
async function boundedObservation(observe,event) {
  let timer;
  try {await Promise.race([Promise.resolve().then(()=>observe(event)),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('EXTRACTION_OBSERVATION_UNCONFIRMED')),2000);
  })]);}finally{clearTimeout(timer);}
}
const effectiveProbe = "const f=require('fs');const s=f.readFileSync('/proc/self/status','utf8');const c=n=>f.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim();process.stdout.write(JSON.stringify({uid:process.getuid(),node:process.version,seccomp:s.match(/^Seccomp:\\s*(\\d+)/m)?.[1],cap:s.match(/^CapEff:\\s*(\\S+)/m)?.[1],nnp:s.match(/^NoNewPrivs:\\s*(\\d+)/m)?.[1],memory:c('memory.max'),swap:c('memory.swap.max'),pids:c('pids.max'),cpu:c('cpu.max')}));";
async function probe(id) {
  const value = JSON.parse((await dockerCommand(['exec', '--user', '1000:1000', id, 'node', '-e', effectiveProbe])).stdout);
  if (value.uid !== 1000 || value.node !== 'v22.16.0' || value.seccomp !== '2' || value.cap !== '0000000000000000' ||
    value.nnp !== '1' || value.memory !== '536870912' || value.swap !== '0' || value.pids !== '64' || value.cpu !== '100000 100000')
    throw Error('EXTRACTION_RUNTIME_CONTROLS');
  return value;
}
function controls(value, expectedImage, runId) {
  const host = value.HostConfig;
  if (value.Image !== expectedImage || value.Config.Labels?.['intake.t03.run'] !== runId ||
    value.Config.User !== '1000:1000' || !host.ReadonlyRootfs || host.NetworkMode !== 'none' ||
    host.Memory !== 536870912 || host.MemorySwap !== 536870912 || host.PidsLimit !== 64 || host.NanoCpus !== 1000000000 ||
    !host.CapDrop?.includes('ALL') || !host.SecurityOpt?.includes('no-new-privileges') ||
    value.Mounts.length !== 1 || value.Mounts[0].Destination !== '/input/original' || value.Mounts[0].RW)
    throw Error('EXTRACTION_EFFECTIVE_CONTROLS');
}

/** A trusted controller supplies image and originalPath after current service admission. */
export async function launchExtraction({request, originalPath, image, runId, observe = async () => {}, signal, testInputFault = false, testHoldInput = false}) {
  if(typeof testInputFault!=='boolean'||typeof testHoldInput!=='boolean'||testInputFault&&testHoldInput)throw Error('EXTRACTION_TEST_FAULT_SCOPE');
  if (!WORKER_REQUEST_V3(request) || !/^sha256:[a-f0-9]{64}$/.test(image) || !/^[a-z0-9-]{1,64}$/.test(runId)) throw Error('EXTRACTION_LAUNCH_INPUT');
  if(signal?.aborted)throw Error('EXTRACTION_STOPPED_BEFORE_CREATE');
  const original = await realpath(path.resolve(originalPath)), file = await stat(original);
  if (!file.isFile() || file.size !== request.binding.original.bytes || original.includes(',')) throw Error('EXTRACTION_ORIGINAL_MOUNT');
  const name = 'intake-t03-' + request.binding.channel_id.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{1,110}$/.test(name)) throw Error('EXTRACTION_CONTAINER_NAME');
  let id, child, timer, killPromise, completed = false, closed = false, createIssued = false;
  const record=event=>boundedObservation(observe,event);
  let collector, resolveClose, rejectClose;
  const closure = new Promise((resolve, reject) => {resolveClose = resolve; rejectClose = reject;});
  // Avoid an unhandled rejection if setup fails before waiting on the child.
  closure.catch(() => {});
  const stop = () => {
    if (id && !killPromise) killPromise = dockerCommand(['kill', id], {timeout: 5000}).catch(async error => {
      const current = await inspect(id);
      if (current.State.Running) throw error;
    });
    killPromise?.catch(() => {});
  };
  const abort = () => {collector?.terminate('stopped'); stop();};
  // A retained identity is a recovery case, never a disposable new launch.
  if(await inspectOptional(name))throw Error('EXTRACTION_EXISTING_CONTAINER');
  try {
    await record({kind:'creating',name,channel_id:request.binding.channel_id,image,runId});
    if(signal?.aborted)throw Error('EXTRACTION_STOPPED_BEFORE_CREATE');
    createIssued=true;
    const created = await dockerCommand(['create', '--name', name, '--label', 'intake.t03.run=' + runId, '--interactive', '--init',
      '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none',
      '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64', '--ulimit', 'nofile=128:128',
      '--tmpfs', '/work:rw,noexec,nosuid,size=67108864,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8388608,uid=1000,gid=1000',
      '--mount', `type=bind,src=${original},dst=/input/original,readonly`, image], {timeout: 60000});
    id = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('EXTRACTION_CONTAINER_ID');
    controls(await inspect(id), image, runId);
    await record({kind: 'created', id, name, channel_id: request.binding.channel_id, image});
    if(signal?.aborted)throw Error('EXTRACTION_STOPPED_BEFORE_START');
    child = spawn('docker', ['start', '--attach', '--interactive', id], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    collector = collectProcessOutput(child.stdout, child.stderr, {outputBytes: EXTRACTION_BOUNDS.stdoutBytes,
      diagnosticBytes: EXTRACTION_BOUNDS.diagnosticBytes, stop});
    child.once('error', rejectClose);
    child.stdin.on('error', () => collector.terminate('input_failure'));
    child.once('close', (code, childSignal) => {closed = true; resolveClose({code, signal: childSignal});});
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const readyDeadline = Date.now() + 5000;
    let running;
    do {
      running = await inspect(id);
      if (running.State.Running) break;
      if (closed || Date.now() >= readyDeadline) throw Error('EXTRACTION_LAUNCH_NOT_RUNNING');
      await pause(25);
    } while (true);
    controls(running, image, runId);
    const effective = await probe(id);
    await record({kind: 'running', id, name, channel_id: request.binding.channel_id, pid: running.State.Pid, started_at: running.State.StartedAt, image, effective});
    if(signal?.aborted||collector.finish().reason)abort();
    else{
      timer = setTimeout(() => collector.terminate('worker_timeout'), EXTRACTION_BOUNDS.wallMs);
      // Harness-owned transport fault, never a worker/public request field.
      // The normal stdin error listener must classify it and close the real process.
      if(testInputFault)child.stdin.destroy(Object.assign(Error('Injected input disconnect'),{code:'EPIPE'}));
      // Test-only held stdin stays withheld until actual cancellation or the
      // existing wall limit closes the process. Elapsed time never releases it.
      else if(!testHoldInput)child.stdin.end(JSON.stringify(request));
    }
    const result = await closure;
    clearTimeout(timer);
    if (killPromise) await killPromise;
    const final = await inspect(id);
    if (final.State.Running) throw Error('EXTRACTION_TERMINATION_UNKNOWN');
    const output = collector.finish();
    await record({kind: 'closed', id, name, channel_id: request.binding.channel_id, ...result,
      state: final.State, stdout_bytes: output.stdoutBytes, stderr_bytes: output.stderrBytes, reason: output.reason ?? null});
    completed = true;
    let reply = null, protocolError = null;
    if (!output.reason && result.code === 0) {
      try {
        reply = readWorkerReply(Buffer.from(output.stdout));
        if (!workerBindingMatches(request.binding, reply.binding, request.binding.channel_id)) throw Error('EXTRACTION_CHANNEL_BINDING');
      } catch (error) {protocolError = error.message; reply = null;}
    }
    return {reply, protocolError, termination: final.State, output, retainedStdout:collector.retainedStdout(),containerId: id, image};
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    let reconciledCreate=null;
    if(!id&&createIssued){
      const retained=await inspectOptional(name);
      if(retained){
        if(retained.Config.Labels?.['intake.t03.run']!==runId||retained.Image!==image)throw Error('EXTRACTION_CLEANUP_OWNERSHIP');
        id=retained.Id;
        reconciledCreate={kind:'create-reconciled',id,name,channel_id:request.binding.channel_id};
      }else await record({kind:'create-currently-absent',name,channel_id:request.binding.channel_id});
    }
    if (id) {
      const actual = await inspect(id);
      if (actual.Config.Labels?.['intake.t03.run'] !== runId) throw Error('EXTRACTION_CLEANUP_OWNERSHIP');
      if (actual.State.Running) {stop(); await killPromise;}
      if ((await inspect(id)).State.Running) throw Error('EXTRACTION_CLEANUP_NOT_CLOSED');
      if (child && !closed) {
        const deadline = setTimeout(() => child.kill(), 5000);
        try {await closure;} finally {clearTimeout(deadline);}
      }
      await dockerCommand(['rm', id]);
      if(reconciledCreate)await record(reconciledCreate);
      await record({kind: 'cleaned', id, name, completed});
    }
  }
}
