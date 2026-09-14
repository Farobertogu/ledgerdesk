import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {treatment} from './fixtures.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const root='/work/output/temporal';
const targets=[['reserve','reserve_reception','reservation-commit'],['capture','upload_original','private-object-dispatch'],
  ['receipt','finalize_reception','receipt-commit'],['original','original','response-handoff']];

/** Finite observations of writer-free expiry; no expected conformity is supplied. */
export async function temporalCases(t,{env,client,request,requestEvents,storage,barriers,setBarrier}){
  mkdirSync(root,{recursive:true});const observations=[];
  const bytes=Buffer.from('temporal-original\r\n'),reference={bytes:bytes.length,sha256:digest(bytes)};
  writeFileSync(root+'/original.bin',bytes,{flag:'wx'});
  writeFileSync(root+'/references.json',JSON.stringify({profile:'intake-temporal-reference/1',fixedAtMs:Date.now(),original:reference,
    points:targets,windowMs:2500,pastDeadlineMs:100,conformityExpected:null},null,2),{flag:'wx'});
  const now=async()=>Number((await env.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
  const control=async()=>({live:(await env.admin.query('SELECT source_id,revision,generation,incarnation,enabled FROM intake_control.live')).rows[0],
    treatment:(await env.admin.query('SELECT * FROM intake_control.treatment_current')).rows[0],
    epoch:(await env.admin.query('SELECT epoch FROM intake_control.fence_head')).rows[0].epoch});
  const rows=async id=>({receptions:(await env.admin.query('SELECT id,state,revision FROM intake_trial.reception WHERE id=$1',[id])).rows,
    attempts:(await env.admin.query('SELECT generation,state,actual_bytes FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[id])).rows,
    receipts:(await env.admin.query('SELECT id,effect_id FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows,
    jobs:(await env.admin.query('SELECT w.id,w.state,w.dispatchable FROM intake_trial.work w JOIN intake_trial.receipt r ON r.id=w.receipt_id WHERE r.reception_id=$1',[id])).rows});
  const declaration=ref=>({profile:'intake/1',original:{name:'temporal.txt',...reference,declared_media_type:'text/plain'},format_profile:'text-utf8/1',
    receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:ref}});
  const reserve=async()=>{const reply=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration(treatment)});
    assert.equal(reply.status,202,JSON.stringify(reply.body));return reply.body;};
  const upload=r=>request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{client,bytes});
  const finalize=(r,s)=>request(`/api/intake/receptions/${r.reception_id}/finalize`,{client,key:randomUUID(),body:{profile:'intake/1',
    expected_revision:s.revision,original:s.original,format_profile:'text-utf8/1'}});
  try{
    for(const [name,route,point]of targets)for(const expire of [false,true])await t.test(`writer-free ${name}: ${expire?'after-expiry observation':'before-expiry positive'}`,async()=>{
      let r=null,s=null;
      if(name!=='reserve')r=await reserve();
      if(['receipt','original'].includes(name)){const uploaded=await upload(r);assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));s=uploaded.body;}
      if(name==='original')assert.equal((await finalize(r,s)).status,200);
      const revision=2+observations.length,deadline=await now()+2500,ref={id:treatment.id,revision,sha256:digest(Buffer.from(JSON.stringify({revision,deadline})))};
      // A new immutable declaration is selected before the operation. No writer
      // changes a deadline, session or authority source inside the paused window.
      await env.admin.query(`INSERT INTO intake_control.treatment
        SELECT id,$1,$2,scope_ref,purpose_ref,fields,actions,receiver,storage,processor,response_destination,disposition_ref,$3
        FROM intake_control.treatment WHERE id=$4 AND revision=1`,[revision,ref.sha256,deadline,treatment.id]);
      await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[ref.id,ref.revision]);
      const baselineControl=await control(),start=requestEvents.length,storageStart=storage.length,clientKey=randomUUID();
      let pause=null,committed=null;
      setBarrier(async(label,event)=>{
        if(label==='before_handoff'&&pause&&event.route===route){
          committed={observedAtMs:await now(),...(r?await rows(r.reception_id):{receptions:(await env.admin.query(
            'SELECT r.id,r.state,r.revision FROM intake_trial.reception r JOIN intake_trial.intention i ON i.reception_id=r.id WHERE i.client_key=$1',[clientKey])).rows})};
        }
        if(label!=='after_last_clock'||event.route!==route||event.point!==point||pause)return;
        const observedAtMs=await now();assert.equal(event.deadlineMs,deadline);assert.ok(event.lastEvaluationMs<deadline&&observedAtMs<deadline,'The actual last evaluation must precede expiry');
        pause={...event,observedAtMs,controlBefore:await control(),before:r?await rows(r.reception_id):{receptions:(await env.admin.query(
          'SELECT reception_id FROM intake_trial.intention WHERE client_key=$1',[clientKey])).rows}};
        if(expire)while(await now()<=deadline+100)await delay(20);
        pause.releasedAtMs=await now();pause.controlAtRelease=await control();
        assert.deepEqual(pause.controlAtRelease,pause.controlBefore,'No authority/control writer may intervene in the expiry window');
      });
      let reply;
      try{
        reply=name==='reserve'?await request('/api/intake/receptions',{client,key:clientKey,body:declaration(ref)}):name==='capture'?await upload(r):
          name==='receipt'?await finalize(r,s):await request(`/api/intake/receptions/${r.reception_id}/original`,{client});
        assert.ok(pause,'The targeted final evaluation must be reached, not an earlier denial');
        const events=requestEvents.slice(start),captures=storage.slice(storageStart).filter(e=>e.kind==='capture'),end=events.filter(e=>e.kind==='terminal-end').at(-1);
        const reads=events.filter(e=>e.kind==='application-read'&&e.callId===pause.callId);
        const finalRows=r?await rows(r.reception_id):{receptions:(await env.admin.query(
          'SELECT r.id,r.state,r.revision FROM intake_trial.reception r JOIN intake_trial.intention i ON i.reception_id=r.id WHERE i.client_key=$1',[clientKey])).rows};
        const effected=name==='reserve'?finalRows.receptions.length===1:name==='receipt'?finalRows.receipts.length===1:
          name==='capture'?reads.some(e=>e.atMs>=pause.releasedAtMs):reply.status===200&&reply.bytes.equals(bytes);
        const violation=expire&&pause.releasedAtMs>deadline&&effected;
        const record={case:name,expire,reference,baselineControl,pause,committed,status:reply.status,finalRows,
          capturedBytes:captures.reduce((sum,e)=>sum+e.bytes,0),reads:reads.map(({data,...e})=>e),end,
          deliveredBytes:name==='original'&&reply.status===200?reply.bytes.length:0,effectObserved:effected,
          temporalViolation:violation,conformity:expire?(violation?'observed-violation':'no-violation-observed-at-this-point'):'positive-control',
          universalConformityClaim:false};observations.push(record);
        if(!expire){assert.ok(effected);assert.equal(reply.status,name==='reserve'?202:200);assert.ok(pause.releasedAtMs<deadline);}
        else{assert.ok(pause.releasedAtMs>deadline);if(['reserve','receipt'].includes(name))assert.equal(pause.before[name==='reserve'?'receptions':'receipts'].length,0);}
      }finally{setBarrier(async()=>{});await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);}
    });
  }finally{
    writeFileSync(root+'/observations.json',JSON.stringify(observations,null,2),{flag:'wx'});
    writeFileSync(root+'/barriers.json',JSON.stringify(barriers,null,2),{flag:'wx'});
  }
}
