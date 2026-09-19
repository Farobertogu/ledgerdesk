import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl,processingTreatment} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';

export async function extractionAuthorityMatrix(t,{env,intake,client,request,boundary}){
  assert.ok(['original','result','effect'].includes(boundary));
  await extractionControl(env);const observations=[];
  const ordinary=new ExtractionService(intake);
  const counters=async r=>{
    const events={};for(const p of ['objects','extraction'])events[p]=(await administration('observe-extraction',{participant:p})).events;
    return{original:events.objects.filter(e=>e.kind==='read'&&e.artifactId===r.original.id).length,
      raw:events.extraction.filter(e=>e.kind==='protected-raw-read'&&e.subject?.job_id===r.work.id).length,
      launches:(await env.admin.query("SELECT count(*)::int n FROM intake_trial.extraction_event WHERE job_id=$1 AND kind='launch'",[r.work.id])).rows[0].n,
      results:(await env.admin.query('SELECT count(*)::int n FROM intake_trial.extraction_result WHERE job_id=$1',[r.work.id])).rows[0].n};
  };
  async function withdraw(kind,boundary){
    if(kind==='treatment'){
      const id='without-body-'+randomUUID(),field=boundary==='original'?'original-body':'extraction-body';
      await env.admin.query(`INSERT INTO intake_control.treatment SELECT $1,1,$2,scope_ref,purpose_ref,array_remove(fields,$3),actions,
        receiver,storage,processor,response_destination,disposition_ref,expires_at FROM intake_control.treatment WHERE id=$4`,
        [id,'c'.repeat(64),field,processingTreatment.id]);
      await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[id]);
      return()=>env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[processingTreatment.id]);
    }
    if(kind==='assignment'&&boundary==='original'){
      // The assignment is declared by this exact controlled tuple. There is no
      // independent assignment-enabled flag in this contract. Remove that tuple,
      // not the whole service or the executor's separate faculty.
      const rows=(await env.admin.query("DELETE FROM intake_control.processing_current WHERE id='text-extraction-1' RETURNING *")).rows;
      assert.equal(rows.length,1);
      return()=>env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
    }
    if(kind==='assignment'||kind==='plan'){
      const id=kind+'-replacement-'+randomUUID(),ref={id,revision:1,sha256:'d'.repeat(64)};
      await env.admin.query(`INSERT INTO intake_control.processing_declaration SELECT $1,1,$2,format,configuration,limits,
        request,${kind==='plan'?'$3::jsonb':'plan'},${kind==='assignment'?'$3::jsonb':'assignment'},worker,executor_account,executor_reference,
        scope_ref,purpose_ref,session_dependency,image,expires_at FROM intake_control.processing_declaration WHERE id='text-extraction-1'`,
        [id,'d'.repeat(64),ref]);
      await env.admin.query("SELECT intake_control.set_processing('text-utf8/1',$1,1,$2,true)",[id,'d'.repeat(64)]);
      return()=>env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
    }
    if(kind==='support'){
      await env.admin.query("SELECT access_trial.set_support('domain',false,'synthetic extraction support withdrawal')");
      return()=>env.admin.query("SELECT access_trial.set_support('domain',true,'synthetic extraction support restored')");
    }
    const rows=(await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE permission_id='intake_processing' AND faculty='exercise' RETURNING id")).rows;
    assert.equal(rows.length,1);
    return()=>env.admin.query('UPDATE access_trial.grant_record SET withdrawn=false WHERE id=$1',[rows[0].id]);
  }
  try{
    for(const kind of ['treatment','assignment','plan','support','faculty']){
      t.signal.throwIfAborted();
      await t.test('AUTH '+kind+' withdrawal before '+boundary+' retains history without the protected action',async()=>{
        const r=await receivedOriginal(request,client,Buffer.from('Current authority: '+kind+' at '+boundary+'.\n'));
        if(boundary!=='original')await ordinary.dispatch(r.work.id);
        if(boundary==='effect'){
          const staged=new ExtractionService(intake,{barrier:async label=>{if(label==='after_extraction_stage_commit')throw Error('AUTH_STAGED_BOUNDARY');}});
          await assert.rejects(staged.accept(r.work.id),/AUTH_STAGED_BOUNDARY/);
        }
        const before=await counters(r),history=(await env.admin.query('SELECT * FROM intake_trial.extraction_attempt WHERE job_id=$1',[r.work.id])).rows;
        const restore=await withdraw(kind,boundary);
        try{
          await assert.rejects(boundary==='original'?ordinary.dispatch(r.work.id):ordinary.accept(r.work.id),/INTAKE_404/);
          const after=await counters(r);
          assert.deepEqual({counters:after,attempts:(await env.admin.query('SELECT * FROM intake_trial.extraction_attempt WHERE job_id=$1',[r.work.id])).rows},
            {counters:before,attempts:history});
          observations.push({kind,boundary,job:r.work.id,before,after,denied:404});
        }finally{await restore();}
        if(boundary==='original')await ordinary.dispatch(r.work.id);
        const effect=await ordinary.accept(r.work.id),q=await request('/api/intake/extractions/'+r.work.id,{client});
        assert.deepEqual({status:q.status,id:q.body.result?.id,text:q.body.result?.content.elements.map(e=>e.text).join('')},
          {status:200,id:effect.resultId,text:'Current authority: '+kind+' at '+boundary+'.\n'});
      });
    }
  }finally{writeFileSync('/work/output/extraction-authority-matrix.json',JSON.stringify({boundary,observations,
    scope:'Actual current treatment field, exact declared assignment, processing plan, live support and independent processing faculty. Assignment removal before first dispatch removes its controlling tuple; replacement after dispatch is compared to the retained assignment. Not writer-free temporal conformity.'},null,2),{flag:'wx'});}
}
