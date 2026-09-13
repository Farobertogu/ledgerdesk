import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from 'pg';
import {PrivateIntakePort} from '../../../src/server/intake/ports.ts';
import {administration} from './recovery_cases.mjs';
import {treatment} from './fixtures.mjs';

async function until(read,accept,label,ms=3000){
  const end=Date.now()+ms;let value;
  do{value=await read();if(accept(value))return value;await delay(10);}while(Date.now()<end);
  assert.fail(label+': '+JSON.stringify(value));
}

/** Real private append under explicit missing-stop injection; not a normal-latency claim. */
export async function fenceLossCase(t,{env,intake,client,request,application,retained,reserve,paused,declare,text}){
  const kind=process.env.LEDGERDESK_INTAKE_FENCE_LOSS;
  await t.test(`F03/F${kind==='sql'?'04':'05'} ${kind} loss leaves a durable barrier until actual worker and runtime closure`,async()=>{
    const previous=await reserve(declare(text)),partial=await paused(previous,text);
    try{partial.destroy();}finally{partial.release();}
    await partial.response;
    await until(async()=> (await env.admin.query('SELECT state FROM intake_trial.reception WHERE id=$1',[previous.reception_id])).rows[0]?.state,
      state=>state==='interrupted','RESTART_INTERRUPTED_PREDECESSOR');
    const r=await reserve(declare(text)),transfer=await paused(r,text),observations={kind,receptionId:r.reception_id,original:r.original};
    let controller;
    try{
      assert.equal((await env.admin.query('SELECT actual_bytes FROM intake_trial.attempt WHERE reception_id=$1',[r.reception_id])).rows[0].actual_bytes,41);
      assert.equal((await administration('arm-stall',{artifactId:r.original.id,generation:1,offset:41})).ok,true);
      transfer.end();transfer.release();
      const p=await until(async()=> (await env.admin.query(`SELECT p.* FROM intake_control.fence_head h JOIN intake_control.private_phase p ON p.id=h.active_phase WHERE p.reception_id=$1`,[r.reception_id])).rows[0],Boolean,'PRIVATE_PHASE_NOT_REGISTERED');
      observations.phase=p;
      const alive=await administration('observe-stalled-worker',{phaseId:p.id});
      assert.equal(alive.ok,true);assert.ok(alive.before);assert.equal(alive.closure,null);
      observations.childBeforeLoss=alive;
      const backend=await env.admin.query('SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1',[p.backend_pid]);
      assert.equal(backend.rowCount,1,'LOSS_MUST_TARGET_A_LIVE_ADMITTED_SQL_SESSION');
      observations.backendBeforeLoss=backend.rows[0];
      if(kind==='sql'){
        assert.equal((await env.admin.query('SELECT pg_terminate_backend($1,1000) AS ended',[p.backend_pid])).rows[0].ended,true);
      }else if(kind==='runtime'){
        observations.runtimeClosed=await application.crash();
        assert.equal(observations.runtimeClosed.signal,'SIGKILL');
      }else{
        observations.supervisorClosed=await administration('fence-private-process-set',{phaseId:p.id});
        assert.deepEqual({running:observations.supervisorClosed.after.Running,pid:observations.supervisorClosed.after.Pid,
          status:observations.supervisorClosed.after.Status},{running:false,pid:0,status:'exited'});
        observations.runtimeClosed=await application.crash();assert.equal(observations.runtimeClosed.signal,'SIGKILL');
      }
      await until(async()=> (await env.admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[p.backend_pid])).rows[0].n,n=>n===0,'OLD_SQL_BACKEND_REMAINS');
      const locks=(await env.admin.query('SELECT * FROM pg_locks WHERE pid=$1',[p.backend_pid])).rows;assert.equal(locks.length,0);
      const head=(await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0];assert.equal(head.active_phase,p.id);
      if(kind!=='supervisor'){
        const liveAfterLoss=await administration('observe-stalled-worker',{phaseId:p.id});assert.ok(liveAfterLoss.before);assert.equal(liveAfterLoss.closure,null);
        observations.afterLoss={locks,head,child:liveAfterLoss};
      }else observations.afterLoss={locks,head,processSet:observations.supervisorClosed};
      const started=Date.now();let sqlState=null;
      try{await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]);}catch(error){sqlState=error.code;}
      const treatmentAfter=(await env.admin.query('SELECT enabled FROM intake_control.treatment_current')).rows[0];
      assert.deepEqual({sqlState,enabled:treatmentAfter.enabled},{sqlState:'55P03',enabled:true});
      assert.ok(Date.now()-started<1500);observations.writerRefused={sqlState,enabled:treatmentAfter.enabled,milliseconds:Date.now()-started};
      // SQL and HTTP loss are not quiescence. The external owner verifies the
      // selected worker identity and observes its actual disappearance and close.
      if(kind!=='supervisor'){
        const childClosed=await administration('terminate-stalled-worker',{phaseId:p.id});
        assert.equal(childClosed.after,null);assert.equal(childClosed.closure.signal,'SIGKILL');
        observations.childClosed=childClosed;
      }else{
        observations.participantRecovery=await administration('recover-private-participant',{phaseId:p.id,incarnation:p.incarnation,
          evidenceId:p.evidence_id,originalId:p.artifact_id,generation:p.generation,runtimeProcess:{observed:'closed',...observations.runtimeClosed}});
        assert.equal(observations.participantRecovery.oldContainerRemoved,observations.supervisorClosed.containerRef);
        assert.notEqual(observations.participantRecovery.newContainer,observations.participantRecovery.oldContainerRemoved);
      }
      if(!observations.runtimeClosed)observations.runtimeClosed=await application.crash();
      assert.equal(observations.runtimeClosed.signal,'SIGKILL');
      await until(async()=> (await env.admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[p.backend_pid])).rows[0].n,n=>n===0,'RECOVERY_SQL_PREDECESSOR');
      const participants={};
      for(const participant of Object.keys(p.participant_plan)){
        const socket=participant==='objects'?intake.brokerSocket:intake.verifierSocket;
        const port=new PrivateIntakePort(socket,1500000,1000,intake.namespace);
        participants[participant]=await port.closePhase(p.id);
        await assert.rejects(()=>port.openPhase({id:p.id,incarnation:p.incarnation,namespace:p.namespace,original:r.original,
          evidenceId:p.evidence_id,participant,actions:p.participant_plan[participant]}),/INTAKE_PHASE_OPEN/);
        const late=await port.call({phaseId:p.id,action:'append',original:r.original,incarnation:p.incarnation,evidenceId:p.evidence_id,
          offset:41,data:text.subarray(41).toString('base64')});
        assert.deepEqual({ok:late.ok,outcome:late.outcome,bytes:late.bytes},{ok:false,outcome:'denied',bytes:0});
      }
      const closure={profile:'intake-controller-closure/1',phaseId:p.id,backendPid:p.backend_pid,mode:'runtime-ended-participants-closed',
        runtimeProcess:{observed:'closed',...observations.runtimeClosed},participants};
      const password=randomBytes(24).toString('hex');
      await env.admin.query(`ALTER ROLE inc03_intake_control LOGIN PASSWORD '${password}'`);
      controller=new Client({connectionString:`postgresql://inc03_intake_control:${password}@127.0.0.1:55432/inc02_synthetic`,
        statement_timeout:2000,lock_timeout:250});await controller.connect();
      assert.equal((await controller.query('SELECT session_user AS role')).rows[0].role,'inc03_intake_control');
      await assert.rejects(()=>controller.query('SELECT intake_control.reconcile_phase($1,$2,$3,$4)',
        [randomUUID(),p.source_id,p.incarnation,JSON.stringify(closure)]),error=>error.code==='42501');
      await controller.query('SELECT intake_control.reconcile_phase($1,$2,$3,$4)',[p.id,p.source_id,p.incarnation,JSON.stringify(closure)]);
      observations.reconciled=(await env.admin.query('SELECT * FROM intake_control.phase_completion WHERE phase_id=$1',[p.id])).rows[0];
      assert.equal(observations.reconciled.kind,'controller_reconciled');assert.equal(observations.reconciled.connection_role,'inc03_intake_control');
      await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]);
      assert.equal((await env.admin.query('SELECT enabled FROM intake_control.treatment_current')).rows[0].enabled,false);
      const stored=await administration('inspect',{}),physical=stored.objects.find(x=>x.name===r.original.id+'-1.stage');
      assert.equal(physical.bytes,41);observations.physicalAfterRecovery=physical;
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.receipt WHERE reception_id=$1',[r.reception_id])).rows[0].n,0);
      // New work uses a new controlled incarnation. The stranded reception is
      // not resumed or reclassified merely because its phase was retired.
      const next={...intake,incarnation:'intake-runtime-recovered-2'};
      await env.admin.query('UPDATE intake_control.live SET incarnation=$1,revision=revision+1 WHERE singleton',[next.incarnation]);
      await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);
      await application.restart(next);
      const preserved=await request(`/api/intake/receptions/${retained.receptionId}/original`,{client});
      assert.deepEqual({status:preserved.status,bytes:preserved.bytes},{status:200,bytes:retained.bytes});
      const current=await request(`/api/intake/receptions/${previous.reception_id}`,{client});assert.equal(current.status,200);
      const resumed=await request(`/api/intake/receptions/${previous.reception_id}/resume`,{body:{profile:'intake/1',expected_revision:current.body.revision,
        expected_generation:1,cause:'interrupted',original:previous.original},client,key:randomUUID()});
      assert.equal(resumed.status,202,JSON.stringify(resumed.body));
      const reloaded=await request(`/api/intake/receptions/${previous.reception_id}/attempts/2/original`,{bytes:text,client});
      assert.equal(reloaded.status,200,JSON.stringify(reloaded.body));
      observations.retainedContinuity={completedOriginalBytes:preserved.bytes.length,receptionId:previous.reception_id,
        attempts:(await env.admin.query('SELECT generation,incarnation,state,actual_bytes FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[previous.reception_id])).rows};
      assert.deepEqual(observations.retainedContinuity.attempts.map(a=>({generation:a.generation,state:a.state,bytes:a.actual_bytes})),
        [{generation:1,state:'fenced',bytes:41},{generation:2,state:'sealed',bytes:text.length}]);
      const fresh=await reserve(declare(text)),staged=await request(`/api/intake/receptions/${fresh.reception_id}/attempts/1/original`,{bytes:text,client});
      assert.equal(staged.status,200,JSON.stringify(staged.body));assert.equal(staged.body.state,'staged');
      observations.progress={incarnation:next.incarnation,receptionId:fresh.reception_id,state:staged.body.state};
    }finally{
      transfer.release();transfer.destroy();await controller?.end();
      writeFileSync('/work/output/fence-loss-'+kind+'.json',JSON.stringify(observations,null,2),{flag:'wx'});
    }
  });
}
