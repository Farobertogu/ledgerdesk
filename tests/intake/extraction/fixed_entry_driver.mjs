import assert from 'node:assert/strict';
import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {launchExtraction} from '../../../ci/intake/extraction/launcher.mjs';
import {materializeExtraction} from '../../../src/server/intake/extraction_output.ts';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
import {requestFor, runFixedEntryCases, assertLiteralObservation} from './references/cases.mjs';

/** Invalid invocation tests use a test-only Docker caller, never a product flag. */
export async function fixedEntryCases({image, runId, command, save, resources}) {
  const events = [];
  const positive = await requestFor('short.txt', 'text-utf8/1');
  positive.request.binding.channel_id = randomUUID();
  const actual = await launchExtraction({request: positive.request, originalPath: positive.path, image, runId,
    observe: async event => {events.push(event);}});
  await save('launcher-positive.json', {events, ...actual});
  assert.equal(actual.protocolError, null); assert.equal(actual.output.reason, undefined);
  assert.equal(actual.reply?.outcome.kind, 'produced');
  assertLiteralObservation('short.txt', actual.reply.outcome.observation, positive.bytes);
  assert.equal(events.filter(e => e.kind === 'running').length, 1);
  assert.equal(events.at(-1).kind, 'cleaned');
  const lifecycle=[];
  for(const point of ['before-create','created','running']) {
    const trial=await requestFor('short.txt','text-utf8/1');trial.request.binding.channel_id=randomUUID();
    const controller=new AbortController(),observed=[];
    if(point==='before-create')controller.abort();
    const invoke=()=>launchExtraction({request:trial.request,originalPath:trial.path,image,runId,signal:controller.signal,
      observe:async event=>{observed.push(event);if(event.kind===point)controller.abort();}});
    let stopped;
    try{
      if(point==='running'){
        stopped=await invoke();
        // Once started, cancellation conserves actual closure rather than
        // pretending that the worker was never started. No input is submitted.
        assert.deepEqual({reason:stopped.output.reason,reply:stopped.reply,running:stopped.termination.Running,
          stdoutBytes:stopped.output.stdoutBytes,closed:observed.filter(e=>e.kind==='closed').length},
          {reason:'stopped',reply:null,running:false,stdoutBytes:0,closed:1});
        assert.notEqual(stopped.termination.ExitCode,0);
      }else{
        await assert.rejects(invoke(),/EXTRACTION_STOPPED_BEFORE/);
        assert.equal(observed.some(e=>e.kind==='closed'),false,'No execution is claimed before start');
      }
      if(point==='before-create')assert.deepEqual(observed,[]);
      else assert.equal(observed.at(-1).kind,'cleaned');
    }finally{
      lifecycle.push({point,observed,stopped});
      await save('launcher-stop-'+point+'.json',{point,observed,stopped});
    }
  }
  await save('launcher-stop-controls.json',lifecycle);

  const materializations=[];
  const results = await runFixedEntryCases(async ({inputPath, requestBytes, argv}) => {
    const name = 'ld-i03-t03-entry-' + randomUUID().slice(0, 8), resource = {kind: 'container', id: null, name, image, cleaned: false};
    resources.push(resource);
    const input = await realpath(path.resolve(inputPath));
    if (input.includes(',')) throw Error('FIXED_ENTRY_MOUNT_PATH');
    const id = await command(['create', '--name', name, '--label', 'intake.t03.run=' + runId, '--interactive', '--init',
      '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64', '--ulimit', 'nofile=128:128',
      '--tmpfs', '/work:rw,noexec,nosuid,size=67108864,uid=1000,gid=1000',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=8388608,uid=1000,gid=1000',
      '--mount', `type=bind,src=${input},dst=/input/original,readonly`, image, ...argv], {timeout: 60000});
    resource.id = id;
    let stdout, code = 0, signal = null;
    try {stdout = await command(['start', '--attach', '--interactive', id], {input: requestBytes, timeout: 15000, limit: EXTRACTION_BOUNDS.stdoutBytes});}
    catch (error) {
      if (!error.observed || error.observed.reason) throw error;
      stdout = error.observed.stdout; code = error.observed.code; signal = error.observed.signal;
    }
    const final = JSON.parse(await command(['inspect', id]))[0];
    assert.equal(final.State.Running, false, 'A reply is not termination evidence');
    assert.equal(final.Config.Labels['intake.t03.run'], runId);
    await save(name + '-termination.json', final.State);
    await command(['rm', id]); resource.cleaned = true;
    const captured=Buffer.from(stdout);
    if(code===0){
      const expected=JSON.parse(requestBytes),reply=JSON.parse(captured);
      // Size/projection exercise only for a compatible produced reply; invalid
      // original-association vectors remain the independent entry test's job.
      if(reply.outcome?.kind==='produced'){
        const material=materializeExtraction(captured,expected.binding,expected.binding.channel_id);
        materializations.push({fixture:path.basename(inputPath),rawBytes:captured.length,normalizedBytes:material.normalized.length,
          conservedBytes:material.aggregateBytes,outcome:material.outcome,rawSha256:material.rawSha256,normalizedSha256:material.normalizedSha256,
          parentMaxRssKiB:process.resourceUsage().maxRSS});
      }
    }
    return {stdout: captured, code, signal};
  });
  await save('fixed-entry-results.json', {results, distinction: 'Launcher positive uses the trusted supervisor. Malformed invocation cases call only the fixed image entry point through a test-only driver.'});
  await save('materialization-budgets.json',{observations:materializations,
    limitation:'Actual worker output plus service normalization; not durable output storage or authorized query. Parent max RSS is cumulative for this runner, not an isolated peak per fixture.'});
  return results;
}
