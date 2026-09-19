import assert from 'node:assert/strict';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';
import {writeFileSync} from 'node:fs';
import {extractionControl} from './runtime_control.mjs';

export async function extractionRetryGroup(t,{env,intake,client,request}){
  await extractionControl(env);const observations=[];
  const original=Buffer.from('AZ-17\nUnder condition Z, receipt R replaces receipt Q.\n','utf8');
  try{
    await extractionRetryCases(t,{env,intake,client,request,original,observations});
    assert.deepEqual((await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_trial.extraction_result) AS results,
      (SELECT count(*)::int FROM intake_trial.extraction_attempt) AS attempts`)).rows[0],{results:3,attempts:5});
  }finally{writeFileSync('/work/output/extraction-retry.json',JSON.stringify({observations,
    scope:'The unchanged E04g/h/i cases in their own finite synthetic cluster. No stopped obligation from another case is deleted to make room.'},null,2),{flag:'wx'});}
}

/** Fault the real controller input pipe, not the adapter or its result model. */
export async function extractionRetryCases(t,{env,intake,client,request,original,observations}){
  const attempts=async job=>(await env.admin.query('SELECT * FROM intake_trial.extraction_attempt WHERE job_id=$1 ORDER BY attempt_generation',[job])).rows;
  const failNext=async()=>assert.equal((await administration('fail-next-extraction-input',{})).ok,true);
  const closedFailure=async(job,result)=>{
    assert.equal(result.metadata.reason,'input_failure');assert.equal(result.metadata.raw.bytes,0);
    assert.ok(result.metadata.observations.some(e=>e.kind==='closed'&&e.id===result.metadata.container_id));
    const event=(await env.admin.query("SELECT observation FROM intake_trial.extraction_event WHERE job_id=$1 AND attempt_generation=$2 AND kind='termination'",
      [job,result.binding.attempt_generation])).rows[0].observation;
    assert.deepEqual({reason:event.reason,closed:event.observed,channel:event.channelId},
      {reason:'input_failure',closed:'closed',channel:result.binding.channel_id});
    assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,null);
  };
  const failedResult=async(received,service)=>{
    const effect=await service.accept(received.work.id),response=await request('/api/intake/extractions/'+received.work.id,{client});
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.result.id,effect.resultId);
    const value=response.body.result.content;
    assert.deepEqual({outcome:value.outcome,inventory:value.inventory,elements:value.elements,original:value.original},
      {outcome:'failed',inventory:'unknown',elements:[],original:received.original});
    assert.deepEqual(value.incidents,[{id:'supervisor-failure',component:'extraction',cause:'technical_failure',code:'input_failure'}]);
    assert.equal(value.current_use,'not_evaluated');
    return effect;
  };
  await t.test('E04g one closed input interruption retries with a fresh channel and the same original',async()=>{
    const received=await receivedOriginal(request,client,original,{name:'retry-success.txt'}),job=received.work.id,service=new ExtractionService(intake);
    await failNext();const first=await service.dispatch(job);await closedFailure(job,first);
    const previous=(await attempts(job))[0];
    await assert.rejects(service.dispatch(job),/INTAKE_409/,'Normal dispatch must not silently become retry');
    await assert.rejects(service.retry(job,2),/INTAKE_409/,'The retry names the exact predecessor, not a future generation');
    const second=await service.retry(job,1);assert.equal(second.metadata.reason,null);assert.equal(second.binding.attempt_generation,2);
    assert.deepEqual(second.binding.original,first.binding.original);
    for(const name of ['channel_id','claim_id'])assert.notEqual(second.binding[name],first.binding[name]);
    const rows=await attempts(job);assert.equal(rows.length,2);assert.deepEqual(rows[0],previous);
    assert.notEqual(rows[0].normalized_id,rows[1].normalized_id);
    const accepted=await service.accept(job),response=await request('/api/intake/extractions/'+job,{client});
    assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.result.id,accepted.resultId);
    assert.equal(response.body.result.attempt_generation,2);assert.deepEqual(response.body.original,received.original);
    assert.equal(response.body.result.content.elements.map(e=>e.text).join(''),original.toString());
    await assert.rejects(service.retry(job,1),/INTAKE_409/);assert.equal((await attempts(job)).length,2);
    observations.push({label:'closed-transport-retry',jobId:job,first:first.metadata,second:second.metadata,result:accepted});
  });
  await t.test('E04h accepted failure is an effect and cannot retry even with an unused attempt',async()=>{
    const received=await receivedOriginal(request,client,original,{name:'accepted-failure.txt'}),service=new ExtractionService(intake);
    await failNext();const failed=await service.dispatch(received.work.id);await closedFailure(received.work.id,failed);
    const effect=await failedResult(received,service);
    await assert.rejects(service.retry(received.work.id,1),/INTAKE_409/);
    assert.equal((await attempts(received.work.id)).length,1);
    observations.push({label:'accepted-failure',jobId:received.work.id,metadata:failed.metadata,result:effect});
  });
  await t.test('E04i two real input interruptions exhaust the attempt bound without hiding the failure',async()=>{
    const received=await receivedOriginal(request,client,original,{name:'retry-exhaustion.txt'}),service=new ExtractionService(intake);
    await failNext();const first=await service.dispatch(received.work.id);await closedFailure(received.work.id,first);
    await failNext();const second=await service.retry(received.work.id,1);await closedFailure(received.work.id,second);
    await assert.rejects(service.retry(received.work.id,2),/INTAKE_409/);
    assert.equal((await attempts(received.work.id)).length,2);
    const effect=await failedResult(received,service);
    observations.push({label:'retry-exhaustion',jobId:received.work.id,first:first.metadata,second:second.metadata,result:effect});
  });
}
