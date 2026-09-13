import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,chmodSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {snapshot,save,hash,responseHeaders} from './real_observation_case.mjs';
import {administration} from './recovery_cases.mjs';
import {assertCase,MODULE_RELEASE} from './independent/index.mjs';

const only=(rows,message)=>{assert.equal(rows.length,1,message);return rows[0];};
const actualBytes=e=>Buffer.isBuffer(e.data)?e.data:Buffer.from(e.data.data);
const namespace=(intake,event)=>({deployment:intake.deployment,principal:event.principal,act:event.act,variant:event.variant,clientKey:event.clientKey});

/** The reservation and real upload precede this window; finalization does not. */
export async function realCanonicalCase(t,context){
  const {env,intake,client,request,requestEvents,clientCalls,admissions,comparisons,incumbentComparisons,evidenceInserts,selections,setBarrier,variant}=context;
  await t.test('real finalization and canonical reconciliation: '+variant,async()=>{
    const caseId=variant==='receipt'?'IC05':'IC04',caseVariant=variant==='receipt'?'receipt':variant==='incompatible'?'incompatible':'compatible';
    const root='/work/output/real-canonical/'+variant,fixtureRoot=root+'/fixed',evidenceRoot=root+'/observed';
    mkdirSync(fixtureRoot+'/references/'+caseId,{recursive:true});mkdirSync(evidenceRoot,{recursive:true});
    const before=await snapshot(env.admin),reception=only(before.raw.reception),attempt=only(before.raw.attempt);
    assert.deepEqual([before.raw.receipt.length,reception.state,attempt.state],[0,'staged','sealed']);
    const route=`/api/intake/receptions/${reception.id}/finalize`;
    const original=readFileSync(new URL('../t01/fixtures/bom.txt',import.meta.url));
    assert.deepEqual([original.length,hash(original)],[17,'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9']);
    // Fixed protocol recipe, no import of the production resolver/canonicalizer or checker builder.
    const body={profile:'intake/1',expected_revision:reception.revision,
      original:{id:attempt.artifact_id,generation:attempt.generation,bytes:17,sha256:hash(original)},format_profile:'text-utf8/1'};
    const second={format_profile:body.format_profile,original:{sha256:body.original.sha256,bytes:17,generation:attempt.generation,id:attempt.artifact_id},
      expected_revision:body.expected_revision+(variant==='incompatible'?1:0),profile:'intake/1'};
    const recipes=[{label:'subject',key:'fixed-canonical-finalization-A',body,status:200},
      {label:'reconcile',key:variant==='new-key'?'fixed-canonical-finalization-B':'fixed-canonical-finalization-A',body:second,status:variant==='incompatible'?409:200}];
    if(variant==='receipt')recipes.pop();
    const references={'bom.txt':original,'references/actors.json':{executorRef:'intake-service:'+intake.incarnation,
      bindings:before.packet.principalBindings.map(b=>({accountId:b.accountId,personId:b.personId}))}};
    const invocationReferences=[];
    for(const r of recipes){
      references[r.label+'.wire.json']=Buffer.from(JSON.stringify(r.body));
      references[r.label+'.canonical.json']={profile:'canon_m09_1',contract:'intake/1',variant:'finalize_reception',
        path:{template:'/api/intake/receptions/:id/finalize',parameters:{id:reception.id}},query:{},body:r.body};
      invocationReferences.push({label:r.label,principal:reception.principal,clientKey:r.key,act:'CARGAR_MATERIAL',variant:'finalize_reception',
        target:{receptionId:reception.id,artifactId:attempt.artifact_id,generation:attempt.generation,expectedRevision:r.body.expected_revision},
        canonicalProfile:'canon_m09_1',keyVersion:1,wireFile:r.label+'.wire.json',canonicalFile:r.label+'.canonical.json'});
    }
    references['references/'+caseId+'/'+caseVariant+'.json']={executorRef:'intake-service:'+intake.incarnation,deployment:intake.deployment,invocations:invocationReferences};
    references['references/'+caseId+'/'+caseVariant+'.calls.json']={calls:recipes.map((r,i)=>({label:r.label,method:'POST',route,requestClass:'canonical-act',
      principal:reception.principal,receptionId:reception.id,allowedAccess:i===0?['open','read'].map(kind=>({kind,artifactId:attempt.artifact_id,generation:attempt.generation})):[]}))};
    for(const [file,value]of Object.entries(references)){save(fixtureRoot+'/'+file,value);chmodSync(fixtureRoot+'/'+file,0o400);}
    save(evidenceRoot+'/fixed-operation.json',{frozenAtMs:Date.now(),setupSnapshot:before,
      expectedStatuses:recipes.map(r=>r.status),references:Object.keys(references).map(file=>({file,sha256:hash(readFileSync(fixtureRoot+'/'+file))}))});
    const objectsBefore=await administration('observe-events',{}),start=requestEvents.length,clientStart=clientCalls.length;
    if(variant==='receipt'){
      const seal=only(objectsBefore.events.filter(e=>e.origin==='object-boundary'&&e.kind==='seal'&&e.artifactId===attempt.artifact_id&&e.generation===attempt.generation));
      const sealEvidence=only((await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[seal.evidenceId])).rows);
      const uploadCall=only(evidenceInserts.filter(e=>e.id===seal.evidenceId)).callId;
      const uploadRequest=only(requestEvents.filter(e=>e.callId===uploadCall&&e.kind==='server-request'));
      const artifact=only((await env.admin.query('SELECT * FROM intake_trial.artifact WHERE id=$1',[attempt.artifact_id])).rows);
      assert.deepEqual([seal.bytes,artifact.bytes,artifact.sha256,sealEvidence.reception_id],[17,17,hash(original),reception.id]);
      assert.equal(uploadRequest.route,`/api/intake/receptions/${reception.id}/attempts/${attempt.generation}/original`);
      save(evidenceRoot+'/prior-upload-seal-lineage.json',{scope:'Real completed setup upload before the finalization observation window; not reassigned to its later call',
        observedAtMs:Date.now(),seal,sealEvidence,uploadRequest,artifact});
    }
    const retained=[],pauses=[],measured=[];
    setBarrier(async(label,event)=>{
      if(!['before_metadata_read','before_original_read','before_handoff'].includes(label))return;
      const reachedAtMs=Date.now(),pending=evidenceInserts.filter(e=>e.callId===event.callId&&!retained.some(r=>r.row.id===e.id));
      const rows=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=ANY($1::uuid[])',[pending.map(e=>e.id)])).rows;
      assert.equal(rows.length,pending.length,'Evidence visibility comes from an independent connection');
      const backend=only((await env.admin.query('SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows);
      assert.deepEqual([backend.state,backend.xact_start],['idle',null]);
      for(const row of rows){
        const own=(await env.admin.query('SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1',[row.backend_pid])).rows[0]??null;
        if(own)assert.deepEqual([own.pid,own.state,own.xact_start],[row.backend_pid,'idle',null]);
        retained.push({callId:event.callId,row,backend:own,observedAtMs:Date.now()});
      }
      pauses.push({origin:'test-controller',label,reachedAtMs,releasedAtMs:Date.now(),writerCommittedAtMs:null,
        clientBytesAtPause:clientCalls.at(-1).receivedBytes,backendPid:backend.pid,transactionOpen:false});
    });
    try{
      for(const recipe of recipes){
        const boundaryStart=requestEvents.length;
        const reply=await request(route,{client,key:recipe.key,bytes:readFileSync(fixtureRoot+'/'+recipe.label+'.wire.json'),headers:{'content-type':'application/json'}});
        const events=requestEvents.slice(boundaryStart),server=only(events.filter(e=>e.kind==='server-request')),actualClient=clientCalls.at(-1);
        const consumed=Buffer.concat(events.filter(e=>e.kind==='application-read').map(actualBytes));
        save(evidenceRoot+'/'+recipe.label+'-consumed.bin',consumed);save(evidenceRoot+'/'+recipe.label+'-response.bin',reply.bytes);
        const comparison=only(comparisons.filter(e=>e.callId===server.callId));
        const observed=await snapshot(env.admin);
        // Include every committed INSERT attributed to this call, including pre-selection metadata rows.
        const pending=evidenceInserts.filter(e=>e.callId===server.callId&&!retained.some(r=>r.row.id===e.id));
        const remaining=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=ANY($1::uuid[])',[pending.map(e=>e.id)])).rows;
        for(const row of remaining){
          const backend=(await env.admin.query('SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1',[row.backend_pid])).rows[0]??null;
          assert.ok(!backend||backend.xact_start===null);retained.push({callId:server.callId,row,backend,observedAtMs:Date.now()});
        }
        const rows=observed.raw.intention.filter(i=>i.deployment===intake.deployment&&i.principal===comparison.principal&&i.act===comparison.act&&i.variant===comparison.variant&&i.client_key===server.clientKey);
        const receipt=only(observed.raw.receipt),job=only(observed.raw.work);
        const row=rows.length?only(rows):only(observed.raw.intention.filter(i=>i.id===receipt.operation_id));
        measured.push({recipe,reply,events,server,actualClient,comparison,consumed,observed,rows,row,receipt,job,
          selected:only(selections.filter(e=>e.callId===server.callId)),
          admission:admissions.filter(e=>e.callId===server.callId&&e.kind==='authorized')[0],
          incumbent:incumbentComparisons.find(e=>e.callId===server.callId)??null});
      }
    }finally{setBarrier(async()=>{});}
    const objectsAfter=await administration('observe-events',{}),after=await snapshot(env.admin);
    save(evidenceRoot+'/raw.json',{before,after,objectsBefore,objectsAfter,retained,pauses,measured,
      requestEvents:requestEvents.slice(start),clientCalls:clientCalls.slice(clientStart)});
    assert.deepEqual(objectsAfter.events.slice(0,objectsBefore.events.length),objectsBefore.events);
    assert.deepEqual(measured.map(m=>m.reply.status),recipes.map(r=>r.status));
    assert.deepEqual([after.raw.receipt.length,after.raw.work.length],[1,1]);
    for(const m of measured){assert.equal(m.server.clientKey,m.recipe.key);assert.deepEqual(m.consumed,readFileSync(fixtureRoot+'/'+m.recipe.label+'.wire.json'));}
    const evidence=retained.map(({callId,row:e,backend})=>({origin:'sql-observer',callId,id:e.id,phase:e.phase,
      operationId:e.operation_id,receptionId:e.reception_id,artifactId:e.artifact_id,generation:e.generation,principal:e.principal,
      status:e.status,atMs:Number(e.recorded_at),backendPid:e.backend_pid,transactionOpen:backend===null?null:backend.xact_start!==null,
      ...(e.phase==='effect'?{personRef:e.binding.load.person.id,executorRef:e.binding.phase.executor.id}:{})}));
    const storage=objectsAfter.events.slice(objectsBefore.events.length).filter(e=>e.origin==='object-boundary').map(e=>{
      const bound=only(retained.filter(x=>x.row.id===e.evidenceId),'Every physical event needs its real prior SQL admission');
      return {origin:e.origin,kind:e.kind,artifactId:e.artifactId,generation:e.generation,bytes:e.bytes,offset:e.offset,evidenceId:e.evidenceId,
        atMs:e.atMs,incarnation:e.incarnation,callId:bound.callId,receptionId:bound.row.reception_id,operationId:bound.row.operation_id};
    });
    const transport=[];
    for(const m of measured){
      const deliveries=retained.filter(e=>e.callId===m.server.callId&&e.row.phase==='delivery');
      if(!deliveries.length){assert.equal(m.reply.status,409);continue;}
      const delivery=only(deliveries),end=only(m.events.filter(e=>e.kind==='terminal-end'));let rows=[];
      for(let i=0;i<20;i++){rows=(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[delivery.row.id])).rows;if(rows.length)break;await delay(10);}
      assert.deepEqual([only(rows).outcome,end.status,delivery.row.status],['handed_off',m.recipe.status,m.recipe.status]);
      save(evidenceRoot+'/'+m.recipe.label+'-transport.json',{rows,end});
      transport.push({origin:'terminal-boundary',route,operationId:delivery.row.operation_id,evidenceId:delivery.row.id,kind:'handoff',
        bytes:end.bytes,atMs:end.atMs,callId:m.server.callId,receptionId:delivery.row.reception_id});
    }
    const subject=m=>({receptionId:m.selected.receptionId,callId:m.server.callId,
      queryIntentionId:null,finalizationIntentionId:m.receipt.operation_id});
    const packet={profile:'intake-observation/1',interfaceRevision:3,interfaceAddendum:'3.2',caseId,variant:caseVariant,
      ...JSON.parse(readFileSync('/work/output/observer-source.json','utf8')),
      input:{fixture:'bom.txt',artifactId:attempt.artifact_id,generation:attempt.generation,principal:reception.principal,subject:subject(measured[0])},
      before:before.packet,after:after.packet,storage,evidence,transport,barriers:pauses,control:[],temporal:null,
      responses:measured.map(m=>({origin:'https-client',label:m.recipe.label,route,status:m.reply.status,
        headers:Object.fromEntries(Object.entries(m.reply.headers).filter(([k])=>responseHeaders.has(k))),body:m.reply.body,bodyFile:null,
        bytes:m.reply.bytes.length,sha256:hash(m.reply.bytes),atMs:m.actualClient.atMs})),
      requestBoundaries:measured.map(m=>({origin:'https-client-and-server-boundary',callId:m.server.callId,label:m.recipe.label,requestClass:'canonical-act',method:m.server.method,route:m.server.route,
        client:m.actualClient.socket,server:{...m.server.socket,observedAtMs:m.server.atMs,boundary:'application-consumer'},correlationMode:'connection-and-request',
        principal:m.admission.principal,receptionId:m.selected.receptionId,responseLabel:m.recipe.label,
        admission:{result:'accepted',source:'current-sql-admission',observedAtMs:m.admission.atMs,backendPid:m.admission.backendPid,controlSourceId:m.admission.controlSourceId,controlRevision:m.admission.controlRevision}})),
      invocations:measured.map(m=>({origin:'https-client-and-request-observer',label:m.recipe.label,callId:m.server.callId,principal:m.comparison.principal,
        clientKey:m.server.clientKey,act:m.comparison.act,variant:m.comparison.variant,
        target:{receptionId:m.selected.receptionId,artifactId:JSON.parse(m.consumed).original.id,generation:JSON.parse(m.consumed).original.generation,expectedRevision:JSON.parse(m.consumed).expected_revision},
        subject:subject(m),wireBodySha256:hash(m.consumed),canonicalPayloadSha256:m.comparison.comparedCanonicalSha256,
        canonicalProfile:m.comparison.canonicalProfile,keyVersion:m.comparison.keyVersion,responseLabel:m.recipe.label})),
      comparisons:measured.map(m=>({...m.comparison,label:m.recipe.label,phase:'namespace-lookup',row:m.comparison.operationId===null?'absent':'present'})),
      incumbentComparisons:measured.flatMap(m=>m.incumbent?[{...m.incumbent,label:m.recipe.label}]:[]),
      correlations:measured.map(m=>({origin:'independent-sql-observer',callId:m.server.callId,atMs:m.observed.packet.atMs,
        namespace:namespace(intake,m.comparison),outcome:'confirmed',observation:{resolution:m.rows.length?'same-namespace':'existing-reception-effect',
          operationId:m.row.id,receptionId:m.row.reception_id,storedPayloadDigest:m.row.payload_digest,effectId:m.row.effect_id,
          receiptId:m.receipt.id,jobId:m.job.id,observerBackendPid:m.observed.observer.pid,transactionSnapshot:m.observed.observer.snapshot,
          matchedIntentionIds:m.rows.map(x=>x.id),...(m.rows.length?{}:{comparedIncumbentCanonicalSha256:m.incumbent.comparedCanonicalSha256})}}))};
    save(evidenceRoot+'/packet.json',packet);
    try{save(evidenceRoot+'/verdict.json',{release:MODULE_RELEASE,...assertCase(caseId,caseVariant,packet,{fixtureRoot,evidenceRoot})});}
    catch(error){save(evidenceRoot+'/checker-failure.json',{name:error.name,message:error.message,actual:error.actual,expected:error.expected,
      scope:'Actual retained observations; no packet edits to satisfy a checker'});throw error;}
  });
}
