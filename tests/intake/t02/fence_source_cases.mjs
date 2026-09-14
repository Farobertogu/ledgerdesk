import assert from 'node:assert/strict';

// Independently enumerated from the admission sources, not extracted from the
// trigger-installation loop. Entire-statement coverage deliberately includes
// harmless column changes and the loaded-but-noninvalidating incompatibility set.
export const guardedSources=Object.freeze([
  ['access_trial','deployment','singleton'],['access_trial','account','id'],['access_trial','session','digest'],
  ['access_trial','permission_definition','id'],['access_trial','scope_definition','id'],['access_trial','support_definition','id'],
  ['access_trial','grant_record','id'],['access_trial','investiture','id'],['access_trial','revalidation_event','id'],
  ['access_trial','investiture_resolution','id'],['access_trial','incompatibility','id'],
  ['intake_control','live','singleton'],['intake_control','treatment_current','singleton'],['intake_control','catalog_entry','operation'],
  ['intake_control','profile','format'],['intake_control','namespace_admission','namespace'],
]);

export async function fenceSourceCases(t,{env,open,head,observe,expectCode,probeLogin}){
  await t.test('F09 installed statement guards cover the fixed source inventory, all columns and four mutation events',async()=>{
    const triggers=(await env.admin.query(`SELECT n.nspname AS schema,c.relname AS table,t.tgtype,t.tgenabled,t.tgattr::text AS columns,
      t.tgqual::text AS predicate,p.proname AS function,pg_get_userbyid(p.proowner) AS function_owner,p.prosecdef,p.proconfig,
      pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgname='intake_private_fence' ORDER BY n.nspname,c.relname`)).rows;
    assert.deepEqual(triggers.map(r=>r.schema+'.'+r.table).sort(),guardedSources.map(([s,t])=>s+'.'+t).sort());
    for(const row of triggers){
      assert.deepEqual({type:row.tgtype,enabled:row.tgenabled,columns:row.columns,predicate:row.predicate,
        function:row.function,owner:row.function_owner,definer:row.prosecdef},
      {type:62,enabled:'O',columns:'',predicate:null,function:'source_mutation_guard',owner:'inc03_intake_owner',definer:true});
      assert.ok(row.proconfig.includes('search_path=pg_catalog'));assert.ok(row.proconfig.includes('lock_timeout=250ms'));
    }
    const inventory=[];
    for(const [schema,table]of guardedSources){
      const relation=schema+'.'+table;
      const columns=(await env.admin.query(`SELECT attname AS name,format_type(atttypid,atttypmod) AS type
        FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[relation])).rows;
      const roles=[];
      for(const role of ['inc02_runtime','inc02_reader','inc02_control','inc03_intake_runtime','inc03_intake_reader','inc03_intake_control']){
        const tableRights=(await env.admin.query(`SELECT has_table_privilege($1,$2,'SELECT') AS select,
          has_table_privilege($1,$2,'INSERT') AS insert,has_table_privilege($1,$2,'UPDATE') AS update,
          has_table_privilege($1,$2,'DELETE') AS delete,has_table_privilege($1,$2,'TRUNCATE') AS truncate`,[role,relation])).rows[0];
        const columnRights=(await env.admin.query(`SELECT attname AS name,has_column_privilege($1,attrelid,attnum,'SELECT') AS select,
          has_column_privilege($1,attrelid,attnum,'INSERT') AS insert,has_column_privilege($1,attrelid,attnum,'UPDATE') AS update
          FROM pg_attribute WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[role,relation])).rows;
        if(role.startsWith('inc03_')){
          assert.deepEqual([tableRights.insert,tableRights.update,tableRights.delete,tableRights.truncate],[false,false,false,false]);
          assert.ok(columnRights.every(c=>!c.insert&&!c.update),'Intake must not receive a column-level source mutation grant');
        }
        roles.push({role,tableRights,columnRights});
      }
      inventory.push({relation,events:['INSERT','UPDATE','DELETE','TRUNCATE'],columns,roles,
        immutableTriggers:(await env.admin.query(`SELECT tgname AS name,pg_get_triggerdef(oid) AS definition FROM pg_trigger
          WHERE tgrelid=$1::regclass AND NOT tgisinternal AND tgname<>'intake_private_fence' ORDER BY tgname`,[relation])).rows});
    }
    const p=await open();try{
      await p.begin();await p.admission.db.commit();await p.admission.db.releaseAdmission();
      const checks=[];
      for(const [schema,table,column]of guardedSources){
        const role=schema==='access_trial'?'inc02_owner':'inc03_intake_owner';
        const statements=[`INSERT INTO ${schema}.${table} SELECT * FROM ${schema}.${table} WHERE false`,
          `UPDATE ${schema}.${table} SET ${column}=${column} WHERE false`,`DELETE FROM ${schema}.${table} WHERE false`,
          `TRUNCATE ${schema}.${table} CASCADE`];
        for(const sql of statements){
          await env.admin.query('BEGIN');await env.admin.query(`SET LOCAL ROLE ${role}`);
          try{const code=await expectCode(()=>env.admin.query(sql),'55P03');checks.push({schema,table,role,event:sql.split(' ')[0],code});}
          finally{await env.admin.query('ROLLBACK');}
        }
      }
      assert.equal((await head()).active_phase,p.phase);await p.finish();
      // Same syntactically valid statements, same effective installation owners,
      // now execute. Rollback preserves the populated synthetic fixture exactly.
      for(const [schema,table,column]of guardedSources){
        const role=schema==='access_trial'?'inc02_owner':'inc03_intake_owner';
        for(const sql of [`INSERT INTO ${schema}.${table} SELECT * FROM ${schema}.${table} WHERE false`,
          `UPDATE ${schema}.${table} SET ${column}=${column} WHERE false`,`DELETE FROM ${schema}.${table} WHERE false`,
          `TRUNCATE ${schema}.${table} CASCADE`]){
          await env.admin.query('BEGIN');await env.admin.query(`SET LOCAL ROLE ${role}`);
          try{await env.admin.query(sql);}finally{await env.admin.query('ROLLBACK');}
        }
      }
      await observe('fixed-source-statement-inventory',{triggers,inventory,checks,positive:'same statements executed with no phase and rolled back',
        limitation:'Statement trigger reachability is not an application authorization test or a claim of owner bypass resistance.'});
    }finally{await p.admission.db.close();}
  });
  await t.test('F09 actual runtime grant and account writes, direct control and shared login refuse a private phase',async()=>{
    const p=await open(),account=p.admission.session.account_id;
    const grant=(await env.admin.query('SELECT id FROM access_trial.grant_record WHERE account_id=$1 LIMIT 1',[account])).rows[0];assert.ok(grant);
    try{
      await p.begin();await p.admission.db.commit();await p.admission.db.releaseAdmission();
      const runtimeChanges=[['grant',()=>env.runtime.query('UPDATE access_trial.grant_record SET revision=revision WHERE id=$1',[grant.id])],
        ['account',()=>env.runtime.query('UPDATE access_trial.account SET revision=revision WHERE id=$1',[account])]];
      for(const [,change]of runtimeChanges)await expectCode(change,'55P03');
      await expectCode(()=>env.control.query('SELECT access_trial.restrict_account($1,true)',[account]),'55P03');
      await expectCode(()=>env.control.query('SELECT access_trial.set_support($1,false,$2)',['domain','bounded synthetic withdrawal']),'55P03');
      const before=Number((await env.admin.query('SELECT count(*) FROM access_trial.session')).rows[0].count);
      const login=await probeLogin();
      assert.deepEqual({status:login.status,sessions:Number((await env.admin.query('SELECT count(*) FROM access_trial.session')).rows[0].count)},
        {status:503,sessions:before});
      assert.equal((await head()).active_phase,p.phase);await p.finish();
      for(const [,change]of runtimeChanges)assert.equal((await change()).rowCount,1);
      const positive=await probeLogin();assert.equal(positive.status,200);
      // Run the actual controller setters in transactions, preserving the actor
      // and authority fixture afterward. Negative and positive share the entry.
      for(const [sql,args]of [['SELECT access_trial.restrict_account($1,true)',[account]],
        ['SELECT access_trial.set_support($1,false,$2)',['domain','bounded synthetic withdrawal']]]){
        await env.control.query('BEGIN');try{await env.control.query(sql,args);}finally{await env.control.query('ROLLBACK');}
      }
      await observe('actual-source-writers',{phase:p.phase,grantId:grant.id,accountId:account,deniedLogin:login.status,positiveLogin:positive.status});
    }finally{await p.admission.db.close();}
  });
}
