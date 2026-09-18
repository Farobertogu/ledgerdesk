import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {RECEPTION_V2_ACCEPT} from '../../../src/contracts/intake_extraction.ts';
import {extractionControl,processingTreatment} from './runtime_control.mjs';
import {administration} from '../t02/recovery_cases.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {receivedOriginal} from './received_fixture.mjs';
import {PrivateExtractionPort,extractionSubject} from '../../../src/server/intake/extraction_ports.ts';
import {recipientEmail} from '../../access/journey_environment.mjs';

export async function extractionRuntimeCases(t,{env,intake,client,request,post,login}){
  const observations=[];
  const controlled=await extractionControl(env);
  const service=new ExtractionService(intake,{observe:e=>observations.push(e),barrier:async(label,event)=>{
    observations.push({label,...event});
    if(label==='extraction_phase_committed'){
      const p=(await env.admin.query('SELECT p.*,a.state,a.xact_start FROM intake_control.private_phase p JOIN pg_stat_activity a ON a.pid=p.backend_pid WHERE p.id=$1',[event.phaseId])).rows[0];
      assert.ok(p);assert.equal(p.state,'idle');assert.equal(p.xact_start,null);
      assert.equal(p.evidence_id,event.evidenceId);
    }
    if(label==='after_extraction_accept_commit')throw Error('EXPECTED_ACCEPT_REPLY_LOSS');
  }});
  const original=Buffer.from('AZ-17\nUnder condition Z, receipt R replaces receipt Q.\n','utf8');
  const expectedHash=createHash('sha256').update(original).digest('hex');
  let receipt,jobId,dispatch,accepted;
  try{
    await t.test('E00 current availability is versioned, independently controlled and never dispatches a job',async()=>{
      const query=()=>request('/api/intake/profiles',{client,headers:{accept:RECEPTION_V2_ACCEPT}});
      const positive=await query();assert.equal(positive.status,200,JSON.stringify(positive.body));
      const offered=positive.body.profiles.filter(p=>p.processing_available).map(p=>p.format_profile);assert.deepEqual(offered,['text-utf8/1']);
      const legacy=await request('/api/intake/profiles',{client});assert.equal(legacy.status,409);assert.equal(legacy.body.code,'representation_conflict');
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,false)",['b'.repeat(64)]);
      const disabled=await query();assert.equal(disabled.status,200);assert.ok(disabled.body.profiles.every(p=>!p.processing_available));
      assert.equal((await request('/api/intake/profiles',{client})).status,200);
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
      assert.deepEqual((await query()).body.profiles,positive.body.profiles);
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_job')).rows[0].n,0);
    });
    await t.test('E01 actual HTTPS receipt fixes original, request and plan before dispatch',async()=>{
      const declaration={profile:'intake/1',original:{name:'synthetic.txt',bytes:original.length,sha256:expectedHash,declared_media_type:'text/plain'},
        format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:processingTreatment}};
      const reserved=await request('/api/intake/receptions',{client,body:declaration,key:randomUUID()});
      assert.equal(reserved.status,202,JSON.stringify(reserved.body));
      const staged=await request(`/api/intake/receptions/${reserved.body.reception_id}/attempts/1/original`,{client,bytes:original});
      assert.equal(staged.status,200,JSON.stringify(staged.body));
      const finalized=await request(`/api/intake/receptions/${reserved.body.reception_id}/finalize`,{client,key:randomUUID(),
        body:{profile:'intake/1',expected_revision:staged.body.revision,original:staged.body.original,format_profile:'text-utf8/1'}});
      assert.equal(finalized.status,200,JSON.stringify(finalized.body));receipt=finalized.body;jobId=receipt.work.id;
      assert.equal(receipt.work.state,'not_started');assert.equal(receipt.original.sha256,expectedHash);
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_attempt')).rows[0].n,0);
    });
    if(!jobId)throw Error('EXTRACTION_RECEIPT_PRECONDITION');
    await t.test('E02 controlled worker receives the received original and actually closes',async()=>{
      dispatch=await service.dispatch(jobId);
      assert.equal(dispatch.binding.original.sha256,expectedHash);assert.equal(dispatch.binding.original.id,receipt.original.id);
      assert.equal(dispatch.metadata.exit_code,0);assert.equal(dispatch.metadata.reason,null);
      assert.ok(dispatch.metadata.observations.some(e=>e.kind==='closed'));
      const row=(await env.admin.query('SELECT * FROM intake_trial.extraction_job WHERE id=$1',[jobId])).rows[0];
      assert.equal(row.state,'running');assert.equal(row.accepted_result,null);
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_output')).rows[0].n,0);
      const legacy=await request('/api/intake/receptions/'+receipt.reception_id,{client});assert.equal(legacy.status,409);
      const current=await request('/api/intake/receptions/'+receipt.reception_id,{client,headers:{accept:RECEPTION_V2_ACCEPT}});
      assert.equal(current.status,200,JSON.stringify(current.body));assert.equal(current.body.work.state,'running');
      const pending=await request('/api/intake/extractions/'+jobId,{client});
      assert.equal(pending.status,200,JSON.stringify(pending.body));assert.equal(pending.body.result,null);
    });
    if(!dispatch)throw Error('EXTRACTION_DISPATCH_PRECONDITION');
    await t.test('E03a withdrawal before result admission causes zero protected raw reads',async()=>{
      const reads=async()=>(await administration('observe-extraction',{participant:'extraction'})).events.filter(e=>e.kind==='protected-raw-read').length;
      assert.equal(await reads(),0);
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,false)",['b'.repeat(64)]);
      await assert.rejects(service.accept(jobId),/INTAKE_404/);
      assert.deepEqual({reads:await reads(),results:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_result')).rows[0].n},{reads:0,results:0});
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
    });
    await t.test('E03 fresh result admission seals distinct bytes before fresh SQL acceptance',async()=>{
      await assert.rejects(service.accept(jobId),/EXPECTED_ACCEPT_REPLY_LOSS/);
      const row=(await env.admin.query(`SELECT j.state,r.effect_id,r.outcome,o.*,p.participant_plan,c.kind
        FROM intake_trial.extraction_job j JOIN intake_trial.extraction_result r ON r.id=j.accepted_result
        JOIN intake_trial.extraction_output o ON o.id=r.output_id JOIN intake_control.private_phase p ON p.id=o.seal_phase
        JOIN intake_control.phase_completion c ON c.phase_id=p.id WHERE j.id=$1`,[jobId])).rows[0];
      assert.ok(row);assert.equal(row.state,'accepted');assert.equal(row.outcome,'completed');
      const effect=(await env.admin.query('SELECT id,effect_id FROM intake_trial.extraction_result WHERE job_id=$1',[jobId])).rows[0];
      accepted={resultId:effect.id,effectId:effect.effect_id};
      assert.notEqual(row.raw_id,row.normalized_id);assert.equal(row.bytes,row.raw_bytes+row.normalized_bytes);
      assert.deepEqual(row.participant_plan,{extraction:['read'],outputs:['seal']});assert.equal(row.kind,'participants_closed');
      const evidence=(await env.admin.query("SELECT * FROM intake_trial.evidence WHERE route='accept_extraction_result' ORDER BY recorded_at")).rows;
      assert.deepEqual(evidence.map(e=>e.phase),['read_admission','effect']);
      assert.notEqual(evidence[0].backend_pid,evidence[1].backend_pid);
      assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,null);
    });
    if(!accepted)throw Error('EXTRACTION_ACCEPT_PRECONDITION');
    await t.test('E04 protected query delivers exact text after a lost acceptance reply',async()=>{
      const result=await request('/api/intake/extractions/'+jobId,{client});
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.deepEqual({id:result.body.result.id,effect:result.body.result.effect.id}, {id:accepted.resultId,effect:accepted.effectId});
      assert.equal(result.body.result.content.elements.map(e=>e.text).join(''),original.toString());
      assert.deepEqual(result.body.original,receipt.original);assert.equal(result.headers['cache-control'],'private, no-store');
      assert.equal(Object.hasOwn(result.body.result.content,'raw'),false);
      // Receiving HTTP bytes precedes the terminal's subsequent transport INSERT.
      // Observe its completion; do not retry the request or infer it from a flush of IPC messages.
      const until=Date.now()+2000;let count;
      do{count=(await env.admin.query("SELECT count(*)::int AS n FROM intake_trial.transport t JOIN intake_trial.evidence e ON e.id=t.evidence_id WHERE e.route='extraction' AND t.outcome='handed_off'")).rows[0].n;
        if(count!==2)await delay(10);
      }while(count!==2&&Date.now()<until);
      assert.equal(count,2);
    });
    await t.test('E04a seal-to-SQL loss and staged restart retain one output identity and one accepted effect',async()=>{
      const declaration={profile:'intake/1',original:{name:'restart.txt',bytes:original.length,sha256:expectedHash,declared_media_type:'text/plain'},
        format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:processingTreatment}};
      const reserved=await request('/api/intake/receptions',{client,body:declaration,key:randomUUID()});assert.equal(reserved.status,202);
      const uploaded=await request(`/api/intake/receptions/${reserved.body.reception_id}/attempts/1/original`,{client,bytes:original});assert.equal(uploaded.status,200);
      const received=await request(`/api/intake/receptions/${reserved.body.reception_id}/finalize`,{client,key:randomUUID(),
        body:{profile:'intake/1',expected_revision:uploaded.body.revision,original:uploaded.body.original,format_profile:'text-utf8/1'}});assert.equal(received.status,200);
      const target=received.body.work.id;
      assert.notEqual(received.body.original.id,receipt.original.id);assert.equal(received.body.original.sha256,receipt.original.sha256);
      const first=new ExtractionService(intake,{barrier:async label=>{if(label==='after_extraction_seal_before_sql')throw Error('EXPECTED_SEAL_SQL_GAP');}});
      await first.dispatch(target);await assert.rejects(first.accept(target),/EXPECTED_SEAL_SQL_GAP/);
      const state=async()=>(await env.admin.query(`SELECT j.state,a.normalized_id,
        (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=j.id) AS outputs,
        (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) AS results
        FROM intake_trial.extraction_job j JOIN intake_trial.extraction_attempt a ON a.job_id=j.id AND a.attempt_generation=j.attempt_generation WHERE j.id=$1`,[target])).rows[0];
      const afterSeal=await state();assert.deepEqual({state:afterSeal.state,outputs:afterSeal.outputs,results:afterSeal.results},{state:'running',outputs:0,results:0});
      const second=new ExtractionService(intake,{barrier:async label=>{if(label==='after_extraction_stage_commit')throw Error('EXPECTED_STAGE_REPLY_LOSS');}});
      await assert.rejects(second.accept(target),/EXPECTED_STAGE_REPLY_LOSS/);
      assert.deepEqual(await state(),{...afterSeal,state:'result_staged',outputs:1});
      const before=(await administration('observe-extraction',{participant:'outputs'})).events.filter(e=>e.kind==='sealed').length;
      const third=new ExtractionService(intake),acceptedAfterRestart=await third.accept(target);
      const after=(await administration('observe-extraction',{participant:'outputs'})).events.filter(e=>e.kind==='sealed').length;
      assert.equal(after,before,'Staged reconciliation must not read or seal the body again');
      assert.deepEqual(await state(),{...afterSeal,state:'accepted',outputs:1,results:1});
      const result=await request('/api/intake/extractions/'+target,{client});assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal(result.body.result.id,acceptedAfterRestart.resultId);assert.equal(result.body.original.id,received.body.original.id);
      assert.equal(result.body.result.content.elements.map(e=>e.text).join(''),original.toString());
      observations.push({label:'seal-sql-restart',jobId:target,normalizedId:afterSeal.normalized_id,result:acceptedAfterRestart});
    });
    await t.test('E04b cancellation observes actual launch and closure without accepting the stopped output',async()=>{
      const declaration={profile:'intake/1',original:{name:'stop.txt',bytes:original.length,sha256:expectedHash,declared_media_type:'text/plain'},
        format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:processingTreatment}};
      const reserved=await request('/api/intake/receptions',{client,body:declaration,key:randomUUID()});assert.equal(reserved.status,202);
      const uploaded=await request(`/api/intake/receptions/${reserved.body.reception_id}/attempts/1/original`,{client,bytes:original});assert.equal(uploaded.status,200);
      const received=await request(`/api/intake/receptions/${reserved.body.reception_id}/finalize`,{client,key:randomUUID(),
        body:{profile:'intake/1',expected_revision:uploaded.body.revision,original:uploaded.body.original,format_profile:'text-utf8/1'}});assert.equal(received.status,200);
      const target=received.body.work.id,stopKey=randomUUID(),stopBody={profile:'intake/1',expected_revision:received.body.revision};
      assert.equal((await administration('hold-next-extraction',{})).ok,true);
      let stopResponse;
      const stopping=new ExtractionService(intake,{barrier:async label=>{
        if(label!=='after_extraction_launch')return;
        const before=(await env.admin.query(`SELECT j.state,
          (SELECT count(*)::int FROM intake_trial.extraction_event WHERE job_id=j.id AND kind='termination') AS terminations
          FROM intake_trial.extraction_job j WHERE j.id=$1`,[target])).rows[0];
        assert.deepEqual(before,{state:'running',terminations:0});
        await assert.rejects(new ExtractionService(intake).dispatch(target),/INTAKE_409/);
        await assert.rejects(new ExtractionService(intake).retry(target,1),/INTAKE_409/,'A live predecessor is not a closed interruption');
        assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_attempt WHERE job_id=$1',[target])).rows[0].n,1);
        const binding=(await env.admin.query('SELECT binding FROM intake_trial.extraction_attempt WHERE job_id=$1',[target])).rows[0].binding;
        const subject=extractionSubject(binding);
        for(const foreign of [{...subject,job_id:randomUUID()},{...subject,attempt_generation:2},{...subject,binding_sha256:'0'.repeat(64)}])
          await assert.rejects(new PrivateExtractionPort('extraction').stop(foreign),/EXTRACTION_STOP_UNCONFIRMED/);
        stopResponse=await request(`/api/intake/receptions/${received.body.reception_id}/cancel`,
          {client,key:stopKey,body:stopBody,headers:{accept:RECEPTION_V2_ACCEPT}});
        assert.equal(stopResponse.status,200,JSON.stringify(stopResponse.body));
        assert.equal(stopResponse.body.work.state,'stopping');
      }});
      const completed=await stopping.dispatch(target);assert.ok(stopResponse);
      assert.equal(completed.metadata.reason,'stopped');assert.ok(completed.metadata.observations.some(e=>e.kind==='closed'));
      assert.equal(completed.metadata.raw.bytes,0,'The held process must not receive the input before the stop');
      const current=await request(`/api/intake/receptions/${received.body.reception_id}`,{client,headers:{accept:RECEPTION_V2_ACCEPT}});
      assert.equal(current.status,200,JSON.stringify(current.body));assert.deepEqual({state:current.body.state,work:current.body.work.state},{state:'stopped',work:'stopped'});
      const counts=(await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=$1) AS outputs,
        (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=$1) AS results`,[target])).rows[0];
      assert.deepEqual(counts,{outputs:0,results:0});await assert.rejects(stopping.accept(target),/INTAKE_404/);
      const repeated=await request(`/api/intake/receptions/${received.body.reception_id}/cancel`,
        {client,key:stopKey,body:stopBody,headers:{accept:RECEPTION_V2_ACCEPT}});
      assert.equal(repeated.status,200);assert.equal(repeated.body.work.state,'stopped');
      observations.push({label:'actual-stop',jobId:target,metadata:completed.metadata,initialReply:stopResponse.body.work.state});
    });
    await t.test('E04c the declared originating-session mode gates real original reads, not later query sessions',async()=>{
      await env.admin.query(`INSERT INTO intake_control.processing_declaration SELECT 'text-origin-session-1',1,$1,format,configuration,limits,
        request,plan,assignment,worker,executor_account,executor_reference,scope_ref,purpose_ref,'origin_session',image,expires_at
        FROM intake_control.processing_declaration WHERE id='text-extraction-1'`,['c'.repeat(64)]);
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-origin-session-1',1,$1,true)",['c'.repeat(64)]);
      const first=await receivedOriginal(request,client,original,{name:'session-bound-positive.txt'}),freshService=new ExtractionService(intake);
      await freshService.dispatch(first.work.id);await freshService.accept(first.work.id);
      assert.equal((await request('/api/intake/extractions/'+first.work.id,{client})).status,200);
      const second=await receivedOriginal(request,client,original,{name:'session-bound-negative.txt'});
      const originalReads=async()=>(await administration('observe-extraction',{participant:'objects'})).events
        .filter(e=>e.kind==='read'&&e.artifactId===second.original.id).length;
      const before=await originalReads(),priorSession={...client};
      assert.equal((await post('/sessions/logout',{},client)).status,200);
      await assert.rejects(freshService.dispatch(second.work.id),/INTAKE_404/);
      Object.assign(client,await login(recipientEmail));
      await assert.rejects(freshService.dispatch(second.work.id),/INTAKE_404/,'A new session of the same account is not the originating session');
      assert.deepEqual({reads:await originalReads(),attempts:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_attempt WHERE job_id=$1',[second.work.id])).rows[0].n},
        {reads:before,attempts:0});
      // Select the already controlled independent mode before any dispatch. The
      // original session stays revoked; current load and executor faculties remain.
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
      await freshService.dispatch(second.work.id);const result=await freshService.accept(second.work.id);
      assert.equal(await originalReads(),before+1);
      const denied=await request('/api/intake/extractions/'+second.work.id,{client:priorSession});assert.equal(denied.status,403);
      const current=await request('/api/intake/extractions/'+second.work.id,{client});assert.equal(current.status,200,JSON.stringify(current.body));
      assert.equal(current.body.result.id,result.resultId);assert.equal(current.body.original.id,second.original.id);
      observations.push({label:'both-session-modes',positive:first.work.id,negativeThenIndependent:second.work.id,readsBefore:before,readsAfter:before+1});
    });
    await t.test('E04d missing or corrupt accepted output affects availability, never historical acceptance or redispatch',async()=>{
      const history=async()=>(await env.admin.query(`SELECT j.*,r.id AS result_id,r.effect_id,o.location_binding,
        (SELECT count(*)::int FROM intake_trial.extraction_attempt WHERE job_id=j.id) AS attempts
        FROM intake_trial.extraction_job j JOIN intake_trial.extraction_result r ON r.id=j.accepted_result
        JOIN intake_trial.extraction_output o ON o.id=r.output_id WHERE j.id=$1`,[jobId])).rows[0];
      const before=await history(),bundle=JSON.parse(before.location_binding);
      for(const mode of ['missing','corrupt']){
        const faultId=randomUUID(),input={channel:bundle.id,faultId,mode};
        assert.equal((await administration('fault-extraction-output',input)).ok,true);
        try{
          const unavailable=await request('/api/intake/extractions/'+jobId,{client});
          assert.equal(unavailable.status,503,JSON.stringify(unavailable.body));
          assert.equal(unavailable.bytes.includes(original),false);assert.deepEqual(await history(),before);
          assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,null);
        }finally{assert.equal((await administration('fault-extraction-output',{...input,mode:'restore'})).ok,true);}
        const restored=await request('/api/intake/extractions/'+jobId,{client});assert.equal(restored.status,200,JSON.stringify(restored.body));
        assert.equal(restored.body.result.id,accepted.resultId);assert.equal(restored.body.result.effect.id,accepted.effectId);
        assert.equal(restored.body.result.content.elements.map(e=>e.text).join(''),original.toString());assert.deepEqual(await history(),before);
      }
    });
    await t.test('E04e stop-only remains available after processing withdrawal and reads no result body',async()=>{
      const received=await receivedOriginal(request,client,original,{name:'stop-only.txt'}),stopService=new ExtractionService(intake);
      await stopService.dispatch(received.work.id);
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,false)",['b'.repeat(64)]);
      const rawReads=async()=>(await administration('observe-extraction',{participant:'extraction'})).events.filter(e=>e.kind==='protected-raw-read').length;
      const before=await rawReads();
      await assert.rejects(stopService.accept(received.work.id),/INTAKE_404/);
      const stop=await request(`/api/intake/receptions/${received.reception_id}/cancel`,{client,key:randomUUID(),headers:{accept:RECEPTION_V2_ACCEPT},
        body:{profile:'intake/1',expected_revision:received.revision}});
      assert.equal(stop.status,200,JSON.stringify(stop.body));assert.equal(stop.body.work.state,'stopped');
      assert.deepEqual({reads:await rawReads(),results:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_result WHERE job_id=$1',[received.work.id])).rows[0].n},
        {reads:before,results:0});
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
    });
    await t.test('E04f a foreign channel reply leaves a visible uncertain predecessor and cannot redispatch',async()=>{
      const received=await receivedOriginal(request,client,original,{name:'channel-negative.txt'}),badChannel=new ExtractionService(intake);
      const call=badChannel.extraction.call.bind(badChannel.extraction);let reached=false;
      badChannel.extraction.call=async command=>{
        const reply=await call(command);
        if(command.action==='run'&&reply.ok){reached=true;return{...reply,metadata:{...reply.metadata,channel_id:randomUUID()}};}
        return reply;
      };
      await assert.rejects(badChannel.dispatch(received.work.id),/INTAKE_503/);assert.equal(reached,true);
      const observed=(await env.admin.query(`SELECT j.state,j.attempt_generation,
        (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=j.id) AS outputs,
        (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) AS results
        FROM intake_trial.extraction_job j WHERE j.id=$1`,[received.work.id])).rows[0];
      assert.deepEqual(observed,{state:'uncertain',attempt_generation:1,outputs:0,results:0});
      const status=await request('/api/intake/receptions/'+received.reception_id,{client,headers:{accept:RECEPTION_V2_ACCEPT}});
      assert.equal(status.status,200,JSON.stringify(status.body));assert.equal(status.body.work.state,'uncertain');
      await assert.rejects(new ExtractionService(intake).dispatch(received.work.id),/INTAKE_409/);
      await assert.rejects(new ExtractionService(intake).retry(received.work.id,1),/INTAKE_409/,'Unknown closure cannot authorize another execution');
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.extraction_attempt WHERE job_id=$1',[received.work.id])).rows[0].n,1);
      assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,null);
      const stopped=await request(`/api/intake/receptions/${received.reception_id}/cancel`,{client,key:randomUUID(),headers:{accept:RECEPTION_V2_ACCEPT},
        body:{profile:'intake/1',expected_revision:received.revision}});
      assert.equal(stopped.status,200,JSON.stringify(stopped.body));assert.equal(stopped.body.work.state,'stopped');
      const ended=(await env.admin.query("SELECT observation FROM intake_trial.extraction_event WHERE job_id=$1 AND kind='termination'",[received.work.id])).rows;
      assert.equal(ended.length,1);assert.ok(ended[0].observation.reconciledFromPhase);
      observations.push({label:'foreign-channel-negative',jobId:received.work.id,fault:'replace-only-returned-channel-after-real-closed-worker',observed});
    });
    // Stopped outputs retain their reserve. Retry scenarios have their own
    // finite cluster; do not erase these obligations or enlarge the product cap.
    observations.push({label:'retained-service-capacity',
      capacity:(await env.admin.query('SELECT * FROM intake_trial.extraction_capacity')).rows,
      reservations:(await env.admin.query('SELECT * FROM intake_trial.extraction_reservation ORDER BY job_id,attempt_generation')).rows});
    await t.test('E05 removing processing preserves known effect lookup; removing query denies disclosure',async()=>{
      const count=async()=>(await env.admin.query('SELECT (SELECT count(*)::int FROM intake_trial.extraction_result) AS results,(SELECT count(*)::int FROM intake_trial.extraction_attempt) AS attempts')).rows[0];
      assert.deepEqual(await count(),{results:4,attempts:7});
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,false)",['b'.repeat(64)]);
      const known=await request('/api/intake/extractions/'+jobId,{client});
      assert.equal(known.status,200,JSON.stringify(known.body));assert.equal(known.body.result.id,accepted.resultId);
      assert.deepEqual(await count(),{results:4,attempts:7});
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true,revision=revision+1 WHERE account_id=$1 AND permission_id='intake_extraction_read'",[controlled.account.id]);
      const denied=await request('/api/intake/extractions/'+jobId,{client}),absent=await request('/api/intake/extractions/'+randomUUID(),{client});
      assert.deepEqual({status:denied.status,body:denied.body,headers:denied.headers},{status:404,body:absent.body,headers:absent.headers});
      assert.equal(absent.status,404);assert.deepEqual(await count(),{results:4,attempts:7});
    });
  }finally{
    writeFileSync('/work/output/extraction-journey.json',JSON.stringify({profile:'intake-extraction-journey/1',
      original:{bytes:original.length,sha256:expectedHash},account:controlled.account.id,jobId,dispatch,accepted,observations,
      limitations:['First text path; complete recovery, generation, stop-only and temporal obligations remain open.']},null,2));
  }
}
