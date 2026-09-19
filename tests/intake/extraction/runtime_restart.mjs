import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {startExtractionProcess} from './service_process.mjs';
import {administration} from '../t02/recovery_cases.mjs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';

/** Real service-process death at three durable boundaries, not new instances. */
export async function extractionRestartCases(t,{env,intake,client,request,application}){
  const controlled=await extractionControl(env),processes=[],observations=[];
  const original=Buffer.from('AZ-17\nUnder condition Z, receipt R replaces receipt Q.\n');
  const originalReference={bytes:original.length,sha256:createHash('sha256').update(original).digest('hex'),text:original.toString()};
  writeFileSync('/work/output/extraction-restart-reference.json',JSON.stringify(originalReference,null,2),{flag:'wx'});
  const receipt=await receivedOriginal(request,client,original,{name:'real-process-restart.txt'}),jobId=receipt.work.id;
  let normalizedId,accepted;
  const state=async()=>(await env.admin.query(`SELECT j.state,j.accepted_result,a.normalized_id,
    (SELECT count(*)::int FROM intake_trial.extraction_attempt WHERE job_id=j.id) AS attempts,
    (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=j.id) AS outputs,
    (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) AS results
    FROM intake_trial.extraction_job j JOIN intake_trial.extraction_attempt a ON a.job_id=j.id AND a.attempt_generation=j.attempt_generation WHERE j.id=$1`,[jobId])).rows[0];
  const privateEvents=async()=>({
    extraction:(await administration('observe-extraction',{participant:'extraction'})).events,
    outputs:(await administration('observe-extraction',{participant:'outputs'})).events});
  async function runToDeath(operation,pauseAt=null,target=jobId){
    const proc=await startExtractionProcess(intake);processes.push(proc);
    const reply=await proc.invoke(operation,target,pauseAt);
    assert.equal(reply.kind,pauseAt?'paused':'result');if(pauseAt)assert.equal(reply.label,pauseAt);
    const ended=await proc.terminate();assert.deepEqual({code:ended.code,signal:ended.signal},{code:null,signal:'SIGKILL'});
    assert.deepEqual({pid:ended.pid,startTicks:ended.startTicks,bootId:ended.bootId},proc.processRef);
    observations.push({operation,target,pauseAt,process:proc.processRef,closed:ended,reply});return reply;
  }
  try{
    await t.test('RESTART01 the original worker actually closes before its service process dies',async()=>{
      const reply=await runToDeath('dispatch');
      assert.equal(reply.result.binding.original.sha256,originalReference.sha256);
      assert.ok(reply.result.metadata.observations.some(e=>e.kind==='closed'&&e.id===reply.result.metadata.container_id));
      const row=await state();normalizedId=row.normalized_id;
      assert.deepEqual(row,{state:'running',accepted_result:null,normalized_id:normalizedId,attempts:1,outputs:0,results:0});
    });
    if(!normalizedId)throw Error('RESTART_DISPATCH_PRECONDITION');
    await t.test('RESTART02 death after actual seal but before SQL retains the predetermined identity',async()=>{
      await runToDeath('accept','after_extraction_seal_before_sql');
      const events=await privateEvents();assert.ok(events.outputs.some(e=>e.kind==='sealed'));
      assert.deepEqual(await state(),{state:'running',accepted_result:null,normalized_id:normalizedId,attempts:1,outputs:0,results:0});
      assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,null);
    });
    await t.test('RESTART03 a new process reconciles the sealed identity and dies after staging commit',async()=>{
      await runToDeath('accept','after_extraction_stage_commit');
      assert.deepEqual(await state(),{state:'result_staged',accepted_result:null,normalized_id:normalizedId,attempts:1,outputs:1,results:0});
      const output=(await env.admin.query('SELECT normalized_id FROM intake_trial.extraction_output WHERE job_id=$1',[jobId])).rows[0];
      assert.equal(output.normalized_id,normalizedId);
    });
    await t.test('RESTART04 death after acceptance loses the reply, not the durable effect, without another read or seal',async()=>{
      const before=await privateEvents();const reply=await runToDeath('accept','after_extraction_accept_commit');
      accepted={resultId:reply.event.resultId,effectId:reply.event.effectId};
      assert.deepEqual(await privateEvents(),before,'Committing a staged result must not reread or reseal its content');
      assert.deepEqual(await state(),{state:'accepted',accepted_result:accepted.resultId,normalized_id:normalizedId,attempts:1,outputs:1,results:1});
      const result=await request('/api/intake/extractions/'+jobId,{client});assert.equal(result.status,200,JSON.stringify(result.body));
      assert.deepEqual({result:result.body.result.id,effect:result.body.result.effect.id,text:result.body.result.content.elements.map(e=>e.text).join('')},
        {result:accepted.resultId,effect:accepted.effectId,text:originalReference.text});
    });
    if(!accepted)throw Error('RESTART_ACCEPT_PRECONDITION');
    await t.test('RESTART05 a physically restarted HTTP process reconciles under current query authority, never old processing authority',async()=>{
      const before=await state(),privateBefore=await privateEvents();
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,false)",['b'.repeat(64)]);
      const ended=await application.crash();assert.equal(ended.signal,'SIGKILL');
      const current=await application.restart(intake);
      assert.notDeepEqual({pid:current.pid,startTicks:current.startTicks,bootId:current.bootId},
        {pid:ended.pid,startTicks:ended.startTicks,bootId:ended.bootId});
      const recovered=await request('/api/intake/extractions/'+jobId,{client});assert.equal(recovered.status,200,JSON.stringify(recovered.body));
      assert.deepEqual({id:recovered.body.result.id,effect:recovered.body.result.effect.id,text:recovered.body.result.content.elements.map(e=>e.text).join('')},
        {id:accepted.resultId,effect:accepted.effectId,text:originalReference.text});
      const afterRead=await privateEvents();assert.deepEqual(afterRead.extraction,privateBefore.extraction,'Reconciliation must not relaunch or reread parser output');
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true,revision=revision+1 WHERE account_id=$1 AND permission_id='intake_extraction_read'",[controlled.account.id]);
      const denied=await request('/api/intake/extractions/'+jobId,{client});
      assert.deepEqual({status:denied.status,state:await state(),private:await privateEvents()},{status:404,state:before,private:afterRead});
      observations.push({point:'http-restart',closed:ended,current,accepted});
    });
    await t.test('RESTART06 death after durable claim keeps an unconfirmed predecessor closed to redispatch',async()=>{
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
      const pending=await receivedOriginal(request,client,original,{name:'unconfirmed-prelaunch.txt'}),target=pending.work.id;
      const originalReads=async()=>(await administration('observe-extraction',{participant:'objects'})).events
        .filter(e=>e.artifactId===pending.original.id&&e.kind==='read');
      // Receipt verification has already read this original. Capture those exact
      // observations before dispatch; no extraction read may be added afterward.
      const receiptReads=await originalReads();assert.ok(receiptReads.length>0);
      const paused=await runToDeath('dispatch','extraction_phase_committed',target);
      const observe=async()=>({
        job:(await env.admin.query('SELECT state,attempt_generation,accepted_result FROM intake_trial.extraction_job WHERE id=$1',[target])).rows[0],
        attempts:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_attempt WHERE job_id=$1',[target])).rows[0].n,
        termination:(await env.admin.query("SELECT count(*)::int AS n FROM intake_trial.extraction_event WHERE job_id=$1 AND kind='termination'",[target])).rows[0].n,
        result:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_result WHERE job_id=$1',[target])).rows[0].n,
        activePhase:(await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,
        launches:(await administration('observe-extraction',{participant:'extraction'})).events.filter(e=>e.subject?.job_id===target&&e.kind==='queued').length,
        originalReads:await originalReads()});
      const before=await observe();assert.deepEqual(before,{job:{state:'claimed',attempt_generation:1,accepted_result:null},attempts:1,
        termination:0,result:0,activePhase:paused.event.phaseId,launches:0,originalReads:receiptReads});
      const replacement=new ExtractionService(intake);
      await assert.rejects(replacement.dispatch(target),/INTAKE_(409|503)/);
      await assert.rejects(replacement.retry(target,1),/INTAKE_(409|503)/);
      assert.deepEqual(await observe(),before,'Process death must not become fabricated closure or another attempt');
      observations.push({point:'unconfirmed-prelaunch',target,receiptReads,observed:before,
        interpretation:'Claim and unresolved phase remain retained and unavailable; no automatic repair or lease-based closure is asserted.'});
    });
    assert.equal(new Set(processes.map(p=>p.processRef.bootId+':'+p.processRef.pid+':'+p.processRef.startTicks)).size,5);
  }finally{
    const closure=await Promise.allSettled(processes.map(p=>p.terminate()));
    writeFileSync('/work/output/extraction-restart.json',JSON.stringify({originalReference,jobId,observations,closure,
      limitations:['Actual service and HTTP process death, including fail-closed prelaunch recovery, is covered; private participant replacement, post-launch controller recovery and populated restore remain separate obligations.',
        'This does not close the observed writer-free temporal interval.']},null,2),{flag:'wx'});
    assert.ok(closure.every(r=>r.status==='fulfilled'),'All owned service children must be observed closed');
  }
}
