import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {save,hash,responseHeaders} from './observation_support.mjs';

const only=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0];};
/** Lossless source references plus explicit profile mapping; no independent verdict is fabricated. */
export function phaseLineagePackets(root){
  const fixed=root+'/fixed',observed=root+'/observed',bytes=readFileSync(observed+'/raw.json'),raw=JSON.parse(bytes);
  assert.equal(raw.failure,null);assert.ok(bytes.length<=1048576);
  const ref=pointer=>({file:'raw.json',bytes:bytes.length,sha256:hash(bytes),pointer});
  const itemRef=(collection,value)=>{const index=raw[collection].indexOf(value);assert.ok(index>=0);return ref('/'+collection+'/'+index);};
  const file=(directory,name)=>{const b=readFileSync((directory==='fixture'?fixed:observed)+'/'+name);return{root:directory,file:name,bytes:b.length,sha256:hash(b)};};
  const upload=raw.calls[0],attempt=only(raw.initial.raw.attempt),reception=only(raw.initial.raw.reception);
  const seal=only(raw.physicalAfter.events.filter(e=>e.origin==='object-boundary'&&e.kind==='seal'));
  const sealEvidence=only(raw.sql.filter(e=>e.id===seal.evidenceId)),phase=only(raw.phases.filter(p=>p.row.evidence_id===seal.evidenceId));
  const physical=raw.physicalAfter.events.filter(e=>e.origin==='object-boundary');
  const uploadCallId=upload.server.callId;
  const readEvents=upload.events.filter(e=>e.kind==='application-read');
  const transfer={origin:'client-stream-and-owned-object-observers',callId:uploadCallId,receptionId:reception.id,
    artifactId:attempt.artifact_id,generation:attempt.generation,
    declared:{origin:'independent-reservation-sql',observedAtMs:raw.initial.packet.atMs,original:{id:attempt.artifact_id,generation:attempt.generation,
      bytes:reception.declaration.bytes,sha256:reception.declaration.sha256},declarationFile:file('fixture','declaration.json')},
    sent:{origin:'https-client-body',observedAtMs:upload.client.sent.observedAtMs,body:file('evidence','upload-sent.bin'),ended:upload.client.sent.ended},
    consumed:{origin:'application-stream-boundary',firstReadAtMs:readEvents[0].atMs,lastReadAtMs:readEvents.at(-1).atMs,
      body:file('evidence','upload-consumed.bin'),bytes:readEvents.reduce((n,e)=>n+e.bytes,0),sha256:hash(readFileSync(observed+'/upload-consumed.bin')),completed:true},
    staged:{origin:'owned-physical-object-observer',observedAtMs:raw.stagedCapture.observedAtMs,present:raw.stagedCapture.present,
      body:file('evidence','upload-staged.bin'),artifactId:raw.stagedCapture.artifactId,generation:raw.stagedCapture.generation}};
  const foreignRef=(collection,find)=>itemRef(collection,only(raw[collection].filter(find)));
  for(const [caseId,variant,number]of [['IC04','compatible',3],['IC05','receipt',2]]){
    const calls=raw.calls.slice(0,number),canonical=calls.slice(1),ids=new Set(calls.map(c=>c.server.callId));
    const sourceSQL=raw.sql.filter(row=>raw.evidenceInserts.some(i=>i.id===row.id&&ids.has(i.callId)));
    const storage=physical.filter(event=>sourceSQL.some(row=>row.id===event.evidenceId)).map(e=>{
      const row=only(sourceSQL.filter(r=>r.id===e.evidenceId)),insert=only(raw.evidenceInserts.filter(i=>i.id===e.evidenceId));
      return {origin:e.origin,kind:e.kind,artifactId:e.artifactId,generation:e.generation,bytes:e.bytes,offset:e.offset,evidenceId:e.evidenceId,
        atMs:e.atMs,incarnation:e.incarnation,callId:insert.callId,receptionId:row.reception_id,operationId:row.operation_id};
    });
    const evidence=sourceSQL.map(row=>{
      const insert=only(raw.evidenceInserts.filter(i=>i.id===row.id)),sample=raw.transactions.find(s=>s.evidenceId===row.id);
      assert.ok(sample);assert.equal(sample.backendPid,row.backend_pid);
      return{origin:'sql-observer',callId:insert.callId,id:row.id,phase:row.phase,operationId:row.operation_id,receptionId:row.reception_id,
        artifactId:row.artifact_id,generation:row.generation,principal:row.principal,status:row.status,atMs:Number(row.recorded_at),
        backendPid:row.backend_pid,transactionOpen:sample.transactionOpen,
        ...(row.phase==='effect'?{personRef:row.binding.load.person.id,executorRef:row.binding.phase.executor.id}:{})};
    });
    const details=canonical.map(call=>{
      const comparison=only(raw.comparisons.filter(c=>c.callId===call.server.callId)),selected=only(raw.selections.filter(s=>s.callId===call.server.callId));
      const receipt=only(call.after.raw.receipt),job=only(call.after.raw.work),rows=call.after.raw.intention.filter(i=>i.deployment===raw.before.raw.intention[0].deployment&&
        i.principal===comparison.principal&&i.act===comparison.act&&i.variant===comparison.variant&&i.client_key===call.server.clientKey);
      return{call,comparison,selected,receipt,job,rows,row:only(rows),body:JSON.parse(readFileSync(observed+'/'+call.label+'-consumed.bin','utf8'))};
    });
    const subject=d=>({receptionId:d.selected.receptionId,callId:d.call.server.callId,queryIntentionId:null,finalizationIntentionId:d.receipt.operation_id});
    const packet={profile:'intake-observation/1',interfaceRevision:3,interfaceAddendum:'3.3',caseId,variant,...raw.source,
      input:{fixture:'bom.txt',artifactId:attempt.artifact_id,generation:attempt.generation,principal:reception.principal,subject:subject(details[0])},
      before:raw.before.packet,after:calls.at(-1).after.packet,evidence,storage,control:[],temporal:null,
      barriers:raw.pauses.filter(p=>ids.has(p.callId)&&p.label==='before_handoff').map(p=>({origin:'test-controller',label:p.label,reachedAtMs:p.reachedAtMs,
        releasedAtMs:p.releasedAtMs,writerCommittedAtMs:null,clientBytesAtPause:p.clientBytesAtPause,backendPid:p.backendPid,
        transactionOpen:only(raw.transactions.filter(s=>s.evidenceId===p.evidenceId)).transactionOpen})),
      responses:calls.map(call=>({origin:'https-client',label:call.label,route:call.server.route,status:call.reply.status,
        headers:Object.fromEntries(Object.entries(call.reply.headers).filter(([name])=>responseHeaders.has(name))),body:call.reply.body,bodyFile:null,
        bytes:call.reply.bytes.data.length,sha256:hash(Buffer.from(call.reply.bytes.data)),atMs:call.client.atMs})),
      requestBoundaries:calls.map(call=>{
        const admission=raw.admissions.find(a=>a.callId===call.server.callId&&a.kind==='authorized');assert.ok(admission);
        const selected=raw.selections.find(s=>s.callId===call.server.callId);assert.ok(selected);
        return{origin:'https-client-and-server-boundary',callId:call.server.callId,label:call.label,requestClass:call.label==='upload'?'binary-transfer':'canonical-act',
          method:call.server.method,route:call.server.route,client:call.client.socket,server:{...call.server.socket,observedAtMs:call.server.atMs,boundary:'application-consumer'},
          correlationMode:'connection-and-request',principal:admission.principal,receptionId:selected.receptionId,responseLabel:call.label,
          admission:{result:'accepted',source:'current-sql-admission',observedAtMs:admission.atMs,backendPid:admission.backendPid,
            controlSourceId:admission.controlSourceId,controlRevision:admission.controlRevision}};
      }),
      transport:calls.map(call=>{const delivery=only(sourceSQL.filter(r=>r.phase==='delivery'&&raw.evidenceInserts.some(i=>i.id===r.id&&i.callId===call.server.callId)));
        return{origin:'terminal-boundary',route:call.server.route,operationId:delivery.operation_id,evidenceId:delivery.id,kind:'handoff',
          bytes:call.terminal.bytes,atMs:call.terminal.atMs,callId:call.server.callId,receptionId:delivery.reception_id};}),
      invocations:details.map(d=>({origin:'https-client-and-request-observer',label:d.call.label,callId:d.call.server.callId,principal:d.comparison.principal,
        clientKey:d.call.server.clientKey,act:d.comparison.act,variant:d.comparison.variant,
        target:{receptionId:d.selected.receptionId,artifactId:d.body.original.id,generation:d.body.original.generation,expectedRevision:d.body.expected_revision},
        subject:subject(d),wireBodySha256:hash(readFileSync(observed+'/'+d.call.label+'-consumed.bin')),
        canonicalPayloadSha256:d.comparison.comparedCanonicalSha256,canonicalProfile:d.comparison.canonicalProfile,keyVersion:d.comparison.keyVersion,responseLabel:d.call.label})),
      comparisons:details.map(d=>({...d.comparison,label:d.call.label,phase:'namespace-lookup',row:d.comparison.operationId===null?'absent':'present'})),
      incumbentComparisons:details.flatMap(d=>raw.incumbentComparisons.filter(i=>i.callId===d.call.server.callId).map(i=>({...i,label:d.call.label}))),
      correlations:details.map(d=>({origin:'independent-sql-observer',callId:d.call.server.callId,atMs:d.call.after.packet.atMs,
        namespace:{deployment:d.row.deployment,principal:d.comparison.principal,act:d.comparison.act,variant:d.comparison.variant,clientKey:d.call.server.clientKey},
        outcome:'confirmed',observation:{resolution:'same-namespace',operationId:d.row.id,receptionId:d.row.reception_id,storedPayloadDigest:d.row.payload_digest,
          effectId:d.row.effect_id,receiptId:d.receipt.id,jobId:d.job.id,observerBackendPid:d.call.after.observer.pid,transactionSnapshot:d.call.after.observer.snapshot,
          matchedIntentionIds:d.rows.map(i=>i.id)}})),
      phaseLineage:{metadata:details.map(d=>{
        const insert=only(raw.evidenceInserts.filter(i=>i.callId===d.call.server.callId&&sourceSQL.some(r=>r.id===i.id&&r.binding?.scope==='metadata-capture')));
        return{evidenceId:insert.id,callId:d.call.server.callId,sql:foreignRef('sql',r=>r.id===insert.id),insert:itemRef('evidenceInserts',insert),
          admission:foreignRef('admissions',a=>a.callId===d.call.server.callId&&a.kind==='metadata-admitted'&&a.backendPid===insert.backendPid),
          consumption:foreignRef('requestEvents',e=>e.callId===d.call.server.callId&&e.kind==='application-read'),selection:itemRef('selections',d.selected),
          transaction:foreignRef('transactions',s=>s.evidenceId===insert.id)};
      }),priorUploads:[{uploadCallId,finalizeCallId:details[0].call.server.callId,startedAtMs:upload.startedAtMs,completedAtMs:upload.completedAtMs,
        transfer,sealIndex:storage.findIndex(e=>e.kind==='seal'&&e.evidenceId===seal.evidenceId),sqlEvidence:itemRef('sql',sealEvidence),
        evidenceInsert:foreignRef('evidenceInserts',i=>i.id===seal.evidenceId),phase:itemRef('phases',phase),
        dispatch:foreignRef('privateDispatches',d=>d.requestId===seal.requestId),completion:foreignRef('completions',c=>c.row.phase_id===phase.row.id),
        artifact:foreignRef('artifactRows',a=>a.row.id===attempt.artifact_id),request:ref('/calls/0/server'),client:ref('/calls/0/client'),terminal:ref('/calls/0/terminal')}]}};
    save(observed+'/'+caseId+'-'+variant+'-packet.json',packet);
  }
}
