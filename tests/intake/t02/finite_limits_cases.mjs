import assert from 'node:assert/strict';
import https from 'node:https';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {uiOrigin} from '../../access/journey_environment.mjs';
import {treatment} from './fixtures.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function finiteLimitsCases(t,{env,intake,client,request,restart,storage}){
  const mode=process.env.LEDGERDESK_INTAKE_FINITE,output='/work/output/finite-limits';mkdirSync(output,{recursive:true});
  const observations=[],payload=Buffer.alloc(mode==='finite-quota'?1048576:100,97);
  const declaration={profile:'intake/1',original:{name:'finite.txt',bytes:payload.length,sha256:sha(payload),declared_media_type:'text/plain'},
    format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  writeFileSync(output+'/reference.json',JSON.stringify({mode,declaration,atMs:Date.now(),
    bounds:{receptions:32,generations:3,reservedBytes:67108864,concurrentUploads:1,idleMs:5000,transferMs:10000},
    observedDeadlineToleranceMs:3000,storageMeaning:'Sum of durable attempt reservations, not physical filesystem consumption.'},null,2),{flag:'wx'});
  const reserve=async()=>{const r=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration});assert.equal(r.status,202,JSON.stringify(r.body));return r.body;};
  const totals=async()=>(await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_trial.reception) receptions,
    (SELECT coalesce(sum(reserved_bytes),0)::bigint::text FROM intake_trial.attempt) reserved,
    (SELECT count(*)::int FROM intake_trial.receipt) receipts,(SELECT count(*)::int FROM intake_trial.work) jobs`)).rows[0];
  const record=async r=>{const response=await request(`/api/intake/receptions/${r.reception_id}`,{client});assert.equal(response.status,200);return response.body;};
  const resume=(r)=>request(`/api/intake/receptions/${r.reception_id}/resume`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:r.revision,
    expected_generation:r.original.generation,cause:'interrupted',original:r.original}});
  function sender(r){
    let call,done=false;const started=performance.now();
    const response=new Promise(resolve=>{
      const finish=result=>{if(!done){done=true;resolve({...result,elapsedMs:performance.now()-started});}};
      call=https.request({host:'127.0.0.1',port:9443,servername:'api.inc02.test',ca:env.ca,
        path:`/api/intake/receptions/${r.reception_id}/attempts/${r.original.generation}/original`,method:'POST',
        headers:{host:'api.inc02.test:9443',origin:uiOrigin,cookie:client.cookie,'x-ledgerdesk-csrf':client.csrf,
          'content-type':'application/octet-stream','content-length':String(payload.length)}},reply=>{
          const chunks=[];reply.on('data',b=>chunks.push(b));reply.on('end',()=>finish({status:reply.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
          reply.on('error',()=>finish({status:null,transportError:true}));
        });
      call.on('error',()=>finish({status:null,transportError:true}));
      call.setTimeout(14000,()=>{call.destroy();finish({status:null,clientDeadline:true});});call.write(payload.subarray(0,1));
    });
    return{response,write:()=>{if(!done)call.write(payload.subarray(0,1));},end:()=>call.end(payload.subarray(1)),destroy:()=>call.destroy(),done:()=>done};
  }
  async function captured(r){
    const until=Date.now()+4000;let row;
    do{row=(await env.admin.query('SELECT actual_bytes FROM intake_trial.attempt WHERE reception_id=$1 AND generation=$2',[r.reception_id,r.original.generation])).rows[0];
      if(row.actual_bytes>0)return row;await delay(20);
    }while(Date.now()<until);assert.fail('ACTUAL_CAPTURE_NOT_REACHED');
  }
  try{
    if(mode==='finite-quota'){
      await t.test('the actual 32-reception boundary serializes racing reservations without oversubscription',async()=>{
        for(let i=0;i<31;i++)await reserve();
        const before=await totals(),responses=await Promise.all([1,2].map(()=>request('/api/intake/receptions',{client,key:randomUUID(),body:declaration}))),after=await totals();
        observations.push({case:'reception-race',before,statuses:responses.map(r=>r.status),after});
        assert.deepEqual({statuses:responses.map(r=>r.status).sort(),...after},{statuses:[202,429],receptions:32,reserved:String(32*1048576),receipts:0,jobs:0});
      });
      await t.test('64 MiB of actual durable attempt reservations is admitted exactly and the next generation is refused',async()=>{
        const ids=(await env.admin.query('SELECT id FROM intake_trial.reception ORDER BY id')).rows;
        for(const {id}of ids){const r=await record({reception_id:id}),result=await resume(r);assert.equal(result.status,202,JSON.stringify(result.body));}
        const before=await totals(),r=await record({reception_id:ids[0].id}),result=await resume(r),after=await totals();
        observations.push({case:'reserved-byte-boundary',before,status:result.status,after});
        assert.deepEqual({status:result.status,...after},{status:429,receptions:32,reserved:'67108864',receipts:0,jobs:0});assert.deepEqual(after,before);
      });return;
    }
    if(mode==='finite-attempts'){
      await t.test('the third generation survives a process restart and the fourth cannot reset the durable limit',async()=>{
        let r=await reserve();const one=await resume(r);assert.equal(one.status,202);r=one.body;
        const two=await resume(r);assert.equal(two.status,202);r=two.body;assert.equal(r.original.generation,3);
        const before=(await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[r.reception_id])).rows;
        await env.admin.query("UPDATE intake_control.live SET incarnation='intake-runtime-2',generation=generation+1,revision=revision+1");
        const processChange=await restart({...intake,incarnation:'intake-runtime-2',generation:2});
        await env.admin.query("UPDATE intake_control.namespace_admission SET generation=2 WHERE namespace='intake_trial' AND generation=1");
        const recovered=await record(r),result=await resume(recovered),after=(await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[r.reception_id])).rows;
        observations.push({case:'generation-after-restart',before,processChange,recovered,status:result.status,after});
        assert.deepEqual({status:result.status,generation:recovered.original.generation,after},{status:409,generation:3,after:before});
        const positive=await reserve();assert.equal(positive.original.generation,1);
      });return;
    }
    assert.equal(mode,'finite-stream');
    await t.test('one active binary upload refuses another but allows an actual record query to progress',async()=>{
      const a=await reserve(),b=await reserve(),active=sender(a);
      try{
        await captured(a);const before=storage.filter(x=>x.artifactId===b.original.id).length;
        const queryStarted=performance.now(),query=await record(a),queryMs=performance.now()-queryStarted;
        const second=await request(`/api/intake/receptions/${b.reception_id}/attempts/1/original`,{client,bytes:payload});
        const after=storage.filter(x=>x.artifactId===b.original.id).length;assert.equal(active.done(),false);
        active.end();const first=await active.response;
        const positive=await request(`/api/intake/receptions/${b.reception_id}/attempts/1/original`,{client,bytes:payload});
        observations.push({case:'one-active-upload',query,queryMs,statuses:[first.status,second.status,positive.status],before,after});
        assert.deepEqual({statuses:[first.status,second.status,positive.status],newCaptures:after-before},{statuses:[200,429,200],newCaptures:0});
        assert.ok(queryMs<3000,'QUERY_MUST_PROGRESS_BEFORE_UPLOAD_END');
      }finally{active.destroy();}
    });
    for(const kind of ['idle','slow'])await t.test('actual '+kind+' sender is terminated by the declared upload deadline',async()=>{
      const r=await reserve(),active=sender(r);let timer;
      try{
        await captured(r);if(kind==='slow')timer=setInterval(()=>active.write(),1000);
        const result=await active.response,rows=(await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1',[r.reception_id])).rows;
        const total=await totals(),expected=kind==='idle'?5000:10000;
        observations.push({case:kind+'-deadline',result,rows,total});
        assert.equal(result.status,400,JSON.stringify(result));assert.ok(result.elapsedMs>=expected-500&&result.elapsedMs<expected+3000,JSON.stringify(result));
        assert.ok(rows[0].actual_bytes>0&&rows[0].actual_bytes<payload.length);assert.deepEqual({receipts:total.receipts,jobs:total.jobs},{receipts:0,jobs:0});
      }finally{clearInterval(timer);active.destroy();}
    });
  }finally{writeFileSync(output+'/observations.json',JSON.stringify(observations,null,2),{flag:'wx'});}
}
