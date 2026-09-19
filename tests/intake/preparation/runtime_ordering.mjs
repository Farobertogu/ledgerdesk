import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from 'pg';
import {persistDocument,preparationProfile as profile,preparationHash} from './runtime_helpers.mjs';
import {preparationTreatment} from './runtime_control.mjs';

const points=[['prepare','E_prepare','finalize_preparation'],['propose','E_propose','propose'],
  ['constitute','E_constitute','constitute'],['deliver','response-handoff','preparation']];
function latch(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function bounded(promise,label,ms=5000){let timer;try{return await Promise.race([promise,
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function eventually(read,predicate,label){const until=Date.now()+1800;let value;
  do{value=await read();if(predicate(value))return value;await delay(10);}while(Date.now()<until);
  assert.fail(label+': '+JSON.stringify(value));}

/** Ordinary writers and writer-free expiry are separate properties. These
 * controls use the real treatment writer and independent PostgreSQL sessions. */
export async function preparationOrderingCases(t,{env,call,check,controlled,record,document,reservation,
  prepared,setBarrier,clientCalls,storage}){
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const root='/work/output/preparation-ordering',observations=[];
  await env.admin.query('CREATE TABLE public.t04_unrelated_writer(note text NOT NULL)');
  mkdirSync(root,{recursive:true});writeFileSync(root+'/reference.json',JSON.stringify({points,
    writer:'intake_control.set_treatment',admissionDomain:20202,source:reservation.selection,
    expectedBeforeAdmission:{status:404,newEffects:0,protectedReads:0},writerFreeExpiryClaim:false},null,2),{flag:'wx'});
  const rows=async()=>({preparations:(await env.admin.query('SELECT id,revision,sha256 FROM intake_trial.preparation ORDER BY id,revision')).rows,
    proposals:(await env.admin.query('SELECT id,revision,sha256 FROM intake_trial.preparation_proposal ORDER BY id,revision')).rows,
    constitutions:(await env.admin.query('SELECT id,outcome FROM intake_trial.constitution_outcome ORDER BY id')).rows});
  const setup=async(name)=>{
    const key=randomUUID();let subject,invoke;
    if(name==='prepare'){
      const bytes=Buffer.from(JSON.stringify(document));
      const reserved=await call('/preparation-attempts',{key:randomUUID(),body:{...reservation,document:{bytes:bytes.length,sha256:preparationHash(bytes)}}});check(reserved,202);
      const attempt=reserved.body.result,staged=await call(`/preparation-attempts/${attempt.attempt_id}/content`,{bytes});check(staged,200);
      subject=attempt.preparation;
      invoke=()=>call(`/preparation-attempts/${attempt.attempt_id}/finalize`,{key,body:{...profile,
        expected_revision:subject.revision,document:staged.body.result.document,differences:[]}});
    }else{
      const source=name==='deliver'?{reference:prepared.result.preparation}:
        await persistDocument({call,check,document:structuredClone(document),inputs:reservation.inputs,selection:reservation.selection});
      const r=source.reference;subject=r;
      const propose=()=>call(`/preparations/${r.id}/revisions/${r.revision}/proposals`,{key,body:{...profile,unit:'AZ17',
        target:{kind:'new',declaration:'Independent writer-order item.'},judgment:{kind:'distinct',reason:'Explicit synthetic operation.'}}});
      if(name==='propose')invoke=propose;
      else if(name==='deliver')invoke=()=>call(`/preparations/${r.id}/revisions/${r.revision}`);
      else{const proposal=await propose();check(proposal,200);subject=proposal.body.result.proposal;
        invoke=()=>call('/constitutions',{key:randomUUID(),body:{...profile,proposal:subject,mode:'person'}});}
    }
    return {subject,invoke};
  };
  try{
    for(const [name,point,route] of points){
      await t.test(`WO-${name} real invalidator waits behind the admitted effect or handoff`,async()=>{
        const {subject,invoke}=await setup(name),before=await rows(),reached=latch(),release=latch();
        let pause,delivery,writer,writerResult,writerFinished=false,replyFinished=false;
        const startClient=clientCalls.length;
        setBarrier(async(label,event)=>{
          if(label==='before_handoff'&&event.route===route)delivery={event,
            evidence:(await env.admin.query('SELECT status FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows[0],
            sql:(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows[0],
            transport:(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[event.evidenceId])).rows};
          if(label!=='after_last_clock'||event.route!==route||event.point!==point||pause)return;
          pause={...event,atMs:Date.now()};reached.resolve();await bounded(release.promise,'WRITER_ORDER_RELEASE');
        });
        const pending=invoke().then(r=>{replyFinished=true;return r;});pending.catch(()=>{});
        try{
          await bounded(reached.promise,'WRITER_ORDER_POINT_NOT_REACHED');
          assert.deepEqual(await rows(),before,'The paused producer has not committed its protected effect.');
          if(name==='deliver')assert.deepEqual({status:delivery?.evidence?.status,sql:delivery?.sql,transport:delivery?.transport},
            {status:200,sql:{state:'idle',xact_start:null},transport:[]});
          writer=new Client({...env.admin.connectionParameters,statement_timeout:5000,lock_timeout:4000});await writer.connect();
          const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          writerResult=writer.query('SELECT intake_control.set_treatment($1,1,false)',[preparationTreatment.id])
            .then(()=>{writerFinished=true;return {atMs:Date.now()};});writerResult.catch(()=>{});
          const wait=await eventually(async()=>(await env.admin.query(`SELECT wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1`,[pid])).rows[0],
            value=>value?.wait_event==='advisory'&&value.blockers.length>0,'ACTUAL_INVALIDATOR_NOT_WAITING');
          const holders=(await env.admin.query(`SELECT pid,granted FROM pg_locks WHERE locktype='advisory' AND classid=20202 AND objid=1`)).rows;
          assert.ok(wait.blockers.some(pid=>holders.some(h=>h.pid===pid&&h.granted)));
          const noTransfer={replyFinished,writerFinished,bytes:clientCalls.slice(startClient).reduce((n,c)=>n+c.receivedBytes,0)};
          assert.deepEqual(noTransfer,{replyFinished:false,writerFinished:false,bytes:0});
          // A real unrelated SQL writer completes while the invalidator waits;
          // the positive is not explained by a globally frozen database.
          const unrelated = new Client({...env.admin.connectionParameters,statement_timeout:1000});
          try {await unrelated.connect();await unrelated.query('INSERT INTO public.t04_unrelated_writer VALUES($1)',[name]);}
          finally {await unrelated.end();}
          assert.equal(writerFinished,false);
          release.resolve();const reply=await bounded(pending,'WRITER_ORDER_REPLY'),writerDone=await bounded(writerResult,'INVALIDATOR_DID_NOT_FINISH');
          check(reply,200);const after=await rows();
          if(name==='deliver')assert.deepEqual(after,before);else assert.notDeepEqual(after,before,'The admitted positive must actually persist its effect.');
          const transport=await eventually(async()=>(await env.admin.query('SELECT outcome,bytes FROM intake_trial.transport WHERE evidence_id=$1',[delivery.event.evidenceId])).rows,
            rows=>rows.length===1,'TRANSPORT_OBSERVATION_NOT_RECORDED');
          assert.deepEqual(transport,[{outcome:'handed_off',bytes:reply.bytes.length}]);
          const observation={name,subject,pause,delivery,pid,wait,holders,noTransfer,unrelatedWriterCompleted:true,transport,writerDone,status:reply.status,before,after};
          observations.push(observation);record('preparation-writer-order',observation);
        }finally{release.resolve();setBarrier(async()=>{});await pending.catch(()=>{});await writerResult?.catch(()=>{});await writer?.end();
          await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[preparationTreatment.id]);}
      });
      await t.test(`WO-${name} completed invalidation refuses the new operation before protected reads`,async()=>{
        const {invoke}=await setup(name),before=await rows(),reads=storage.length;
        await env.admin.query('SELECT intake_control.set_treatment($1,1,false)',[preparationTreatment.id]);
        try{const reply=await invoke(),after=await rows();
          const observation={name,order:'writer-first',status:reply.status,before,after,protectedObservations:storage.slice(reads)};
          observations.push(observation);record('preparation-writer-order',observation);
          assert.deepEqual({status:reply.status,after,reads:storage.length},{status:404,after:before,reads});
        }finally{await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[preparationTreatment.id]);}
        check(await invoke(),200,'The same independent operation remains reachable after re-admission.');
      });
    }
  }finally{setBarrier(async()=>{});writeFileSync(root+'/observations.json',JSON.stringify(observations,null,2),{flag:'wx'});}
}
