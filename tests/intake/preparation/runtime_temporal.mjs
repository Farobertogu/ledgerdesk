import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {persistDocument,preparationProfile as profile,preparationHash} from './runtime_helpers.mjs';

const points=[['prepare','E_prepare','finalize_preparation','intake_prepare'],
  ['propose','E_propose','propose','intake_prepare'],
  ['constitute','E_constitute','constitute','intake_constitute'],
  ['deliver','response-handoff','preparation','intake_prepared_read']];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Finite writer-free observations of the actual new effect consumers. Passing
 * the observation harness is not a temporal-conformity result. */
export async function preparationTemporalCases(t,{env,call,check,controlled,record,document,reservation,
  prepared,setBarrier,clientCalls}){
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const root='/work/output/preparation-temporal',observations=[];
  mkdirSync(root,{recursive:true});
  writeFileSync(root+'/reference.json',JSON.stringify({profile:'preparation-temporal-reference/1',points,
    windowMs:5000,pastDeadlineMs:100,normative:'No protected effect after applicable authority expires',
    resultNotPredetermined:true,independentSource:reservation.selection},null,2),{flag:'wx'});
  const now=async()=>Number((await env.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
  const control=async()=>({live:(await env.admin.query('SELECT source_id,revision,generation,incarnation,enabled FROM intake_control.live')).rows[0],
    treatment:(await env.admin.query('SELECT * FROM intake_control.treatment_current')).rows[0],
    authorityDigest:digest((await env.admin.query('SELECT * FROM access_trial.grant_record ORDER BY id')).rows),
    epoch:(await env.admin.query('SELECT epoch FROM intake_control.fence_head')).rows[0].epoch});
  const effectRows=async(name,subject)=>{
    if(name==='prepare')return (await env.admin.query('SELECT id,revision,sha256,recorded_at FROM intake_trial.preparation WHERE id=$1',[subject.preparation])).rows;
    if(name==='propose')return (await env.admin.query('SELECT id,revision,sha256,recorded_at FROM intake_trial.preparation_proposal WHERE slot_id IN (SELECT id FROM intake_trial.constitution_slot WHERE preparation_id=$1)',[subject.preparation])).rows;
    if(name==='constitute')return (await env.admin.query('SELECT id,outcome,recorded_at FROM intake_trial.constitution_outcome WHERE proposal_id=$1',[subject.proposal])).rows;
    return [];
  };
  try{
    for(const [name,point,route,permission] of points)for(const expire of [false,true])await t.test(`PT-${name} ${expire?'writer-free expiry observation':'nonexpired positive'}`,async()=>{
      let invoke,subject;
      const commandKey=randomUUID();
      if(name==='prepare'){
        const bytes=Buffer.from(JSON.stringify(document));
        const reserved=await call('/preparation-attempts',{key:randomUUID(),body:{...reservation,document:{bytes:bytes.length,sha256:preparationHash(bytes)}}});check(reserved,202);
        const attempt=reserved.body.result,staged=await call(`/preparation-attempts/${attempt.attempt_id}/content`,{bytes});check(staged,200);
        subject={preparation:attempt.preparation.id};
        invoke=()=>call(`/preparation-attempts/${attempt.attempt_id}/finalize`,{key:commandKey,body:{...profile,
          expected_revision:attempt.preparation.revision,document:staged.body.result.document,differences:[]}});
      }else{
        const source=name==='deliver'?{reference:prepared.result.preparation}:
          await persistDocument({call,check,document:structuredClone(document),inputs:reservation.inputs,selection:reservation.selection});
        const r=source.reference;subject={preparation:r.id};
        const propose=()=>call(`/preparations/${r.id}/revisions/${r.revision}/proposals`,{key:commandKey,body:{...profile,unit:'AZ17',
          target:{kind:'new',declaration:'A separate temporal observation item.'},judgment:{kind:'distinct',reason:'Explicit synthetic independent selection.'}}});
        if(name==='propose')invoke=propose;
        else if(name==='deliver')invoke=()=>call(`/preparations/${r.id}/revisions/${r.revision}`);
        else{
          const proposed=await propose();check(proposed,200);subject.proposal=proposed.body.result.proposal.id;
          invoke=()=>call('/constitutions',{key:randomUUID(),body:{...profile,proposal:proposed.body.result.proposal,mode:'person'}});
        }
      }
      const grant=(await env.admin.query("SELECT id,expires_at FROM access_trial.grant_record WHERE account_id=$1 AND permission_id=$2 AND faculty='exercise'",[controlled.account.id,permission])).rows[0];
      const deadline=await now()+5000;
      // Change the governing grant BEFORE starting. The exact conserved
      // treatment reference remains the same; no false early context conflict.
      await env.admin.query('UPDATE access_trial.grant_record SET expires_at=$1 WHERE id=$2',[deadline,grant.id]);
      let pause=null,delivery=null,reply,error;
      const firstClient=clientCalls.length;
      setBarrier(async(label,event)=>{
        if(label==='before_handoff'&&event.route===route){
          delivery={event,evidence:(await env.admin.query('SELECT id,status,recorded_at FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows[0],
            sql:(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows[0],
            transport:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.transport WHERE evidence_id=$1',[event.evidenceId])).rows[0].n};
        }
        if(label!=='after_last_clock'||event.route!==route||event.point!==point||pause)return;
        const observedAtMs=await now();
        assert.equal(event.deadlineMs,deadline);
        assert.ok(event.lastEvaluationMs<deadline&&observedAtMs<deadline,'The final real evaluation must precede expiry.');
        pause={...event,observedAtMs,before:await effectRows(name,subject),controlBefore:await control()};
        assert.deepEqual(pause.before,[],'No uncommitted effect may be visible from the independent SQL connection.');
        if(name==='deliver'){
          assert.deepEqual({status:delivery?.evidence?.status,state:delivery?.sql?.state,transaction:delivery?.sql?.xact_start,
            transport:delivery?.transport,receiverBytes:clientCalls.slice(firstClient).reduce((n,c)=>n+c.receivedBytes,0)},
            {status:200,state:'idle',transaction:null,transport:0,receiverBytes:0});
        }
        if(expire)while(await now()<=deadline+100)await delay(20);
        pause.releasedAtMs=await now();pause.controlAtRelease=await control();
        assert.deepEqual(pause.controlAtRelease,pause.controlBefore,'The paused expiry interval contains no control or authority writer.');
      });
      try{
        try{reply=await invoke();}catch(e){error={name:e.name,message:e.message};}
        assert.ok(pause,'An earlier refusal does not exercise this temporal point.');
        const after=await effectRows(name,subject),observedAtMs=await now();
        const transferred=name==='deliver'&&reply?.status===200&&reply.body?.preparation?.payload?.elements.some(e=>e.id==='rule');
        const effectObserved=name==='deliver'?Boolean(transferred):after.length===1;
        const observeTransport=async()=>delivery?(await env.admin.query('SELECT outcome,bytes,recorded_at FROM intake_trial.transport WHERE evidence_id=$1',[delivery.event.evidenceId])).rows:[];
        const transportInitial=await observeTransport();let transport=transportInitial;
        const observationStarted=performance.now();
        // HTTP completion precedes the asynchronous transport observation. Wait
        // only for that independent record, never replay or extend the effect.
        if(name==='deliver'&&transferred)while(!transport.length&&performance.now()-observationStarted<1500){
          await delay(10);transport=await observeTransport();
        }
        const observation={name,point,route,expire,subject,deadline,pause,after,observedAtMs,delivery,transport,
          transportInitial,observationWaitMs:performance.now()-observationStarted,
          httpStatus:reply?.status??null,error:error??null,effectObserved,protectedBytes:transferred?reply.bytes.length:0,
          temporalViolation:expire&&effectObserved&&pause.releasedAtMs>deadline,universalConformityClaim:false};
        observations.push(observation);record('preparation-temporal',observation);
        writeFileSync(root+'/case-'+name+'-'+(expire?'expired':'positive')+'.json',JSON.stringify(observation,null,2),{flag:'wx'});
        if(name==='deliver'&&transferred)assert.ok(transport.some(r=>r.outcome==='handed_off'&&r.bytes===reply.bytes.length),JSON.stringify(observation));
        if(!expire){assert.ok(effectObserved,'The nonexpired control must reach the actual effect.');assert.ok(pause.releasedAtMs<deadline);}
        else assert.ok(pause.releasedAtMs>deadline);
      }finally{
        setBarrier(async()=>{});
        await env.admin.query('UPDATE access_trial.grant_record SET expires_at=$1 WHERE id=$2',[grant.expires_at,grant.id]);
      }
    });
  }finally{
    setBarrier(async()=>{});writeFileSync(root+'/observations.json',JSON.stringify({observations,
      limitations:['Finite synthetic effect observations, not universal temporal conformity','R24 remains open; ordinary writer coordination is a separate property']},null,2),{flag:'wx'});
  }
}
