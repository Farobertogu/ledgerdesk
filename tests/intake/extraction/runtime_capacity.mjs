import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from 'pg';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
import {extractionControl,processingTreatment} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';
import {compareTiming,TIMING_PROTOCOL} from '../../reading/timing_comparison.mjs';

/** Coupled SQL quota, retained objects and authorized metadata/content queries. */
export async function extractionCapacityCases(t,{env,intake,client,request,admissions}){
  await extractionControl(env,{allFormats:true});
  const observations=[],service=new ExtractionService(intake),reserve=EXTRACTION_BOUNDS.conservedBytes;
  const capacity=async()=>(await env.admin.query('SELECT capacity_bytes::int,charged_bytes::int FROM intake_trial.extraction_capacity')).rows[0];
  const reservation=async job=>(await env.admin.query(`SELECT attempt_generation,reserved_bytes::int,charged_bytes::int,state
    FROM intake_trial.extraction_reservation WHERE job_id=$1 ORDER BY attempt_generation`,[job])).rows;
  const counter=async()=>{
    const a=(await administration('observe-extraction',{participant:'extraction'})).events;
    const b=(await administration('observe-extraction',{participant:'outputs'})).events;
    const o=(await administration('observe-extraction',{participant:'objects'})).events;
    return {queued:a.filter(e=>e.kind==='queued').length,raw:a.filter(e=>e.kind==='protected-raw-read').length,
      normalized:b.filter(e=>e.kind==='protected-normalized-read').length,original:o.filter(e=>e.kind==='read').length};
  };
  const query=job=>request('/api/intake/extractions/'+job,{client});
  const setFields=async(fields,scope='organisation')=>{
    if(fields===null){await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[processingTreatment.id]);return;}
    const id='query-treatment-'+randomUUID();
    await env.admin.query(`INSERT INTO intake_control.treatment SELECT $1,1,$2,$5,purpose_ref,$3,actions,
      receiver,storage,processor,response_destination,disposition_ref,expires_at FROM intake_control.treatment WHERE id=$4`,
      [id,'c'.repeat(64),fields,processingTreatment.id,scope]);
    await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[id]);
  };
  let first,second,denied;
  try{
    await t.test('CAP01 actual dispatch reserves before reading and accepted bytes settle once',async()=>{
      first=await receivedOriginal(request,client,Buffer.from('Capacity keeps the earlier result useful.\n'));
      let observed=false;
      const guarded=new ExtractionService(intake,{barrier:async label=>{
        if(label!=='before_extraction_original_read')return;
        observed=true;assert.deepEqual(await reservation(first.work.id),[{attempt_generation:1,reserved_bytes:reserve,charged_bytes:reserve,state:'reserved'}]);
      }});
      const before=await counter();await guarded.dispatch(first.work.id);assert.equal(observed,true);
      assert.equal((await counter()).queued,before.queued+1);
      assert.equal((await capacity()).charged_bytes,reserve);
      await service.accept(first.work.id);
      const output=(await env.admin.query('SELECT bytes FROM intake_trial.extraction_output WHERE job_id=$1',[first.work.id])).rows[0];
      assert.deepEqual(await reservation(first.work.id),[{attempt_generation:1,reserved_bytes:reserve,charged_bytes:output.bytes,state:'durable'}]);
      assert.equal((await capacity()).charged_bytes,output.bytes);
      assert.equal((await query(first.work.id)).body.result.content.elements.map(e=>e.text).join(''),'Capacity keeps the earlier result useful.\n');
      observations.push({case:'CAP01',capacity:await capacity(),reservation:await reservation(first.work.id)});
    });
    await t.test('CAP02 insufficient aggregate capacity refuses before original read or launch despite free job slots',async()=>{
      denied=await receivedOriginal(request,client,Buffer.from('This dispatch must not start.\n'));
      const base=await capacity(),before=await counter();let protectedReads=0;
      await env.admin.query('UPDATE intake_trial.extraction_capacity SET capacity_bytes=charged_bytes+$1',[reserve-1]);
      try{
        const guarded=new ExtractionService(intake,{barrier:async label=>{if(label==='before_extraction_original_read')protectedReads++;}});
        await assert.rejects(guarded.dispatch(denied.work.id),/INTAKE_429/);
        assert.deepEqual({protectedReads,counters:await counter(),reservations:await reservation(denied.work.id)},
          {protectedReads:0,counters:before,reservations:[]});
        const state=(await env.admin.query(`SELECT count(*)::int AS jobs,count(*) FILTER(WHERE state IN
          ('claimed','running','result_staged','stopping','uncertain'))::int AS live FROM intake_trial.extraction_job`)).rows[0];
        assert.ok(state.jobs<32);assert.equal(state.live,0);
        assert.equal((await query(first.work.id)).status,200);
      }finally{await env.admin.query('UPDATE intake_trial.extraction_capacity SET capacity_bytes=$1',[base.capacity_bytes]);}
      observations.push({case:'CAP02',protectedReads,capacity:await capacity()});
    });
    await t.test('CAP03 sealed-before-SQL and staged restart retain one obligation, then one durable charge',async()=>{
      second=await receivedOriginal(request,client,Buffer.from('The retained seal must survive reconciliation.\n'));
      const base=await capacity();
      const sealing=new ExtractionService(intake,{barrier:async label=>{if(label==='after_extraction_seal_before_sql')throw Error('CAP_SEAL_SQL_GAP');}});
      await sealing.dispatch(second.work.id);await assert.rejects(sealing.accept(second.work.id),/CAP_SEAL_SQL_GAP/);
      assert.equal((await capacity()).charged_bytes,base.charged_bytes+reserve);
      assert.equal((await reservation(second.work.id))[0].state,'reserved');
      const staged=new ExtractionService(intake,{barrier:async label=>{if(label==='after_extraction_stage_commit')throw Error('CAP_STAGED_REPLY_LOST');}});
      await assert.rejects(staged.accept(second.work.id),/CAP_STAGED_REPLY_LOST/);
      const charged=await capacity(),before=await counter();
      const result=await new ExtractionService(intake).accept(second.work.id);
      assert.deepEqual(await capacity(),charged);assert.deepEqual(await counter(),before);
      assert.equal((await query(second.work.id)).body.result.id,result.resultId);
      observations.push({case:'CAP03',capacity:charged,reservation:await reservation(second.work.id)});
    });
    await t.test('CAP04 a genuinely failed extraction is conserved and charged, not deleted to make room',async()=>{
      const r=await receivedOriginal(request,client,Buffer.from('a\n'.repeat(1001)),{name:'record-limit.csv',format:'csv-utf8/1',media:'text/csv'});
      await service.dispatch(r.work.id);await service.accept(r.work.id);
      const q=await query(r.work.id);assert.equal(q.status,200);assert.equal(q.body.result.content.outcome,'failed');
      const row=(await env.admin.query('SELECT bytes FROM intake_trial.extraction_output WHERE job_id=$1',[r.work.id])).rows[0];
      assert.deepEqual(await reservation(r.work.id),[{attempt_generation:1,reserved_bytes:reserve,charged_bytes:row.bytes,state:'durable'}]);
      assert.ok(row.bytes>0);observations.push({case:'CAP04',job:r.work.id,reservation:await reservation(r.work.id)});
    });
    await t.test('META01 useful historical metadata does not materialize any protected extraction body',async()=>{
      await setFields(['intake-metadata']);
      try{
        const before=await counter(),q=await query(first.work.id);
        assert.deepEqual({status:q.status,view:q.body.view,state:q.body.extraction.state,result:!!q.body.result,
          resultFields:Object.keys(q.body.result).sort(),counters:await counter()},
          {status:200,view:'metadata',state:'accepted',result:true,resultFields:['attempt_generation','effect','id'],counters:before});
        assert.equal(JSON.stringify(q.body).includes('Capacity keeps'),false);
        observations.push({case:'META01',projection:q.body,counters:before});
      }finally{await setFields(null);}
    });
    await t.test('META02 original and extraction content permissions are independent',async()=>{
      await setFields(['intake-metadata','extraction-body']);
      try{
        const q=await query(first.work.id);assert.equal(q.status,200);assert.equal(q.body.view,'content');
        assert.equal(q.body.result.content.elements.map(e=>e.text).join(''),'Capacity keeps the earlier result useful.\n');
        assert.equal((await request('/api/intake/receptions/'+first.reception_id+'/original',{client})).status,404);
      }finally{await setFields(null);}
      await setFields(['intake-metadata','original-body']);
      try{
        const before=await counter(),q=await query(first.work.id);
        assert.deepEqual({status:q.status,view:q.body.view,counters:await counter()},{status:200,view:'metadata',counters:before});
        const original=await request('/api/intake/receptions/'+first.reception_id+'/original',{client});
        assert.equal(original.status,200);assert.equal(original.bytes.toString(),'Capacity keeps the earlier result useful.\n');
      }finally{await setFields(null);}
    });
    await t.test('META03 withdrawn query authority is neutral for existing and absent records without body reads',async()=>{
      const before=await counter(),absent=randomUUID(),times={hidden:[],absent:[]};
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE permission_id='intake_extraction_read'");
      try{
        let reference;
        for(let i=0;i<TIMING_PROTOCOL.warmupRounds+TIMING_PROTOCOL.rounds;i++)for(const name of i%2?['hidden','absent']:['absent','hidden']){
          const r=await query(name==='hidden'?first.work.id:absent);
          const observation={status:r.status,headers:r.headers,body:r.bytes.toString()};
          assert.equal(r.status,404);if(reference)assert.deepEqual(observation,reference);else reference=observation;
          if(i>=TIMING_PROTOCOL.warmupRounds)times[name].push(r.elapsedMs);
        }
        const comparison=compareTiming(times),shifted=compareTiming({hidden:times.hidden,absent:times.absent.map(v=>v+100)});
        observations.push({case:'META03',comparison,shifted,counters:await counter()});
        assert.deepEqual(await counter(),before);assert.equal(comparison.signalDetected,false);assert.equal(shifted.signalDetected,true);
      }finally{await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE permission_id='intake_extraction_read'");}
      assert.equal((await query(first.work.id)).status,200);
    });
    await t.test('META04 an admitted query cannot distinguish an out-of-population record from absence',async()=>{
      await setFields(['intake-metadata'],'inc02-material');
      const before=await counter(),absent=randomUUID(),times={hidden:[],absent:[]},admissionStart=admissions.length;
      try{
        let reference;
        for(let i=0;i<TIMING_PROTOCOL.warmupRounds+TIMING_PROTOCOL.rounds;i++)for(const name of i%2?['hidden','absent']:['absent','hidden']){
          const r=await query(name==='hidden'?first.work.id:absent),observation={status:r.status,headers:r.headers,body:r.bytes.toString()};
          assert.equal(r.status,404);if(reference)assert.deepEqual(observation,reference);else reference=observation;
          if(i>=TIMING_PROTOCOL.warmupRounds)times[name].push(r.elapsedMs);
        }
        const comparison=compareTiming(times),shifted=compareTiming({hidden:times.hidden,absent:times.absent.map(v=>v+100)});
        observations.push({case:'META04',comparison,shifted,counters:await counter()});
        assert.equal(admissions.slice(admissionStart).filter(e=>e.kind==='authorized'&&e.operation==='extraction').length,
          2*(TIMING_PROTOCOL.warmupRounds+TIMING_PROTOCOL.rounds),'Both populations must reach current query authorization');
        assert.deepEqual(await counter(),before);assert.equal(comparison.signalDetected,false);assert.equal(shifted.signalDetected,true);
      }finally{await setFields(null);}
      assert.equal((await query(first.work.id)).status,200);
    });
    await t.test('CAP05 independent SQL attempts compete for one remaining reservation without a service mutex',async()=>{
      // Exercise the actual AFTER INSERT reservation trigger under two database
      // connections, without claim_extraction's separate one-live-job guard.
      // These isolated SQL fixture attempts do not claim a second execution or
      // new authorization; the earlier cases cover the real service admission.
      const clients=[new Client(env.admin.connectionParameters),new Client(env.admin.connectionParameters)];
      const base=await capacity();await env.admin.query('UPDATE intake_trial.extraction_capacity SET capacity_bytes=charged_bytes+$1',[reserve]);
      const insert=async(db,job)=>db.query(`INSERT INTO intake_trial.extraction_attempt
        SELECT job_id,2,$2,$3,$4,binding,input_evidence,deadline_ms,created_at,$5 FROM intake_trial.extraction_attempt
        WHERE job_id=$1 AND attempt_generation=1`,[job,randomUUID(),randomUUID(),randomUUID(),randomUUID()]);
      let waiting,committed=false;
      try{
        await Promise.all(clients.map(c=>c.connect()));
        for(const c of clients)await c.query("BEGIN; SET LOCAL statement_timeout='5s'");
        await insert(clients[0],first.work.id);
        waiting=insert(clients[1],second.work.id).then(()=>({code:'unexpected-success'}),e=>({code:e.code}));
        const pid=clients[1].processID,until=Date.now()+2000;let blocked=false;
        while(Date.now()<until){const a=(await env.admin.query('SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
          if(a?.wait_event_type==='Lock'&&a.blockers.includes(clients[0].processID)){blocked=true;break;}await delay(10);}
        assert.equal(blocked,true,'The second reservation must reach the actual capacity-row lock');
        await clients[0].query('COMMIT');committed=true;
        assert.deepEqual(await waiting,{code:'53400'});await clients[1].query('ROLLBACK');
        assert.equal((await capacity()).charged_bytes,base.charged_bytes+reserve);
        assert.equal((await reservation(second.work.id)).length,1);
        assert.equal((await query(first.work.id)).status,200);
        observations.push({case:'CAP05',blocked,firstCommitted:committed,secondCode:'53400',capacity:await capacity(),
          scope:'Actual reservation trigger under independent SQL transactions; no second worker or accepted effect is claimed.'});
      }finally{
        for(const c of clients){try{await c.query('ROLLBACK');}catch{}await c.end();}
        await waiting;await env.admin.query('UPDATE intake_trial.extraction_capacity SET capacity_bytes=$1',[base.capacity_bytes]);
      }
    });
  }finally{
    writeFileSync('/work/output/extraction-capacity-query.json',JSON.stringify({observations,limits:EXTRACTION_BOUNDS,
      meaning:'Finite synthetic aggregate reservation is separate from scratch, original storage and OS disk quotas. Timing is the declared finite detector, not universal indistinguishability.',
      remaining:'R24 and browser investigations remain open.'},null,2),{flag:'wx'});
  }
}
