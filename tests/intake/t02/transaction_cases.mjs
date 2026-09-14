import assert from 'node:assert/strict';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {treatment} from './fixtures.mjs';
import {uiOrigin} from '../../access/journey_environment.mjs';
import {administration} from './recovery_cases.mjs';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
async function bounded(promise,label,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}

/** Real receipt transactions, not the earlier private-phase commit experiments. */
export async function transactionCases(t,{env,client,request,setBarrier}){
  const output='/work/output/transactions';mkdirSync(output,{recursive:true});const observations=[];
  const bytes=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');
  const declaration={profile:'intake/1',original:{name:'bom.txt',bytes:17,sha256:'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9',declared_media_type:'text/plain'},
    format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  writeFileSync(output+'/reference.json',JSON.stringify({declaration,expectedReceipts:1,expectedJobs:1,dispatchable:false,fixedAtMs:Date.now()},null,2),{flag:'wx'});
  const state=async id=>({receipt:(await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows,
    jobs:(await env.admin.query('SELECT w.* FROM intake_trial.work w JOIN intake_trial.receipt r ON r.id=w.receipt_id WHERE r.reception_id=$1',[id])).rows,
    attempts:(await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[id])).rows});
  const events=async id=>(await administration('observe-events',{})).events.filter(e=>e.origin==='object-boundary'&&e.artifactId===id);
  async function stage(generation=1){
    let r=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration});assert.equal(r.status,202);
    if(generation===2){r=await request(`/api/intake/receptions/${r.body.reception_id}/resume`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:r.body.revision,expected_generation:1,cause:'interrupted',original:r.body.original}});assert.equal(r.status,202);}
    const s=await request(`/api/intake/receptions/${r.body.reception_id}/attempts/${generation}/original`,{client,bytes});assert.equal(s.status,200);return s.body;
  }
  const command=s=>({profile:'intake/1',expected_revision:s.revision,original:s.original,format_profile:'text-utf8/1'});
  const finalize=(s,key=randomUUID(),body=command(s))=>request(`/api/intake/receptions/${s.reception_id}/finalize`,{client,key,body});
  const checkEffect=(rows)=>assert.deepEqual({receipts:rows.receipt.length,jobs:rows.jobs.length,dispatchable:rows.jobs[0]?.dispatchable},{receipts:1,jobs:1,dispatchable:false});
  const original=async s=>{const r=await request(`/api/intake/receptions/${s.reception_id}/original`,{client});assert.deepEqual({status:r.status,bytes:r.bytes},{status:200,bytes});};
  try{
    if(process.env.LEDGERDESK_INTAKE_RECEIPT_COMMIT==='1'){
      await t.test('an unread real receipt COMMIT reply reconciles its durable effect',async()=>{
        const positive=await stage();assert.equal((await finalize(positive)).status,200);await original(positive);
        const s=await stage(),key=randomUUID();let durable=null,commitResult=null;
        setBarrier(async(label,event)=>{
          if(event.receptionId!==s.reception_id)return;
          if(label==='receipt_commit_reply_held'){
            const deadline=Date.now()+4000;let rows;
            do{rows=await state(s.reception_id);if(rows.receipt.length===1)break;await delay(10);}while(Date.now()<deadline);
            checkEffect(rows);const sql=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows;
            const evidence=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows;
            assert.deepEqual(sql,[{state:'idle',xact_start:null}]);assert.equal(evidence.length,1);durable={event,rows,sql,evidence,atMs:Date.now()};
          }else if(label==='receipt_commit_reply_lost'){commitResult=event;assert.equal(event.commitResolved,false);}
        });
        writeFileSync('/work/output/receipt-commit-fault.json',JSON.stringify({receptionId:s.reception_id}),{flag:'wx'});
        let failed;try{failed=await finalize(s,key).catch(error=>({status:null,errorCode:error.code??null}));
          await bounded((async()=>{while(!commitResult)await delay(10);})(),'COMMIT_LOSS_NOT_OBSERVED');
        }finally{setBarrier(async()=>{});}
        assert.ok(durable);assert.ok(failed.status===null||failed.status===503);assert.equal(commitResult.commitResolved,false);
        const before=await events(s.original.id),reconciled=await finalize(s,key),after=await state(s.reception_id),journal=await events(s.original.id);
        observations.push({case:'receipt-sql-reply-loss',durable,commitResult,failedStatus:failed.status,reconciled:{status:reconciled.status,body:reconciled.body},after,before,journal});
        assert.equal(reconciled.status,200);assert.deepEqual(after.receipt,durable.rows.receipt);assert.deepEqual(after.jobs,durable.rows.jobs);assert.deepEqual(journal,before);await original(s);
      });return;
    }
    for(const sameKey of [true,false])await t.test('concurrent real finalization reconciles '+(sameKey?'one intention':'distinct keys'),async()=>{
      const s=await stage(),key=randomUUID(),startedAtMs=Date.now();
      const replies=await Promise.all([finalize(s,key),finalize(s,sameKey?key:randomUUID())]);
      const after=await state(s.reception_id);observations.push({case:'concurrent-finalization',sameKey,startedAtMs,replies:replies.map(r=>({status:r.status,body:r.body})),after});
      assert.deepEqual({statuses:replies.map(r=>r.status),receipts:after.receipt.length,jobs:after.jobs.length},{statuses:[200,200],receipts:1,jobs:1});
      assert.deepEqual(replies[0].body.effect,replies[1].body.effect);checkEffect(after);await original(s);
    });
    await t.test('finalization compares the exact original, generation and revision before a receipt',async()=>{
      const a=await stage(),b=await stage(2);const expected=command(a);const before=await state(a.reception_id);
      for(const [name,body]of [['other-existing-artifact',{...expected,original:b.original}],['wrong-generation',{...expected,original:{...a.original,generation:2}}],['old-revision',{...expected,expected_revision:a.revision-1}]]){
        const reply=await finalize(a,randomUUID(),body),after=await state(a.reception_id);observations.push({case:name,expected,other:b.original,status:reply.status,before,after});
        assert.deepEqual({status:reply.status,receipt:after.receipt,jobs:after.jobs},{status:409,receipt:[],jobs:[]});
      }
      assert.equal((await finalize(a)).status,200);assert.equal((await finalize(b)).status,200);await original(a);await original(b);
    });
    await t.test('failure before the business receipt commit rolls back its effect but retains the sealed original',async()=>{
      const s=await stage(),key=randomUUID();let fault=null;
      setBarrier(async(label,event)=>{if(label==='before_receipt_commit'&&event.receptionId===s.reception_id){fault={event,atMs:Date.now(),visible:await state(s.reception_id)};throw Error('EXPECTED_RECEIPT_PRECOMMIT_FAILURE');}});
      let reply;try{reply=await finalize(s,key);}finally{setBarrier(async()=>{});}
      const failed=await state(s.reception_id);observations.push({case:'receipt-precommit-failure',fault,status:reply.status,failed});
      assert.ok(fault);assert.deepEqual({status:reply.status,receipt:failed.receipt,jobs:failed.jobs,state:failed.attempts[0].state},{status:503,receipt:[],jobs:[],state:'sealed'});
      const before=await events(s.original.id),retry=await finalize(s,key),after=await state(s.reception_id),journal=await events(s.original.id);
      observations.push({case:'receipt-precommit-recovery',status:retry.status,after,before,journal});assert.equal(retry.status,200);checkEffect(after);
      assert.equal(journal.filter(e=>e.kind==='append'||e.kind==='seal').length,before.filter(e=>e.kind==='append'||e.kind==='seal').length);await original(s);
    });
    await t.test('a lost committed receipt is recovered under query authority without repeating its effect',async()=>{
      const s=await stage(),key=randomUUID(),body=Buffer.from(JSON.stringify(command(s))),reached=deferred(),release=deferred();let call,networkBytes=0,committed;
      const loss=new Promise(resolve=>{
        setBarrier(async(label,event)=>{if(label==='after_receipt_commit'&&event.receptionId===s.reception_id){committed={event,atMs:Date.now(),state:await state(s.reception_id)};reached.resolve();await bounded(release.promise,'RECEIPT_LOSS_RELEASE');}});
        call=https.request({host:'127.0.0.1',port:9443,servername:'api.inc02.test',ca:env.ca,path:`/api/intake/receptions/${s.reception_id}/finalize`,method:'POST',
          headers:{host:'api.inc02.test:9443',origin:uiOrigin,cookie:client.cookie,'x-ledgerdesk-csrf':client.csrf,'x-ledgerdesk-intent':key,'content-type':'application/json','content-length':String(body.length)}},reply=>{
          reply.on('data',chunk=>{networkBytes+=chunk.length;});reply.once('end',()=>resolve({status:reply.statusCode,networkBytes}));reply.once('error',()=>resolve({status:null,networkBytes}));});
        call.once('error',()=>resolve({status:null,networkBytes}));call.setTimeout(8000,()=>call.destroy());call.end(body);
      });
      try{await bounded(reached.promise,'RECEIPT_NOT_COMMITTED');checkEffect(committed.state);assert.equal(networkBytes,0);call.destroy();
        const lost=await bounded(loss,'RECEIPT_RESPONSE_NOT_LOST');assert.deepEqual(lost,{status:null,networkBytes:0});observations.push({case:'lost-receipt-response',committed,lost});
      }finally{release.resolve();call?.destroy();setBarrier(async()=>{});}
      // The writer follows the released delivery admission. It does not revoke query.
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE permission_id='intake_load' AND faculty='exercise'");
      try{
        const before=await events(s.original.id),retry=await finalize(s,key),after=await state(s.reception_id);
        observations.push({case:'known-without-load',status:retry.status,body:retry.body,after});assert.equal(retry.status,200);checkEffect(after);assert.deepEqual(after.receipt,committed.state.receipt);
        assert.deepEqual(await events(s.original.id),before);
        await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE permission_id='intake_records' AND faculty='exercise'");
        const denied=await finalize(s,key),hidden=await state(s.reception_id);observations.push({case:'known-without-query',status:denied.status,hidden});
        assert.deepEqual({status:denied.status,history:hidden.receipt},{status:404,history:committed.state.receipt});
      }finally{await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE permission_id IN ('intake_load','intake_records') AND faculty='exercise'");}
      await original(s);
    });
    await t.test('cancellation of staged work wins before finalization and cannot resurrect a receipt',async()=>{
      const s=await stage(),cancelled=await request(`/api/intake/receptions/${s.reception_id}/cancel`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:s.revision}});
      assert.equal(cancelled.status,200);const before=await events(s.original.id),reply=await finalize(s),after=await state(s.reception_id);
      observations.push({case:'staged-stop-first',status:reply.status,after});assert.deepEqual({status:reply.status,receipt:after.receipt,jobs:after.jobs},{status:409,receipt:[],jobs:[]});assert.deepEqual(await events(s.original.id),before);
    });
    await t.test('an old finalizer cannot replace the accepted newer generation',async()=>{
      const r=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration});assert.equal(r.status,202);const old=r.body;
      const advanced=await request(`/api/intake/receptions/${old.reception_id}/resume`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:old.revision,expected_generation:1,cause:'interrupted',original:old.original}});assert.equal(advanced.status,202);
      const uploaded=await request(`/api/intake/receptions/${old.reception_id}/attempts/2/original`,{client,bytes});assert.equal(uploaded.status,200);assert.equal((await finalize(uploaded.body)).status,200);
      const before=await state(old.reception_id),journal=await events(uploaded.body.original.id),late=await finalize(old),after=await state(old.reception_id);
      observations.push({case:'late-finalizer',old:old.original,current:uploaded.body.original,status:late.status,before,after});assert.deepEqual({status:late.status,after},{status:409,after:before});
      assert.deepEqual(await events(uploaded.body.original.id),journal);await original(uploaded.body);
    });
    await t.test('a completed treatment withdrawal stops finalizer reads while an unrelated profile change permits them',async()=>{
      const s=await stage();await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]);
      try{const before=await events(s.original.id),reply=await finalize(s),after=await state(s.reception_id),journal=await events(s.original.id);
        observations.push({case:'writer-before-finalizer',status:reply.status,before,journal,after});
        assert.deepEqual({status:reply.status,receipt:after.receipt,jobs:after.jobs,journal},{status:404,receipt:[],jobs:[],journal:before});
      }finally{await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);}
      await env.admin.query("UPDATE intake_control.profile SET revealable=false WHERE format='xlsx-cells/1'");
      try{const before=await events(s.original.id),reply=await finalize(s),journal=await events(s.original.id),after=await state(s.reception_id);
        observations.push({case:'unrelated-profile-change',status:reply.status,before,journal,after});assert.equal(reply.status,200);checkEffect(after);assert.ok(journal.length>before.length);await original(s);
      }finally{await env.admin.query("UPDATE intake_control.profile SET revealable=true WHERE format='xlsx-cells/1'");}
    });
  }finally{setBarrier(async()=>{});writeFileSync(output+'/observations.json',JSON.stringify(observations,null,2),{flag:'wx'});}
}
