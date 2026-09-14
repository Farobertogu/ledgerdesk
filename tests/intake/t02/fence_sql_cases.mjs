import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {Client} from 'pg';
import {ReceptionService} from '../../../src/server/intake/service.ts';
import {selected,phase as resolvePhase} from '../../../src/server/intake/reception.ts';
import {sessionToken} from '../../../src/server/access/transport.ts';
import {fenceSourceCases} from './fence_source_cases.mjs';
import {fenceBoundaryCases} from './fence_boundary_cases.mjs';

/** SQL-ordering prototype: association fixtures do not certify private-process closure. */
export async function fenceSqlCases(t,{env,intake,accessService,client,receptionId,request,declaration,probeLogin}){
  const observations=[];
  const service=new ReceptionService(intake,value=>accessService.digest(value),{},{});
  const head=async()=> (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0];
  const observe=async(name,body)=>{observations.push({name,...body,atMs:Date.now()});
    writeFileSync('/work/output/fence-sql-observations.json',JSON.stringify({profile:'fence-sql-prototype/1',
      privateWorkDispatched:false,acknowledgmentSource:'SQL association fixture, not physical closure evidence',observations},null,2));};
  async function open(id=receptionId,route='original'){
    const input={route,method:route==='original'?'GET':'POST',parameters:{id,generation:'1'},csrf:client.csrf,clientKey:null};
    const admission=await service.authority.open(input,sessionToken(client.cookie),['intake:reception:'+id],()=>{});
    try{
      await service.authority.beforeMetadata(admission,route);
      const {reception,attempt}=await selected(admission.db,id,admission.session.account_id);
      await service.authority.resolve(admission,route,undefined,reception,resolvePhase(admission,reception,attempt));
      const evidence=await service.evidence(admission,route,route==='original'?'read_admission':'capture_admission',
        {receptionId:id,artifactId:attempt.artifact_id,generation:attempt.generation});
      const phase=randomUUID(),plan=route==='original'?{objects:['read']}:{objects:['create','append']};
      const args=[phase,intake.namespace,evidence.id,intake.controlSource,intake.incarnation,JSON.stringify(plan),Math.min(admission.deadline,Number(attempt.expires_at))];
      return{admission,evidence,phase,reception,attempt,args,
        begin:()=>admission.db.query('SELECT intake_control.begin_phase($1,$2,$3,$4,$5,$6,$7) AS epoch',args),
        finish:(id=phase)=>admission.db.query('SELECT intake_control.finish_phase($1,$2,$3,$4,$5) AS epoch',
          [id,intake.controlSource,intake.incarnation,evidence.id,JSON.stringify({objects:{profile:'intake-phase-closed/1',id,participant:'objects'}})])};
    }catch(error){await admission.db.close();throw error;}
  }
  async function expectCode(work,code){let observed;try{await work();}catch(error){observed=error.code;}assert.equal(observed,code);return observed;}
  await t.test('F07 SQL registration and evidence roll back together before dispatch',async()=>{
    const p=await open();try{await p.begin();await p.admission.db.query('ROLLBACK');
      assert.deepEqual((await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_control.private_phase WHERE id=$1) AS phases,
        (SELECT count(*)::int FROM intake_trial.evidence WHERE id=$2) AS evidence`,[p.phase,p.evidence.id])).rows[0],{phases:0,evidence:0});
      assert.equal((await head()).active_phase,null);await observe('rollback',{phase:p.phase,evidence:p.evidence.id,head:await head()});
    }finally{await p.admission.db.close();}
  });
  await t.test('F08 an old RR mutation snapshot cannot bypass committed registration',async()=>{
    const writer=new Client(env.runtime.connectionParameters);await writer.connect();
    const p=await open();try{
      await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await writer.query('SELECT id FROM access_trial.account');
      await p.begin();await p.admission.db.commit();assert.equal((await head()).active_phase,p.phase);
      const code=await expectCode(()=>writer.query('UPDATE access_trial.session SET expires_at=expires_at WHERE account_id=$1',[p.admission.session.account_id]),'40001');
      await writer.query('ROLLBACK');await p.finish();await observe('old-RR-writer',{code,phase:p.phase,head:await head()});
    }finally{await writer.end();await p.admission.db.close();}
  });
  await t.test('F08 an old authorizing snapshot aborts registration after a shared source write',async()=>{
    const p=await open();try{
      await env.runtime.query('UPDATE access_trial.session SET expires_at=expires_at WHERE account_id=$1',[p.admission.session.account_id]);
      const code=await expectCode(()=>p.begin(),'40001');await p.admission.db.query('ROLLBACK');
      assert.equal((await env.admin.query('SELECT count(*)::int FROM intake_trial.evidence WHERE id=$1',[p.evidence.id])).rows[0].count,0);
      assert.equal((await head()).active_phase,null);await observe('old-registration',{code,phase:p.phase,head:await head()});
    }finally{await p.admission.db.close();}
  });
  await t.test('F09 direct RC source mutation refuses while active and succeeds after closure',async()=>{
    const p=await open();try{
      await p.begin();await p.admission.db.commit();
      const start=Date.now(),code=await expectCode(()=>env.runtime.query('UPDATE access_trial.session SET expires_at=expires_at WHERE account_id=$1',[p.admission.session.account_id]),'55P03');
      assert.ok(Date.now()-start<1000);await p.finish();
      const result=await env.runtime.query('UPDATE access_trial.session SET expires_at=expires_at WHERE account_id=$1',[p.admission.session.account_id]);assert.ok(result.rowCount>0);
      await observe('RC-writer',{code,milliseconds:Date.now()-start,updated:result.rowCount,head:await head()});
    }finally{await p.admission.db.close();}
  });
  await t.test('F10 direct stop and resume refuse an active phase before valid predecessors change',async()=>{
    const reserved=await request('/api/intake/receptions',{body:declaration,client,key:randomUUID()});assert.equal(reserved.status,202);
    const p=await open(reserved.body.reception_id,'upload_original');try{
      await p.begin();await p.admission.db.commit();
      const probes=[['SELECT intake_trial.stop_reception($1,$2,$3)',[p.reception.id,1,1]],
        ['SELECT intake_trial.resume_attempt($1,$2,$3,$4,$5,$6)',[p.reception.id,1,1,randomUUID(),intake.incarnation,p.attempt.expires_at]]];
      const runtime=new Client({connectionString:intake.connectionString});await runtime.connect();
      try{
        // Release normal admission to exercise the durable head, not the advisory lock.
        await p.admission.db.releaseAdmission();
        for(const [sql,args]of probes)await expectCode(()=>runtime.query(sql,args),'55P03');
        assert.equal((await head()).active_phase,p.phase);await p.finish();
        for(const [sql,args]of probes){await runtime.query('BEGIN');await runtime.query(sql,args);await runtime.query('ROLLBACK');}
        await observe('direct-stop-resume',{phase:p.phase,head:await head(),positiveTransitions:'executed then rolled back to retain the shared fixture'});
      }finally{await runtime.end();}
    }finally{await p.admission.db.close();}
  });
  await t.test('F11 retiring old A never clears the new active B',async()=>{
    const a=await open();await a.begin();await a.admission.db.commit();await a.finish();await a.admission.db.close();
    const b=await open();try{await b.begin();await b.admission.db.commit();
      const code=await expectCode(()=>b.admission.db.query('SELECT intake_control.finish_phase($1,$2,$3,$4,$5)',
        [a.phase,intake.controlSource,intake.incarnation,a.evidence.id,'{}']),'42501');
      assert.equal((await head()).active_phase,b.phase);await b.finish();await observe('stale-finish',{code,old:a.phase,current:b.phase,head:await head()});
    }finally{await b.admission.db.close();}
  });
  await t.test('F15 runtime and reader cannot rewrite the barrier or grant themselves source rights',async()=>{
    const codes=[];
    for(const connectionString of [intake.connectionString,intake.readerConnectionString]){
      const db=new Client({connectionString});await db.connect();try{
        for(const sql of ['UPDATE intake_control.fence_head SET active_phase=NULL','DELETE FROM intake_control.private_phase',
          'TRUNCATE intake_control.phase_completion','UPDATE access_trial.grant_record SET withdrawn=false',
          'ALTER TABLE intake_control.fence_head DISABLE TRIGGER ALL'])codes.push(await expectCode(()=>db.query(sql),'42501'));
      }finally{await db.end();}
    }
    await observe('privilege-boundary',{codes});
  });
  await fenceSourceCases(t,{env,open,head,observe,expectCode,probeLogin});
  await fenceBoundaryCases(t,{env,intake,open,head,observe,expectCode});
  await t.test('F04 SQL-only loss probe preserves the barrier after backend termination',async()=>{
    const p=await open();await p.begin();await p.admission.db.commit();
    const before=await head();
    // PostgreSQL's no-timeout form confirms a signal, not process termination.
    // https://www.postgresql.org/docs/16/functions-admin.html
    const terminated=(await env.admin.query('SELECT pg_terminate_backend($1,1000) AS stopped',[p.evidence.pid])).rows[0].stopped;
    assert.equal(terminated,true);
    const active=(await env.admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[p.evidence.pid])).rows[0].n;
    assert.equal(active,0);const code=await expectCode(()=>env.control.query('SELECT access_trial.set_support($1,$2,$3)',['domain',false,'synthetic fence probe']),'55P03');
    assert.deepEqual(await head(),before);assert.equal((await env.admin.query("SELECT active FROM access_trial.support_definition WHERE id='domain'")).rows[0].active,true);
    await observe('SQL-backend-loss-only',{phase:p.phase,backendPid:p.evidence.pid,backendCount:active,code,head:await head(),
      physicalWorkerLossCovered:false,recoveryCovered:false});
    await p.admission.db.close();
  });
}
