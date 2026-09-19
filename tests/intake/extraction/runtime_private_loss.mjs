import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {PrivateExtractionPort} from '../../../src/server/intake/extraction_ports.ts';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {startExtractionProcess} from './service_process.mjs';
import {administration} from '../t02/recovery_cases.mjs';

export async function extractionPrivateLossCases(t,{env,intake,client,request}){
  await extractionControl(env);const observations=[];let process,paused,target,replaced;
  const service=new ExtractionService(intake);
  const state=async()=>(await env.admin.query(`SELECT j.state,j.attempt_generation,j.accepted_result,
    (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=j.id) AS outputs,
    (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) AS results,
    (SELECT charged_bytes::int FROM intake_trial.extraction_reservation WHERE job_id=j.id AND attempt_generation=j.attempt_generation) AS charged,
    (SELECT active_phase FROM intake_control.fence_head) AS active_phase FROM intake_trial.extraction_job j WHERE id=$1`,[target])).rows[0];
  try{
    await t.test('LOSS01 the same implementation first produces a useful accepted result',async()=>{
      const bytes=Buffer.from('Private replacement control remains useful.\n'),r=await receivedOriginal(request,client,bytes);
      const d=await service.dispatch(r.work.id);assert.ok(d.metadata.observations.some(e=>e.kind==='closed'));
      await service.accept(r.work.id);const q=await request('/api/intake/extractions/'+r.work.id,{client});
      assert.equal(q.status,200);assert.equal(q.body.result.content.elements.map(e=>e.text).join(''),bytes.toString());
    });
    await t.test('LOSS02 real replacement preserves an unresolved output phase, not a closed journal',async()=>{
      const r=await receivedOriginal(request,client,Buffer.from('An open sealing phase cannot be inherited.\n'));target=r.work.id;
      const d=await service.dispatch(target);assert.ok(d.metadata.observations.some(e=>e.kind==='closed'));
      process=await startExtractionProcess(intake);paused=await process.invoke('accept',target,'before_extraction_output_seal');
      assert.equal(paused.kind,'paused');
      const phase=(await env.admin.query('SELECT p.* FROM intake_control.private_phase p JOIN intake_control.fence_head f ON f.active_phase=p.id')).rows[0];
      assert.ok(phase);assert.deepEqual(phase.participant_plan,{extraction:['read'],outputs:['seal']});
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_control.phase_completion WHERE phase_id=$1',[phase.id])).rows[0].n,0);
      replaced=await administration('replace-unresolved-extraction-participant',{participant:'outputs'});
      assert.equal(replaced.ok,true);assert.notEqual(replaced.oldContainerId,replaced.newContainerId);
      assert.deepEqual({running:replaced.ended.Running,pid:replaced.ended.Pid,restarting:replaced.ended.Restarting},{running:false,pid:0,restarting:false});
      const retained=replaced.retained.rows[phase.id];assert.ok(retained);assert.notEqual(retained.state,'closed');
      assert.equal(JSON.parse(retained.binding).id,phase.id);
      const port=new PrivateExtractionPort('outputs');
      await assert.rejects(port.openPhase(JSON.parse(retained.binding)),/EXTRACTION_PHASE_OPEN/);
      await assert.rejects(new PrivateExtractionPort('outputs').openPhase({...JSON.parse(retained.binding),id:randomUUID()}),/EXTRACTION_PHASE_OPEN/);
      await assert.rejects(new PrivateExtractionPort('outputs').closePhase(phase.id),/EXTRACTION_PHASE_UNCLOSED/);
      const events=(await administration('observe-extraction',{participant:'outputs'})).events;
      assert.equal(events.filter(e=>e.phaseId===phase.id&&e.kind==='sealed').length,0);
      assert.ok(events.filter(e=>e.phaseId===phase.id&&e.code==='PHASE_RECOVERY_REQUIRED').length>=2);
      assert.deepEqual(await state(),{state:'running',attempt_generation:1,accepted_result:null,outputs:0,results:0,
        charged:EXTRACTION_BOUNDS.conservedBytes,active_phase:phase.id});
      observations.push({point:'replacement-with-unresolved-phase',phaseId:phase.id,replaced,observed:await state(),events});
    });
    await t.test('LOSS03 a new service cannot turn the unresolved predecessor into another attempt or accepted effect',async()=>{
      assert.ok(process&&replaced);const ended=await process.terminate();assert.equal(ended.signal,'SIGKILL');
      const before=await state(),fresh=new ExtractionService(intake);
      await assert.rejects(fresh.dispatch(target),/INTAKE_(409|503)/);
      await assert.rejects(fresh.retry(target,1),/INTAKE_(409|503)/);
      await assert.rejects(fresh.accept(target),{code:'55P03',message:'Private phase unresolved'});
      assert.deepEqual(await state(),before);
      observations.push({point:'fail-closed-replacement',serviceClosed:ended,observed:before});
    });
  }finally{
    await process?.terminate();
    writeFileSync('/work/output/extraction-private-loss.json',JSON.stringify({observations,
      scope:'Real output participant replacement during an unresolved admitted seal phase. The prior analyzer had closed; no running-analyzer death is claimed.',
      outcome:'No automatic recovery, inherited authority or successful stop is inferred from replacement reachability.'},null,2),{flag:'wx'});
  }
}
