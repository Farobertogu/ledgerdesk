import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Client} from 'pg';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl,processingTreatment} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';

const points=[['original','before_extraction_original_read'],['input','before_extraction_input_dispatch'],
  ['raw','before_extraction_result_read'],['seal','before_extraction_output_seal'],['accept','before_extraction_accept_commit'],
  ['query','extraction-query-read'],['delivery','response-handoff']];

/** A real invalidating writer, not an invented new deadline or mock permission. */
export async function extractionFencingCases(t,{env,intake,client,request,setBarrier,clientCalls}){
  await extractionControl(env);
  const root='/work/output/extraction-fencing',observations=[];
  const bytes=Buffer.from('AZ-17\nUnder condition Z, receipt R replaces receipt Q.\n');
  mkdirSync(root,{recursive:true});
  writeFileSync(root+'/reference.json',JSON.stringify({profile:'extraction-fencing-reference/1',points,fixedAtMs:Date.now(),
    original:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},
    writer:'Actual intake_control.set_treatment on a separate PostgreSQL connection',
    expectedWriterSQLState:'55P03',expectedAfterWriterStatus:404},null,2),{flag:'wx'});
  const current=async()=>(await env.admin.query('SELECT * FROM intake_control.treatment_current')).rows[0];
  const state=async id=>({job:(await env.admin.query('SELECT id,state,accepted_result FROM intake_trial.extraction_job WHERE id=$1',[id])).rows[0],
    results:(await env.admin.query('SELECT id,effect_id FROM intake_trial.extraction_result WHERE job_id=$1',[id])).rows,
    attempts:(await env.admin.query('SELECT channel_id,attempt_generation FROM intake_trial.extraction_attempt WHERE job_id=$1 ORDER BY attempt_generation',[id])).rows});
  const events=async received=>{
    const result={};
    for(const participant of ['objects','extraction','outputs'])result[participant]=(await administration('observe-extraction',{participant})).events
      .filter(e=>participant==='objects'?e.artifactId===received.original.id:e.subject?.job_id===received.work.id);
    return result;
  };
  try{
    for(const [name,point]of points)await t.test('EF-'+name+' fences an overlapping writer and rejects a completed prior invalidation',async()=>{
      const received=await receivedOriginal(request,client,bytes,{name:'writer-'+name+'.txt'}),jobId=received.work.id;
      const ordinary=new ExtractionService(intake);
      if(!['original','input'].includes(name))await ordinary.dispatch(jobId);
      if(['query','delivery'].includes(name))await ordinary.accept(jobId);
      const startCalls=clientCalls.length;let paused=null,delivery=null;
      const barrier=async(label,event)=>{
        if(label==='before_handoff'&&event.route==='extraction')delivery=event;
        const matches=['query','delivery'].includes(name)?label==='after_last_clock'&&event.route==='extraction'&&event.point===point:label===point&&event.jobId===jobId;
        if(!matches||paused)return;
        const phase=(await env.admin.query(`SELECT p.id,p.backend_pid,p.participant_plan,p.evidence_id,a.state,a.xact_start
          FROM intake_control.fence_head h JOIN intake_control.private_phase p ON p.id=h.active_phase
          JOIN pg_stat_activity a ON a.pid=p.backend_pid`)).rows[0]??null;
        if(!['accept','delivery'].includes(name)){
          assert.ok(phase);assert.deepEqual({state:phase.state,transaction:phase.xact_start},{state:'idle',transaction:null});
          const evidence=(await env.admin.query('SELECT artifact_id,generation,status FROM intake_trial.evidence WHERE id=$1',[phase.evidence_id])).rows[0];
          assert.deepEqual(evidence,{artifact_id:received.original.id,generation:received.original.generation,status:200});
        }
        if(name==='accept')assert.equal((await state(jobId)).results.length,0,'No acceptance is visible before its commit');
        if(name==='delivery'){
          assert.ok(delivery);assert.ok(clientCalls.slice(startCalls).every(c=>c.receivedBytes===0));
          const evidence=(await env.admin.query('SELECT status FROM intake_trial.evidence WHERE id=$1',[delivery.evidenceId])).rows;
          const sql=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[delivery.backendPid])).rows;
          const transport=(await env.admin.query('SELECT id FROM intake_trial.transport WHERE evidence_id=$1',[delivery.evidenceId])).rows;
          assert.deepEqual({evidence,sql,transport},{evidence:[{status:200}],sql:[{state:'idle',xact_start:null}],transport:[]});
        }
        paused={point,event,phase,controlBefore:await current(),before:await state(jobId),startedAtMs:Date.now()};
        const writer=new Client({...env.admin.connectionParameters,statement_timeout:2000});await writer.connect();
        try{
          paused.writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          let sqlState=null;
          try{await writer.query('SELECT intake_control.set_treatment($1,1,false)',[processingTreatment.id]);}
          catch(error){sqlState=error.code;}
          paused.writer={sqlState,endedAtMs:Date.now()};paused.controlAfter=await current();
          assert.equal(sqlState,'55P03','The real source writer must not invalidate an in-flight protected effect');
          assert.deepEqual(paused.controlAfter,paused.controlBefore);
        }finally{await writer.end();}
      };
      setBarrier(barrier);const service=new ExtractionService(intake,{barrier});
      try{
        const reply=['query','delivery'].includes(name)?await request('/api/intake/extractions/'+jobId,{client}):
          ['original','input'].includes(name)?await service.dispatch(jobId):await service.accept(jobId);
        assert.ok(paused,'The actual protected boundary must be exercised');
        if(['query','delivery'].includes(name)){
          assert.equal(reply.status,200,JSON.stringify(reply.body));assert.equal(reply.body.result.content.elements.map(e=>e.text).join(''),bytes.toString());
        }else if(['original','input'].includes(name)){assert.equal(reply.metadata.reason,null);assert.equal(reply.metadata.exit_code,0);}
        else assert.ok(reply.resultId&&reply.effectId);
        // The same mutation now completes after the effect/phase has finished.
        setBarrier(async()=>{});
        await env.admin.query('SELECT intake_control.set_treatment($1,1,false)',[processingTreatment.id]);
        assert.equal((await current()).enabled,false);
        const before=await events(received),history=await state(jobId);
        let denied;
        if(['query','delivery'].includes(name)){
          const result=await request('/api/intake/extractions/'+jobId,{client});denied=result.status;
          assert.equal(result.bytes.includes(bytes),false);
        }else{
          try{await ordinary.accept(jobId);}catch(error){denied=error.status;}
        }
        const after=await events(received),retained=await state(jobId);
        assert.deepEqual({denied,events:after,history:retained},{denied:404,events:before,history});
        observations.push({name,point,jobId,paused,positive:'actual operation succeeded',writerAfterEffect:'committed',denied,before,after,history,retained});
      }finally{
        setBarrier(async()=>{});await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[processingTreatment.id]);
        if((await state(jobId)).job?.state==='running')await ordinary.accept(jobId);
      }
    });
  }finally{
    writeFileSync(root+'/observations.json',JSON.stringify({profile:'extraction-fencing-observations/1',observations,
      limitations:['Writer-coordination evidence is separate from writer-free temporal conformity','No claim of a production deployment']},null,2),{flag:'wx'});
  }
}
