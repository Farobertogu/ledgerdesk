import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,chmodSync} from 'node:fs';
import {snapshot,save,hash} from './observation_support.mjs';
import {administration} from './recovery_cases.mjs';
import {phaseLineagePackets} from './phase_lineage_packet.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const only=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0];};
const buffer=event=>Buffer.isBuffer(event.data)?event.data:Buffer.from(event.data.data);

/** New actual windows. Prior rejected captures are neither edited nor upgraded. */
export async function phaseLineageCapture(t,context){
  const {env,intake,client,request,requestEvents,clientCalls,admissions,comparisons,incumbentComparisons,
    evidenceInserts,selections,privateDispatches,setBarrier}=context;
  await t.test('actual metadata connections and prior upload phase lineage',async()=>{
    const root='/work/output/phase-lineage',fixed=root+'/fixed',observed=root+'/observed';
    mkdirSync(fixed+'/references',{recursive:true});mkdirSync(observed,{recursive:true});
    const source=JSON.parse(readFileSync('/work/output/observer-source.json','utf8'));
    const {runId}=source,initial=await snapshot(env.admin);
    const reception=only(initial.raw.reception,'one reserved original'),attempt=only(initial.raw.attempt,'one reserved generation');
    assert.deepEqual([initial.raw.receipt.length,initial.raw.work.length,attempt.state],[0,0,'reserved']);
    // The literal and operation scope are fixed before dispatch, not reconstructed from SQL after sealing.
    const original=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');
    assert.deepEqual([original.length,hash(original)],[17,'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9']);
    const identity={id:attempt.artifact_id,generation:attempt.generation,bytes:17,sha256:hash(original)};
    const uploadRoute=`/api/intake/receptions/${reception.id}/attempts/${attempt.generation}/original`;
    const finalizeRoute=`/api/intake/receptions/${reception.id}/finalize`;
    const live=only((await env.admin.query('SELECT * FROM intake_control.live')).rows);
    const expectation={uploadLabel:'upload',finalizeLabel:'subject',principal:reception.principal,
      executorRef:'intake-service:'+intake.incarnation,original:identity,incarnation:intake.incarnation,namespace:intake.namespace,
      controlSourceId:live.source_id,controlRevision:live.revision,connectionRole:'inc03_intake_runtime',
      plan:{objects:['create','read_stage','seal'],verifier:['verify']}};
    const freeze=(file,value)=>{save(fixed+'/'+file,value);chmodSync(fixed+'/'+file,0o400);};
    freeze('bom.txt',original);
    freeze('references/actors.json',{executorRef:expectation.executorRef,bindings:initial.packet.principalBindings.map(b=>({accountId:b.accountId,personId:b.personId}))});
    freeze('declaration.json',{original:identity});
    for(const [caseId,variant,labels]of [['IC04','compatible',['subject','reconcile']],['IC05','receipt',['subject']]]){
      mkdirSync(fixed+'/references/'+caseId,{recursive:true});
      freeze(`references/${caseId}/${variant}.phases.json`,{runId,sourceManifestSha256:source.source.manifestSha256,metadataLabels:labels,priorUploads:[expectation]});
      freeze(`references/${caseId}/${variant}.calls.json`,{calls:[{label:'upload',method:'POST',route:uploadRoute,requestClass:'binary-transfer',
        principal:reception.principal,receptionId:reception.id,allowedAccess:['append','open','read','seal'].map(kind=>({kind,artifactId:identity.id,generation:identity.generation}))},
        ...labels.map((label,i)=>({label,method:'POST',route:finalizeRoute,requestClass:'canonical-act',principal:reception.principal,receptionId:reception.id,
          allowedAccess:i===0?['open','read'].map(kind=>({kind,artifactId:identity.id,generation:identity.generation})):[]}))]});
    }
    freeze('upload-operation.json',{frozenAtMs:Date.now(),expectation,method:'POST',route:uploadRoute,
      allowedAccess:['append','open','read','seal'].map(kind=>({kind,artifactId:identity.id,generation:identity.generation})),initial});
    const starts={requests:requestEvents.length,clients:clientCalls.length,admissions:admissions.length,
      comparisons:comparisons.length,incumbents:incumbentComparisons.length,inserts:evidenceInserts.length,
      selections:selections.length,dispatches:privateDispatches.length};
    const sql=[],transactions=[],phases=[],completions=[],controls=[],artifactRows=[],calls=[],pauses=[];
    let physicalBefore,physicalAfter,stagedCapture,before,after,failure=null;
    const stamp=async()=>only((await env.admin.query('SELECT pg_backend_pid() AS pid,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows);
    async function ownEvidence(event){
      const row=only((await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows,'independently visible evidence');
      assert.equal(row.backend_pid,event.backendPid,'Sample the INSERT backend, never a later connection');
      const backend=only((await env.admin.query('SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1',[row.backend_pid])).rows,'actual connection still present');
      const at=await stamp();
      assert.deepEqual([backend.state,backend.xact_start],['idle',null]);
      if(!sql.some(value=>value.id===row.id))sql.push(row);
      transactions.push({origin:'independent-backend-observer',backendPid:backend.pid,atMs:Number(at.now),
        transactionOpen:backend.xact_start!==null,observerBackendPid:at.pid,evidenceId:row.id,callId:event.callId,backend});
      return row;
    }
    setBarrier(async(label,event)=>{
      if(!['before_metadata_read','private_phase_committed','private_phase_closed','before_original_read','before_handoff'].includes(label))return;
      const reachedAtMs=Date.now(),clientBytesAtPause=clientCalls.at(-1).receivedBytes;
      if(label==='private_phase_closed'){
        const row=only((await env.admin.query('SELECT * FROM intake_control.phase_completion WHERE phase_id=$1',[event.phaseId])).rows);
        const at=await stamp();
        completions.push({origin:'independent-sql-observer',runId,observedAtMs:Number(at.now),observerBackendPid:at.pid,row});
      }else{
        await ownEvidence(event);
        if(label==='before_handoff')for(const insert of evidenceInserts.filter(i=>i.callId===event.callId&&!sql.some(row=>row.id===i.id))){
          await ownEvidence({...event,evidenceId:insert.id,backendPid:insert.backendPid});
        }
        if(label==='private_phase_committed'){
          const row=only((await env.admin.query('SELECT * FROM intake_control.private_phase WHERE id=$1',[event.phaseId])).rows);
          const at=await stamp();
          phases.push({origin:'independent-sql-observer',runId,observedAtMs:Number(at.now),observerBackendPid:at.pid,row});
          controls.push({phaseId:row.id,observedAtMs:Date.now(),
            head:(await env.admin.query('SELECT * FROM intake_control.fence_head')).rows,
            live:(await env.admin.query('SELECT * FROM intake_control.live')).rows,
            treatment:(await env.admin.query('SELECT t.*,c.enabled FROM intake_control.treatment_current c JOIN intake_control.treatment t USING(id,revision)')).rows});
        }
        if(label==='before_handoff'&&event.route==='upload_original'){
          const row=only((await env.admin.query('SELECT * FROM intake_trial.artifact WHERE id=$1',[identity.id])).rows);
          const at=await stamp();
          artifactRows.push({origin:'independent-prior-artifact-observer',runId,observedAtMs:Number(at.now),observerBackendPid:at.pid,row});
        }
      }
      pauses.push({label,...event,reachedAtMs,releasedAtMs:Date.now(),clientBytesAtPause});
    });
    async function perform(label,route,options){
      const start=requestEvents.length,startedAtMs=Date.now();
      const reply=await request(route,{client,label,...options});
      const events=requestEvents.slice(start),server=only(events.filter(event=>event.kind==='server-request'));
      const actualClient=clientCalls.at(-1),terminal=only(events.filter(event=>event.kind==='terminal-end'));
      save(observed+'/'+label+'-sent.bin',actualClient.sent.bytes);
      const consumed=Buffer.concat(events.filter(event=>event.kind==='application-read').map(buffer));
      save(observed+'/'+label+'-consumed.bin',consumed);save(observed+'/'+label+'-response.bin',reply.bytes);
      const result={label,startedAtMs,completedAtMs:Date.now(),server,client:actualClient,terminal,reply,events};
      calls.push(result);assert.equal(actualClient.label,label);assert.equal(reply.status,200,JSON.stringify(reply.body));
      const delivery=only(sql.filter(r=>r.phase==='delivery'&&evidenceInserts.some(i=>i.id===r.id&&i.callId===server.callId)));
      let transport=[];
      for(let i=0;i<20;i++){
        transport=(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[delivery.id])).rows;
        if(transport.length)break;await delay(10);
      }
      result.transport=transport;assert.deepEqual([only(transport).outcome,delivery.status,terminal.status],['handed_off',reply.status,reply.status]);
      return result;
    }
    try{
      physicalBefore=await administration('observe-events',{});
      assert.deepEqual(physicalBefore.events,[],'New owned participant has not processed an original');
      const upload=await perform('upload',uploadRoute,{bytes:readFileSync(fixed+'/bom.txt')});
      assert.deepEqual(upload.reply.body.original,identity);
      stagedCapture=await administration('observe-original',{artifactId:identity.id,generation:identity.generation});
      save(observed+'/upload-staged.bin',Buffer.from(stagedCapture.data,'base64'));
      assert.deepEqual(Buffer.from(stagedCapture.data,'base64'),original,'Independent physical read, not a copy of sent bytes');
      // All prior-phase SQL observations above precede this finalization before snapshot.
      before=await snapshot(env.admin);
      assert.deepEqual([before.raw.receipt.length,before.raw.work.length,only(before.raw.attempt).state],[0,0,'sealed']);
      const body={profile:'intake/1',expected_revision:only(before.raw.reception).revision,original:identity,format_profile:'text-utf8/1'};
      const second={format_profile:'text-utf8/1',original:{sha256:identity.sha256,bytes:17,generation:identity.generation,id:identity.id},
        expected_revision:body.expected_revision,profile:'intake/1'};
      const recipes=[{label:'subject',body},{label:'reconcile',body:second}];
      for(const recipe of recipes){
        freeze(recipe.label+'.wire.json',Buffer.from(JSON.stringify(recipe.body)));
        freeze(recipe.label+'.canonical.json',{profile:'canon_m09_1',contract:'intake/1',variant:'finalize_reception',
          path:{template:'/api/intake/receptions/:id/finalize',parameters:{id:reception.id}},query:{},body:recipe.body});
      }
      for(const [caseId,variant,count]of [['IC04','compatible',2],['IC05','receipt',1]]){
        freeze(`references/${caseId}/${variant}.json`,{executorRef:expectation.executorRef,deployment:intake.deployment,
          invocations:recipes.slice(0,count).map(r=>({label:r.label,principal:reception.principal,clientKey:'fixed-phase-finalization-A',act:'CARGAR_MATERIAL',variant:'finalize_reception',
            target:{receptionId:reception.id,artifactId:identity.id,generation:identity.generation,expectedRevision:r.body.expected_revision},
            canonicalProfile:'canon_m09_1',keyVersion:1,wireFile:r.label+'.wire.json',canonicalFile:r.label+'.canonical.json'}))});
      }
      freeze('finalize-operation.json',{frozenAtMs:Date.now(),before,route:finalizeRoute,principal:reception.principal,
        clientKey:'fixed-phase-finalization-A',recipes:recipes.map(r=>({label:r.label,wireFile:r.label+'.wire.json',canonicalFile:r.label+'.canonical.json'}))});
      for(const recipe of recipes){
        const call=await perform(recipe.label,finalizeRoute,{key:'fixed-phase-finalization-A',
          bytes:readFileSync(fixed+'/'+recipe.label+'.wire.json'),headers:{'content-type':'application/json'}});
        call.after=await snapshot(env.admin);
      }
      physicalAfter=await administration('observe-events',{});after=await snapshot(env.admin);
      assert.equal(physicalAfter.present,true,'A missing post-operation journal is not an empty observation');
      assert.deepEqual([after.raw.receipt.length,after.raw.work.length],[1,1]);
      assert.equal(calls[1].reply.body.effect.id,calls[2].reply.body.effect.id);
      const seal=only(physicalAfter.events.filter(e=>e.origin==='object-boundary'&&e.kind==='seal'&&e.artifactId===identity.id));
      const phase=only(phases.filter(p=>p.row.evidence_id===seal.evidenceId));
      const dispatch=only(privateDispatches.slice(starts.dispatches).filter(d=>d.requestId===seal.requestId));
      const completion=only(completions.filter(c=>c.row.phase_id===phase.row.id));
      assert.deepEqual(phase.row.participant_plan,expectation.plan);
      assert.deepEqual([phase.row.artifact_id,phase.row.generation,phase.row.principal,phase.row.connection_role],
        [identity.id,identity.generation,expectation.principal,expectation.connectionRole]);
      assert.deepEqual([dispatch.phaseId,dispatch.evidenceId,dispatch.original,dispatch.action],[phase.row.id,seal.evidenceId,identity,'seal']);
      assert.ok(phase.observedAtMs<=dispatch.atMs&&dispatch.atMs<=seal.atMs&&seal.atMs<Number(phase.row.deadline_ms));
      assert.ok(seal.atMs<=Number(completion.row.completed_at)&&Number(completion.row.completed_at)<=completion.observedAtMs);
      assert.ok(completion.observedAtMs<=calls[0].terminal.atMs&&calls[0].completedAtMs<=before.packet.atMs);
      assert.deepEqual([completion.row.kind,completion.row.observation.objects.id,completion.row.observation.verifier.id],
        ['participants_closed',phase.row.id,phase.row.id]);
      const artifact=only(artifactRows);artifact.seal=seal;
      assert.deepEqual([artifact.row.bytes,artifact.row.sha256,artifact.row.verification.ok,artifact.row.verification.bytes,artifact.row.verification.sha256],
        [17,identity.sha256,true,17,identity.sha256]);
      assert.ok(artifact.observedAtMs<calls[1].server.atMs);
      for(const call of calls){
        assert.deepEqual([call.client.socket.port,call.client.socket.peerPort],[call.server.socket.peerPort,call.server.socket.port]);
        assert.deepEqual([call.terminal.destroyed,call.terminal.writableEnded,call.terminal.status],[false,true,200]);
      }
      for(const call of calls.slice(1)){
        const consumed=only(call.events.filter(e=>e.kind==='application-read'));
        assert.deepEqual(buffer(consumed),readFileSync(fixed+'/'+call.label+'.wire.json'));
        const selected=only(selections.filter(s=>s.callId===call.server.callId));
        const row=only(sql.filter(r=>r.binding?.scope==='metadata-capture'&&evidenceInserts.some(i=>i.id===r.id&&i.callId===call.server.callId)));
        const sample=only(transactions.filter(x=>x.evidenceId===row.id));
        assert.deepEqual([row.operation_id,row.reception_id,row.artifact_id,row.generation],[null,null,null,null]);
        assert.equal(sample.backendPid,row.backend_pid);assert.notEqual(sample.backendPid,selected.backendPid);
        assert.equal(sample.transactionOpen,false);assert.ok(sample.atMs<=consumed.atMs&&consumed.atMs<selected.atMs);
      }
    }catch(error){failure={name:error.name,message:error.message,actual:error.actual,expected:error.expected};throw error;}
    finally{
      setBarrier(async()=>{});
      // Persist every observed record even when a directed assertion fails.
      save(observed+'/raw.json',{scope:'Actual new capture; independent checker execution remains a separate step',source,initial,before,after,
        physicalBefore,physicalAfter,stagedCapture,sql,transactions,phases,completions,controls,artifactRows,calls,pauses,
        requestEvents:requestEvents.slice(starts.requests),clientCalls:clientCalls.slice(starts.clients),
        admissions:admissions.slice(starts.admissions),comparisons:comparisons.slice(starts.comparisons),
        incumbentComparisons:incumbentComparisons.slice(starts.incumbents),evidenceInserts:evidenceInserts.slice(starts.inserts),
        selections:selections.slice(starts.selections),privateDispatches:privateDispatches.slice(starts.dispatches).map(e=>({...e,runId})),failure});
    }
    console.log('INTAKE_PHASE_LINEAGE_CAPTURED '+JSON.stringify({runId,metadataConnections:transactions.filter(x=>sql.some(r=>r.id===x.evidenceId&&r.binding?.scope==='metadata-capture')).length,
      priorUploadWindows:1,finalizeCalls:2,receipts:after.raw.receipt.length,jobs:after.raw.work.length}));
    phaseLineagePackets(root);
  });
}
