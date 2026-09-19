import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {Client} from 'pg';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {IntakeAuthority} from '../../../src/server/intake/authority.ts';
import {selected} from '../../../src/server/intake/reception.ts';
import {sessionToken} from '../../../src/server/access/transport.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration,tables as receptionTables} from '../t02/recovery_cases.mjs';
import {recipientEmail} from '../../access/journey_environment.mjs';

const tables=[...receptionTables,'extraction_job','extraction_attempt','extraction_event','extraction_output','extraction_result'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function snapshot(admin,namespace){
  assert.ok(['intake_trial','intake_restore'].includes(namespace));const data={};
  for(const table of tables)data[table]=(await admin.query(`SELECT * FROM ${namespace}.${table} ORDER BY 1,2`)).rows;
  return data;
}
/** Extends the real reception restore with anchored historical extraction rows
 * and distinct restored output objects. No trigger is disabled for the import. */
export async function extractionRestoreCases(t,{env,intake,client,request,post,master,flow,messages,digestSession,restart}){
  await extractionControl(env,{allFormats:true});const observations=[],receipts=[],references=[];
  let cut,anchor,originalBackup,outputBackup,liveConfig=intake;
  const service=new ExtractionService(intake);
  const outputState=()=>administration('extraction-restore-inspect',{});
  const req={route:'original',parameters:{},method:'GET',contentLength:0,clientKey:null,csrf:null};
  async function admission(){
    const authority=new IntakeAuthority(liveConfig,digestSession);
    const a=await authority.open(req,sessionToken(client.cookie),['intake:extraction-restore'],()=>{},'inc03_intake_reader');
    try{
      await authority.beforeMetadata(a,'original');await authority.beforeExtractionSelection(a);
      for(const receipt of receipts){const {reception}=await selected(a.db,receipt.reception_id,a.session.account_id);
        await authority.resolve(a,'original',undefined,reception);await authority.resolve(a,'extraction',undefined,reception);}
      await a.db.commit();return a;
    }catch(error){await a.db.close();throw error;}
  }
  async function attempt(variant,{originals=false,install=false}={}){
    let a;
    try{
      a=await admission();
      const retained=(await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1',[anchor.id])).rows[0];assert.deepEqual(retained,anchor);
      const binding=(await env.admin.query('SELECT * FROM intake_control.extraction_restore_cut WHERE anchor_id=$1',[anchor.id])).rows[0];
      assert.ok(await a.db.now()<a.deadline,'Current admission must precede protected archive access');
      const outputs=await administration('extraction-restore',{variant,anchorId:anchor.id,anchorSha256:binding.output_manifest_sha256});
      if(!outputs.ok)return{status:409,outputs};
      if(!originals)return{status:200,outputs};
      const original=await administration('restore',{variant:'intact',anchorSha256:binding.original_manifest_sha256});
      assert.equal(original.ok,true,JSON.stringify(original));
      const bytes=readFileSync('/work/output/restore-data.json');assert.equal(hash(bytes),binding.data_sha256);
      const data=JSON.parse(bytes);assert.deepEqual(Object.keys(data),tables);assert.deepEqual(data,cut);
      if(!install)return{status:200,outputs,original};
      assert.equal((await env.admin.query("SELECT to_regnamespace('intake_restore') AS n")).rows[0].n,null);
      for(const name of ['002_data.sql','005_extraction_data.sql','007_extraction_capacity.sql'])await env.admin.query(
        readFileSync(new URL('../../../src/server/intake/postgres/'+name,import.meta.url),'utf8').replaceAll('intake_trial','intake_restore'));
      await env.admin.query('BEGIN');
      try{
        for(const name of tables){
          const columns=(await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='intake_restore' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",[name])).rows.map(r=>r.column_name);
          assert.ok(columns.length&&columns.every(c=>/^[a-z_][a-z0-9_]*$/.test(c)),'Declared restore columns: '+name+' '+JSON.stringify(columns));
          const insert=`INSERT INTO intake_restore.${name}(${columns.join(',')}) SELECT ${columns.join(',')} FROM jsonb_populate_recordset(NULL::intake_restore.${name},$1::jsonb)`;
          if(name==='extraction_output'){
            const altered={...data[name][0],normalized_sha256:'0'.repeat(64)};
            assert.notEqual(altered.normalized_sha256,data[name][0].normalized_sha256);
            await env.admin.query('SAVEPOINT altered_output');
            await assert.rejects(env.admin.query(insert,[JSON.stringify([altered])]),error=>error.code==='42501',
              'A structurally valid arriving row must reach and fail the retained-cut association gate');
            await env.admin.query('ROLLBACK TO SAVEPOINT altered_output');
            observations.push({point:'restore-row-association',expectedCode:'42501',changedField:'normalized_sha256',outputId:altered.id});
          }
          await env.admin.query(insert,[JSON.stringify(data[name])]);
        }
        assert.deepEqual(await snapshot(env.admin,'intake_restore'),cut);
        assert.ok(await a.db.now()<a.deadline,'Fresh evaluation precedes activation; no temporal completeness claim');
        await env.admin.query('SELECT intake_control.activate_namespace($1,$2,$3)',['intake_restore',anchor.id,anchor.manifest_sha256]);
        await env.admin.query('COMMIT');
      }catch(error){await env.admin.query('ROLLBACK');throw error;}
      return{status:200,outputs,original};
    }catch(error){if([403,404,503].includes(error.status))return{status:error.status};throw error;}
    finally{await a?.db.close();}
  }
  try{
    await t.test('RESTORE01 the cut contains a real completed and a real failed extraction',async()=>{
      for(const [name,bytes,outcome]of [['complete.txt',Buffer.from('AZ-17 requires R under condition Z.\n'),'completed'],
        ['record-limit.csv',Buffer.from('a\n'.repeat(1001)),'failed']]){
        const reference={name,bytes:bytes.length,sha256:hash(bytes),outcome};references.push(reference);
        const receipt=await receivedOriginal(request,client,bytes,{name,...(outcome==='failed'?{format:'csv-utf8/1',media:'text/csv'}:{})});receipts.push(receipt);
        await service.dispatch(receipt.work.id);const accepted=await service.accept(receipt.work.id);
        const result=await request('/api/intake/extractions/'+receipt.work.id,{client});assert.equal(result.status,200,JSON.stringify(result.body));
        assert.equal(result.body.result.content.outcome,outcome);assert.equal(result.body.result.id,accepted.resultId);
        if(outcome==='failed')assert.equal(result.body.result.content.incidents[0].code,'record_limit');
        reference.result=result.body.result;reference.original=receipt.original;
      }
    });
    await t.test('RESTORE02 one controlled cut binds the exact SQL rows, originals and output archive outside the arriving data',async()=>{
      const a=await admission();await a.db.close();
      await env.admin.query('SELECT pg_advisory_lock(20202,1)');
      try{
        await env.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase,null);
        cut=await snapshot(env.admin,'intake_trial');assert.equal(cut.extraction_result.length,2);
        assert.ok(cut.extraction_job.every(j=>j.state==='accepted'));
        const data=Buffer.from(JSON.stringify(cut));writeFileSync('/work/output/backup-data.json',data,{flag:'wx'});
        originalBackup=await administration('backup',{objects:cut.artifact.map(o=>({id:o.id,generation:o.generation,bytes:o.bytes,sha256:o.sha256}))});
        assert.equal(originalBackup.ok,true,JSON.stringify(originalBackup));
        outputBackup=await administration('extraction-backup',{bundles:cut.extraction_output.map(o=>JSON.parse(o.location_binding))});
        assert.equal(outputBackup.ok,true,JSON.stringify(outputBackup));
        const members=[...originalBackup.members.map(m=>({...m,name:'originals/'+m.name})),...outputBackup.members.map(m=>({...m,name:'outputs/'+m.name}))];
        const anchorId=randomUUID(),manifest=hash(Buffer.from(JSON.stringify(members)));
        await env.admin.query('INSERT INTO intake_control.backup_anchor VALUES($1,$2,$3,$4,$5)',[anchorId,intake.controlSource,manifest,JSON.stringify(members),Date.now()]);
        await env.admin.query(`INSERT INTO intake_control.extraction_restore_cut(anchor_id,target_namespace,source_namespace,
          original_manifest_sha256,output_manifest_sha256,data_sha256) VALUES($1,'intake_restore','intake_trial',$2,$3,$4)`,
          [anchorId,originalBackup.manifestSha256,outputBackup.manifestSha256,hash(data)]);
        await env.admin.query('INSERT INTO intake_control.extraction_restore_output SELECT $1,o.id,to_jsonb(o) FROM intake_trial.extraction_output o',[anchorId]);
        await env.admin.query('COMMIT');anchor=(await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1',[anchorId])).rows[0];
        observations.push({point:'cut',anchor,originalBackup,outputBackup,data:{bytes:data.length,sha256:hash(data)},sourceControl:(await env.admin.query('SELECT source_id,incarnation,generation,revision FROM intake_control.live')).rows[0]});
      }catch(error){await env.admin.query('ROLLBACK');throw error;}
      finally{await env.admin.query('SELECT pg_advisory_unlock(20202,1)');}
    });
    if(!anchor)throw Error('EXTRACTION_RESTORE_CUT_PRECONDITION');
    await t.test('RESTORE03 neither runtime nor reader can manufacture the retained restore association',async()=>{
      for(const connectionString of [intake.connectionString,intake.readerConnectionString]){
        const db=new Client({connectionString});await db.connect();try{
          for(const table of ['extraction_restore_cut','extraction_restore_output'])assert.equal((await db.query('SELECT has_table_privilege(current_user,$1,\'INSERT\') AS allowed',['intake_control.'+table])).rows[0].allowed,false);
          await assert.rejects(db.query('INSERT INTO intake_control.extraction_restore_output SELECT * FROM intake_control.extraction_restore_output'),e=>e.code==='42501');
        }finally{await db.end();}
      }
    });
    await t.test('RESTORE04 disabled live control and withdrawn query authority admit zero protected archive reads',async()=>{
      const before=(await outputState()).events.filter(e=>e.kind==='protected-archive-read').length;
      await env.admin.query('SELECT intake_control.set_enabled(false)');
      try{assert.equal((await attempt('intact')).status,503);}finally{await env.admin.query('SELECT intake_control.set_enabled(true)');}
      const grant=(await env.admin.query("SELECT * FROM access_trial.grant_record WHERE permission_id='intake_extraction_read' AND faculty='exercise' AND NOT withdrawn")).rows[0];
      assert.equal((await post(`/grants/${grant.id}/withdraw`,{expected_revision:grant.revision,reason:'Synthetic query withdrawal after backup'},master)).status,200);
      assert.equal((await attempt('intact')).status,404);
      assert.equal((await outputState()).events.filter(e=>e.kind==='protected-archive-read').length,before);
      observations.push({point:'withdrawn-query',grantId:grant.id,archiveReads:before});
    });
    await t.test('RESTORE05 a new accepted invitation restores the needed faculty, not the old archive',async()=>{
      const offered=await post('/invitations',{email:recipientEmail,family:'application',expires_at:Date.now()+300000,
        grants:[{permission_id:'intake_extraction_read',exercise_or_grant:'exercise',scope_ref:'organisation',support_ref:'domain'}]},master);
      assert.equal(offered.status,200,JSON.stringify(offered.body));const receiving=await flow();
      assert.equal((await post(`/invitations/${offered.body.invitation_id}/challenges`,{},receiving)).status,200);
      const challenge=messages.at(-1),verified=await post(`/invitation-proofs/${challenge.challenge_id}/verify`,{code:challenge.code},receiving);assert.equal(verified.status,200);
      assert.equal((await post(`/invitations/${offered.body.invitation_id}/accept`,{expected_revision:offered.body.revision,proof_id:verified.body.proof_id},receiving)).status,200);
      const a=await admission();await a.db.close();
    });
    for(const variant of ['forged-manifest','missing-member'])await t.test('RESTORE06 '+variant+' cannot replace the independently retained output anchor',async()=>{
      const result=await attempt(variant);assert.equal(result.status,409,JSON.stringify(result));
      assert.equal((await outputState()).targetExists,false);observations.push({variant,result});
    });
    await t.test('RESTORE07 the populated data restores under a newer non-restored incarnation, preserving both results',async()=>{
      await env.admin.query("UPDATE intake_control.live SET incarnation='intake-runtime-restored-2',generation=2,revision=revision+1");
      await env.admin.query("UPDATE intake_control.namespace_admission SET generation=2 WHERE namespace='intake_trial'");
      assert.equal((await attempt('intact')).status,503,'The old launch configuration cannot use the new incarnation');
      liveConfig={...intake,incarnation:'intake-runtime-restored-2',generation:2};
      const beforeControl=(await env.admin.query('SELECT source_id,incarnation,generation,revision FROM intake_control.live')).rows[0];
      const result=await attempt('intact',{originals:true,install:true});assert.equal(result.status,200,JSON.stringify(result));
      assert.deepEqual((await env.admin.query('SELECT source_id,incarnation,generation,revision FROM intake_control.live')).rows[0],beforeControl);
      await restart({...liveConfig,namespace:'intake_restore'});
      // Corrupt only the old live normalized copies. Restored queries must use
      // their separate restored objects, not fall back to those original paths.
      for(const row of cut.extraction_output)assert.equal((await administration('fault-extraction-output',{channel:row.channel_id,faultId:randomUUID(),mode:'corrupt'})).ok,true);
      for(let i=0;i<receipts.length;i++){
        const result=await request('/api/intake/extractions/'+receipts[i].work.id,{client});assert.equal(result.status,200,JSON.stringify(result.body));
        assert.deepEqual(result.body.result,references[i].result);assert.deepEqual(result.body.original,references[i].original);
        const original=await request('/api/intake/receptions/'+receipts[i].reception_id+'/original',{client});assert.equal(original.status,200);
        assert.deepEqual({bytes:original.bytes.length,sha256:hash(original.bytes)},{bytes:references[i].bytes,sha256:references[i].sha256});
      }
      const grants=(await env.admin.query("SELECT withdrawn FROM access_trial.grant_record WHERE permission_id='intake_extraction_read' AND faculty='exercise'")).rows;
      assert.deepEqual(grants.map(g=>g.withdrawn).sort(),[false,true]);
      assert.deepEqual((await env.admin.query('SELECT id,effect_id,outcome FROM intake_restore.extraction_result ORDER BY id')).rows,
        cut.extraction_result.map(({id,effect_id,outcome})=>({id,effect_id,outcome})).sort((a,b)=>a.id.localeCompare(b.id)));
      observations.push({point:'restored',result,control:beforeControl,namespace:(await env.admin.query("SELECT * FROM intake_control.namespace_admission WHERE namespace='intake_restore'")).rows[0]});
    });
  }finally{
    writeFileSync('/work/output/extraction-restore.json',JSON.stringify({references,observations,
      limits:{bundles:4,aggregateMemberBytes:67108864,archiveBytes:90000000},
      limitations:['Controlled synthetic recovery path; no general administrative endpoint or automatic untrusted archive import.',
        'This cut contains accepted results, including a real CSV limit failure; recovery of active parser process sets is separate.',
        'The finite archive bounds and measured small cut do not certify a universal memory maximum or writer-free temporal conformity.']},null,2),{flag:'wx'});
  }
}
