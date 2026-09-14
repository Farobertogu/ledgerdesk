import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {treatment,permissionIds} from './fixtures.mjs';
import {administration} from './recovery_cases.mjs';
import {password} from '../../access/journey_environment.mjs';
import {compareTiming,TIMING_PROTOCOL} from '../../reading/timing_comparison.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function completionCases(t,ctx){
  const {env,client,master,request,post,flow,messages,login,storage,selections}=ctx;
  const mode=process.env.LEDGERDESK_INTAKE_COMPLETION;
  assert.ok(['authority','missing-catalog','transitions','neutrality','original-scope','fragment-permissions'].includes(mode));
  const output='/work/output/completion';mkdirSync(output,{recursive:true});const observations=[];
  const save=(name,value)=>writeFileSync(output+'/'+name,Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  const original=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');
  const declaration={profile:'intake/1',original:{name:'bom.txt',bytes:17,sha256:'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9',declared_media_type:'text/plain'},
    format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  assert.equal(sha(original),declaration.original.sha256);save('original.bin',original);
  save('reference.json',{mode,declaration,fixedAtMs:Date.now(),expectedProfiles:['text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1'],
    ...(mode==='neutrality'?{timingProtocol:TIMING_PROTOCOL,shiftedControlMs:100,clock:'HTTPS request creation through response end; excludes observer flush',
      negativeSurface:{status:404,body:'unavailable'},noForbiddenObjectEvents:true}: {})});
  const record=async(id=null)=>({receptions:(await env.admin.query('SELECT * FROM intake_trial.reception WHERE $1::uuid IS NULL OR id=$1 ORDER BY id',[id])).rows,
    receipts:(await env.admin.query('SELECT * FROM intake_trial.receipt WHERE $1::uuid IS NULL OR reception_id=$1 ORDER BY id',[id])).rows,
    jobs:(await env.admin.query('SELECT w.* FROM intake_trial.work w JOIN intake_trial.receipt r ON r.id=w.receipt_id WHERE $1::uuid IS NULL OR r.reception_id=$1 ORDER BY w.id',[id])).rows});
  const observe=async()=>({rows:await record(),events:(await administration('observe-events',{})).events.length,captures:storage.length});
  const reserve=async(c=client,key=randomUUID(),body=declaration)=>{const r=await request('/api/intake/receptions',{client:c,key,body});assert.equal(r.status,202,JSON.stringify(r.body));return r.body;};
  async function receive(c=client,declared=declaration){
    const r=await reserve(c,randomUUID(),declared),uploaded=await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{client:c,bytes:original});assert.equal(uploaded.status,200);
    const result=await request(`/api/intake/receptions/${r.reception_id}/finalize`,{client:c,key:randomUUID(),body:{profile:'intake/1',expected_revision:uploaded.body.revision,original:uploaded.body.original,format_profile:'text-utf8/1'}});
    assert.equal(result.status,200);const actual=await request(`/api/intake/receptions/${r.reception_id}/original`,{client:c});
    assert.deepEqual({status:actual.status,bytes:actual.bytes},{status:200,bytes:original});return result.body;
  }
  async function secondPrincipal(){
    const email='second-loader@example.test';
    await env.admin.query('INSERT INTO access_trial.person_determination VALUES($1,$2,$3)',[email,'synthetic-second-loader','declared-person-link']);
    const issued=await post('/invitations',{email,family:'application',expires_at:Date.now()+300000,
      grants:permissionIds.map(permission_id=>({permission_id,exercise_or_grant:'exercise',scope_ref:mode==='original-scope'&&permission_id==='intake_original'?'intake-child':'organisation',support_ref:'domain'}))},master);
    assert.equal(issued.status,200,JSON.stringify(issued.body));const receiving=await flow();
    assert.equal((await post(`/invitations/${issued.body.invitation_id}/challenges`,{},receiving)).status,200);
    const proof=messages.at(-1),verified=await post(`/invitation-proofs/${proof.challenge_id}/verify`,{code:proof.code},receiving);assert.equal(verified.status,200);
    assert.equal((await post(`/invitations/${issued.body.invitation_id}/accept`,{expected_revision:issued.body.revision,proof_id:verified.body.proof_id},receiving)).status,200);
    assert.equal((await post('/account/initial-credential',{password},receiving)).status,200);
    const accepted=(await env.admin.query(`SELECT g.permission_id,g.faculty,a.person_ref FROM access_trial.grant_record g
      JOIN access_trial.account a ON a.id=g.account_id WHERE a.person_ref='synthetic-second-loader' ORDER BY g.permission_id`)).rows;
    assert.deepEqual(accepted,permissionIds.toSorted().map(permission_id=>({permission_id,faculty:'exercise',person_ref:'synthetic-second-loader'})));
    return login(email);
  }
  try{
    if(mode==='fragment-permissions'){
      await t.test('a real readable fragment does not grant whole-original authority; no same-original lineage is claimed',async()=>{
        const expectedFragments=[{fragment_id:'rule',text:'Regla.'},{fragment_id:'exception',text:'Excepto los domingos.'}];
        save('fragment-reference.json',{fixedAtMs:Date.now(),material:{unit_id:'content',version_id:'v1',kind:'EXCERPT',fragments:expectedFragments},
          intake:declaration,expectedOriginalDenied:404,expectedProtectedEvents:0,
          scope:'Permission separation only. The existing material fixture has no provenance relationship to this received original.'});
        const r=await receive();
        const offered=await post('/invitations',{email:'reader@example.test',family:'application',expires_at:Date.now()+300000,
          grants:[{permission_id:'read_material',exercise_or_grant:'exercise',scope_ref:'inc02-material',support_ref:'domain'}]},master);
        assert.equal(offered.status,200,JSON.stringify(offered.body));const f=await flow();
        assert.equal((await post(`/invitations/${offered.body.invitation_id}/challenges`,{},f)).status,200);
        const message=messages.at(-1),v=await post(`/invitation-proofs/${message.challenge_id}/verify`,{code:message.code},f);assert.equal(v.status,200);
        assert.equal((await post(`/invitations/${offered.body.invitation_id}/accept`,{expected_revision:offered.body.revision,proof_id:v.body.proof_id},f)).status,200);
        const account=(await env.admin.query("SELECT id FROM access_trial.account WHERE person_ref='synthetic-recipient'")).rows;
        assert.equal(account.length,1);
        const hierarchy=await env.materialPolicy(account[0].id,'EXCERPT');
        await env.admin.query(`INSERT INTO material_trial.policy VALUES('inc02-synthetic','inc02-material','"content"','"v1"',$1)`,[JSON.stringify(hierarchy)]);
        const read=()=>request('/api/v1/material/content/versions/v1',{client});
        const assertFragment=response=>assert.deepEqual({status:response.status,kind:response.body?.projection?.kind,
          fragments:response.body?.projection?.fragments?.map(({fragment_id,text})=>({fragment_id,text})),hasOriginal:Object.hasOwn(response.body?.projection??{},'original_text')},
          {status:200,kind:'EXCERPT',fragments:expectedFragments,hasOriginal:false});
        const positive=await read();assertFragment(positive);
        const grant=(await env.admin.query("SELECT * FROM access_trial.grant_record WHERE account_id=$1 AND permission_id='intake_original' AND faculty='exercise' AND NOT withdrawn",[account[0].id])).rows;
        assert.equal(grant.length,1);
        assert.equal((await post(`/grants/${grant[0].id}/withdraw`,{expected_revision:grant[0].revision,reason:'Synthetic permission separation'},master)).status,200);
        const before=await observe(),refused=await request(`/api/intake/receptions/${r.reception_id}/original`,{client}),after=await observe();
        const retainedFragment=await read(),retainedRecord=await request(`/api/intake/receptions/${r.reception_id}`,{client});
        observations.push({case:'fragment-permission-separation',reference:'fragment-reference.json',received:r,positive:positive.body,
          before,refused:{status:refused.status,body:refused.body},after,retainedFragment:retainedFragment.body,record:retainedRecord.body,
          sameOriginalProvenance:'unexercised: no material-to-reception lineage is constructed by T02'});
        assert.deepEqual({status:refused.status,...after},{status:404,...before});assertFragment(retainedFragment);
        assert.deepEqual({status:retainedRecord.status,effect:retainedRecord.body.effect},{status:200,effect:r.effect});
      });return;
    }
    if(mode==='missing-catalog'){
      await t.test('an absent immutable cancellation catalog entry refuses the actual operation',async()=>{
        const r=await reserve(),before=await observe();
        assert.equal((await env.admin.query("SELECT count(*)::int n FROM intake_control.catalog_entry WHERE operation='cancel_reception'")).rows[0].n,0);
        const result=await request(`/api/intake/receptions/${r.reception_id}/cancel`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:r.revision}});
        const after=await observe();observations.push({case:'missing-catalog',before,status:result.status,after});
        assert.deepEqual({status:result.status,...after},{status:503,...before});
        assert.equal((await request(`/api/intake/receptions/${r.reception_id}`,{client})).status,200);
      });return;
    }
    if(mode==='authority'){
      await t.test('the real loader works while the declared master has grant but not exercise faculty',async()=>{
        const positive=await receive(),before=await observe();
        const masterGrants=(await env.admin.query("SELECT g.faculty FROM access_trial.grant_record g JOIN access_trial.account a ON a.id=g.account_id WHERE a.office='master' AND g.permission_id='intake_load'")).rows;
        assert.deepEqual(masterGrants,[{faculty:'grant'}]);
        const result=await request('/api/intake/receptions',{client:master,key:randomUUID(),body:declaration}),after=await observe();
        observations.push({case:'grant-not-exercise',positive:positive.effect,masterGrants,before,status:result.status,after});
        assert.deepEqual({status:result.status,...after},{status:404,...before});
      });
      await env.admin.query("INSERT INTO access_trial.scope_definition VALUES('outside-organisation',NULL,'Outside','synthetic-other-purpose',1,true)");
      for(const [name,change]of [['wrong-existing-scope',{scope_id:'outside-organisation'}],['wrong-purpose',{purpose_id:'synthetic-other-purpose'}]]){
        await t.test(name+' cannot reserve or capture an original',async()=>{
          const before=await observe(),result=await request('/api/intake/receptions',{client,key:randomUUID(),body:{...declaration,receiving_context:{...declaration.receiving_context,...change}}}),after=await observe();
          observations.push({case:name,before,status:result.status,after});assert.deepEqual({status:result.status,...after},{status:404,...before});
          await reserve();
        });
      }
      await t.test('removed treatment blocks metadata effects and original capture while the current treatment positive still works',async()=>{
        const r=await reserve();await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]);
        try{
          const before=await observe(),metadata=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration});
          const body=await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{client,bytes:original}),after=await observe();
          observations.push({case:'removed-treatment',before,status:[metadata.status,body.status],after});
          assert.deepEqual({status:[metadata.status,body.status],...after},{status:[404,404],...before});
        }finally{await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);}
        const positive=await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{client,bytes:original});assert.equal(positive.status,200);
      });
      await t.test('a non-revealable profile is absent from the actual JSON and its restored positive is present',async()=>{
        const before=await request('/api/intake/profiles',{client});assert.equal(before.status,200);assert.equal(before.body.profiles.length,4);
        await env.admin.query("UPDATE intake_control.profile SET revealable=false WHERE format='xlsx-cells/1'");
        try{
          const hidden=await request('/api/intake/profiles',{client});observations.push({case:'profile-omission',before:before.body,status:hidden.status,body:hidden.body});
          assert.deepEqual(Object.keys(hidden.body).sort(),['profile','profiles','representation']);
          assert.equal(hidden.status,200);assert.equal(hidden.body.profiles.length,3);assert.equal(JSON.stringify(hidden.body).includes('xlsx'),false);
          assert.ok(hidden.body.profiles.every(row=>!('revealable'in row)&&!row.processing_available));
        }finally{await env.admin.query("UPDATE intake_control.profile SET revealable=true WHERE format='xlsx-cells/1'");}
        assert.deepEqual((await request('/api/intake/profiles',{client})).body,before.body);
      });
      await t.test('record faculty does not authorize any original storage access',async()=>{
        const r=await receive(),grant=(await env.admin.query("SELECT * FROM access_trial.grant_record WHERE permission_id='intake_original' AND faculty='exercise' AND NOT withdrawn")).rows[0];
        assert.equal((await post(`/grants/${grant.id}/withdraw`,{expected_revision:grant.revision,reason:'Synthetic whole-original withdrawal'},master)).status,200);
        const before=await observe(),recordResponse=await request(`/api/intake/receptions/${r.reception_id}`,{client});
        const originalResponse=await request(`/api/intake/receptions/${r.reception_id}/original`,{client}),after=await observe();
        observations.push({case:'record-only',status:originalResponse.status,record:recordResponse.body,before,after});
        assert.deepEqual({status:originalResponse.status,recordStatus:recordResponse.status,effect:recordResponse.body.effect,...after},
          {status:404,recordStatus:200,effect:r.effect,...before});
      });return;
    }
    if(mode==='original-scope'){
      await t.test('current descendant-only original authority succeeds without a root exercise grant',async()=>{
        const old=await receive();
        await env.admin.query("INSERT INTO access_trial.scope_definition VALUES('intake-child','organisation','Child','synthetic-reading-trial',1,true)");
        const childTreatment={id:'intake-treatment-child',revision:1,sha256:sha(Buffer.from('independent-child-treatment'))};
        await env.admin.query(`INSERT INTO intake_control.treatment SELECT $1,1,$2,'intake-child',purpose_ref,fields,actions,receiver,storage,processor,response_destination,disposition_ref,expires_at
          FROM intake_control.treatment WHERE id=$3 AND revision=1`,[childTreatment.id,childTreatment.sha256,treatment.id]);
        await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[childTreatment.id]);
        const child=await secondPrincipal(),grants=(await env.admin.query(`SELECT g.scope_ref FROM access_trial.grant_record g JOIN access_trial.account a ON a.id=g.account_id
          WHERE a.person_ref='synthetic-second-loader' AND g.permission_id='intake_original' AND g.faculty='exercise'`)).rows;
        assert.deepEqual(grants,[{scope_ref:'intake-child'}]);
        const current=await receive(child,{...declaration,receiving_context:{...declaration.receiving_context,scope_id:'intake-child',treatment_revision:childTreatment}});
        const before=await observe(),wrongContext=await request(`/api/intake/receptions/${old.reception_id}/original`,{client}),absent=await request(`/api/intake/receptions/${randomUUID()}/original`,{client}),after=await observe();
        observations.push({case:'descendant-original-positive',grants,current:current.effect,wrongContext:wrongContext.status,absent:absent.status,before,after});
        assert.deepEqual({status:wrongContext.status,headers:wrongContext.headers,bytes:wrongContext.bytes},{status:404,headers:absent.headers,bytes:absent.bytes});
        assert.deepEqual(after,before);
      });return;
    }
    const other=await secondPrincipal();
    if(mode==='neutrality'){
      const own=await receive(),foreign=await receive(other),absent=randomUUID();
      assert.equal((await env.admin.query('SELECT count(*)::int n FROM intake_trial.reception WHERE id=$1',[absent])).rows[0].n,0);
      const absentOperation=randomUUID();assert.equal((await env.admin.query('SELECT count(*)::int n FROM intake_trial.intention WHERE id=$1',[absentOperation])).rows[0].n,0);
      const publicSurface=r=>({status:r.status,headers:r.headers,bytes:r.bytes.toString('hex'),body:r.body});
      for(const route of ['record','lookup','original'])await t.test(route+' absence and protected ownership use the same public surface and finite timing detector',async()=>{
        const call=entry=>route==='lookup'?request('/api/intake/operations/lookup',{client,body:{profile:'intake/1',by:'operation',operation_id:entry.operation_id}})
          :request(`/api/intake/receptions/${entry.reception_id}${route==='original'?'/original':''}`,{client});
        const positive=await call(own);assert.equal(positive.status,200);
        if(route==='original')assert.deepEqual(positive.bytes,original);else assert.deepEqual(positive.body.effect,own.effect);
        const entries={absent:{reception_id:absent,operation_id:absentOperation},foreign};
        if(route==='original'){
          const grant=(await env.admin.query("SELECT g.* FROM access_trial.grant_record g JOIN access_trial.account a ON a.id=g.account_id WHERE g.permission_id='intake_original' AND g.faculty='exercise' AND NOT g.withdrawn AND a.person_ref<>'synthetic-second-loader'")).rows;
          assert.equal(grant.length,1);assert.equal((await post(`/grants/${grant[0].id}/withdraw`,{expected_revision:grant[0].revision,reason:'Synthetic neutrality observation'},master)).status,200);
          entries['owned-record-only']=own;
        }
        const before=await observe(),selectedBefore=selections.length,groups=Object.fromEntries(Object.keys(entries).map(k=>[k,[]])),surfaces=[];
        let reference=null;const mismatches=[];
        for(let round=0;round<TIMING_PROTOCOL.warmupRounds+TIMING_PROTOCOL.rounds;round++){
          const names=Object.keys(entries);if(round%2)names.reverse();
          for(const name of names){const response=await call(entries[name]),surface=publicSurface(response);
            if(reference===null)reference=surface;
            try{assert.equal(response.status,404);assert.deepEqual(surface,reference);}catch{mismatches.push({round,name,surface});}
            if(round===0)surfaces.push({name,surface});
            if(round>=TIMING_PROTOCOL.warmupRounds)groups[name].push(response.elapsedMs);
          }
        }
        const comparison=compareTiming(groups),control=compareTiming({baseline:groups.absent,shifted:groups.absent.map(ms=>ms+100)}),after=await observe();
        const selectedAfter=selections.length;
        const evidence={case:'neutrality-'+route,positive:publicSurface(positive),surfaces,mismatches,groups,comparison,control,before,after,selectedBefore,selectedAfter};
        observations.push(evidence);save('neutrality-'+route+'.json',evidence);
        assert.deepEqual({mismatches,signal:comparison.signalDetected,control:control.signalDetected,...after,
          ...(route==='original'?{protectedSelections:selectedAfter-selectedBefore}:{})},
          {mismatches:[],signal:false,control:true,...before,...(route==='original'?{protectedSelections:0}:{})});
      });return;
    }
    await t.test('two legitimately invited principals using one client key retain distinct intention namespaces',async()=>{
      const key=randomUUID(),a=await reserve(client,key),b=await reserve(other,key);
      const rows=(await env.admin.query('SELECT principal,reception_id FROM intake_trial.intention WHERE client_key=$1 ORDER BY principal',[key])).rows;
      assert.equal(rows.length,2);assert.notEqual(rows[0].principal,rows[1].principal);assert.notEqual(a.operation_id,b.operation_id);assert.notEqual(a.reception_id,b.reception_id);
      const own=await request(`/api/intake/receptions/${b.reception_id}`,{client:other}),foreign=await request(`/api/intake/receptions/${a.reception_id}`,{client:other});
      observations.push({case:'independent-principals',rows,status:[own.status,foreign.status]});assert.deepEqual([own.status,foreign.status],[200,404]);
    });
    await t.test('stop preserves a committed receipt, stops its unstarted job and reconciles the same stop intention',async()=>{
      const r=await receive(),before=await record(r.reception_id),key=randomUUID(),body={profile:'intake/1',expected_revision:r.revision};
      const foreignBefore=await observe(),foreign=await request(`/api/intake/receptions/${r.reception_id}/cancel`,{client:other,key:randomUUID(),body}),foreignAfter=await observe();
      assert.deepEqual({status:foreign.status,...foreignAfter},{status:404,...foreignBefore});
      const stopped=await request(`/api/intake/receptions/${r.reception_id}/cancel`,{client,key,body}),after=await record(r.reception_id);
      observations.push({case:'stop-committed',before,status:stopped.status,body:stopped.body,after});
      assert.deepEqual({status:stopped.status,effect:stopped.body?.effect,receipts:after.receipts,jobs:after.jobs},
        {status:200,effect:r.effect,receipts:before.receipts,jobs:before.jobs.map(row=>({...row,state:'stopped'}))});
      assert.equal(stopped.body.work.dispatchable,false);assert.equal(stopped.body.state,'stopped');
      const repeated=await request(`/api/intake/receptions/${r.reception_id}/cancel`,{client,key,body});
      const stale=await request(`/api/intake/receptions/${r.reception_id}/cancel`,{client,key:randomUUID(),body});
      const final=await record(r.reception_id);observations.push({case:'repeated-stale-stop',status:[repeated.status,stale.status],final});
      assert.deepEqual({statuses:[repeated.status,stale.status],effect:repeated.body?.effect,final},{statuses:[200,409],effect:r.effect,final:after});
    });
  }finally{save('observations.json',observations);}
}
