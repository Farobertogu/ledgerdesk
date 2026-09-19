import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {InvitationAuthority} from '../../../src/server/access/invitation_authority.ts';
import {catalog,limits,ref} from '../t02/fixtures.mjs';
import {preparationContext,preparationTreatment} from './runtime_control.mjs';
import {persistDocument,preparationProfile as profile} from './runtime_helpers.mjs';

// Independently governed upstream INPUT only. The fixture does not insert an
// effect, candidate or runtime authorization flag, or claim an authoring flow.
const exact=(domain,id,body)=>({id,revision:1,sha256:createHash('sha256').update(canonicalValue({domain,body})).digest('hex')});
export async function preparationPriorActCases(t,{env,intake,call,check,counts,controlled,record,document,reservation,storage}){
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const p=await persistDocument({call,check,document:structuredClone(document),inputs:reservation.inputs,selection:reservation.selection});
  const target={kind:'new',declaration:'A separately selected exact synthetic consequence.'};
  const judgment={kind:'distinct',reason:'Explicit prior human selection; no candidate or effect exists at issuance.'};
  const proposed=await call(`/preparations/${p.reference.id}/revisions/1/proposals`,{key:randomUUID(),body:{...profile,unit:'AZ17',target,judgment}});
  check(proposed,200);
  const proposal=proposed.body.result.proposal;
  const slot=(await env.admin.query('SELECT id FROM intake_trial.constitution_slot WHERE preparation_id=$1',[p.reference.id])).rows[0].id;
  // Literal independent selection/context and real retained identity are fixed
  // before the constitution producer. No expected outcome comes from its output.
  const selection={proposal,preparation:p.reference,item:'unit:AZ17',slot_id:slot,selected:['rule','exception'],
    identity:proposed.body.inspection.proposal.identity,target,judgment,disposition:'constituted'};
  const executor={id:'intake-service:'+intake.incarnation,revision:intake.generation,
    sha256:createHash('sha256').update(canonicalValue({incarnation:intake.incarnation,generation:intake.generation})).digest('hex')};
  const reads=()=>storage.filter(x=>['constitution-prior-act-boundary','prepared-record-boundary'].includes(x.origin)).length;
  const make=async(alter=()=>{})=>{
    const now=Number((await env.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
    const authority=new InvitationAuthority({client:env.admin},now);await authority.load();
    const issuer=authority.accounts.find(x=>x.id===controlled.account.id);
    assert.equal(authority.allows(issuer,'intake_constitute','exercise','organisation'),true);
    const grant=authority.grants.find(x=>x.account_id===issuer.id&&x.permission_id==='intake_constitute'&&x.faculty==='exercise'&&authority.grantAlive(x));
    const support=authority.supports.find(x=>x.id===grant.support_ref);
    const identity={account:issuer.id,person:issuer.person_ref,grant:{id:grant.id,revision:grant.revision},support:{id:support.id,revision:support.revision}};
    const source=(await env.admin.query("SELECT source_comparison,entry_revision FROM intake_control.catalog_entry WHERE operation='constitute'")).rows[0];
    const body={profile:'constitution-prior-act/1',operation:'constitute',mode:'authorized_consequence',
      continuity:'issuer-exercise-support',issuer:identity,executor,principal:controlled.account.id,
      deployment:intake.deployment,source_id:intake.controlSource,namespace:intake.namespace,context:preparationContext,
      issued_at:now,expires_at:now+60000,catalog,limits,
      source:{basis:'CONSTITUIR_CANDIDATA',holder:'FN-APROBACION',entry_revision:source.entry_revision,comparison:source.source_comparison},
      issuance_evidence:exact('synthetic-upstream-issuance/1',randomUUID(),{identity,now,grant,scope:'organisation',purpose:'synthetic-reading-trial'}),
      target:structuredClone(selection),express:{operation:'constitute',mode:'authorized_consequence',effect:'constitute-exact-proposal-or-C9-disposition',target:null}};
    alter(body);
    const selected=exact('constitution-exact-target/1',randomUUID(),body.target);
    body.express.target=selected;
    const express=exact('constitution-express-authorization/1',randomUUID(),body.express);
    const act=exact('constitution-prior-act/1',randomUUID(),body);
    const authorization={act,express_authorization:express,target:selected};
    await env.admin.query('INSERT INTO intake_control.constitution_prior_act VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [act.id,act.sha256,body.source_id,body.namespace,body.principal,body.context,body.executor,body.issuer,authorization,body.issued_at,body.expires_at,body]);
    await env.admin.query('INSERT INTO intake_control.constitution_prior_current VALUES($1,1,true)',[act.id]);
    return {act,authorization,body};
  };
  const confirm=(prior,key=randomUUID(),mode='authorized_consequence')=>call('/constitutions',{key,
    body:{...profile,proposal,mode,...(mode==='authorized_consequence'?{prior_act:prior}: {})}});
  let admitted;
  await t.test('A01 a proposal or predecessor does not authorize a consequence; hidden and missing acts are neutral',async()=>{
    const before=await counts(),start=reads();
    const wrongSource=await make(body=>{body.source_id='untrusted-source';});
    const replies=[await confirm(proposal),await confirm({...proposal,id:randomUUID()}),await confirm(wrongSource.act)];
    assert.deepEqual({statuses:replies.map(r=>r.status),bodies:replies.map(r=>r.body),reads:reads(),counts:await counts()},
      {statuses:[404,404,404],bodies:[replies[0].body,replies[0].body,replies[0].body],reads:start,counts:before});
    assert.deepEqual(replies[0].headers,replies[1].headers);
    assert.deepEqual(replies[0].headers,replies[2].headers);
  });
  await t.test('A02 valid integrity does not excuse a wrong exact selection, target or absent express consequence',async()=>{
    for(const kind of ['selection','target','express']){
      const value=await make(body=>{
        if(kind==='selection')body.target.selected=['rule'];
        if(kind==='target')body.target.target={kind:'new',declaration:'A different human selection.'};
        if(kind==='express')body.express.operation='propose';
      });
      const before=await counts(),reply=await confirm(value.act);
      assert.deepEqual({status:reply.status,counts:await counts()},{status:404,counts:before},kind);
    }
  });
  await t.test('A03 expired, revoked or unsupported act and withdrawn treatment stop before protected bodies',async()=>{
    admitted=await make();
    const expired=await make(body=>{body.issued_at-=2000;body.expires_at=body.issued_at+1000;});
    const wrongExecutor=await make(body=>{body.executor=ref('other-service');});
    const before=await counts();
    for(const kind of ['expired','executor','revoked','support','treatment']){
      const start=reads();
      if(kind==='revoked')await env.admin.query('SELECT intake_control.set_constitution_prior_act($1,1,false)',[admitted.act.id]);
      if(kind==='support')await env.admin.query('UPDATE access_trial.support_definition SET active=false WHERE id=$1',[admitted.body.issuer.support.id]);
      if(kind==='treatment')await env.admin.query('SELECT intake_control.set_treatment($1,1,false)',[preparationTreatment.id]);
      try{
        const reply=await confirm(kind==='expired'?expired.act:kind==='executor'?wrongExecutor.act:admitted.act);
        assert.deepEqual({status:reply.status,reads:reads(),counts:await counts()},{status:404,reads:start,counts:before},kind);
      }finally{
        if(kind==='revoked')await env.admin.query('SELECT intake_control.set_constitution_prior_act($1,1,true)',[admitted.act.id]);
        if(kind==='support')await env.admin.query('UPDATE access_trial.support_definition SET active=true WHERE id=$1',[admitted.body.issuer.support.id]);
        if(kind==='treatment')await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[preparationTreatment.id]);
      }
    }
  });
  await t.test('A04 the real consumer constitutes once, preserving the human source and real executor',async()=>{
    const before=await counts(),start=reads(),positive=await confirm(admitted.act);check(positive,200);
    assert.deepEqual(await counts(),{candidates:before.candidates+1,outcomes:before.outcomes+1,effects:before.effects+1});
    assert.ok(reads()>start,'The positive reaches the same prior-act and prepared-body ports.');
    const saved=(await env.admin.query('SELECT provenance FROM intake_trial.candidate WHERE outcome_id=$1',[positive.body.result.outcome_id])).rows[0].provenance;
    assert.deepEqual(saved.execution,{mode:'authorized_consequence',executor,principal:controlled.account.id,
      authorization:admitted.authorization,issuer:admitted.body.issuer,issuance_evidence:admitted.body.issuance_evidence});
    await env.admin.query('SELECT intake_control.set_constitution_prior_act($1,1,false)',[admitted.act.id]);
    await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
    const countsAfter=await counts(),readAfter=reads();
    for(const mode of ['authorized_consequence','person']){
      const recovered=await confirm(admitted.act,randomUUID(),mode);check(recovered,200);
      assert.deepEqual({effect:recovered.body.effect,operation:recovered.body.operation_id,result:recovered.body.result,
        counts:await counts(),reads:reads()},
        {effect:positive.body.effect,operation:positive.body.operation_id,result:positive.body.result,counts:countsAfter,reads:readAfter});
    }
    record('prior-act-consumer',{prior:admitted.act,effect:positive.body.effect,counts:countsAfter,
      scope:'Controlled synthetic upstream input and actual consumer; no upstream human authoring endpoint is claimed.'});
  });
}
