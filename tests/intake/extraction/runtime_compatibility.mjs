import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {RECEPTION_V2_ACCEPT} from '../../../src/contracts/intake_extraction.ts';
import {treatment} from '../t02/fixtures.mjs';
import {extractionControl} from './runtime_control.mjs';

export async function extractionCompatibilityCases(t,{env,intake,client,request,setBarrier}){
  const observations=[],bytes=Buffer.from('A populated historical intention remains the same operation.\n');
  const declaration={profile:'intake/1',original:{name:'historical.txt',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),declared_media_type:'text/plain'},
    format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  // Produce the actual old intention before installing the additive extraction tables.
  assert.equal((await env.admin.query("SELECT to_regclass('intake_trial.extraction_job') AS table_name")).rows[0].table_name,null);
  const reserved=await request('/api/intake/receptions',{client,body:declaration,key:randomUUID()});assert.equal(reserved.status,202);
  const uploaded=await request(`/api/intake/receptions/${reserved.body.reception_id}/attempts/1/original`,{client,bytes});assert.equal(uploaded.status,200);
  const path=`/api/intake/receptions/${reserved.body.reception_id}/finalize`,key=randomUUID(),body={profile:'intake/1',expected_revision:uploaded.body.revision,
    original:uploaded.body.original,format_profile:'text-utf8/1'};
  const receipt=await request(path,{client,key,body});assert.equal(receipt.status,200);assert.equal(receipt.body.representation,'intake-reception/1');
  const history=(await env.admin.query('SELECT * FROM intake_trial.intention ORDER BY id')).rows;
  const retainedWork=(await env.admin.query('SELECT * FROM intake_trial.work WHERE id=$1',[receipt.body.work.id])).rows[0];
  const counts=async()=>(await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_trial.receipt) receipts,
    (SELECT count(*)::int FROM intake_trial.work) jobs,(SELECT count(*)::int FROM intake_trial.intention) intentions`)).rows[0];
  const before=await counts();let pending;
  try{
    await extractionControl(env);
    // Explicitly admit the historical fixed request/plan. Do not rewrite its
    // receipt, intention or work to the current profile's newer references.
    await env.admin.query(`INSERT INTO intake_control.processing_declaration SELECT 'historical-plan-realization',1,$1,format,configuration,limits,
      $2,$3,assignment,worker,executor_account,executor_reference,scope_ref,purpose_ref,session_dependency,image,expires_at
      FROM intake_control.processing_declaration WHERE id='text-extraction-1'`,['d'.repeat(64),retainedWork.request,retainedWork.plan]);
    await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','historical-plan-realization',1,$1,true)",['d'.repeat(64)]);
    await t.test('COMP01 populated v1 intention is recovered through v2 without repeating its effect',async()=>{
      const q=await request(path,{client,key,body,headers:{accept:RECEPTION_V2_ACCEPT}});
      assert.deepEqual({status:q.status,representation:q.body.representation,effect:q.body.effect,counts:await counts()},
        {status:200,representation:'intake-reception/2',effect:receipt.body.effect,counts:before});
      assert.deepEqual((await env.admin.query('SELECT * FROM intake_trial.intention ORDER BY id')).rows,history);
      observations.push({case:'COMP01',old:receipt.body,current:q.body,counts:before,retainedWork});
    });
    await t.test('COMP02 actual promotion waits for the prior response handoff, then v2 exposes it once',async()=>{
      let reached=false,blocked=false;
      setBarrier(async(label,event)=>{
        if(label!=='before_handoff'||event.route!=='finalize_reception'||reached)return;
        reached=true;
        pending=new ExtractionService(intake).dispatch(receipt.body.work.id).then(value=>({value}),error=>({error}));
        const until=Date.now()+2000;
        while(Date.now()<until){
          const rows=(await env.admin.query("SELECT pid,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE usename='inc03_intake_runtime' AND wait_event_type='Lock'")).rows;
          if(rows.some(r=>r.blockers.includes(event.backendPid))){blocked=true;break;}await delay(10);
        }
        assert.equal(blocked,true,'Promotion must contend with the actual response admission, not a test mutex');
        assert.equal((await env.admin.query('SELECT count(*)::int n FROM intake_trial.extraction_job')).rows[0].n,0);
      });
      let old;
      try{old=await request(path,{client,key,body});}finally{setBarrier(async()=>{});}
      assert.equal(reached,true);assert.equal(old.status,200);assert.equal(old.body.representation,'intake-reception/1');
      const dispatched=await pending;if(dispatched.error)throw dispatched.error;
      assert.equal(dispatched.value.metadata.reason,null);
      const effect=await new ExtractionService(intake).accept(receipt.body.work.id);
      const obsolete=await request(path,{client,key,body});assert.equal(obsolete.status,409);assert.equal(obsolete.body.code,'representation_conflict');
      const current=await request(path,{client,key,body,headers:{accept:RECEPTION_V2_ACCEPT}});
      const content=await request('/api/intake/extractions/'+receipt.body.work.id,{client});
      assert.deepEqual({status:current.status,effect:current.body.effect,state:current.body.work.state,counts:await counts(),result:content.body.result.id},
        {status:200,effect:receipt.body.effect,state:'accepted',counts:before,result:effect.resultId});
      assert.equal(content.body.result.content.elements.map(e=>e.text).join(''),bytes.toString());
      assert.deepEqual((await env.admin.query('SELECT * FROM intake_trial.intention ORDER BY id')).rows,history);
      observations.push({case:'COMP02',blocked,old:old.body,current:current.body,extractionEffect:effect,counts:await counts()});
    });
  }finally{setBarrier(async()=>{});await pending;writeFileSync('/work/output/extraction-compatibility.json',JSON.stringify({observations,
    scope:'Populated HTTPS-produced v1 history and real SQL/admission contention. The historical processing plan is explicitly realized; historical facts are not migrated into new intentions.'},null,2),{flag:'wx'});}
}
