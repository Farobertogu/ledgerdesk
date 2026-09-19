import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';

export async function extractionLineageCases(t,{env,intake,client,request}){
  await extractionControl(env);const observations=[];let received,first,second,effect,originalView;
  const service=new ExtractionService(intake),text='Only the current closed generation can supply this result.\n';
  const history=async()=>({attempts:(await env.admin.query('SELECT * FROM intake_trial.extraction_attempt ORDER BY job_id,attempt_generation')).rows,
    events:(await env.admin.query('SELECT * FROM intake_trial.extraction_event ORDER BY id')).rows,
    results:(await env.admin.query('SELECT * FROM intake_trial.extraction_result ORDER BY id')).rows});
  try{
    await t.test('LINEAGE01 an actual closed input interruption is followed by a useful distinct generation',async()=>{
      received=await receivedOriginal(request,client,Buffer.from(text));
      assert.equal((await administration('fail-next-extraction-input',{})).ok,true);
      first=await service.dispatch(received.work.id);assert.equal(first.metadata.reason,'input_failure');
      assert.ok(first.metadata.observations.some(e=>e.kind==='closed'));
      second=await service.retry(received.work.id,1);assert.equal(second.metadata.reason,null);
      assert.deepEqual([first.binding.attempt_generation,second.binding.attempt_generation],[1,2]);
      assert.notEqual(first.binding.channel_id,second.binding.channel_id);
      effect=await service.accept(received.work.id);originalView=await request('/api/intake/extractions/'+received.work.id,{client});
      assert.equal(originalView.status,200);assert.equal(originalView.body.result.id,effect.resultId);
      assert.equal(originalView.body.result.content.elements.map(e=>e.text).join(''),text);
    });
    if(!effect)throw Error('LINEAGE_POSITIVE_REQUIRED');
    await t.test('LINEAGE02 delayed old completion and duplicate current callback cannot overwrite a real accepted generation',async()=>{
      const before=await history(),probe=await administration('replay-extraction-completion',{oldChannel:first.binding.channel_id,currentChannel:second.binding.channel_id});
      assert.equal(probe.ok,true);assert.deepEqual(probe.before,probe.after);
      const [old,duplicate]=probe.result;assert.equal(old.code,1);assert.match(old.stderr,/EXTRACTION_BRIDGE_ASSOCIATION/);
      assert.equal(duplicate.code,1);assert.match(duplicate.stderr,/EEXIST/);
      assert.deepEqual(await history(),before);
      const after=await request('/api/intake/extractions/'+received.work.id,{client});assert.deepEqual(after.body,originalView.body);
      assert.deepEqual({attempts:before.attempts.length,launches:before.events.filter(e=>e.kind==='launch').length,results:before.results.length},
        {attempts:2,launches:2,results:1});
      observations.push({first,second,effect,probe,history:before});
    });
  }finally{writeFileSync('/work/output/extraction-lineage.json',JSON.stringify({observations,
    scope:'Real first/current worker identities; delayed delivery of retained first-generation completion and duplicate current publication through the actual bridge. The first generation ended with input interruption and has no invented successful output.'},null,2),{flag:'wx'});}
}
