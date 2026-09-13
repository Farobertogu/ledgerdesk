import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,chmodSync,renameSync,statSync} from 'node:fs';
import {Client} from 'pg';
import {PrivateIntakePort} from '../../../src/server/intake/ports.ts';
import {administration} from './recovery_cases.mjs';
import {treatment} from './fixtures.mjs';

export async function privilegeCases(t,{env,intake,client,request,setBarrier}){
  const output='/work/output/privileges';mkdirSync(output,{recursive:true});const observations=[];
  const original=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex'),sha256='8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9';
  const declaration={profile:'intake/1',original:{name:'bom.txt',bytes:17,sha256,declared_media_type:'text/plain'},format_profile:'text-utf8/1',
    receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  writeFileSync(output+'/reference.json',JSON.stringify({declaration,atMs:Date.now(),negativeSqlState:'42501',sealedMode:256},null,2),{flag:'wx'});
  async function receive(generation=1){
    const r=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration});assert.equal(r.status,202);let reserved=r.body;
    if(generation===2){const advanced=await request(`/api/intake/receptions/${reserved.reception_id}/resume`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:reserved.revision,expected_generation:1,cause:'interrupted',original:reserved.original}});assert.equal(advanced.status,202);reserved=advanced.body;}
    const sent=await request(`/api/intake/receptions/${reserved.reception_id}/attempts/${generation}/original`,{client,bytes:original});assert.equal(sent.status,200);
    const result=await request(`/api/intake/receptions/${reserved.reception_id}/finalize`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:sent.body.revision,original:sent.body.original,format_profile:'text-utf8/1'}});assert.equal(result.status,200);return result.body;
  }
  try{
    const a=await receive(),b=await receive(2);
    await env.admin.query("INSERT INTO retained_legacy.private_data VALUES('existing-synthetic-target')");
    await t.test('effective SQL roles reject real cross-namespace targets in both directions',async()=>{
      const targets=['intake_trial.receipt','retained_legacy.private_data','material_trial.material'];
      for(const table of targets)assert.ok((await env.admin.query('SELECT count(*)::int n FROM '+table)).rows[0].n>0);
      for(const [kind,connectionString,positive,negatives]of[
        ['intake-runtime',intake.connectionString,'SELECT id FROM intake_trial.receipt',['SELECT * FROM retained_legacy.private_data','SELECT * FROM material_trial.material']],
        ['intake-reader',intake.readerConnectionString,'SELECT id FROM intake_trial.receipt',['SELECT * FROM retained_legacy.private_data','SELECT * FROM material_trial.material']],
        ['access-runtime',env.runtimeConfig.connectionString,'SELECT id FROM access_trial.account',['SELECT * FROM intake_trial.receipt']],
        ['material-reader',env.reading.connectionString,'SELECT * FROM material_trial.material',['SELECT * FROM intake_trial.receipt']],
      ]){
        const connection=new Client({connectionString});await connection.connect();
        try{const role=(await connection.query('SELECT current_user role')).rows[0].role,positiveRows=(await connection.query(positive)).rowCount;assert.ok(positiveRows>0);
          for(const sql of negatives){let sqlState=null;try{await connection.query(sql);}catch(error){sqlState=error.code;}
            observations.push({case:'sql-cross-namespace',kind,role,positive,positiveRows,sql,sqlState});assert.equal(sqlState,'42501');}
        }finally{await connection.end();}
      }
    });
    await t.test('the existing sealed-file mode allows its exact read and denies a write-open by the effective broker identity',async()=>{
      const result=await administration('probe-object-privileges',{artifactId:a.original.id,sha256});observations.push({case:'sealed-mode',result});
      assert.deepEqual({uid:result.uid,mode:result.mode,bytes:result.bytes,sha256:result.sha256,writeCode:result.writeCode,afterSha256:result.afterSha256},
        {uid:1000,mode:256,bytes:17,sha256,writeCode:'EACCES',afterSha256:sha256});
    });
    await t.test('the effective runtime cannot chmod, replace or open a broker object because its volume is not mounted',async()=>{
      const stored=(await administration('inspect',{})).objects.find(o=>o.name===a.original.id+'-1.sealed');
      assert.ok(stored);assert.equal(stored.bytes,17);assert.equal(stored.sha256,sha256);assert.notEqual(process.getuid(),0);
      const file='/objects/'+a.original.id+'-1.sealed',codes=[];
      for(const [name,operation]of [['stat',()=>statSync(file)],['chmod',()=>chmodSync(file,0o600)],['overwrite',()=>writeFileSync(file,Buffer.from('unauthorized'))],['replace',()=>renameSync(file,file+'.replacement')]]){
        let code=null;try{operation();}catch(error){code=error.code;}codes.push({name,code});assert.equal(code,'ENOENT');
      }
      const after=(await administration('inspect',{})).objects.find(o=>o.name===stored.name);
      observations.push({case:'runtime-no-object-mount',uid:process.getuid(),stored,codes,after,limitation:'No-mount denial for runtime, not hostile-owner immutability inside the broker'});
      assert.deepEqual(after,stored);const allowed=await request(`/api/intake/receptions/${a.reception_id}/original`,{client});assert.deepEqual({status:allowed.status,bytes:allowed.bytes},{status:200,bytes:original});
    });
    await t.test('an active admitted original phase rejects another existing artifact and generation without opening it',async()=>{
      let observed=null;
      setBarrier(async(label,event)=>{
        if(label!=='before_original_read'||event.receptionId!==a.reception_id||observed)return;
        const phase=(await env.admin.query('SELECT * FROM intake_control.private_phase WHERE evidence_id=$1',[event.evidenceId])).rows;
        assert.equal(phase.length,1);assert.equal(phase[0].artifact_id,a.original.id);
        const events=async()=>(await administration('observe-events',{})).events.filter(x=>x.origin==='object-boundary');
        const before=await events(),port=new PrivateIntakePort(intake.brokerSocket,1500000,1000,intake.namespace),statuses=[];
        for(const [phaseId,target]of [[phase[0].id,b.original],[randomUUID(),a.original]]){
          const result=await port.call({action:'read',phaseId,original:target,incarnation:intake.incarnation,evidenceId:event.evidenceId});
          statuses.push({ok:result.ok,outcome:result.outcome,bytes:result.bytes,dispatch:result.dispatch});
        }
        const after=await events();observed={phase:phase[0],otherExistingOriginal:b.original,before,statuses,after};observations.push({case:'wrong-private-target',...observed});
        assert.deepEqual(statuses,[0,1].map(()=>({ok:false,outcome:'denied',bytes:0,dispatch:'not-started'})));assert.deepEqual(after,before);
      });
      try{const positive=await request(`/api/intake/receptions/${a.reception_id}/original`,{client});assert.ok(observed);assert.deepEqual({status:positive.status,bytes:positive.bytes},{status:200,bytes:original});}
      finally{setBarrier(async()=>{});}
      const other=await request(`/api/intake/receptions/${b.reception_id}/original`,{client});assert.deepEqual({status:other.status,bytes:other.bytes},{status:200,bytes:original});
    });
  }finally{writeFileSync(output+'/observations.json',JSON.stringify(observations,null,2),{flag:'wx'});}
}
