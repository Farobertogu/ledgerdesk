import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from 'pg';
import {treatment} from './fixtures.mjs';
import {administration} from './recovery_cases.mjs';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
async function bounded(promise,label,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function eventually(read,predicate,label){const until=Date.now()+2000;let value;do{value=await read();if(predicate(value))return value;await delay(10);}while(Date.now()<until);assert.fail(label+': '+JSON.stringify(value));}

/** Independent writer/client/SQL observations of the four current governed egresses. */
export async function deliveryOrderCases(t,{env,client,request,setBarrier,requestEvents,clientCalls}){
  const output='/work/output/delivery-order';mkdirSync(output,{recursive:true});const observations=[];
  const original=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');
  const declaration={profile:'intake/1',original:{name:'bom.txt',bytes:17,sha256:'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9',declared_media_type:'text/plain'},format_profile:'text-utf8/1',
    receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  writeFileSync(output+'/reference.json',JSON.stringify({declaration,writerGate:20202,expectedNeutralStatus:404,initialExpiredNotR24:true,fixedAtMs:Date.now()},null,2),{flag:'wx'});
  const reserved=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration});assert.equal(reserved.status,202);
  const staged=await request(`/api/intake/receptions/${reserved.body.reception_id}/attempts/1/original`,{client,bytes:original});assert.equal(staged.status,200);
  const received=await request(`/api/intake/receptions/${reserved.body.reception_id}/finalize`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:staged.body.revision,original:staged.body.original,format_profile:'text-utf8/1'}});assert.equal(received.status,200);
  const id=received.body.reception_id;
  const targets=[['profiles','/api/intake/profiles',null],['reception',`/api/intake/receptions/${id}`,null],
    ['lookup_operation','/api/intake/operations/lookup',{profile:'intake/1',by:'operation',operation_id:received.body.operation_id}],['original',`/api/intake/receptions/${id}/original`,null]];
  const invoke=([,path,body])=>request(path,{client,...(body?{body}:{}),label:'delivery-order'});
  const journal=async()=>(await administration('observe-events',{})).events;
  const effect=async()=>(await env.admin.query('SELECT id,effect_id FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows;
  try{
    for(const target of targets){const [route,path]=target;
      await t.test(route+' handoff is ordered before an overlapping real invalidator',async()=>{
        const reached=deferred(),release=deferred();let paused,replyFinished=false,writerFinished=false,writerResult,writer;
        const startCalls=clientCalls.length,startEvents=requestEvents.length;
        setBarrier(async(label,event)=>{if(label==='before_handoff'&&event.route===route){paused=event;reached.resolve(event);await bounded(release.promise,'HANDOFF_RELEASE');}});
        const pending=invoke(target).then(r=>{replyFinished=true;return r;});pending.catch(()=>{});
        try{
          await bounded(reached.promise,'GOVERNED_HANDOFF_NOT_REACHED');
          const evidence=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[paused.evidenceId])).rows;
          const sql=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[paused.backendPid])).rows;
          const transport=(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[paused.evidenceId])).rows;
          assert.equal(evidence.length,1);assert.equal(evidence[0].route,route);assert.deepEqual(sql,[{state:'idle',xact_start:null}]);assert.deepEqual(transport,[]);
          writer=new Client({...env.admin.connectionParameters,statement_timeout:5000,lock_timeout:4000});await writer.connect();
          const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid,writerStartedAtMs=Date.now();
          writerResult=writer.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]).then(()=>{writerFinished=true;return{completedAtMs:Date.now()};});writerResult.catch(()=>{});
          const wait=await eventually(async()=>(await env.admin.query("SELECT wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0],v=>v?.wait_event==='advisory'&&v.blockers.includes(paused.backendPid),'WRITER_NOT_BLOCKED_BY_ADMITTED_HANDOFF');
          const activeCalls=clientCalls.slice(startCalls).filter(c=>c.path===path),before={replyFinished,writerFinished,networkBytes:activeCalls.reduce((n,c)=>n+c.receivedBytes,0),terminalEnds:requestEvents.slice(startEvents).filter(e=>e.kind==='terminal-end').length};
          assert.deepEqual(before,{replyFinished:false,writerFinished:false,networkBytes:0,terminalEnds:0});
          const releasedAtMs=Date.now();release.resolve();const reply=await bounded(pending,'HANDOFF_REPLY'),writerDone=await bounded(writerResult,'WRITER_AFTER_HANDOFF');
          const after=(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[paused.evidenceId])).rows;
          const ends=requestEvents.slice(startEvents).filter(e=>e.kind==='terminal-end'&&e.status===200);
          observations.push({case:'handoff-first',route,paused,evidence,sql,transport,pid,writerStartedAtMs,wait,before,releasedAtMs,status:reply.status,writerDone,ends,after});
          assert.equal(reply.status,200);if(route==='original')assert.deepEqual(reply.bytes,original);else assert.ok(reply.body);
          assert.equal(after.length,1);assert.equal(after[0].outcome,'handed_off');assert.equal(ends.length,1);assert.ok(writerDone.completedAtMs>=ends[0].atMs);
        }finally{release.resolve();setBarrier(async()=>{});await pending.catch(()=>{});await writerResult?.catch(()=>{});await writer?.end();await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);}
      });
      for(const expired of [false,true])await t.test(route+' refuses '+(expired?'already-expired treatment':'a writer that completed before admission'),async()=>{
        if(expired){
          const deadline=Date.now()-1000,revision=100+targets.indexOf(target),sha256=createHash('sha256').update(JSON.stringify({deadline,revision})).digest('hex');
          await env.admin.query(`INSERT INTO intake_control.treatment SELECT id,$1,$2,scope_ref,purpose_ref,fields,actions,receiver,storage,processor,response_destination,disposition_ref,$3
            FROM intake_control.treatment WHERE id=$4 AND revision=1`,[revision,sha256,deadline,treatment.id]);
          await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,revision]);
        }else await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]);
        try{const before=await journal(),history=await effect(),reply=await invoke(target),after=await journal(),retained=await effect();
          observations.push({case:expired?'expired-before-admission':'writer-first',route,status:reply.status,before,after,history,retained});
          assert.deepEqual({status:reply.status,after,history:retained},{status:404,after:before,history});
        }finally{await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);}
        assert.equal((await invoke(target)).status,200,'An independently allowed current counterpart must remain reachable');
      });
    }
  }finally{setBarrier(async()=>{});writeFileSync(output+'/observations.json',JSON.stringify(observations,null,2),{flag:'wx'});}
}
