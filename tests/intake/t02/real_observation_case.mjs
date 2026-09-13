import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { administration } from './recovery_cases.mjs';
import { assertCase, MODULE_RELEASE } from './independent/index.mjs';

export {hash,responseHeaders,save,snapshot} from './observation_support.mjs';
import {hash,responseHeaders,save,snapshot} from './observation_support.mjs';

/** A real retained-original GET. Setup is outside, and frozen before, its bounded window. */
export async function realObservationCase(t,{env,intake,client,request,requestEvents,clientCalls,admissions,setBarrier,evidenceInserts,selections}){
  for(const mode of ['original','record','denied'])await t.test('real HTTPS/SQL/object observations: '+mode,async()=>{
    const binary=mode==='original',denied=mode==='denied';
    const cases=denied?[['IC08','query-denied']]:binary?[['IC01','round-trip'],['IC11','intact'],['IC14','whole'],['IC15','prior-evidence']]
      :[['IC11','query-only'],['IC14','record-only'],['IC15','prior-evidence']];
    const root='/work/output/real-observer/'+mode,fixtureRoot=root+'/fixed',evidenceRoot=root+'/observed';
    for(const [caseId] of cases)mkdirSync(fixtureRoot+'/references/'+caseId,{recursive:true});
    mkdirSync(evidenceRoot,{recursive:true});
    const before=await snapshot(env.admin),receipt=before.raw.receipt[0];
    assert.equal(before.raw.receipt.length,1);
    const reception=before.raw.reception.find(r=>r.id===receipt.reception_id);
    const reserve=before.raw.intention.find(i=>i.reception_id===reception.id&&i.variant==='reserve_reception');
    if(denied){
      const prior=(await env.admin.query("SELECT * FROM access_trial.grant_record WHERE account_id=$1 AND permission_id='intake_records' AND faculty='exercise'",[reception.principal])).rows;
      assert.equal(prior.length,1);assert.equal(prior[0].withdrawn,false);
      const changed=(await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=true,revision=revision+1 WHERE id=$1 RETURNING *',[prior[0].id])).rows;
      save(evidenceRoot+'/current-authority-withdrawal.json',{prior,changed,committedObservedAtMs:Date.now()});
      assert.equal(changed[0].withdrawn,true);
    }
    const fixture=readFileSync(new URL('../t01/fixtures/bom.txt',import.meta.url));
    assert.deepEqual([fixture.length,hash(fixture)],[17,'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9']);
    const route=`/api/intake/receptions/${reception.id}`+(binary?'/original':'');
    const references={
      'bom.txt':fixture,
      'references/actors.json':{executorRef:'intake-service:'+intake.incarnation,
        bindings:before.packet.principalBindings.map(b=>({accountId:b.accountId,personId:b.personId}))},
      ...Object.fromEntries(cases.map(([caseId,variant])=>['references/'+caseId+'/'+variant+'.calls.json',{calls:[{label:'subject',method:'GET',route,requestClass:'noncanonical-query',
        principal:reception.principal,receptionId:denied?null:reception.id,
        allowedAccess:(binary?['open','read']:[]).map(kind=>({kind,artifactId:receipt.artifact_id,generation:receipt.generation}))}]}])),
    };
    for(const [name,value]of Object.entries(references)){save(fixtureRoot+'/'+name,value);chmodSync(fixtureRoot+'/'+name,0o400);}
    save(evidenceRoot+'/reference-freeze.json',{atMs:Date.now(),scope:'completed setup before the measured GET',
      setup:before,files:Object.keys(references).map(file=>({file,sha256:hash(readFileSync(fixtureRoot+'/'+file))}))});
    if(binary){save('/work/output/observer-fault-armed',{});assert.equal((await administration('arm-observer',{})).ok,true);}
    const objectsBefore=await administration('observe-events',{}),eventStart=requestEvents.length,callStart=clientCalls.length;
    const retained=[],barrierRecords=[];
    setBarrier(async(label,event)=>{
      if(!['before_original_read','before_handoff'].includes(label))return;
      const reachedAtMs=Date.now();
      const written=evidenceInserts.filter(e=>e.callId===event.callId&&!retained.some(r=>r.row.id===e.id));
      const rows=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=ANY($1::uuid[])',[written.map(e=>e.id)])).rows;
      assert.equal(rows.length,written.length,'Written evidence must be independently visible before relying on its commit');
      assert.ok(rows.some(e=>e.id===event.evidenceId)||retained.some(e=>e.row.id===event.evidenceId));
      const backend=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows[0];
      assert.deepEqual([backend.state,backend.xact_start],['idle',null]);
      for(const e of rows)retained.push({callId:event.callId,row:e,backend,observedAtMs:Date.now()});
      barrierRecords.push({origin:'test-controller',label,reachedAtMs,releasedAtMs:Date.now(),writerCommittedAtMs:null,
        clientBytesAtPause:clientCalls.at(-1).receivedBytes,backendPid:event.backendPid,transactionOpen:backend.xact_start!==null});
    });
    let result;
    try{result=await request(route,{client});}finally{setBarrier(async()=>{});}
    const after=await snapshot(env.admin),objectsAfter=await administration('observe-events',{});
    save(evidenceRoot+'/physical-before.json',objectsBefore);save(evidenceRoot+'/physical-after.json',objectsAfter);
    save(evidenceRoot+'/durable-barriers.json',retained);save(evidenceRoot+'/before.json',before);save(evidenceRoot+'/after.json',after);
    assert.deepEqual(objectsAfter.events.slice(0,objectsBefore.events.length),objectsBefore.events,'Raw event prefix remains intact');
    const actual=requestEvents.slice(eventStart),boundaries=actual.filter(e=>e.kind==='server-request'),calls=clientCalls.slice(callStart);
    save(evidenceRoot+'/raw-requests.json',{actual,calls});
    assert.deepEqual([boundaries.length,calls.length],[1,1],'Every actual call in this window must be accounted for');
    const boundary=boundaries[0],call=calls[0],authorized=admissions.filter(e=>e.callId===boundary.callId&&e.kind===(denied?'refused':'authorized'));
    assert.ok(authorized.length);const admission=authorized[0];
    const selected=selections.filter(e=>e.callId===boundary.callId);
    assert.equal(selected.length,denied?0:1);
    const selectedId=selected[0]?.receptionId??null;
    assert.equal(selectedId,denied?null:reception.id);
    assert.equal(actual.filter(e=>e.kind==='application-read').length,0);
    const evidence=retained.map(({callId,row:e,backend})=>({origin:'sql-observer',callId,receptionId:e.reception_id,
      id:e.id,phase:e.phase,operationId:e.operation_id,artifactId:e.artifact_id,generation:e.generation,
      principal:e.principal,status:e.status,atMs:Number(e.recorded_at),backendPid:e.backend_pid,transactionOpen:backend.xact_start!==null}));
    const storage=objectsAfter.events.slice(objectsBefore.events.length).filter(e=>e.origin==='object-boundary').map(e=>{
      const binding=retained.find(x=>x.row.id===e.evidenceId);assert.ok(binding,'No unidentified protected event can be dropped');
      return {origin:e.origin,kind:e.kind,artifactId:e.artifactId,generation:e.generation,bytes:e.bytes,offset:e.offset,
        evidenceId:e.evidenceId,atMs:e.atMs,incarnation:e.incarnation,
        callId:binding.callId,receptionId:binding.row.reception_id,operationId:binding.row.operation_id};
    });
    const end=actual.filter(e=>e.kind==='terminal-end');assert.equal(end.length,1);
    const delivery=retained.find(e=>e.row.phase==='delivery');
    let durableTransport=[];
    for(let i=0;delivery&&i<20;i++){
      durableTransport=(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[delivery.row.id])).rows;
      if(durableTransport.length)break;await delay(10);
    }
    assert.equal(durableTransport.length,denied?0:1);save(evidenceRoot+'/durable-transport.json',durableTransport);
    if(denied){assert.deepEqual({status:result.status,authority:admission.status,evidence:evidence.length,storage:storage.length},
      {status:404,authority:404,evidence:0,storage:0});}
    else{
      assert.ok(delivery);
      assert.deepEqual([end[0].destroyed,end[0].writableEnded,durableTransport[0].outcome],[false,true,'handed_off']);
      assert.deepEqual([delivery.row.status,end[0].status],[result.status,result.status],
        'Same-evidence completed handoff retains the prepared HTTP status, not transaction success');
    }
    save(evidenceRoot+'/response.bin',result.bytes);
    const source=JSON.parse(readFileSync('/work/output/observer-source.json','utf8'));
    const packet={profile:'intake-observation/1',interfaceRevision:3,interfaceAddendum:'3.2',caseId:cases[0][0],variant:cases[0][1],
      ...source,input:{fixture:'bom.txt',artifactId:receipt.artifact_id,generation:receipt.generation,principal:reception.principal,
        subject:{receptionId:selectedId,callId:boundary.callId,queryIntentionId:denied?null:reserve.id,finalizationIntentionId:denied?null:receipt.operation_id}},
      before:before.packet,after:after.packet,
      responses:[{origin:'https-client',label:'subject',route,status:result.status,
        headers:Object.fromEntries(Object.entries(result.headers).filter(([key])=>responseHeaders.has(key))),
        body:binary?null:result.body,bodyFile:binary?'response.bin':null,bytes:result.bytes.length,sha256:hash(result.bytes),atMs:call.atMs}],
      storage,control:[],evidence,transport:delivery?[{origin:'terminal-boundary',route,operationId:delivery.row.operation_id,
        evidenceId:delivery.row.id,kind:'handoff',bytes:end[0].bytes,atMs:end[0].atMs,callId:boundary.callId,receptionId:reception.id}]:[],
      barriers:barrierRecords,temporal:null,
      requestBoundaries:[{origin:'https-client-and-server-boundary',callId:boundary.callId,label:'subject',
        requestClass:'noncanonical-query',method:boundary.method,route:boundary.route,client:call.socket,
        server:{...boundary.socket,observedAtMs:boundary.atMs,boundary:'application-consumer'},correlationMode:'connection-and-request',
        principal:admission.principal,receptionId:selectedId,
        admission:{result:denied?'denied':'accepted',source:'current-sql-admission',observedAtMs:admission.atMs,backendPid:admission.backendPid,
          controlSourceId:admission.controlSourceId,controlRevision:admission.controlRevision},responseLabel:'subject'}]};
    for(const [caseId,variant]of cases){
      const selected={...packet,caseId,variant};save(evidenceRoot+'/'+caseId+'-'+variant+'-packet.json',selected);
      const verdict=assertCase(caseId,variant,selected,{fixtureRoot,evidenceRoot});
      save(evidenceRoot+'/'+caseId+'-'+variant+'-verdict.json',{release:MODULE_RELEASE,...verdict,
        scope:'One actual GET reused for the named checks, not an additional execution; setup effects predate this window'});
    }
  });
}
