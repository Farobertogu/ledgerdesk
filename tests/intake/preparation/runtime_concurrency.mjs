import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {recipientEmail} from '../../access/journey_environment.mjs';
import {persistDocument,preparationProfile as profile} from './runtime_helpers.mjs';

function latch(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
async function bounded(promise,label,ms=2200){let timer;try{return await Promise.race([promise,
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}

export async function preparationConcurrencyCases(t,{env,client,request,call,check,counts,controlled,record,
  document,reservation,setBarrier,login}){
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const other=await login(recipientEmail);
  assert.notEqual(other.cookie,client.cookie,'The session lock must not serialize the two contenders.');
  const create=()=>persistDocument({call,check,document:structuredClone(document),inputs:reservation.inputs,selection:reservation.selection});
  const propose=async(p,description)=>{
    const r=p.reference,reply=await call(`/preparations/${r.id}/revisions/${r.revision}/proposals`,{key:randomUUID(),body:{...profile,
      unit:'AZ17',target:{kind:'new',declaration:description},judgment:{kind:'distinct',reason:'Explicit independently confirmable item.'}}});
    check(reply,200);return reply.body;
  };
  const confirm=(proposal,actor,key=randomUUID())=>request('/api/intake/constitutions',{client:actor,key,
    headers:{accept:'application/vnd.ledgerdesk.intake-preparation+json'},body:{...profile,proposal:proposal.result.proposal,mode:'person'}});
  for(const independent of [false,true])await t.test('K-'+(independent?'independent':'same-item')+' real overlapping confirmations have item-scoped effect discipline',async()=>{
    const first=await create(),second=independent?await create():first;
    const proposals=[await propose(first,'First explicit wrapper.'),await propose(second,'Second wrapper with different prose.')];
    const slots=proposals.map(p=>p.inspection.proposal.slot_id);
    assert.equal(slots[0]===slots[1],!independent);
    const before=await counts(),arrived=latch(),release=latch(),events=[];
    let admissions=0,persistences=0,waitingObserved=false;
    setBarrier(async(label,event)=>{
      if(!proposals.some(p=>p.result.proposal.id===event.proposalId))return;
      events.push({label,...event,atMs:Date.now()});
      if(label==='before_constitution_competition'){
        if(++admissions===2)arrived.resolve();
        await bounded(arrived.promise,'BOTH_COMPETITORS_DID_NOT_ARRIVE');
      }else if(label==='before_constitution_persist'){
        persistences++;
        if(independent){
          if(persistences===2)release.resolve();
          await bounded(release.promise,'INDEPENDENT_ITEMS_WERE_GLOBALLY_SERIALIZED');
        }else if(persistences===1){
          const deadline=Date.now()+1500;
          while(Date.now()<deadline){
            const rows=(await env.admin.query(`SELECT pid,granted FROM pg_locks WHERE locktype='advisory'
              AND classid=20203 AND objid=(hashtext($1)::bigint & 4294967295)::oid`,['intake:constitution-slot:'+slots[0]])).rows;
            if(rows.some(r=>r.granted&&r.pid===event.backendPid)&&rows.some(r=>!r.granted&&r.pid!==event.backendPid)){
              waitingObserved=true;events.push({label:'actual-item-lock-competition',rows,atMs:Date.now()});break;
            }
            await delay(10);
          }
        }
      }
    });
    let replies;const keys=[randomUUID(),randomUUID()];
    try{replies=await Promise.all([confirm(proposals[0],client,keys[0]),confirm(proposals[1],other,keys[1])]);}
    finally{arrived.resolve();release.resolve();setBarrier(async()=>{});}
    const after=await counts(),expected=independent?2:1;
    record('concurrent-constitution',{independent,slots,events,replies:replies.map(r=>({status:r.status,body:r.body})),before,after});
    assert.deepEqual({statuses:replies.map(r=>r.status),arrivals:admissions,persistences,waiting:waitingObserved,
      candidates:after.candidates-before.candidates,outcomes:after.outcomes-before.outcomes,effects:after.effects-before.effects},
      {statuses:[200,200],arrivals:2,persistences:expected,waiting:!independent,candidates:expected,outcomes:expected,effects:expected});
    if(independent)assert.notDeepEqual(replies[0].body.effect,replies[1].body.effect);
    else assert.deepEqual(replies[0].body.effect,replies[1].body.effect);
    const bindings=(await env.admin.query('SELECT client_key,effect_id FROM intake_trial.editorial_intention WHERE client_key=ANY($1::text[]) ORDER BY client_key',[keys])).rows;
    assert.deepEqual(bindings.map(r=>r.client_key),[...keys].sort());
    if(!independent)assert.equal(new Set(bindings.map(r=>r.effect_id)).size,1);
    const conflicts=await Promise.all([confirm(proposals[1],client,keys[0]),confirm(proposals[0],other,keys[1])]);
    assert.deepEqual({statuses:conflicts.map(r=>r.status),counts:await counts()},{statuses:[409,409],counts:after});
  });
}
