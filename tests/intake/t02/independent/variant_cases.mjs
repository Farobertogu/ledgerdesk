import { digest, fixture, openBeneath, shape, rows, success } from './observation.mjs';
import { subjectReceipt, fixedReference } from './revision3.mjs';
import { bool,obj,nullable,originalFields,exactFields,fileBytes,transfer,reached,boundary } from './byte_observations.mjs';
import { isProtectedAccess, isProtectedWrite } from './protected_access.mjs';

const id=x=>typeof x==='string'&&x.length>0&&x.length<=512;
const nat=x=>Number.isSafeInteger(x)&&x>=0;
const pos=x=>nat(x)&&x>0;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const word=(...xs)=>x=>xs.includes(x);

export function corruptCase(c,o,locations,h) {
  const fault=o.objectFault;
  shape(c,fault,{origin:word('owned-object-observer'),artifactId:id,generation:pos,beforeFile:id,beforeBytes:nat,beforeSha256:sha,changedFile:id,changedBytes:nat,changedSha256:sha,persistedBytes:nat,persistedSha256:sha,injectedAtMs:nat},'corruption');
  const expected=fixture(c,o,locations),receipt=subjectReceipt(c,o);
  const before=openBeneath(c,locations.evidenceRoot,fault.beforeFile,1048576,'corruption-before');
  const changed=openBeneath(c,locations.evidenceRoot,fault.changedFile,1048576,'corruption-changed');
  c.eq([fault.beforeBytes,fault.beforeSha256,before],[expected.length,digest(expected),expected],'corruption.independent-before');
  c.eq([fault.changedBytes,fault.changedSha256],[changed.length,digest(changed)],'corruption.actual-changed-capture');
  c.ok(changed.length===expected.length&&!changed.equals(expected),'corruption.same-length-different-bytes');
  c.eq([fault.artifactId,fault.generation,fault.persistedBytes,fault.persistedSha256],[receipt.artifactId,receipt.generation,receipt.bytes,receipt.sha256],'corruption.trusted-association-not-rewritten');
  h.unchanged(c,o);
  const positive=h.response(c,o,'positive'),lookup=h.response(c,o,'lookup'),subject=h.response(c,o);
  const intact=openBeneath(c,locations.evidenceRoot,positive.bodyFile,1048576,'corruption-positive-body');
  c.eq({positive:success(positive),bytes:intact,beforeFault:positive.atMs<fault.injectedAtMs,lookup:success(lookup)},{positive:true,bytes:expected,beforeFault:true,lookup:true},'corruption.intact-and-record-controls');
  const accessed=o.storage.filter(x=>x.callId===o.input.subject.callId&&['open','read'].includes(x.kind));
  c.ok(accessed.some(x=>x.kind==='read'&&x.bytes===changed.length),'corruption.actual-authorized-body-read');
  for(const e of accessed)c.eq([e.artifactId,e.generation,e.atMs>=fault.injectedAtMs],[fault.artifactId,fault.generation,true],'corruption.actual-object-after-injection');
  const sent=o.transport.filter(x=>x.callId===o.input.subject.callId&&x.kind==='handoff');
  const ref=fixedReference(c,locations,'references/IC11/corrupt.json');
  c.eq({status:subject.status,headers:subject.headers,body:subject.body,bytes:subject.bytes,sha256:subject.sha256,bodyFile:subject.bodyFile},ref.unavailable,'corruption.no-altered-original-delivery');
  c.ok([404,409,503].includes(subject.status)&&subject.bodyFile===null,'corruption.explicit-unavailable');
  c.eq(sent.reduce((n,x)=>n+x.bytes,0),subject.bytes,'corruption.only-safe-response-handoff');
  reached(c,o,o.input.subject.callId,'noncanonical-query');
  const pb=o.requestBoundaries.find(b=>b.responseLabel==='positive');
  c.ok(pb&&o.storage.some(e=>e.callId===pb.callId&&e.kind==='read'&&e.artifactId===fault.artifactId&&e.generation===fault.generation&&e.bytes===expected.length&&e.atMs<fault.injectedAtMs),'corruption.intact-control-actual-read');
  for(const e of accessed)c.ok(o.evidence.some(v=>v.callId===e.callId&&v.id===e.evidenceId&&v.phase==='read_admission'&&v.artifactId===e.artifactId&&v.generation===e.generation&&v.atMs<=e.atMs),'corruption.prior-authorized-access');
  c.eq(o.after.counts.receipts,o.before.counts.receipts,'corruption.no-new-receipt');
}

export function framingCase(c,o,locations,h) {
  const x=o.ingress;
  shape(c,x,{origin:word('tls-client-and-terminal-observer'),callId:id,method:id,route:id,framingCase:id,clientWireKind:word('sanitized-template','exact-sent-bytes'),clientWireFile:id,clientWireBytes:nat,clientWireSha256:sha,exactAuthenticatedRequestSha256:nullable(sha),clientFacts:obj,serverBoundary:word('tls','http-parser','application-envelope','application-consumer'),serverFacts:obj,terminalReached:bool,ended:bool,interrupted:bool,atMs:nat},'framing');
  shape(c,x.clientFacts,{contentLengthValues:Array.isArray,transferEncodingValues:Array.isArray,contentEncodingValues:Array.isArray,bodyBytesWritten:nat,bodySha256:sha,cookiePresent:bool,csrfPresent:bool},'framing.client');
  shape(c,x.serverFacts,{headersObserved:bool,contentLengthValues:Array.isArray,transferEncodingValues:Array.isArray,contentEncodingValues:Array.isArray,applicationBytesRead:nat,parserErrorCode:nullable(id)},'framing.server');
  const ref=fixedReference(c,locations,'references/IC02/framing.json');
  c.eq([x.framingCase,x.serverBoundary],[ref.framingCase,ref.serverBoundary],'framing.independent-expected-boundary');
  const wire=openBeneath(c,locations.evidenceRoot,x.clientWireFile,1048576,'framing.actual-wire-template');
  c.eq([wire.length,digest(wire)],[x.clientWireBytes,x.clientWireSha256],'framing.actual-file-identity');
  c.eq(x.exactAuthenticatedRequestSha256,null,'framing.no-template-as-authenticated-request');
  const sep=wire.indexOf('\r\n\r\n');c.ok(sep>=0,'framing.header-boundary');
  const lines=wire.subarray(0,sep).toString('latin1').split('\r\n');
  c.eq(lines.shift(),`${x.method} ${x.route} HTTP/1.1`,'framing.actual-request-line');
  const values=name=>lines.filter(s=>s.slice(0,s.indexOf(':')).toLowerCase()===name).map(s=>s.slice(s.indexOf(':')+1).trim());
  const lists=[values('content-length'),values('transfer-encoding'),values('content-encoding')];
  c.eq([x.clientFacts.contentLengthValues,x.clientFacts.transferEncodingValues,x.clientFacts.contentEncodingValues],lists,'framing.duplicate-occurrences-preserved');
  c.eq([x.clientFacts.bodyBytesWritten,x.clientFacts.bodySha256],[wire.length-sep-4,digest(wire.subarray(sep+4))],'framing.actual-synthetic-body');
  c.eq([x.clientFacts.cookiePresent,x.clientFacts.csrfPresent],[values('cookie').length>0,values('x-csrf-token').length>0],'framing.observed-auth-presence');
  for(const name of ['cookie','x-csrf-token','authorization'])for(const v of values(name))c.ok(x.clientWireKind==='sanitized-template'&&v==='[REDACTED]','framing.no-secret-export');
  const b=boundary(c,o,x.callId),positive=o.requestBoundaries.find(v=>v.responseLabel==='positive');
  c.eq([x.callId,x.method,x.route,x.serverBoundary],[o.input.subject.callId,b.method,b.route,b.server.boundary],'framing.actual-correlated-boundary');
  c.ok(positive&&success(h.response(c,o,'positive'))&&positive.server.address===b.server.address&&positive.server.port===b.server.port,'framing.same-listener-positive');
  c.eq([positive.server.boundary,positive.admission.result],['application-consumer','accepted'],'framing.positive-reaches-tested-component');
  c.ok(lists[0].length>1||lists[1].length>0||lists[2].length>0,'framing.actual-offending-envelope');
  c.eq(x.terminalReached,['application-envelope','application-consumer'].includes(x.serverBoundary),'framing.truthful-reached-component');
  if(x.serverFacts.headersObserved)c.eq([x.serverFacts.contentLengthValues,x.serverFacts.transferEncodingValues,x.serverFacts.contentEncodingValues],lists,'framing.server-observed-headers');
  else c.eq([x.serverFacts.contentLengthValues,x.serverFacts.transferEncodingValues,x.serverFacts.contentEncodingValues],[[],[],[]],'framing.no-invented-parser-headers');
  if(x.serverBoundary==='http-parser')c.ok(id(x.serverFacts.parserErrorCode),'framing.actual-parser-refusal');
  else c.ok(x.terminalReached&&x.serverFacts.headersObserved,'framing.application-observed-refusal');
  const r=h.response(c,o),writes=o.storage.filter(e=>e.callId===x.callId&&isProtectedWrite(e.kind));
  c.eq({refused:r.status===null?x.interrupted:[400,413].includes(r.status),ended:x.ended||x.interrupted,consumed:x.serverFacts.applicationBytesRead,writes:writes.length,receipts:o.after.receipts.length,jobs:o.after.jobs.length},{refused:true,ended:true,consumed:0,writes:0,receipts:o.before.receipts.length,jobs:o.before.jobs.length},'framing.refusal-consumption-and-effects');
  h.unchanged(c,o);
}

function lateCommands(c,o,locations,commands,old,resumedAtMs,required=['append','seal']) {
  c.ok(Array.isArray(commands)&&commands.length>=required.length,'continuation.real-late-commands-required');
  const seen=new Set();
  for(const x of commands){
    shape(c,x,{origin:word('private-command-and-object-observers'),callId:id,requestId:id,receptionId:id,original:obj,incarnation:id,evidenceId:id,action:word('append','seal','read_stage'),outcome:word('failed-write','failed-seal','failed-stage-read','completed'),replyOk:bool,replyOutcome:id,offset:nullable(nat),submittedBytes:nat,startedAtMs:nat,endedAtMs:nat,beforeObject:nullable(obj),afterObject:nullable(obj)},'late-command');
    shape(c,x.original,originalFields,'late-command.original');boundary(c,o,x.callId);
    c.eq([x.receptionId,x.original.id,x.original.generation,x.incarnation],[old.receptionId,old.artifactId,old.generation,old.incarnation],'late-command.real-old-handle');
    c.ok(!seen.has(x.requestId),'late-command.unique-request');seen.add(x.requestId);
    c.eq([x.outcome,x.replyOk,x.replyOutcome],[{append:'failed-write',seal:'failed-seal',read_stage:'failed-stage-read'}[x.action],false,{append:'failed-write',seal:'failed-seal',read_stage:'failed-stage-read'}[x.action]],'late-command.exact-private-failure');
    c.ok(x.startedAtMs<=x.endedAtMs,'late-command.observed-order');
    c.ok(x.startedAtMs>=resumedAtMs,'late-command.after-completed-resume');
    c.eq(x.original.bytes,old.reservedBytes,'late-command.declared-length');
    c.ok(x.action==='append'?x.submittedBytes>0&&nat(x.offset):x.submittedBytes===0,'late-command.actual-operation-payload');
    c.ok(x.beforeObject&&x.afterObject,'late-command.retained-physical-captures');
    c.ok(x.beforeObject.file!==x.afterObject.file,'late-command.separate-object-observations');
    const before=fileBytes(c,locations,x.beforeObject,'late-before','evidence');
    c.eq([before.length,digest(before)],[old.actualBytes,old.actualSha256],'late-command.real-retained-object');
    c.eq(fileBytes(c,locations,x.afterObject,'late-after','evidence'),before,'late-command.no-physical-change');
  }
  for(const action of required)c.ok(commands.some(x=>x.action===action),`late-command.${action}-required`);
}

export function resumedCase(c,o,locations,h) {
  const x=o.continuation,ref=fixedReference(c,locations,'references/IC06/resumed.json');
  shape(c,x,{origin:word('sql-and-private-command-observers'),receptionId:id,interruptedCallId:id,resumeCallId:id,completedCallId:id,before:obj,after:obj,lateCommands:Array.isArray},'continuation');
  c.eq(x.receptionId,o.input.subject.receptionId,'continuation.subject');
  const expected=fixture(c,o,locations),old=o.before.attempts.find(a=>a.receptionId===x.receptionId),current=o.after.attempts.find(a=>a.receptionId===x.receptionId&&a.generation===o.input.generation);
  c.ok(old&&current,'continuation.complete-attempt-inventory');
  c.eq([old.actualBytes,old.actualSha256],[10,digest(expected.subarray(0,10))],'continuation.actual-interrupted-prefix');
  c.ok(current.generation>old.generation&&current.artifactId!==old.artifactId,'continuation.new-physical-attempt');
  c.ok(o.after.attempts.some(a=>a.receptionId===old.receptionId&&a.artifactId===old.artifactId&&a.generation===old.generation&&a.actualBytes===old.actualBytes&&a.actualSha256===old.actualSha256),'continuation.predecessor-retained');
  for(const [name,s]of [['before',o.before],['after',o.after]]){
    const obs=x[name];shape(c,obs,{observedAtMs:nat,declaration:obj,quota:obj},`continuation.${name}`);
    shape(c,obs.declaration,{receptionId:id,principal:id,personId:id,originSessionId:id,name:id,bytes:nat,sha256:sha,declaredMediaType:id,formatProfile:id,scopeId:id,purposeId:id,treatmentRevision:obj},'continuation.declaration');shape(c,obs.declaration.treatmentRevision,exactFields,'continuation.treatment');
    c.eq(obs.declaration,ref.declaration,'continuation.independent-unchanged-declaration');
    const r=s.receptions.find(r=>r.id===x.receptionId);c.eq([r.principal,r.personId,r.originSessionId],[ref.declaration.principal,ref.declaration.personId,ref.declaration.originSessionId],'continuation.same-logical-actor-session');
    c.eq([ref.declaration.bytes,ref.declaration.sha256],[expected.length,digest(expected)],'continuation.original-declaration');
    const q=obs.quota;shape(c,q,{origin:word('independent-sql-observer'),logicalDeclaredBytes:nat,subjectReservedBytes:nat,subjectAttemptCount:nat,globalReservedBytes:nat,globalReceptionCount:nat,maximumStorageBytes:nat,maximumAttempts:pos,maximumReceptions:pos,limitsReference:obj},'continuation.quota');shape(c,q.limitsReference,exactFields,'continuation.limits-reference');
    const attempts=s.attempts.filter(a=>a.receptionId===x.receptionId);
    c.eq([q.logicalDeclaredBytes,q.subjectReservedBytes,q.subjectAttemptCount,q.globalReservedBytes,q.globalReceptionCount],[expected.length,attempts.reduce((v,a)=>v+a.reservedBytes,0),attempts.length,s.attempts.reduce((v,a)=>v+a.reservedBytes,0),s.receptions.length],'continuation.actual-physical-quota-not-logical');
    c.eq([q.maximumStorageBytes,q.maximumAttempts,q.maximumReceptions,q.limitsReference],[ref.limits.maximumStorageBytes,ref.limits.maximumAttempts,ref.limits.maximumReceptions,ref.limits.reference],'continuation.independent-limits');
    c.ok(q.globalReservedBytes<=q.maximumStorageBytes&&q.subjectAttemptCount<=q.maximumAttempts&&q.globalReceptionCount<=q.maximumReceptions,'continuation.limits-respected');
  }
  const interrupted=boundary(c,o,x.interruptedCallId),resume=reached(c,o,x.resumeCallId,'canonical-act');
  c.eq(h.response(c,o,interrupted.responseLabel).status,null,'continuation.actual-response-interruption');
  c.ok(success(h.response(c,o,resume.responseLabel)),'continuation.actual-resume-positive');
  reached(c,o,x.completedCallId,'binary-transfer');
  const t=o.byteTransfers?.find(t=>t.callId===x.completedCallId);c.ok(t,'continuation.complete-retransmission-observation');
  const actual=transfer(c,o,locations,t);c.eq([actual.sent,actual.consumed,actual.staged,t.sent.ended,t.consumed.completed],[expected,expected,expected,true,true],'continuation.complete-not-suffix-retransmission');
  c.ok(h.response(c,o,interrupted.responseLabel).atMs<=x.before.observedAtMs&&x.before.observedAtMs<=resume.client.observedAtMs&&h.response(c,o,resume.responseLabel).atMs<=t.sent.observedAtMs&&t.staged.observedAtMs<=x.after.observedAtMs,'continuation.interruption-resume-retransmission-order');
  c.eq([t.artifactId,t.generation],[current.artifactId,current.generation],'continuation.new-attempt-transfer');
  for(const command of x.lateCommands)c.eq(command.original.sha256,digest(expected),'continuation.old-handle-declaration-not-rewritten');
  // This profile has no earlier independently observed generation fence.
  // A completed successful resume response is the observed lower boundary.
  lateCommands(c,o,locations,x.lateCommands,old,h.response(c,o,resume.responseLabel).atMs);
  h.oneReceipt(c,o);h.exactBody(c,o,h.response(c,o),locations);
  c.eq(o.before.receipts.filter(r=>r.receptionId===x.receptionId).length,0,'continuation.no-prior-success');
}

function processIdentity(c,p) {
  if(p?.kind==='os-process')shape(c,p,{kind:word('os-process'),containerId:nullable(sha),pid:pos,startTicks:x=>typeof x==='string'&&/^\d+$/.test(x),bootId:id,pidNamespace:id},'restart.os-identity');
  else shape(c,p,{kind:word('container-process-set'),containerId:sha,imageId:id,initHostPid:pos,startedAt:id},'restart.process-set-identity');
}
export function restartCase(c,o,locations,h) {
  rows(c,o.processes,{origin:word('owned-process-controller'),role:id,processRef:obj,incarnation:id,startedAtMs:nat,endedAtMs:nullable(nat),exitCode:nullable(x=>Number.isSafeInteger(x)),sourceSha256:sha},'restart.processes');
  c.eq(o.processes.length,2,'restart.old-and-replacement-process');
  const [old,next]=[...o.processes].sort((a,b)=>a.startedAtMs-b.startedAtMs);for(const p of o.processes)processIdentity(c,p.processRef);
  c.ok(old.endedAtMs!==null&&old.exitCode!==null&&old.startedAtMs<old.endedAtMs&&old.endedAtMs<next.startedAtMs&&next.endedAtMs===null,'restart.actual-exit-before-replacement');
  c.eq([old.role,old.sourceSha256],[next.role,next.sourceSha256],'restart.same-program-role');
  c.eq(old.processRef.kind,next.processRef.kind,'restart.comparable-process-identities');
  // Strip redundant decimal zeros without Number conversion or precision loss.
  const identity=p=>JSON.stringify(p.kind==='os-process'?[p.kind,p.containerId,p.pid,p.startTicks.replace(/^0+(?=\d)/,''),p.bootId,p.pidNamespace]:[p.kind,p.containerId,p.imageId,p.initHostPid,p.startedAt]);
  c.ok(identity(old.processRef)!==identity(next.processRef),'restart.distinct-os-process-not-label');
  c.ok(old.incarnation!==next.incarnation,'restart.new-incarnation');
  shape(c,o.startup,{origin:word('startup-and-sql-observer'),processRef:obj,incarnation:id,currentSourceId:id,currentGeneration:pos,atMs:nat,admitted:bool,namespace:id},'restart.startup');
  c.eq([o.startup.processRef,o.startup.incarnation,o.startup.admitted],[next.processRef,next.incarnation,true],'restart.actual-replacement-admitted');
  c.ok(o.startup.atMs>=next.startedAtMs,'restart.startup-after-process');
  const ref=fixedReference(c,locations,'references/IC12/restart.json');
  c.eq([o.startup.currentSourceId,o.startup.namespace],[ref.currentSourceId,o.after.schema],'restart.current-source-not-restoration');
  c.eq(o.startup.currentGeneration,ref.currentGeneration,'restart.current-generation');
  h.unchanged(c,o);h.oneReceipt(c,o);h.exactBody(c,o,h.response(c,o),locations);
  const before=o.before.receptions.find(r=>r.id===ref.incompleteReceptionId),after=o.after.receptions.find(r=>r.id===ref.incompleteReceptionId);
  c.ok(before&&after&&before.id!==o.input.subject.receptionId,'restart.preserved-incomplete-reception');
  c.eq([before.principal,before.personId,before.originSessionId],[after.principal,after.personId,after.originSessionId],'restart.incomplete-logical-lineage');
  c.eq(o.after.receipts.filter(r=>r.receptionId===after.id).length,0,'restart.incomplete-not-receipt');
  const incomplete=h.response(c,o,'incomplete');c.eq({status:incomplete.status,body:incomplete.body},ref.incompleteResponse,'restart.actual-incomplete-query');
  for(const label of ['subject','incomplete']){const b=o.requestBoundaries.find(x=>x.responseLabel===label);c.ok(b&&b.server.observedAtMs>=o.startup.atMs&&b.admission.observedAtMs>=o.startup.atMs,'restart.query-from-replacement-window');}
  const stale=o.before.attempts.find(a=>a.receptionId===before.id);c.ok(stale,'restart.old-incomplete-attempt');
  const afterAttempt=o.after.attempts.find(a=>a.artifactId===stale.artifactId);c.ok(afterAttempt&&afterAttempt.actualBytes===stale.actualBytes&&afterAttempt.actualSha256===stale.actualSha256,'restart.partial-bytes-not-recreated');
  c.ok(after.stopped||after.generation>stale.generation||afterAttempt.incarnation===next.incarnation,'restart.owner-generation-reconciled');
  const late=o.storage.filter(x=>x.artifactId===stale.artifactId&&x.generation===stale.generation&&x.incarnation===old.incarnation&&x.atMs>=o.startup.atMs);
  c.ok(late.some(x=>x.kind==='failed_write'&&x.bytes===0),'restart.late-owner-reached-storage');
  c.eq(late.filter(x=>isProtectedAccess(x.kind)).length,0,'restart.no-stale-owner-access');
  const partialBefore=openBeneath(c,locations.evidenceRoot,ref.partialObjects.beforeFile,1048576,'restart.partial-before'),partialAfter=openBeneath(c,locations.evidenceRoot,ref.partialObjects.afterFile,1048576,'restart.partial-after');
  c.eq([partialBefore.length,digest(partialBefore),partialAfter],[stale.actualBytes,stale.actualSha256,partialBefore],'restart.physical-partial-retained');
  const unavailable=h.response(c,o,'unavailable'),b=boundary(c,o,o.requestBoundaries.find(x=>x.responseLabel==='unavailable')?.callId);
  c.eq({status:unavailable.status,access:o.storage.filter(e=>e.callId===b.callId&&isProtectedAccess(e.kind)).length,admitted:b.admission.result},{status:503,access:0,admitted:'denied'},'restart.current-source-unavailable-fails-closed');
  c.ok(o.control.some(x=>x.sourceId===ref.currentSourceId&&x.action==='unavailable'&&!x.available&&x.atMs>=o.startup.atMs&&x.atMs<=unavailable.atMs),'restart.observed-current-source-failure');
}
