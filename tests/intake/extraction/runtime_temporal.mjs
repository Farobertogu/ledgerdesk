import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl,processingTreatment} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';

// Ordered so the last, pre-dispatch observation may retain an uncertain claim
// without bypassing the real capacity guard to prepare another case.
const points=[
  ['accept','before_extraction_accept_commit','accepted-result-commit'],
  ['raw','before_extraction_result_read','protected-raw-read-complete'],
  ['seal','before_extraction_output_seal','sealed'],
  ['input','before_extraction_input_dispatch','queued'],
  ['query','extraction-query-read','protected-normalized-read-complete'],
  ['delivery','response-handoff','transport-handoff'],
  ['original','before_extraction_original_read','original-read'],
];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Actual writer-free observations, not a universal conformity assertion. */
export async function extractionTemporalCases(t,{env,intake,client,request,requestEvents,clientCalls,setBarrier}){
  await extractionControl(env);
  const root='/work/output/extraction-temporal',observations=[];
  const bytes=Buffer.from('AZ-17\nUnder condition Z, receipt R replaces receipt Q.\n');
  const reference={bytes:bytes.length,sha256:digest(bytes)};
  mkdirSync(root,{recursive:true});writeFileSync(root+'/original.bin',bytes,{flag:'wx'});
  writeFileSync(root+'/reference.json',JSON.stringify({profile:'extraction-temporal-reference/1',fixedAtMs:Date.now(),original:reference,
    points,windowMs:5000,pastDeadlineMs:100,normative:'No protected effect after applicable authority expires',
    observedConformity:null,expectedResultNotPredetermined:true},null,2),{flag:'wx'});
  const now=async()=>Number((await env.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
  const control=async()=>({live:(await env.admin.query('SELECT source_id,revision,generation,incarnation,enabled FROM intake_control.live')).rows[0],
    treatment:(await env.admin.query('SELECT * FROM intake_control.treatment_current')).rows[0],
    processing:(await env.admin.query('SELECT * FROM intake_control.processing_current ORDER BY format')).rows,
    authorityDigest:digest(Buffer.from(JSON.stringify((await env.admin.query(`SELECT account_id,permission_id,faculty,scope_ref,revision,withdrawn,expires_at
      FROM access_trial.grant_record ORDER BY id`)).rows))),
    epoch:(await env.admin.query('SELECT epoch FROM intake_control.fence_head')).rows[0].epoch});
  const state=async jobId=>({job:(await env.admin.query('SELECT id,state,revision,attempt_generation,accepted_result FROM intake_trial.extraction_job WHERE id=$1',[jobId])).rows[0]??null,
    attempts:(await env.admin.query('SELECT attempt_generation,claim_id,channel_id,normalized_id FROM intake_trial.extraction_attempt WHERE job_id=$1 ORDER BY attempt_generation',[jobId])).rows,
    outputs:(await env.admin.query('SELECT id,normalized_id,seal_evidence,seal_phase FROM intake_trial.extraction_output WHERE job_id=$1',[jobId])).rows,
    results:(await env.admin.query('SELECT id,effect_id,evidence_id FROM intake_trial.extraction_result WHERE job_id=$1',[jobId])).rows,
    events:(await env.admin.query('SELECT kind,observation,recorded_at FROM intake_trial.extraction_event WHERE job_id=$1 ORDER BY recorded_at,id',[jobId])).rows});
  const privateEvents=async received=>{
    const result={};
    // The test administration bridge is a single request mailbox, not an RPC
    // multiplexer. Keep its calls sequential and outside the expiry window.
    for(const participant of ['objects','extraction','outputs']){
      const all=(await administration('observe-extraction',{participant})).events;
      result[participant]=all.filter(e=>participant==='objects'?e.artifactId===received.original.id:e.subject?.job_id===received.work.id);
    }
    return result;
  };
  try{
    for(const [name,point,effect]of points)for(const expire of [false,true])await t.test(`ET-${name} ${expire?'writer-free expiry observation':'nonexpired positive'}`,async()=>{
      const received=await receivedOriginal(request,client,bytes,{name:'temporal-'+name+'.txt'}),jobId=received.work.id;
      const ordinary=new ExtractionService(intake);
      if(!['input','original'].includes(name))await ordinary.dispatch(jobId);
      if(['query','delivery'].includes(name))await ordinary.accept(jobId);
      // Observe the prior journal before selecting the expiring declaration.
      // Host-side evidence collection must not consume the positive window.
      const privateBefore=await privateEvents(received);
      const revision=2+points.findIndex(row=>row[0]===name)*2+Number(expire),deadline=await now()+5000;
      const ref={id:processingTreatment.id,revision,sha256:digest(Buffer.from(JSON.stringify({revision,deadline})))};
      // Select an immutable expiring declaration BEFORE the operation. The
      // paused interval contains only observations and wall-clock passage.
      await env.admin.query(`INSERT INTO intake_control.treatment
        SELECT id,$1,$2,scope_ref,purpose_ref,fields,actions,receiver,storage,processor,response_destination,disposition_ref,$3
        FROM intake_control.treatment WHERE id=$4 AND revision=1`,[revision,ref.sha256,deadline,ref.id]);
      await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[ref.id,ref.revision]);
      let pause=null,reply=null,error=null,deliveryEvidence=null;
      const requestStart=requestEvents.length,clientStart=clientCalls.length;
      const barrier=async(label,event)=>{
        if(label==='before_handoff'&&event.route==='extraction'){
          deliveryEvidence={event,rows:(await env.admin.query('SELECT id,phase,status,recorded_at FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows,
            backend:(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows[0],
            transport:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.transport WHERE evidence_id=$1',[event.evidenceId])).rows[0].n};
        }
        const matches=['query','delivery'].includes(name)?label==='after_last_clock'&&event.route==='extraction'&&event.point===point:label===point&&event.jobId===jobId;
        if(!matches||pause)return;
        const observedAtMs=await now();
        assert.equal(event.deadlineMs,deadline);assert.ok(event.lastEvaluationMs<deadline&&observedAtMs<deadline,'The final actual evaluation must precede the immutable expiry');
        pause={...event,observedAtMs,controlBefore:await control(),rowsBefore:await state(jobId),privateBefore};
        if(name==='accept')assert.equal(pause.rowsBefore.results.length,0,'Uncommitted acceptance must not be visible from the independent SQL connection');
        if(name==='delivery'){
          assert.deepEqual({evidence:deliveryEvidence?.rows.length,status:deliveryEvidence?.rows[0]?.status,state:deliveryEvidence?.backend.state,
            transaction:deliveryEvidence?.backend.xact_start,transport:deliveryEvidence?.transport},{evidence:1,status:200,state:'idle',transaction:null,transport:0});
          assert.ok(clientCalls.slice(clientStart).every(c=>c.receivedBytes===0),'No content reached the client before the terminal handoff');
        }
        if(expire)while(await now()<=deadline+100)await delay(20);
        pause.releasedAtMs=await now();pause.controlAtRelease=await control();
        assert.deepEqual(pause.controlAtRelease,pause.controlBefore,'No control/authority writer may intervene in the expiry interval');
      };
      setBarrier(barrier);
      const service=new ExtractionService(intake,{barrier});
      try{
        try{reply=['query','delivery'].includes(name)?await request('/api/intake/extractions/'+jobId,{client}):
          ['input','original'].includes(name)?await service.dispatch(jobId):await service.accept(jobId);}
        catch(failure){error={name:failure.name,message:failure.message,status:failure.status??null,code:failure.code??null};}
        assert.ok(pause,'The target must be reached; an earlier denial is not this experiment');
        const after=await state(jobId),events=await privateEvents(received);
        const relevant=name==='accept'?after.results.map(r=>({kind:'accepted-result-commit',...r})):
          name==='original'?events.objects.filter(e=>e.kind==='read'&&e.atMs>=pause.releasedAtMs):
          ['input','raw'].includes(name)?events.extraction.filter(e=>e.kind===effect&&e.atMs>=pause.releasedAtMs):
          ['seal','query'].includes(name)?events.outputs.filter(e=>e.kind===effect&&e.atMs>=pause.releasedAtMs):
          requestEvents.slice(requestStart).filter(e=>e.kind==='terminal-end'&&e.callId===pause.callId);
        const delivered=name==='delivery'&&reply?.status===200&&reply.body?.result?.content?.elements?.map(e=>e.text).join('')===bytes.toString();
        const effectObserved=name==='delivery'?delivered:relevant.length>0;
        if(['raw','query'].includes(name)&&effectObserved)assert.ok(relevant.every(e=>e.bytes>0&&/^[a-f0-9]{64}$/.test(e.sha256)),
          'Observe completed, integrity-checked bytes, not just entry into a read operation');
        const violation=expire&&effectObserved&&pause.releasedAtMs>deadline;
        const record={name,point,effect,expire,reference,jobId,deadline,pause,deliveryEvidence,after,privateEvents:events,
          relevant,error,httpStatus:reply?.status??null,deliveredBytes:delivered?reply.bytes.length:0,effectObserved,
          temporalViolation:violation,conformity:expire?(violation?'observed-violation':'no-violation-observed-at-this-point'):'positive-control',
          universalConformityClaim:false};
        observations.push(record);
        writeFileSync(root+'/case-'+String(observations.length).padStart(2,'0')+'-'+name+'.json',JSON.stringify(record,null,2),{flag:'wx'});
        if(!expire){assert.ok(effectObserved,'The nonexpired control must reach the actual protected effect');assert.ok(pause.releasedAtMs<deadline);}
        else assert.ok(pause.releasedAtMs>deadline);
      }finally{
        setBarrier(async()=>{});
        await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[processingTreatment.id]);
        // Re-authorize a still-running/staged result only AFTER recording the
        // expired operation. This is new authorized work, not its hidden repair.
        const remaining=await state(jobId);
        if(['running','result_staged'].includes(remaining.job?.state))await ordinary.accept(jobId);
      }
    });
  }finally{
    writeFileSync(root+'/observations.json',JSON.stringify({profile:'extraction-temporal-observations/1',observations,
      limitations:['Finite synthetic observations; no universal temporal guarantee','Writer-coordination counterparts remain a separate obligation',
        'A final pre-launch uncertain claim is retained; no fabricated closure or forced redispatch']},null,2),{flag:'wx'});
  }
}
