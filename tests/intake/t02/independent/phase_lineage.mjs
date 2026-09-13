import { shape, rows, digest, openBeneath, success } from './observation.mjs';
import { fixedReference } from './revision3.mjs';
import { transfer, fixedBytes, id, n, pos, sha, bool, obj, nullable, word, originalFields } from './byte_observations.mjs';
import { protectedAccessKinds } from './protected_access.mjs';

const proof=x=>obj(x);
const plan={objects:['create','read_stage','seal'],verifier:['verify']};
const one=(c,x,r)=>{c.eq(x.length,1,r);return x[0];};
const tuple=e=>[e.operationId,e.receptionId,e.artifactId,e.generation];
function millis(c,x,label) {
  c.ok(n(x)||(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x)&&n(Number(x))),label);
  return Number(x);
}
function readProof(c,locations,p,label) {
  shape(c,p,{file:id,bytes:n,sha256:sha,pointer:x=>typeof x==='string'&&x.length<=4096},label);
  const bytes=openBeneath(c,locations.evidenceRoot,p.file,1048576,label);
  c.eq([bytes.length,digest(bytes)],[p.bytes,p.sha256],`${label}.file-identity`);
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{c.ok(false,`${label}.json`);}
  c.ok(p.pointer===''||p.pointer.startsWith('/'),`${label}.pointer`);
  if(p.pointer!=='')for(const raw of p.pointer.slice(1).split('/')) {
    c.ok(!/~(?![01])/u.test(raw),`${label}.pointer-escape`);
    const key=raw.replaceAll('~1','/').replaceAll('~0','~');
    c.ok(!['__proto__','prototype','constructor'].includes(key)&&value!==null&&typeof value==='object'&&Object.hasOwn(value,key),`${label}.pointer-member`);
    value=value[key];
  }
  c.ok(obj(value),`${label}.raw-record`);return value;
}
function sqlEvidence(c,e,raw,label) {
  c.eq([raw.id,raw.phase,raw.operation_id,raw.reception_id,raw.artifact_id,raw.generation,raw.principal,raw.status,millis(c,raw.recorded_at,label+'.sql-time'),raw.backend_pid],
    [e.id,e.phase,e.operationId,e.receptionId,e.artifactId,e.generation,e.principal,e.status,e.atMs,e.backendPid],label+'.sql-evidence');
}
function insertEvidence(c,e,x,label) {
  c.eq([x.origin,x.id,x.callId,x.backendPid],['evidence-insert-boundary',e.id,e.callId,e.backendPid],label+'.insert');
  c.ok(n(x.atMs)&&e.atMs<=x.atMs,label+'.insert-time');
}
function metadata(c,o,locations,m) {
  shape(c,m,{evidenceId:id,callId:id,sql:proof,insert:proof,admission:proof,consumption:proof,selection:proof,transaction:nullable(proof)},'metadata');
  const b=one(c,o.requestBoundaries.filter(x=>x.callId===m.callId),'metadata.actual-call');
  c.eq(b.requestClass,'canonical-act','metadata.canonical-call');
  const e=one(c,o.evidence.filter(x=>x.id===m.evidenceId),'metadata.actual-evidence');
  c.eq([e.callId,e.phase,e.principal,tuple(e)],[b.callId,'capture_admission',b.principal,[null,null,null,null]],'metadata.unselected-identity');
  const raw=readProof(c,locations,m.sql,'metadata.sql');sqlEvidence(c,e,raw,'metadata');
  c.eq(raw.binding?.scope,'metadata-capture','metadata.actual-scope');
  c.ok(success(e),'metadata.successful-admission');
  const ins=readProof(c,locations,m.insert,'metadata.insert-proof');insertEvidence(c,e,ins,'metadata');
  const adm=readProof(c,locations,m.admission,'metadata.admission');
  c.eq([adm.origin,adm.kind,adm.callId,adm.principal,adm.backendPid],['current-authority-boundary','metadata-admitted',b.callId,b.principal,e.backendPid],'metadata.admitted-own-backend');
  c.ok(id(adm.controlSourceId)&&pos(adm.controlRevision)&&n(adm.atMs),'metadata.actual-current-source');
  c.eq(adm.controlRevision,raw.control_revision,'metadata.own-admission-revision');
  const consumed=readProof(c,locations,m.consumption,'metadata.consumption');
  c.eq([consumed.kind,consumed.callId],['application-read',b.callId],'metadata.actual-body-call');
  c.ok(consumed.data?.type==='Buffer'&&Array.isArray(consumed.data.data)&&consumed.data.data.length<=65536&&consumed.data.data.every(x=>Number.isInteger(x)&&x>=0&&x<=255),'metadata.actual-body-bytes');
  const bytes=Buffer.from(consumed.data.data);
  c.eq([consumed.bytes,consumed.sha256],[bytes.length,digest(bytes)],'metadata.body-observation-integrity');
  const ref=fixedReference(c,locations,`references/${o.caseId}/${o.variant}${['IC04','IC05'].includes(o.caseId)?'':'.intentions'}.json`);
  const expected=one(c,ref.invocations.filter(x=>x.label===b.label),'metadata.independent-invocation');
  const wire=openBeneath(c,locations.fixtureRoot,expected.wireFile,65536,'metadata.fixed-wire');
  c.eq(bytes,wire,'metadata.independent-consumed-command');
  const selected=readProof(c,locations,m.selection,'metadata.selection');
  const call=one(c,(o.invocations??[]).filter(x=>x.callId===b.callId),'metadata.actual-invocation');
  c.eq([selected.origin,selected.callId,selected.principal,selected.receptionId],['reception-selection-boundary',b.callId,b.principal,b.receptionId],'metadata.later-selected-call');
  c.eq(selected.receptionId,call.subject.receptionId,'metadata.later-selected-invocation');
  for(const key of ['receptionId','artifactId','generation'])if(expected.target[key]!==null)c.eq(selected[key],expected.target[key],'metadata.independent-selected-target');
  c.ok(pos(selected.backendPid),'metadata.selection-own-backend');
  const response=one(c,o.responses.filter(x=>x.label===b.responseLabel),'metadata.actual-response');
  c.ok(n(consumed.atMs)&&n(selected.atMs)&&b.server.observedAtMs<=adm.atMs&&adm.atMs<=e.atMs&&ins.atMs<=consumed.atMs&&consumed.atMs<selected.atMs&&selected.atMs<=response.atMs,'metadata.observed-phase-order');
  if(m.transaction===null)c.eq(e.transactionOpen,null,'metadata.unsampled-connection-is-unknown');
  else {
    const t=readProof(c,locations,m.transaction,'metadata.transaction');
    c.eq([t.origin,t.backendPid,t.transactionOpen],['independent-backend-observer',e.backendPid,e.transactionOpen],'metadata.own-connection-sample');
    c.ok(bool(t.transactionOpen)&&n(t.atMs)&&ins.atMs<=t.atMs&&t.atMs<=consumed.atMs,'metadata.own-sample-order');
  }
  c.ok(![...o.storage,...o.transport].some(x=>x.evidenceId===e.id),'metadata.never-protected-admission');
  return {label:b.label,callId:b.callId,selectedAtMs:selected.atMs};
}
function observedSQL(c,o,value,label) {
  c.eq([value.origin,value.runId],['independent-sql-observer',o.runId],label+'.source');
  c.ok(n(value.observedAtMs)&&pos(value.observerBackendPid)&&obj(value.row),label+'.observed');
  return value.row;
}
function prior(c,o,locations,p,ref) {
  shape(c,p,{uploadCallId:id,finalizeCallId:id,startedAtMs:n,completedAtMs:n,transfer:obj,sealIndex:n,
    ...Object.fromEntries(['sqlEvidence','evidenceInsert','phase','dispatch','completion','artifact','request','client','terminal'].map(k=>[k,proof]))},'prior');
  const b=one(c,o.requestBoundaries.filter(x=>x.callId===p.uploadCallId),'prior.upload-boundary');
  const f=one(c,o.requestBoundaries.filter(x=>x.callId===p.finalizeCallId),'prior.finalize-boundary');
  const expected=one(c,ref.priorUploads.filter(x=>x.uploadLabel===b.label&&x.finalizeLabel===f.label),'prior.independent-window');
  c.ok((o.caseId==='IC05'&&o.variant==='receipt')||(o.caseId==='IC04'&&o.variant==='compatible'),'prior.supported-composition');
  c.eq([f.callId,b.requestClass,f.requestClass,b.method,b.route],
    [o.input.subject.callId,'binary-transfer','canonical-act','POST',`/api/intake/receptions/${b.receptionId}/attempts/${expected.original.generation}/original`],'prior.distinct-window-classes');
  c.ok(b.callId!==f.callId,'prior.distinct-upload-finalize');
  c.eq([b.principal,f.principal,b.receptionId,f.receptionId],[expected.principal,expected.principal,o.input.subject.receptionId,o.input.subject.receptionId],'prior.actor-and-reception');
  c.eq([b.admission.result,f.admission.result],['accepted','accepted'],'prior.both-currently-admitted');
  c.eq([b.admission.controlSourceId,b.admission.controlRevision],[expected.controlSourceId,expected.controlRevision],'prior.independent-control');
  const fixed=fixedBytes(c,locations,o.input.fixture);
  c.eq([expected.original.id,expected.original.generation,expected.original.bytes,expected.original.sha256],
    [o.input.artifactId,o.input.generation,fixed.length,digest(fixed)],'prior.independent-original');
  const eSeal=o.storage[p.sealIndex];c.ok(eSeal,'prior.exact-seal-required');
  c.eq([eSeal.kind,eSeal.callId,eSeal.receptionId,eSeal.artifactId,eSeal.generation,eSeal.bytes,eSeal.incarnation],
    ['seal',b.callId,b.receptionId,expected.original.id,expected.original.generation,fixed.length,expected.incarnation],'prior.selected-physical-seal');
  const e=one(c,o.evidence.filter(x=>x.id===eSeal.evidenceId),'prior.selected-evidence');
  c.eq([e.callId,e.phase,e.principal,e.receptionId,e.artifactId,e.generation,e.transactionOpen],
    [b.callId,'read_admission',expected.principal,b.receptionId,expected.original.id,expected.original.generation,false],'prior.seal-specific-evidence');
  c.ok(success(e),'prior.successful-evidence');
  const raw=readProof(c,locations,p.sqlEvidence,'prior.sql-evidence');sqlEvidence(c,e,raw,'prior');
  c.eq([raw.route,raw.control_revision,raw.binding?.phase?.executor?.id,raw.binding?.load?.original],
    ['upload_original',expected.controlRevision,expected.executorRef,expected.original],'prior.actual-evidence-binding');
  const ins=readProof(c,locations,p.evidenceInsert,'prior.insert-proof');insertEvidence(c,e,ins,'prior');
  const phase=readProof(c,locations,p.phase,'prior.phase'),q=observedSQL(c,o,phase,'prior.phase');
  c.eq([q.source_id,q.incarnation,q.namespace,q.reception_id,q.artifact_id,q.generation,q.evidence_id,q.principal,q.participant_plan,q.connection_role,q.backend_pid],
    [expected.controlSourceId,expected.incarnation,expected.namespace,b.receptionId,expected.original.id,expected.original.generation,e.id,expected.principal,expected.plan,expected.connectionRole,e.backendPid],'prior.durable-seal-capability');
  c.eq(q.participant_plan,plan,'prior.not-generic-read-authority');c.ok(id(q.id),'prior.actual-phase-id');
  const dispatch=readProof(c,locations,p.dispatch,'prior.dispatch');
  c.eq([dispatch.origin,dispatch.runId,dispatch.callId,dispatch.phaseId,dispatch.evidenceId,dispatch.action,dispatch.original,dispatch.incarnation],
    ['private-phase-dispatch-boundary',o.runId,b.callId,q.id,e.id,'seal',expected.original,expected.incarnation],'prior.actual-seal-dispatch');
  c.ok(id(dispatch.requestId)&&n(dispatch.atMs),'prior.private-request-identity');
  const artifact=readProof(c,locations,p.artifact,'prior.artifact'),a=artifact.row,s=artifact.seal;
  c.eq([artifact.origin,artifact.runId],['independent-prior-artifact-observer',o.runId],'prior.artifact-source');
  c.ok(obj(a)&&obj(s)&&n(artifact.observedAtMs),'prior.artifact-observed');
  c.eq([s.origin,s.kind,s.artifactId,s.generation,s.bytes,s.offset,s.evidenceId,s.atMs,s.incarnation,s.requestId],
    [eSeal.origin,eSeal.kind,eSeal.artifactId,eSeal.generation,eSeal.bytes,eSeal.offset,eSeal.evidenceId,eSeal.atMs,eSeal.incarnation,dispatch.requestId],'prior.actual-object-dispatch-link');
  c.eq([a.id,a.reception_id,a.generation,a.bytes,a.sha256,a.verification?.ok,a.verification?.bytes,a.verification?.sha256],
    [expected.original.id,b.receptionId,expected.original.generation,fixed.length,digest(fixed),true,fixed.length,digest(fixed)],'prior.verified-artifact');
  const complete=readProof(c,locations,p.completion,'prior.completion'),z=observedSQL(c,o,complete,'prior.completion');
  c.eq([z.phase_id,z.kind,z.connection_role,z.backend_pid], [q.id,'participants_closed',q.connection_role,q.backend_pid],'prior.retired-same-phase');
  c.eq(z.observation,Object.fromEntries(['objects','verifier'].map(k=>[k,{profile:'intake-phase-closed/1',id:q.id,participant:k}])),'prior.actual-acknowledgments');
  const request=readProof(c,locations,p.request,'prior.request'),client=readProof(c,locations,p.client,'prior.client'),terminal=readProof(c,locations,p.terminal,'prior.terminal');
  c.eq([request.kind,request.callId,request.method,request.route,request.atMs,request.socket],
    ['server-request',b.callId,b.method,b.route,b.server.observedAtMs,{address:b.server.address,port:b.server.port,peerAddress:b.server.peerAddress,peerPort:b.server.peerPort,requestOrdinal:b.server.requestOrdinal}],'prior.actual-server');
  c.eq([client.label,client.method,client.route,client.socket],[b.label,b.method,b.route,b.client],'prior.actual-client');
  const r=one(c,o.responses.filter(x=>x.label===b.responseLabel),'prior.upload-response');
  c.eq([terminal.kind,terminal.callId,terminal.status,terminal.bytes,terminal.sha256,terminal.destroyed,terminal.writableEnded],
    ['terminal-end',b.callId,r.status,r.bytes,r.sha256,false,true],'prior.actual-terminal');
  c.ok(success(r)&&n(terminal.atMs)&&terminal.atMs<=r.atMs&&r.atMs<=p.completedAtMs,'prior.completed-upload');
  const seen=transfer(c,o,locations,p.transfer);
  c.eq([p.transfer.callId,p.transfer.receptionId,p.transfer.artifactId,p.transfer.generation,p.transfer.sent.ended,p.transfer.consumed.completed],
    [b.callId,b.receptionId,expected.original.id,expected.original.generation,true,true],'prior.actual-transfer-scope');
  c.eq([seen.sent,seen.consumed,seen.staged],[fixed,fixed,fixed],'prior.exact-independent-bytes');
  const start=millis(c,q.started_at,'prior.phase-start'),deadline=millis(c,q.deadline_ms,'prior.phase-deadline'),end=millis(c,z.completed_at,'prior.phase-completed'),created=millis(c,a.created_at,'prior.artifact-created');
  c.ok(p.startedAtMs<=b.client.observedAtMs&&p.startedAtMs<=b.server.observedAtMs&&b.server.observedAtMs<=b.admission.observedAtMs&&b.admission.observedAtMs<=e.atMs&&ins.atMs<=start&&start<=phase.observedAtMs&&phase.observedAtMs<=dispatch.atMs&&dispatch.atMs<=eSeal.atMs&&eSeal.atMs<deadline&&eSeal.atMs<=end&&end<=complete.observedAtMs&&complete.observedAtMs<=terminal.atMs&&eSeal.atMs<=created&&created<=artifact.observedAtMs&&artifact.observedAtMs<=o.before.atMs&&p.completedAtMs<=o.before.atMs&&o.before.atMs<f.server.observedAtMs,'prior.window-and-admitted-order');
  for(const x of [...o.storage,...o.evidence,...o.transport].filter(x=>x.callId===b.callId))c.ok(p.startedAtMs<=x.atMs&&x.atMs<=p.completedAtMs,'prior.complete-storage-window');
  c.ok(p.transfer.consumed.firstReadAtMs>=b.server.observedAtMs&&p.transfer.consumed.lastReadAtMs<=eSeal.atMs&&p.transfer.staged.observedAtMs<=o.before.atMs,'prior.transfer-window');
  const attempt=one(c,o.before.attempts.filter(x=>x.receptionId===b.receptionId&&x.generation===expected.original.generation),'prior.before-current-attempt');
  const reception=one(c,o.before.receptions.filter(x=>x.id===b.receptionId),'prior.before-reception');
  c.eq([attempt.state,attempt.artifactId,attempt.actualBytes,attempt.actualSha256,attempt.incarnation,reception.generation,reception.stopped],
    ['sealed',expected.original.id,fixed.length,digest(fixed),expected.incarnation,expected.original.generation,false],'prior.sealed-current-precondition');
  c.ok(attempt.expiresAtMs>f.server.observedAtMs,'prior.current-attempt-not-expired');
  c.eq([o.before.receipts.length,o.before.jobs.length],[0,0],'prior.no-seeded-receipt-or-job');
  const reads=o.storage.filter(x=>x.callId===f.callId&&x.kind==='read'&&x.artifactId===expected.original.id&&x.generation===expected.original.generation);
  c.ok(reads.some(x=>x.bytes===fixed.length),'prior.fresh-finalizer-read-required');
  c.ok(o.storage.some(x=>x.callId===f.callId&&x.kind==='open'&&x.artifactId===expected.original.id&&x.generation===expected.original.generation),'prior.fresh-finalizer-open-required');
  for(const x of o.storage.filter(x=>x.callId===f.callId&&['open','read'].includes(x.kind))) {
    const admitted=o.evidence.find(y=>y.id===x.evidenceId);
    c.ok(admitted&&admitted.callId===f.callId&&admitted.phase==='read_admission'&&admitted.principal===f.principal&&admitted.receptionId===f.receptionId&&admitted.artifactId===expected.original.id&&admitted.generation===expected.original.generation&&success(admitted)&&admitted.transactionOpen===false&&f.server.observedAtMs<=f.admission.observedAtMs&&f.admission.observedAtMs<=admitted.atMs&&admitted.atMs<=x.atMs,'prior.fresh-current-authority');
  }
  const reply=one(c,o.responses.filter(x=>x.label===f.responseLabel),'prior.finalizer-response');
  c.ok(success(reply)&&o.transport.some(x=>x.callId===f.callId&&x.kind==='handoff'),'prior.actual-finalizer-handoff');
  const receipt=one(c,o.after.receipts.filter(x=>x.receptionId===f.receptionId),'prior.new-finalizer-receipt');
  c.eq(receipt.executorRef,expected.executorRef,'prior.fixed-executor');
  const job=one(c,o.after.jobs.filter(x=>x.receiptId===receipt.id),'prior.new-linked-job');
  c.eq([job.state,job.dispatchable],['not_started',false],'prior.work-not-executed');
  const effect=one(c,o.evidence.filter(x=>x.phase==='effect'&&x.operationId===receipt.operationId),'prior.finalizer-effect');
  c.eq([effect.callId,effect.receptionId,effect.artifactId,effect.generation,effect.principal,effect.executorRef],
    [f.callId,f.receptionId,expected.original.id,expected.original.generation,expected.principal,expected.executorRef],'prior.new-effect-not-history');
  c.ok(reads.every(x=>x.atMs<=effect.atMs)&&effect.atMs<=reply.atMs,'prior.read-before-effect');
  return eSeal;
}
export function validatePhaseLineage(c,o,locations) {
  const metadataIds=new Set(),seals=new Set();
  if(o.interfaceAddendum!=='3.3')return {metadataIds,seals};
  shape(c,o.phaseLineage,{metadata:Array.isArray,priorUploads:Array.isArray},'phase-lineage');
  const ref=fixedReference(c,locations,`references/${o.caseId}/${o.variant}.phases.json`);
  shape(c,ref,{runId:id,sourceManifestSha256:sha,metadataLabels:Array.isArray,priorUploads:Array.isArray},'phase-reference');
  c.eq([ref.runId,ref.sourceManifestSha256],[o.runId,o.source.manifestSha256],'phase-reference.run-and-source');
  c.ok(ref.metadataLabels.every(id)&&new Set(ref.metadataLabels).size===ref.metadataLabels.length,'metadata.unique-fixed-labels');
  rows(c,ref.priorUploads,{uploadLabel:id,finalizeLabel:id,principal:id,executorRef:id,original:obj,incarnation:id,namespace:id,controlSourceId:id,controlRevision:pos,connectionRole:id,plan:obj},'prior.reference');
  for(const e of ref.priorUploads){shape(c,e.original,originalFields,'prior.reference-original');c.eq(e.plan,plan,'prior.fixed-plan');}
  c.ok(o.phaseLineage.metadata.length<=10000&&o.phaseLineage.priorUploads.length<=1,'phase-lineage.bounded');
  const labels=[],selections=new Map();
  for(const m of o.phaseLineage.metadata) {
    c.ok(!metadataIds.has(m.evidenceId),'metadata.unique-evidence');
    const selected=metadata(c,o,locations,m);
    labels.push(selected.label);selections.set(selected.callId,selected.selectedAtMs);metadataIds.add(m.evidenceId);
  }
  c.eq([...new Set(labels)].sort(),[...ref.metadataLabels].sort(),'metadata.complete-fixed-set');
  c.eq(o.phaseLineage.priorUploads.length,ref.priorUploads.length,'prior.complete-fixed-set');
  for(const p of o.phaseLineage.priorUploads)seals.add(prior(c,o,locations,p,ref));
  for(const e of o.evidence)if(!metadataIds.has(e.id)) {
    c.ok(bool(e.transactionOpen),'phase.selected-transaction-observation');
    const b=o.requestBoundaries.find(x=>x.callId===e.callId);
    c.ok(b,'phase.selected-actual-call');c.eq([e.receptionId,e.principal],[b.receptionId,b.principal],'phase.selected-reception-and-principal');
    c.ok(tuple(e).some(x=>x!==null),'metadata.missing-qualified-proof');
    if(selections.has(e.callId))c.ok(e.atMs>=selections.get(e.callId),'phase.selected-evidence-after-selection');
  }
  for(const x of [...o.storage,...o.transport]) {
    const b=o.requestBoundaries.find(b=>b.callId===x.callId);c.ok(b,'phase.event-actual-call');
    c.eq(x.receptionId,b.receptionId,'phase.selected-event-reception');
    c.ok(!metadataIds.has(x.evidenceId),'metadata.never-protected-admission');
    if(selections.has(x.callId))c.ok(x.atMs>=selections.get(x.callId),'phase.protected-event-after-selection');
    if(protectedAccessKinds.includes(x.kind)) {
      const calls=fixedReference(c,locations,`references/${o.caseId}/${o.variant}.calls.json`);
      const allowed=calls.calls.find(z=>z.label===b.label)?.allowedAccess??[];
      c.ok(allowed.some(z=>z.kind===x.kind&&z.artifactId===x.artifactId&&z.generation===x.generation),'phase.independent-protected-scope');
    }
  }
  return {metadataIds,seals};
}
