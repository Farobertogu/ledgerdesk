import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {PrivateExtractionPort} from '../../../src/server/intake/extraction_ports.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';

export async function extractionStorageRecoveryCases(t,{env,intake,client,request}){
  await extractionControl(env);
  const service=new ExtractionService(intake),observations=[];
  const original=Buffer.from('AZ-17\nUnder condition Z, receipt R replaces receipt Q.\n');
  const reference={bytes:original.length,sha256:createHash('sha256').update(original).digest('hex'),text:original.toString()};
  writeFileSync('/work/output/storage-recovery-reference.json',JSON.stringify(reference,null,2),{flag:'wx'});
  const receipt=await receivedOriginal(request,client,original,{name:'storage-restart.txt'}),jobId=receipt.work.id;
  let accepted,channel,rawReference,normalReference;
  const state=async()=>(await env.admin.query(`SELECT j.state,j.accepted_result,j.attempt_generation,
    (SELECT count(*)::int FROM intake_trial.extraction_attempt WHERE job_id=j.id) attempts,
    (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=j.id) outputs,
    (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) results FROM intake_trial.extraction_job j WHERE id=$1`,[jobId])).rows[0];
  const events=async participant=>(await administration('observe-extraction',{participant})).events;
  try{
    await t.test('STORE01 real receipt and worker fix independent original and predetermined seal identities',async()=>{
      const dispatched=await service.dispatch(jobId);channel=dispatched.binding.channel_id;
      assert.equal(dispatched.binding.original.sha256,reference.sha256);
      assert.ok(dispatched.metadata.observations.some(e=>e.kind==='closed'&&e.id===dispatched.metadata.container_id));
      rawReference=dispatched.metadata.raw;
      normalReference=(await env.admin.query('SELECT normalized_id FROM intake_trial.extraction_attempt WHERE job_id=$1',[jobId])).rows[0].normalized_id;
      assert.deepEqual(await state(),{state:'running',accepted_result:null,attempt_generation:1,attempts:1,outputs:0,results:0});
    });
    if(!channel)throw Error('STORAGE_DISPATCH_PRECONDITION');
    await t.test('STORE02 actual child death after raw durability leaves no published bundle or SQL result',async()=>{
      assert.equal((await administration('arm-extraction-seal-fault',{channel})).ok,true);
      await assert.rejects(service.accept(jobId),/INTAKE_503/);
      const physical=await administration('inspect-extraction-seal',{channel}),closed=(await events('outputs'))
        .filter(e=>e.kind==='private-worker-closed'&&e.subject?.channel_id===channel);
      assert.deepEqual({state:await state(),raw:physical.files['raw.bin'],normal:physical.files['normalized.bin'],manifest:physical.files['manifest.json'],
        signals:closed.map(e=>e.termination.signal)},
        {state:{state:'running',accepted_result:null,attempt_generation:1,attempts:1,outputs:0,results:0},
          raw:{bytes:rawReference.bytes,sha256:rawReference.sha256},normal:null,manifest:null,signals:['SIGKILL']});
      assert.ok(physical.files['seal-intent.json']);assert.equal(physical.used.channel,channel);
      const obligation=(await env.admin.query('SELECT state,charged_bytes::int FROM intake_trial.extraction_reservation WHERE job_id=$1',[jobId])).rows;
      assert.deepEqual(obligation,[{state:'reserved',charged_bytes:EXTRACTION_BOUNDS.conservedBytes}]);
      assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,null);
      const visible=await request('/api/intake/extractions/'+jobId,{client});
      assert.deepEqual({status:visible.status,result:visible.body.result},{status:200,result:null});
      observations.push({point:'interrupted-seal',physical,closed,obligation});
    });
    await t.test('STORE03 fresh acceptance completes only that seal, without redispatch or overwriting its original raw bytes',async()=>{
      const before=await events('extraction');accepted=await new ExtractionService(intake).accept(jobId);
      assert.deepEqual((await events('extraction')).slice(0,before.length),before,
        'Retained parser observations remain append-only');
      assert.equal((await events('extraction')).filter(e=>e.kind==='queued').length,1);
      const output=(await env.admin.query('SELECT raw_sha256,normalized_id FROM intake_trial.extraction_output WHERE job_id=$1',[jobId])).rows[0];
      assert.deepEqual(output,{raw_sha256:rawReference.sha256,normalized_id:normalReference});
      const viewed=await request('/api/intake/extractions/'+jobId,{client});assert.equal(viewed.status,200,JSON.stringify(viewed.body));
      assert.equal(viewed.body.result.content.elements.map(e=>e.text).join(''),reference.text);
      assert.deepEqual(await state(),{state:'accepted',accepted_result:viewed.body.result.id,attempt_generation:1,attempts:1,outputs:1,results:1});
      const physical=await administration('inspect-extraction-seal',{channel});
      assert.deepEqual(physical.files['raw.bin'],{bytes:rawReference.bytes,sha256:rawReference.sha256});
      assert.ok(physical.files['normalized.bin']);assert.ok(physical.files['manifest.json']);
      const obligation=(await env.admin.query('SELECT state,charged_bytes::int FROM intake_trial.extraction_reservation WHERE job_id=$1',[jobId])).rows;
      assert.deepEqual(obligation,[{state:'durable',charged_bytes:physical.files['raw.bin'].bytes+physical.files['normalized.bin'].bytes}]);
      accepted=viewed.body;observations.push({point:'reconciled-seal',physical,resultId:accepted.result.id,effectId:accepted.result.effect.id});
    });
    if(!accepted?.result)throw Error('STORAGE_ACCEPT_PRECONDITION');
    for(const participant of ['extraction','outputs'])await t.test('STORE04 closed '+participant+' replacement preserves tombstones and existing content',async()=>{
      const before=await state(),physicalBefore=await administration('inspect-extraction-seal',{channel});
      const replaced=await administration('replace-closed-extraction-participant',{participant});
      assert.equal(replaced.ok,true);assert.notEqual(replaced.oldContainerId,replaced.newContainerId);
      assert.deepEqual({running:replaced.ended.Running,pid:replaced.ended.Pid,restarting:replaced.ended.Restarting},{running:false,pid:0,restarting:false});
      const row=Object.values(replaced.retained.rows).find(r=>r.binding);assert.ok(row);assert.equal(row.state,'closed');
      const beforeEvents=await events(participant);
      await assert.rejects(new PrivateExtractionPort(participant).openPhase(JSON.parse(row.binding)),/^Error: EXTRACTION_PHASE_OPEN$/);
      const afterEvents=await events(participant);
      assert.deepEqual(afterEvents.filter(e=>e.kind!=='refused'),beforeEvents.filter(e=>e.kind!=='refused'),
        'Delayed OPEN must not produce a read, seal or dispatch');
      assert.equal(afterEvents.at(-1).code,'PHASE_CLOSED');
      const viewed=await request('/api/intake/extractions/'+jobId,{client});
      assert.deepEqual({status:viewed.status,body:viewed.body,state:await state()},{status:200,body:accepted,state:before});
      const physicalAfter=await administration('inspect-extraction-seal',{channel});
      assert.deepEqual(physicalAfter.files,physicalBefore.files);observations.push({point:'participant-replacement',replaced});
    });
  }finally{
    writeFileSync('/work/output/extraction-storage-recovery.json',JSON.stringify({reference,jobId,observations,
      limitations:['A closed private participant was replaced, not an unresolved running parser or lost host controller.',
        'The half-seal process fault exists only in the identified disposable source copy.',
        'Writer-free expiry remains an observed unresolved limitation.']},null,2),{flag:'wx'});
  }
}
