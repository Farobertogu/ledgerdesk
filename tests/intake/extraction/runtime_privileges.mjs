import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {validateIntake} from '../../../src/contracts/intake.ts';

export async function extractionPrivilegeCases(t,{env,intake,client,request}){
  await extractionControl(env);const observations=[];
  await env.admin.query("INSERT INTO retained_legacy.private_data VALUES('existing-synthetic-extraction-target')");
  // The retained synthetic NOLOGIN role receives only its own fixture. This
  // makes its positive meaningful without granting any new intake permission.
  await env.admin.query('GRANT USAGE ON SCHEMA retained_legacy TO retained_legacy; GRANT SELECT ON retained_legacy.private_data TO retained_legacy');
  const before=(await env.admin.query('SELECT * FROM material_trial.material ORDER BY 1,2,3')).rows;
  const tableInventory=async()=>(await env.admin.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN ('intake_trial','material_trial') ORDER BY 1,2")).rows;
  const inventory=await tableInventory();let receipt,effect;
  try{
    await t.test('PRIV01 real extraction persists its own result without changing material or enabling preparation',async()=>{
      receipt=await receivedOriginal(request,client,Buffer.from('Only an extraction, never a candidate.\n'));
      const service=new ExtractionService(intake);await service.dispatch(receipt.work.id);effect=await service.accept(receipt.work.id);
      const q=await request('/api/intake/extractions/'+receipt.work.id,{client});assert.equal(q.status,200);assert.equal(q.body.result.id,effect.resultId);
      for(const field of ['preparation','candidate','approval','publication'])assert.equal(Object.hasOwn(q.body.result.content,field),false);
      const denied=[];
      // Well-formed unavailable operations, not empty malformed bodies. These
      // references are selectors only; no preparation/candidate row is created.
      const ref={id:receipt.original.id,revision:1,sha256:receipt.original.sha256};
      const future={reserve_preparation:{profile:'intake/1',inputs:[ref],base:null,transformation:'exact_selection',
        selection:[{antecedent:ref,element_id:'line-1',resource:receipt.original}],payload:receipt.original,
        context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:ref}},
        constitute:{profile:'intake/1',proposal:ref,intended_unit:'U-test',disposition:'new',mode:'person'}};
      assert.equal(validateIntake('reserve_preparation',future.reserve_preparation),true);
      assert.equal(validateIntake('constitute',future.constitute),true);
      for(const [path,body]of [['/api/intake/preparation-attempts',future.reserve_preparation],['/api/intake/constitutions',future.constitute],['/api/intake/preparations/'+randomUUID()+'/revisions/1',undefined]]){
        // Unimplemented route is the existing envelope's 400, not an
        // implemented query's neutral unavailable-resource 404.
        const r=await request(path,{client,...(body?{body,key:randomUUID()}:{})});denied.push({path,status:r.status});assert.equal(r.status,400);
      }
      assert.deepEqual((await env.admin.query('SELECT * FROM material_trial.material ORDER BY 1,2,3')).rows,before);
      assert.deepEqual(await tableInventory(),inventory);observations.push({case:'PRIV01',receipt,effect,denied,inventory});
    });
    await t.test('PRIV02 effective roles read populated own targets and deny cross-namespace targets in both directions',async()=>{
      for(const table of ['intake_trial.extraction_result','intake_trial.extraction_output','retained_legacy.private_data','material_trial.material'])
        assert.ok((await env.admin.query('SELECT count(*)::int n FROM '+table)).rows[0].n>0);
      const own='SELECT id FROM intake_trial.extraction_result';
      for(const [kind,connectionString,positive,negative]of[
        ['intake-runtime',intake.connectionString,own,['SELECT * FROM retained_legacy.private_data','SELECT * FROM material_trial.material']],
        ['intake-reader',intake.readerConnectionString,own,['SELECT * FROM retained_legacy.private_data','SELECT * FROM material_trial.material']],
        ['access-runtime',env.runtimeConfig.connectionString,'SELECT id FROM access_trial.account',['SELECT * FROM intake_trial.extraction_result','SELECT * FROM intake_trial.extraction_output']],
        ['material-reader',env.reading.connectionString,'SELECT * FROM material_trial.material',['SELECT * FROM intake_trial.extraction_result','SELECT * FROM intake_trial.extraction_output']],
      ]){
        const db=new Client({connectionString});await db.connect();
        try{
          const role=(await db.query('SELECT current_user AS name')).rows[0].name;assert.ok((await db.query(positive)).rowCount>0);
          for(const sql of negative){let code=null;try{await db.query(sql);}catch(error){code=error.code;}
            observations.push({kind,role,positive,sql,code});assert.equal(code,'42501');}
        }finally{await db.end();}
      }
      await env.admin.query('SET ROLE retained_legacy');
      try{
        assert.equal((await env.admin.query('SELECT current_user AS name')).rows[0].name,'retained_legacy');
        assert.equal((await env.admin.query('SELECT * FROM retained_legacy.private_data')).rowCount,1);
        for(const sql of ['SELECT * FROM intake_trial.extraction_result','SELECT * FROM intake_trial.extraction_output']){
          let code=null;try{await env.admin.query(sql);}catch(error){code=error.code;}
          observations.push({kind:'retained-legacy',role:'retained_legacy',positive:'SELECT * FROM retained_legacy.private_data',sql,code});
          assert.equal(code,'42501');
        }
      }finally{await env.admin.query('RESET ROLE');}
      assert.equal((await env.admin.query("SELECT has_database_privilege('retained_legacy',current_database(),'CONNECT') permitted")).rows[0].permitted,false);
    });
  }finally{writeFileSync('/work/output/extraction-privileges.json',JSON.stringify({observations,
    scope:'Real populated SQL targets and authenticated unavailable future routes. No preparation/publication implementation, schema mutation by the service or real data.'},null,2),{flag:'wx'});}
}
