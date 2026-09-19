import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {Client} from 'pg';
import {IntakeAuthority} from '../../../src/server/intake/authority.ts';
import {PreparationAuthority} from '../../../src/server/intake/preparation/authority.ts';
import {sessionToken} from '../../../src/server/access/transport.ts';
import {administration,tables as originalTables} from '../t02/recovery_cases.mjs';
import {recipientEmail} from '../../access/journey_environment.mjs';
import {preparationContext} from './runtime_control.mjs';
import {preparationProfile as profile} from './runtime_helpers.mjs';

const tables=[...originalTables,'extraction_job','extraction_attempt','extraction_event','extraction_output','extraction_result',
  'editorial_effect','editorial_intention','preparation_attempt','preparation_stage','preparation','preparation_resource',
  'preparation_resource_association','preparation_difference','preparation_resource_read','constitution_slot',
  'preparation_proposal','constitution_outcome','candidate','candidate_relationship'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function snapshot(db,namespace){
  assert.ok(['intake_trial','intake_restore'].includes(namespace));const result={};
  for(const name of tables)result[name]=(await db.query(`SELECT * FROM ${namespace}.${name} ORDER BY 1,2`)).rows.map(row=>
    Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Buffer.isBuffer(value)?'\\x'+value.toString('hex'):value])));
  return result;
}

/** Controlled extension of the existing anchored synthetic restore. It does
 * not introduce an administrative HTTP route or restore live authority. */
export async function preparationRecoveryCases(t,{env,intake,client,request,call,check,prepared,constitution,
  controlled,record,application,digestSession,post,master,flow,messages}){
  const observations=[],reference=prepared.result.preparation;
  const preparationPath=`/preparations/${reference.id}/revisions/${reference.revision}`;
  const beforeQuery=await call(preparationPath);check(beforeQuery,200);
  const beforeMaterial=(await env.admin.query('SELECT * FROM material_trial.material ORDER BY 1,2,3')).rows;
  const ownTables=['preparation','preparation_stage','preparation_difference','preparation_resource','preparation_resource_association',
    'editorial_effect','editorial_intention','constitution_slot','preparation_proposal','constitution_outcome','candidate'];
  let cut,anchor,binding,liveConfig=intake;
  const queryEffect=()=>call('/operations/lookup',{body:{...profile,operation_id:constitution.operation_id}});
  const preserved=async()=>({control:(await env.admin.query('SELECT source_id,incarnation,generation,revision FROM intake_control.live')).rows[0],
    grants:(await env.admin.query('SELECT id,revision,withdrawn FROM access_trial.grant_record ORDER BY id')).rows,
    comparisons:(await env.admin.query('SELECT * FROM intake_control.preparation_comparison ORDER BY operation')).rows,
    priorActs:(await env.admin.query('SELECT * FROM intake_control.constitution_prior_act ORDER BY id,revision')).rows});
  async function admit(){
    const base=new IntakeAuthority(liveConfig,digestSession),authority=new PreparationAuthority(base,liveConfig);
    const a=await base.open({route:'preparation',parameters:{id:reference.id,revision:String(reference.revision)},method:'GET',contentLength:0,clientKey:null,csrf:null},
      sessionToken(client.cookie),['intake:preparation-restore'],()=>{},'inc03_intake_reader');
    try{
      await base.beforeMetadata(a,'preparation');
      for(const operation of ['preparation','difference','resource','lookup_operation'])await authority.resolve(a,operation,preparationContext);
      await base.resolve(a,'original',preparationContext);await base.resolve(a,'extraction',preparationContext);
      await a.db.commit();return a;
    }catch(error){await a.db.close();throw error;}
  }
  async function restore(variant,{install=false}={}){
    let a;const before=await preserved();
    try{
      a=await admit();
      assert.deepEqual((await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1',[anchor.id])).rows[0],anchor);
      assert.ok(await a.db.now()<a.deadline,'Current authority precedes every protected archive read.');
      const outputs=await administration('extraction-restore',{variant,anchorId:anchor.id,anchorSha256:binding.output_manifest_sha256});
      if(!outputs.ok)return {status:409,outputs};
      const original=await administration('restore',{variant:'intact',anchorSha256:binding.original_manifest_sha256});
      assert.equal(original.ok,true,JSON.stringify(original));
      const bytes=readFileSync('/work/output/restore-data.json');
      assert.equal(hash(bytes),binding.data_sha256,'Incoming data must match the independently retained cut, not its own manifest.');
      const data=JSON.parse(bytes);assert.deepEqual(Object.keys(data),tables);assert.deepEqual(data,cut);
      if(!install)return {status:200};
      assert.equal((await env.admin.query("SELECT to_regnamespace('intake_restore') n")).rows[0].n,null);
      for(const name of ['002_data.sql','005_extraction_data.sql','007_extraction_capacity.sql','008_preparation_data.sql'])
        await env.admin.query(readFileSync(new URL('../../../src/server/intake/postgres/'+name,import.meta.url),'utf8').replaceAll('intake_trial','intake_restore'));
      await env.admin.query('BEGIN');
      try{
        for(const name of tables){
          const columns=(await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='intake_restore' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",[name])).rows.map(r=>r.column_name);
          assert.ok(columns.length&&columns.every(c=>/^[a-z_][a-z0-9_]*$/.test(c)));
          await env.admin.query(`INSERT INTO intake_restore.${name}(${columns.join(',')}) SELECT ${columns.join(',')} FROM jsonb_populate_recordset(NULL::intake_restore.${name},$1::jsonb)`,[JSON.stringify(data[name])]);
        }
        assert.deepEqual(await snapshot(env.admin,'intake_restore'),cut);
        assert.deepEqual((await env.admin.query('SELECT * FROM intake_restore.preparation_capacity')).rows,
          (await env.admin.query('SELECT * FROM intake_trial.preparation_capacity')).rows,'Capacity is recalculated by retained byte insertions, not restored as a permission.');
        assert.ok(await a.db.now()<a.deadline);
        await env.admin.query('SELECT intake_control.activate_namespace($1,$2,$3)',['intake_restore',anchor.id,anchor.manifest_sha256]);
        await env.admin.query('COMMIT');
      }catch(error){await env.admin.query('ROLLBACK');throw error;}
      return {status:200};
    }catch(error){if([403,404,503].includes(error.status))return {status:error.status};throw error;}
    finally{await a?.db.close();assert.deepEqual(await preserved(),before,'Restore must not replay or replace live authority.');}
  }
  try{
    await t.test('REC01 populated preparation privileges deny modification and cross-domain access in both directions',async()=>{
      await env.admin.query("INSERT INTO retained_legacy.private_data VALUES('populated-preparation-legacy'); GRANT USAGE ON SCHEMA retained_legacy TO retained_legacy; GRANT SELECT ON retained_legacy.private_data TO retained_legacy");
      for(const table of ownTables)assert.ok((await env.admin.query('SELECT count(*)::int n FROM intake_trial.'+table)).rows[0].n>0,table);
      for(const [kind,connectionString,positive,negatives] of [
        ['runtime',intake.connectionString,'SELECT id FROM intake_trial.preparation',[
          ...ownTables.flatMap(table=>[`UPDATE intake_trial.${table} SET ${table==='candidate'?'version=version':'id=id'}`,`DELETE FROM intake_trial.${table}`]).filter(sql=>!sql.includes('resource_association SET id=id')),
          'SELECT * FROM retained_legacy.private_data','SELECT * FROM material_trial.material','UPDATE intake_control.preparation_comparison SET enabled=false']],
        ['reader',intake.readerConnectionString,'SELECT id FROM intake_trial.preparation',['DELETE FROM intake_trial.preparation','INSERT INTO intake_trial.preparation SELECT * FROM intake_trial.preparation','SELECT * FROM material_trial.material']],
        ['access',env.runtimeConfig.connectionString,'SELECT id FROM access_trial.account',['SELECT * FROM intake_trial.preparation','SELECT * FROM intake_trial.candidate']],
        ['material',env.reading.connectionString,'SELECT * FROM material_trial.material',['SELECT * FROM intake_trial.preparation','SELECT * FROM intake_trial.preparation_resource']],
      ]){
        const db=new Client({connectionString});await db.connect();try{
          const role=(await db.query('SELECT current_user name')).rows[0].name;assert.ok((await db.query(positive)).rowCount>0);
          for(const sql of negatives){let code;try{await db.query(sql);}catch(error){code=error.code;}
            observations.push({point:'privileges',kind,role,sql,code});assert.equal(code,'42501',sql);}
        }finally{await db.end();}
      }
      await env.admin.query('SET ROLE retained_legacy');try{
        assert.ok((await env.admin.query('SELECT * FROM retained_legacy.private_data')).rowCount>0);
        await assert.rejects(env.admin.query('SELECT * FROM intake_trial.preparation'),e=>e.code==='42501');
      }finally{await env.admin.query('RESET ROLE');}
      assert.deepEqual((await env.admin.query('SELECT * FROM material_trial.material ORDER BY 1,2,3')).rows,beforeMaterial);
    });
    await t.test('REC02 an actual killed and replaced service reads the exact preparation and reconciles without constitution faculty',async()=>{
      const before=await snapshot(env.admin,'intake_trial'),ended=await application.crash();assert.equal(ended.signal,'SIGKILL');
      const current=await application.restart(intake);
      assert.notDeepEqual({pid:current.pid,startTicks:current.startTicks,bootId:current.bootId},
        {pid:ended.pid,startTicks:ended.startTicks,bootId:ended.bootId});
      const actual=await call(preparationPath),effect=await queryEffect();check(actual,200);check(effect,200);
      assert.deepEqual(actual.body,beforeQuery.body);assert.deepEqual(effect.body.result,constitution.result);
      const after=await snapshot(env.admin,'intake_trial');
      for(const name of tables.filter(n=>!['evidence','transport','preparation_resource_read'].includes(n)))assert.deepEqual(after[name],before[name],name);
      observations.push({point:'restart',ended,current,preparation:reference,effect:effect.body.effect});
    });
    await t.test('REC03 the admitted data-only cut binds exact prepared bytes, resources, original and extraction objects',async()=>{
      const a=await admit();await a.db.close();await env.admin.query('SELECT pg_advisory_lock(20202,1)');
      try{
        await env.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');cut=await snapshot(env.admin,'intake_trial');
        const bytes=Buffer.from(JSON.stringify(cut));writeFileSync('/work/output/backup-data.json',bytes,{flag:'wx'});
        const original=await administration('backup',{objects:cut.artifact.map(o=>({id:o.id,generation:o.generation,bytes:o.bytes,sha256:o.sha256}))});assert.equal(original.ok,true,JSON.stringify(original));
        const outputs=await administration('extraction-backup',{bundles:cut.extraction_output.map(o=>JSON.parse(o.location_binding))});assert.equal(outputs.ok,true,JSON.stringify(outputs));
        const members=[...original.members.map(m=>({...m,name:'originals/'+m.name})),...outputs.members.map(m=>({...m,name:'outputs/'+m.name}))];
        assert.ok(!members.some(m=>/intake_control|access_trial/.test(m.name)));
        const id=randomUUID(),manifest=hash(Buffer.from(JSON.stringify(members)));
        await env.admin.query('INSERT INTO intake_control.backup_anchor VALUES($1,$2,$3,$4,$5)',[id,intake.controlSource,manifest,JSON.stringify(members),Date.now()]);
        await env.admin.query(`INSERT INTO intake_control.extraction_restore_cut(anchor_id,target_namespace,source_namespace,original_manifest_sha256,output_manifest_sha256,data_sha256)
          VALUES($1,'intake_restore','intake_trial',$2,$3,$4)`,[id,original.manifestSha256,outputs.manifestSha256,hash(bytes)]);
        await env.admin.query('INSERT INTO intake_control.extraction_restore_output SELECT $1,o.id,to_jsonb(o) FROM intake_trial.extraction_output o',[id]);
        await env.admin.query('COMMIT');anchor=(await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1',[id])).rows[0];
        binding=(await env.admin.query('SELECT * FROM intake_control.extraction_restore_cut WHERE anchor_id=$1',[id])).rows[0];
        observations.push({point:'cut',anchor,binding,dataBytes:bytes.length,dataSha256:hash(bytes),resourceCount:cut.preparation_resource.length});
      }catch(error){await env.admin.query('ROLLBACK');throw error;}finally{await env.admin.query('SELECT pg_advisory_unlock(20202,1)');}
    });
    if(!anchor)throw Error('PREPARATION_RESTORE_CUT_PREREQUISITE');
    await t.test('REC04 current refusal causes zero protected archive reads and never erases history',async()=>{
      const observed=async()=>(await administration('extraction-restore-inspect',{})).events.filter(e=>e.kind==='protected-archive-read').length;
      const reads=await observed();await env.admin.query('SELECT intake_control.set_enabled(false)');
      try{assert.equal((await restore('intact')).status,503);}finally{await env.admin.query('SELECT intake_control.set_enabled(true)');}
      const grant=(await env.admin.query("SELECT * FROM access_trial.grant_record WHERE account_id=$1 AND permission_id='intake_prepared_read' AND faculty='exercise' AND NOT withdrawn",[controlled.account.id])).rows[0];
      check(await post(`/grants/${grant.id}/withdraw`,{expected_revision:grant.revision,reason:'Synthetic restore read-faculty withdrawal'},master),200);
      assert.equal((await restore('intact')).status,404);assert.equal(await observed(),reads);
      check(await queryEffect(),200);assert.equal((await call(preparationPath)).status,404);
      observations.push({point:'restore-refusal',reads,withdrawnGrant:grant.id,historyRetained:true});
    });
    await t.test('REC05 fresh authority arrives by a new accepted invitation, never from the archive',async()=>{
      const invitation=await post('/invitations',{email:recipientEmail,family:'application',expires_at:Date.now()+300000,
        grants:[{permission_id:'intake_prepared_read',exercise_or_grant:'exercise',scope_ref:'organisation',support_ref:'domain'}]},master);check(invitation,200);
      const receiving=await flow();check(await post(`/invitations/${invitation.body.invitation_id}/challenges`,{},receiving),200);
      const challenge=messages.at(-1),proof=await post(`/invitation-proofs/${challenge.challenge_id}/verify`,{code:challenge.code},receiving);check(proof,200);
      check(await post(`/invitations/${invitation.body.invitation_id}/accept`,{expected_revision:invitation.body.revision,proof_id:proof.body.proof_id},receiving),200);
      const a=await admit();await a.db.close();
    });
    for(const variant of ['forged-manifest','missing-member'])await t.test('REC06 '+variant+' fails the retained anchor before any target is admitted',async()=>{
      const actual=await restore(variant);assert.equal(actual.status,409,JSON.stringify(actual));
      assert.equal((await env.admin.query("SELECT to_regnamespace('intake_restore') n")).rows[0].n,null);observations.push({point:variant,actual});
    });
    await t.test('REC07 populated restore under a fresh live incarnation retains identities without new extraction or candidate effects',async()=>{
      await env.admin.query("UPDATE intake_control.live SET incarnation='preparation-restored-2',generation=2,revision=revision+1; UPDATE intake_control.namespace_admission SET generation=2 WHERE namespace='intake_trial'");
      assert.equal((await restore('intact')).status,503,'Old launch identity cannot acquire new live control.');
      liveConfig={...intake,incarnation:'preparation-restored-2',generation:2};check(await restore('intact',{install:true}),200);
      await application.restart({...liveConfig,namespace:'intake_restore'});
      const actual=await call(preparationPath),effect=await queryEffect();check(actual,200);check(effect,200);
      assert.deepEqual(actual.body,beforeQuery.body);assert.deepEqual(effect.body.result,constitution.result);
      for(const table of ['preparation','preparation_stage','preparation_resource','preparation_resource_association','preparation_difference',
        'editorial_effect','editorial_intention','candidate','constitution_outcome','extraction_job','extraction_result'])
        assert.deepEqual((await snapshot(env.admin,'intake_restore'))[table],cut[table],table);
      for(const association of cut.preparation_resource_association){
        const reply=await call(`/preparations/${association.preparation_id}/revisions/${association.preparation_revision}/resources/${association.local_id}`);check(reply,200);
        assert.equal(hash(Buffer.from(reply.body.data,'base64')),association.resource_sha256);
      }
      const grants=(await env.admin.query("SELECT withdrawn FROM access_trial.grant_record WHERE account_id=$1 AND permission_id='intake_prepared_read' AND faculty='exercise'",[controlled.account.id])).rows;
      assert.deepEqual(grants.map(g=>g.withdrawn).sort(),[false,true]);
      observations.push({point:'restored',reference,effect:effect.body.effect,sourceHash:hash(Buffer.from(JSON.stringify(cut))),grants});
    });
  }finally{writeFileSync('/work/output/preparation-recovery.json',JSON.stringify({observations,
    limitations:['Controlled synthetic data-only restore using the existing retained-anchor mechanism; not an exposed administrative route.',
      'No live authority or prior-act control is restored. Finite selected bytes do not certify universal capacity or temporal conformity.']},null,2),{flag:'wx'});
    record('preparation-recovery-summary',{observations});}
}
