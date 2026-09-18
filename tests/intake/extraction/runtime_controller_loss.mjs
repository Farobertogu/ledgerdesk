import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';

export async function extractionControllerLossCases(t,{env,intake,client,request}){
  await extractionControl(env);const service=new ExtractionService(intake),observations=[];let target;
  const state=async()=>(await env.admin.query(`SELECT j.state,j.attempt_generation,j.accepted_result,
    (SELECT count(*)::int FROM intake_trial.extraction_attempt WHERE job_id=j.id) AS attempts,
    (SELECT count(*)::int FROM intake_trial.extraction_event WHERE job_id=j.id AND kind='launch') AS launches,
    (SELECT count(*)::int FROM intake_trial.extraction_event WHERE job_id=j.id AND kind='termination') AS terminations,
    (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) AS results,
    (SELECT charged_bytes::int FROM intake_trial.extraction_reservation WHERE job_id=j.id) AS charged
    FROM intake_trial.extraction_job j WHERE id=$1`,[target])).rows[0];
  try{
    await t.test('HOST01 a useful completed predecessor uses the real unchanged launcher',async()=>{
      const bytes=Buffer.from('A closed controller can return a usable extraction.\n'),r=await receivedOriginal(request,client,bytes);
      await service.dispatch(r.work.id);await service.accept(r.work.id);
      const q=await request('/api/intake/extractions/'+r.work.id,{client});assert.equal(q.status,200);
      assert.equal(q.body.result.content.elements.map(e=>e.text).join(''),bytes.toString());
    });
    await t.test('HOST02 actual post-launch controller death is retained as uncertain, not as a successful stop',async()=>{
      const r=await receivedOriginal(request,client,Buffer.from('This producer loses its host controller.\n'));target=r.work.id;
      assert.equal((await administration('lose-next-extraction-controller',{})).ok,true);
      await assert.rejects(service.dispatch(target),/INTAKE_503/);
      const row=await state();
      assert.deepEqual(row,{state:'uncertain',attempt_generation:1,accepted_result:null,attempts:1,launches:1,terminations:0,results:0,charged:EXTRACTION_BOUNDS.conservedBytes});
      const events=(await env.admin.query('SELECT kind,observation FROM intake_trial.extraction_event WHERE job_id=$1 ORDER BY recorded_at',[target])).rows;
      assert.ok(events.find(e=>e.kind==='launch')?.observation.containerId);
      assert.equal(events.filter(e=>e.kind==='uncertain').length,1);
      observations.push({point:'lost-host-controller',state:row,events});
    });
    await t.test('HOST03 fresh dispatch, retry and acceptance cannot invent a closed predecessor',async()=>{
      const before=await state(),fresh=new ExtractionService(intake);
      await assert.rejects(fresh.dispatch(target),/INTAKE_409/);
      await assert.rejects(fresh.retry(target,1),/INTAKE_409/);
      await assert.rejects(fresh.accept(target),/INTAKE_409/);
      assert.deepEqual(await state(),before);observations.push({point:'replacement-service-refusals',state:before});
    });
  }finally{writeFileSync('/work/output/extraction-controller-loss.json',JSON.stringify({observations,
    scope:'The actual separately spawned host controller is killed after the real analyzer reaches running. Host evidence records exact container identity and scoped cleanup.',
    limitation:'Fail-closed uncertainty, not automatic high availability or recovered output. Cleanup does not fabricate a service termination event.'},null,2),{flag:'wx'});}
}
