import { digest, openBeneath, rows, shape, success } from './observation.mjs';
import { canonicalReference } from './canonical.mjs';
import { validateBoundaries } from './request_boundary.mjs';
import { protectedAccessKinds } from './protected_access.mjs';

const id=x=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\u0000-\u001f\u007f]/u.test(x);
const nat=x=>Number.isSafeInteger(x)&&x>=0;
const pos=x=>nat(x)&&x>0;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const bool=x=>typeof x==='boolean';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const nullable=f=>x=>x===null||f(x);
const word=(...values)=>x=>values.includes(x);
const subjectFields={receptionId:nullable(id),callId:id,queryIntentionId:nullable(id),finalizationIntentionId:nullable(id)};
const namespaceFields={deployment:id,principal:id,act:id,variant:id,clientKey:id};
const targetFields={receptionId:nullable(id),artifactId:nullable(id),generation:nullable(pos),expectedRevision:nullable(pos)};
const namespace=x=>Object.fromEntries(Object.keys(namespaceFields).map(k=>[k,x[k]]));
const equalNamespace=(a,b)=>Object.keys(namespaceFields).every(k=>a[k]===b[k]);
function unique(c,values,key,label) {c.eq(new Set(values.map(x=>x[key])).size,values.length,`${label}.unique-${key}`);}
function one(c,values,rule) {c.eq(values.length,1,rule);return values[0];}
export function fixedReference(c,locations,name) {
  const bytes=openBeneath(c,locations.fixtureRoot,name,1048576,'independent-r3-reference');
  let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{c.ok(false,'independent-r3-reference.valid-json');}
  return result;
}

export function snapshotR3(c,s,label) {
  shape(c,s,{origin:word('sql-observer'),atMs:nat,database:word('inc02_synthetic'),schema:id,receptions:Array.isArray,intentions:Array.isArray,attempts:Array.isArray,receipts:Array.isArray,jobs:Array.isArray,principalBindings:Array.isArray,counts:obj},label);
  shape(c,s.counts,Object.fromEntries(['receptions','receipts','jobs','extractions','candidates','publications'].map(k=>[k,nat])),`${label}.counts`);
  rows(c,s.receptions,{id,principal:id,personId:id,originSessionId:nullable(id),generation:pos,revision:pos,state:id,stopped:bool},`${label}.receptions`);
  rows(c,s.intentions,{id,receptionId:id,...namespaceFields,canonicalProfile:word('canon_m09_1'),keyVersion:pos,storedPayloadDigest:sha,effectId:nullable(id),createdAtMs:nat},`${label}.intentions`);
  rows(c,s.attempts,{receptionId:id,generation:pos,artifactId:id,incarnation:id,state:id,reservedBytes:nat,actualBytes:nat,actualSha256:nullable(sha),expiresAtMs:nat},`${label}.attempts`);
  rows(c,s.receipts,{id,operationId:id,receptionId:id,principal:id,artifactId:id,generation:pos,bytes:nat,sha256:sha,effectId:id,personId:id,executorRef:id},`${label}.receipts`);
  rows(c,s.jobs,{id,receiptId:id,originalId:id,generation:pos,state:id,dispatchable:bool},`${label}.jobs`);
  rows(c,s.principalBindings,{origin:word('independent-sql-observer'),accountId:id,personId:id,accountRevision:pos,atMs:nat},`${label}.principalBindings`);
  for(const key of ['receptions','intentions','receipts','jobs'])unique(c,s[key],'id',`${label}.${key}`);
  unique(c,s.principalBindings,'accountId',`${label}.bindings`);
  unique(c,s.receipts,'effectId',`${label}.receipts`);unique(c,s.receipts,'receptionId',`${label}.receipts`);
  unique(c,s.attempts,'artifactId',`${label}.attempts`);
  c.eq(new Set(s.attempts.map(x=>JSON.stringify([x.receptionId,x.generation]))).size,s.attempts.length,`${label}.attempt-generation-unique`);
  c.eq([s.counts.receptions,s.counts.receipts,s.counts.jobs],[s.receptions.length,s.receipts.length,s.jobs.length],`${label}.counts-have-rows`);
  c.eq([s.counts.extractions,s.counts.candidates,s.counts.publications],[0,0,0],`${label}.no-later-effects`);
  for(const r of s.receptions){
    const binding=one(c,s.principalBindings.filter(x=>x.accountId===r.principal),`${label}.reception-account-binding`);
    c.eq(r.personId,binding.personId,`${label}.reception-person-binding`);
  }
  for(const intention of s.intentions){
    const r=one(c,s.receptions.filter(x=>x.id===intention.receptionId),`${label}.intention-reception-exists`);
    c.eq(intention.principal,r.principal,`${label}.intention-principal`);
    c.ok(intention.createdAtMs<=s.atMs,`${label}.intention-observed-after-creation`);
  }
  for(const attempt of s.attempts)c.ok(s.receptions.some(x=>x.id===attempt.receptionId),`${label}.attempt-reception-exists`);
  for(const r of s.receipts){
    const intent=one(c,s.intentions.filter(x=>x.id===r.operationId),`${label}.receipt-operation-exists`);
    const reception=one(c,s.receptions.filter(x=>x.id===r.receptionId),`${label}.receipt-reception-exists`);
    const attempt=one(c,s.attempts.filter(x=>x.receptionId===r.receptionId&&x.generation===r.generation),`${label}.receipt-attempt-exists`);
    c.eq([intent.receptionId,intent.principal,intent.effectId,intent.variant],[r.receptionId,r.principal,r.effectId,'finalize_reception'],`${label}.receipt-intention-linkage`);
    c.eq([r.principal,r.personId],[reception.principal,reception.personId],`${label}.receipt-person-linkage`);
    c.eq([r.artifactId,r.bytes,r.sha256],[attempt.artifactId,attempt.actualBytes,attempt.actualSha256],`${label}.receipt-original-linkage`);
  }
  for(const j of s.jobs){
    const r=one(c,s.receipts.filter(x=>x.id===j.receiptId),`${label}.job-receipt-exists`);
    c.eq([j.originalId,j.generation,j.dispatchable],[r.artifactId,r.generation,false],`${label}.pending-job-linkage`);
  }
}

export function validateR3(c,o,locations) {
  shape(c,o.input.subject,subjectFields,'input.subject');
  const actors=fixedReference(c,locations,'references/actors.json');
  shape(c,actors,{executorRef:id,bindings:Array.isArray},'actor-reference');
  rows(c,actors.bindings,{accountId:id,personId:id},'actor-reference.bindings');unique(c,actors.bindings,'accountId','actor-reference');
  c.ok(actors.bindings.some(x=>x.accountId===o.input.principal),'actor-reference.subject-account');
  for(const s of[o.before,o.after]) {
    for(const binding of s.principalBindings){
      const expected=one(c,actors.bindings.filter(x=>x.accountId===binding.accountId),'actors.independent-account-required');
      c.eq(binding.personId,expected.personId,'actors.independent-person-association');
    }
    for(const r of s.receipts)c.eq(r.executorRef,actors.executorRef,'executor.persisted-identity-and-lineage');
    const reception=s.receptions.find(x=>x.id===o.input.subject.receptionId);
    if(reception)c.eq(reception.principal,o.input.principal,'input.principal-linkage');
  }
  for(const e of o.evidence.filter(x=>x.phase==='effect')) {
    const expected=one(c,actors.bindings.filter(x=>x.accountId===e.principal),'actors.effect-account-required');
    c.eq([e.personRef,e.executorRef],[expected.personId,actors.executorRef],'executor.persisted-identity-and-lineage');
  }
  for(const key of ['queryIntentionId','finalizationIntentionId']) {
    const selected=o.input.subject[key];if(selected===null)continue;
    const row=one(c,o.after.intentions.filter(x=>x.id===selected),'subject.actual-selected-intention');
    c.eq([row.receptionId,row.principal],[o.input.subject.receptionId,o.input.principal],'subject.selected-intention-linkage');
    if(key==='finalizationIntentionId')c.eq(row.variant,'finalize_reception','subject.finalization-not-reservation');
  }
  validateBoundaries(c,o,locations);
  if(!['IC04','IC05'].includes(o.caseId)&&(o.invocations??[]).some(x=>o.requestBoundaries.find(b=>b.callId===x.callId)?.requestClass==='canonical-act'))invocationCaseR3(c,o,locations,{validationOnly:true});
}

export function subjectReceipt(c,o) {
  const r=one(c,o.after.receipts.filter(x=>x.receptionId===o.input.subject.receptionId),'effects.subject-receipt-required');
  c.eq(r.operationId,o.input.subject.finalizationIntentionId,'effects.finalization-intention-identity');
  c.eq(r.principal,o.input.principal,'effects.receipt-principal');
  return r;
}

function canonicalRequest(c,locations,expected) {
  shape(c,expected.target,targetFields,'reference.target');
  const wire=openBeneath(c,locations.fixtureRoot,expected.wireFile,65536,'independent-wire');
  const source=openBeneath(c,locations.fixtureRoot,expected.canonicalFile,262144,'independent-canonical');
  const bytes=canonicalReference(source,c),packet=JSON.parse(bytes.toString('utf8'));
  shape(c,packet,{profile:word('canon_m09_1'),contract:word('intake/1'),variant:word(expected.variant),path:obj,query:obj,body:obj},'independent-canonical.envelope');
  shape(c,packet.path,{template:id,parameters:obj},'independent-canonical.typed-path');
  const templates={reserve_reception:'/api/intake/receptions',finalize_reception:'/api/intake/receptions/:id/finalize',resume_reception:'/api/intake/receptions/:id/resume',cancel_reception:'/api/intake/receptions/:id/cancel'};
  c.ok(Object.hasOwn(templates,expected.variant),'independent-canonical.supported-act');
  c.eq(packet.path.template,templates[expected.variant],'independent-canonical.route-template');
  c.eq(packet.path.parameters,expected.target.receptionId===null?{}:{id:expected.target.receptionId},'independent-canonical.target-path');
  c.eq(packet.query,{},'independent-canonical.query');
  c.eq(packet.body,JSON.parse(canonicalReference(wire,c).toString('utf8')),'independent-canonical.wire-body');
  c.eq(packet.body.profile,'intake/1','independent-canonical.body-profile');
  if(expected.target.expectedRevision!==null)c.eq(packet.body.expected_revision,expected.target.expectedRevision,'independent-canonical.target-revision');
  if(['finalize_reception','resume_reception'].includes(expected.variant))c.eq([packet.body.original?.id,packet.body.original?.generation],[expected.target.artifactId,expected.target.generation],'independent-canonical.target-original');
  return {wire:digest(wire),canonical:digest(bytes)};
}

function correlate(c,o,call,compared,correlation,deployment) {
  shape(c,correlation,{origin:word('independent-sql-observer'),callId:id,atMs:nat,namespace:obj,outcome:word('confirmed','proven-absent','uncertain'),observation:obj},'correlation');
  shape(c,correlation.namespace,namespaceFields,'correlation.namespace');
  c.eq(correlation.namespace,namespace({...call,deployment}),'correlation.independent-namespace');
  c.eq(correlation.callId,call.callId,'correlation.actual-call');
  c.ok(compared.atMs<=correlation.atMs&&correlation.atMs<=o.after.atMs,'correlation.post-comparison-order');
  const row=correlation.observation,match=o.after.intentions.filter(x=>equalNamespace(x,correlation.namespace));
  if(correlation.outcome==='confirmed') {
    const existing=row.resolution==='existing-reception-effect';
    shape(c,row,{resolution:word('same-namespace','existing-reception-effect'),operationId:id,receptionId:id,storedPayloadDigest:sha,effectId:nullable(id),receiptId:nullable(id),jobId:nullable(id),observerBackendPid:pos,transactionSnapshot:id,matchedIntentionIds:Array.isArray,...(existing?{comparedIncumbentCanonicalSha256:sha}:{})},'correlation.confirmed');
    const intention=existing?one(c,o.after.intentions.filter(x=>x.id===row.operationId),'correlation.actual-incumbent-row'):one(c,match,'correlation.actual-durable-namespace-row');
    c.eq([row.operationId,row.receptionId,row.storedPayloadDigest,row.effectId,row.matchedIntentionIds],[intention.id,intention.receptionId,intention.storedPayloadDigest,intention.effectId,existing?[]:[intention.id]],'correlation.actual-durable-linkage');
    c.eq([intention.canonicalProfile,intention.keyVersion],[call.canonicalProfile,call.keyVersion],'correlation.canonical-version');
    c.eq(call.subject.receptionId,intention.receptionId,'correlation.subject-reception');
    if(compared.row==='present')c.eq([compared.operationId,compared.storedPayloadDigest],[intention.id,intention.storedPayloadDigest],'correlation.incumbent-linkage');
    else if(!existing) {
      c.ok(intention.createdAtMs>=compared.atMs,'correlation.new-row-after-lookup');
      c.eq(o.before.intentions.filter(x=>equalNamespace(x,correlation.namespace)).length,0,'correlation.new-lookup-has-no-prior-incumbent');
    }
    if(existing){
      c.eq([match.length,compared.row,compared.outcome,compared.operationId,compared.storedPayloadDigest],[0,'absent','new',null,null],'correlation.existing-receipt-does-not-invent-namespace-row');
      c.eq([intention.deployment,intention.principal,intention.variant,call.variant],[deployment,call.principal,'finalize_reception','finalize_reception'],'correlation.existing-receipt-principal-act');
      c.ok(intention.clientKey!==call.clientKey,'correlation.new-key-not-overwritten');
      c.eq(row.comparedIncumbentCanonicalSha256,call.canonicalPayloadSha256,'correlation.independent-incumbent-hash');
    }
    if(call.variant==='finalize_reception') {
      const receipt=one(c,o.after.receipts.filter(x=>x.operationId===intention.id),'correlation.finalization-receipt');
      const job=one(c,o.after.jobs.filter(x=>x.receiptId===receipt.id),'correlation.finalization-job');
      c.eq([row.effectId,row.receiptId,row.jobId,call.subject.finalizationIntentionId],[receipt.effectId,receipt.id,job.id,intention.id],'correlation.finalization-effect-linkage');
      if(compared.outcome!=='incompatible'&&!(o.incumbentComparisons??[]).some(x=>x.callId===call.callId&&x.outcome==='incompatible'))c.eq([receipt.receptionId,receipt.artifactId,receipt.generation],[call.target.receptionId,call.target.artifactId,call.target.generation],'correlation.compared-target-linkage');
    } else c.eq([row.receiptId,row.jobId],[null,null],'correlation.no-fabricated-finalization');
    const known=(o.incumbentComparisons??[]).filter(x=>x.callId===call.callId);
    if(existing||(compared.row==='present'&&success(o.responses.find(x=>x.label===call.responseLabel)))||known.length){
      const k=one(c,known,'incumbent.executed-comparison-required');
      shape(c,k,{origin:word('canonical-comparison-boundary'),phase:word('incumbent-payload'),callId:id,label:id,observedAtMs:nat,selection:word('same-namespace','existing-reception-effect'),principal:id,requestVariant:id,requestClientKey:id,receptionId:id,operationId:id,incumbentClientKey:id,canonicalProfile:word('canon_m09_1'),keyVersion:pos,comparedCanonicalSha256:sha,storedPayloadDigest:sha,outcome:word('compatible','incompatible'),effectId:nullable(id),receiptId:nullable(id)},'incumbent');
      c.eq([k.label,k.selection,k.principal,k.requestVariant,k.requestClientKey,k.receptionId,k.operationId,k.incumbentClientKey,k.canonicalProfile,k.keyVersion,k.comparedCanonicalSha256,k.storedPayloadDigest,k.effectId,k.receiptId],[call.label,row.resolution,call.principal,call.variant,call.clientKey,intention.receptionId,intention.id,intention.clientKey,call.canonicalProfile,call.keyVersion,call.canonicalPayloadSha256,intention.storedPayloadDigest,intention.effectId,row.receiptId],'incumbent.actual-row-request-and-effect');
      c.ok(compared.atMs<=k.observedAtMs&&k.observedAtMs<=correlation.atMs&&k.observedAtMs<=o.responses.find(x=>x.label===call.responseLabel).atMs,'incumbent.actual-boundary-order');
      // The stored value is keyed. Never compare it to an unkeyed SHA-256.
      // Actual known() outcome is cross-checked with the independently fixed
      // request relationship in the case, while SQL corroborates its incumbent.
      if(compared.row==='present')c.eq(k.outcome,compared.outcome,'incumbent.observed-comparator-consistency');
      const r=o.responses.find(x=>x.label===call.responseLabel);
      if(k.outcome==='incompatible')c.eq(r.status,409,'incumbent.conflict-not-second-effect');
    }
  } else if(correlation.outcome==='proven-absent') {
    shape(c,row,{resolution:word('no-committed-intention'),operationId:word(null),storedPayloadDigest:word(null),effectId:word(null),receiptId:word(null),jobId:word(null),receptionId:nullable(id),matchedIntentionIds:Array.isArray,transactionOutcome:word('not-started','rolled-back'),producerBackendPid:nullable(pos),transactionId:nullable(id),terminalObservationAtMs:nat,observerBackendPid:pos,transactionSnapshot:id,namespaceFence:obj,activeProducerCount:word(0)},'correlation.absent');
    shape(c,row.namespaceFence,{held:word(true),observedAtMs:nat,effectiveKeys:Array.isArray},'correlation.namespace-fence');
    c.eq(row.receptionId,call.subject.receptionId,'correlation.absent-selected-reception');
    if(row.receptionId!==null&&call.target.receptionId!==null)c.eq(row.receptionId,call.target.receptionId,'correlation.absent-independent-target');
    c.ok(row.namespaceFence.effectiveKeys.length>0&&row.namespaceFence.effectiveKeys.every(Number.isSafeInteger),'correlation.effective-fence-keys');
    c.eq(row.namespaceFence.effectiveKeys,[...new Set(row.namespaceFence.effectiveKeys)].sort((a,b)=>a-b),'correlation.sorted-distinct-fence');
    c.ok(compared.atMs<=row.terminalObservationAtMs&&row.terminalObservationAtMs<=row.namespaceFence.observedAtMs&&row.namespaceFence.observedAtMs<=correlation.atMs,'correlation.completed-before-fresh-fenced-query');
    c.eq([compared.row,compared.outcome,row.matchedIntentionIds,match.length],['absent','new',[],0],'correlation.no-committed-namespace-row');
    if(row.transactionOutcome==='rolled-back')c.ok(pos(row.producerBackendPid)&&id(row.transactionId)&&row.producerBackendPid!==row.observerBackendPid,'correlation.observed-rollback');
    else c.eq([row.producerBackendPid,row.transactionId],[null,null],'correlation.no-started-transaction');
    c.eq([o.after.receipts,o.after.jobs],[o.before.receipts,o.before.jobs],'correlation.absent-no-new-effect');
    c.ok(!success(o.responses.find(x=>x.label===call.responseLabel)),'correlation.absence-not-success');
  } else {
    shape(c,row,{resolution:word('unresolved'),operationId:nullable(id),receptionId:nullable(id),storedPayloadDigest:nullable(sha),lastObservedAtMs:nat,reason:word('connection-lost','owner-unreconciled','current-source-unavailable'),terminalOutcomeEstablished:word(false),namespaceFenceEstablished:word(false)},'correlation.uncertain');
    c.ok(false,'correlation.uncertain-is-not-confirmed-acceptance');
  }
  return row;
}

function compatiblePriorReplay(c,o,a,b,ra,rb) {
  const prior=one(c,o.phaseLineage.priorUploads,'replay.prior-window-required');
  c.eq([a.call.callId,a.call.variant,b.call.variant],
    [prior.finalizeCallId,'finalize_reception','finalize_reception'],'replay.subject-is-first-finalizer');
  const boundary=one(c,o.requestBoundaries.filter(x=>x.callId===b.call.callId),'replay.independent-boundary');
  c.ok(boundary.callId!==a.call.callId&&boundary.callId!==prior.uploadCallId,'replay.distinct-canonical-call');
  c.eq([boundary.requestClass,boundary.admission.result],['canonical-act','accepted'],'replay.current-admission');
  c.ok(ra.atMs<=boundary.server.observedAtMs,'replay.completed-producer-before-reconciliation');
  c.eq(o.storage.filter(x=>x.callId===boundary.callId&&protectedAccessKinds.includes(x.kind)).length,0,'replay.no-original-access');
  c.eq(o.evidence.filter(x=>x.callId===boundary.callId&&x.phase==='effect').length,0,'replay.no-new-effect');
  const receipt=subjectReceipt(c,o),job=one(c,o.after.jobs.filter(x=>x.receiptId===receipt.id),'replay.same-pending-job');
  const handoff=one(c,o.transport.filter(x=>x.callId===boundary.callId&&x.kind==='handoff'),'replay.actual-handoff');
  const query=one(c,o.evidence.filter(x=>x.callId===boundary.callId&&x.phase==='query'),'replay.own-query-evidence');
  c.eq([query.operationId,query.receptionId,query.principal,query.artifactId,query.generation,query.backendPid,query.transactionOpen],
    [receipt.operationId,receipt.receptionId,boundary.principal,null,null,boundary.admission.backendPid,false],'replay.current-query-scope');
  c.ok(success(query)&&boundary.server.observedAtMs<=boundary.admission.observedAtMs&&boundary.admission.observedAtMs<=query.atMs&&query.atMs<=handoff.atMs,'replay.current-query-order');
  for(const r of [ra,rb]) {
    c.eq([r.bodyFile,r.body?.profile,r.body?.representation,r.body?.operation_id,r.body?.reception_id,r.body?.effect?.id,
      r.body?.original,r.body?.work],
      [null,'intake/1','intake-reception/1',receipt.operationId,receipt.receptionId,receipt.effectId,
        {id:receipt.artifactId,generation:receipt.generation,bytes:receipt.bytes,sha256:receipt.sha256},
        {id:job.id,state:'not_started',dispatchable:false}],'replay.returned-known-effect');
  }
}

export function invocationCaseR3(c,o,locations,h) {
  o={...o,invocations:(o.invocations??[]).filter(x=>o.requestBoundaries.find(b=>b.callId===x.callId)?.requestClass==='canonical-act')};
  const ref=fixedReference(c,locations,`references/${o.caseId}/${o.variant}${h.validationOnly?'.intentions':''}.json`);
  shape(c,ref,{executorRef:id,deployment:id,invocations:Array.isArray},'invocation-reference');
  rows(c,ref.invocations,{label:id,principal:id,clientKey:id,act:id,variant:id,target:obj,canonicalProfile:word('canon_m09_1'),keyVersion:pos,wireFile:id,canonicalFile:id},'invocation-reference.rows');
  rows(c,o.invocations,{origin:word('https-client-and-request-observer'),label:id,callId:id,principal:id,clientKey:nullable(id),act:id,variant:id,target:obj,subject:obj,wireBodySha256:nullable(sha),canonicalPayloadSha256:nullable(sha),canonicalProfile:nullable(word('canon_m09_1')),keyVersion:nullable(pos),responseLabel:id},'invocations');
  rows(c,o.comparisons,{origin:word('canonical-comparison-boundary'),label:id,callId:id,principal:id,act:id,variant:id,clientKey:id,canonicalProfile:word('canon_m09_1'),keyVersion:pos,comparedCanonicalSha256:sha,phase:word('namespace-lookup'),row:word('absent','present'),operationId:nullable(id),storedPayloadDigest:nullable(sha),outcome:word('new','compatible','incompatible'),atMs:nat},'comparisons');
  c.ok(Array.isArray(o.correlations),'correlations.required');
  c.ok(ref.invocations.length>0,'invocations.nonempty-reference');
  for(const [name,values]of[['reference',ref.invocations],['invocations',o.invocations],['comparisons',o.comparisons]])unique(c,values,'label',name);
  for(const [name,values]of[['invocations',o.invocations],['comparisons',o.comparisons],['correlations',o.correlations]]){unique(c,values,'callId',name);c.eq(values.length,ref.invocations.length,'invocations.complete-reference-set');}
  const resolved=[];
  for(const expected of ref.invocations){
    const call=one(c,o.invocations.filter(x=>x.label===expected.label),'invocations.reference-label');
    shape(c,call.target,targetFields,'invocations.target');shape(c,call.subject,subjectFields,'invocations.subject');
    c.eq(call.callId,call.subject.callId,'invocations.actual-subject-call');
    const hashes=canonicalRequest(c,locations,expected);
    c.eq([call.principal,call.clientKey,call.act,call.variant,call.target,call.canonicalProfile,call.keyVersion,call.wireBodySha256,call.canonicalPayloadSha256],[expected.principal,expected.clientKey,expected.act,expected.variant,expected.target,expected.canonicalProfile,expected.keyVersion,hashes.wire,hashes.canonical],'invocations.independent-request-identity');
    const compared=one(c,o.comparisons.filter(x=>x.callId===call.callId),'invocations.actual-comparison-required');
    c.eq([compared.label,compared.principal,compared.act,compared.variant,compared.clientKey,compared.canonicalProfile,compared.keyVersion,compared.comparedCanonicalSha256],[call.label,call.principal,call.act,call.variant,call.clientKey,call.canonicalProfile,call.keyVersion,hashes.canonical],'invocations.actual-canonical-comparison');
    if(compared.row==='absent')c.eq([compared.operationId,compared.storedPayloadDigest,compared.outcome],[null,null,'new'],'comparison.truthful-absent-row');
    else c.ok(id(compared.operationId)&&sha(compared.storedPayloadDigest)&&['compatible','incompatible'].includes(compared.outcome),'comparison.actual-incumbent-required');
    c.ok(o.responses.some(x=>x.label===call.responseLabel),'invocations.client-response-required');
    const correlation=one(c,o.correlations.filter(x=>x.callId===call.callId),'correlation.required-actual-call');
    resolved.push({call,compared,correlation,row:correlate(c,o,call,compared,correlation,ref.deployment)});
  }
  if(h.validationOnly)return resolved;
  if(o.caseId==='IC05') {
    if(o.variant==='invalid-linkage'){h.denied(c,o,[403,409]);c.eq(resolved[0].correlation.outcome,'proven-absent','linkage.observed-rollback-required');}
    else {h.successfulReceipt(c,o);const receipt=subjectReceipt(c,o);const ev=one(c,o.evidence.filter(x=>x.phase==='effect'&&x.operationId===receipt.operationId),'executor.one-durable-effect-observation');c.eq([receipt.executorRef,ev.personRef,ev.executorRef,ev.artifactId,ev.generation],[ref.executorRef,receipt.personId,ref.executorRef,receipt.artifactId,receipt.generation],'executor.persisted-identity-and-lineage');}
    return;
  }
  c.eq(resolved.length,2,'intention.two-discriminating-invocations');
  const[a,b]=resolved,ra=h.response(c,o,a.call.responseLabel),rb=h.response(c,o,b.call.responseLabel);
  c.ok(success(ra),'intention.first-producer-positive');
  c.eq(a.compared.outcome,'new','intention.first-actual-producer');
  if(o.variant==='other-principal'){
    c.ok(a.call.principal!==b.call.principal,'intention.distinct-principals');
    c.eq([a.call.clientKey,a.call.act,a.call.variant],[b.call.clientKey,b.call.act,b.call.variant],'intention.same-key-other-principal');
    c.eq({success:success(rb),distinct:a.row.operationId!==b.row.operationId,receipts:o.after.receipts.length,jobs:o.after.jobs.length},{success:true,distinct:true,receipts:2,jobs:2},'intention.separate-namespaces-effects');
    const first=o.after.receipts.find(x=>x.operationId===a.row.operationId),second=o.after.receipts.find(x=>x.operationId===b.row.operationId);
    c.eq([first.principal,second.principal],[a.call.principal,b.call.principal],'intention.receipt-principals');
    const strings=[];const visit=x=>{if(x!==null&&typeof x==='object')Object.values(x).forEach(visit);else strings.push(x);};visit(rb.body);
    c.ok(!strings.includes(first.id)&&!strings.includes(a.row.operationId),'intention.no-other-principal-disclosure');
  } else {
    const newKey=b.row.resolution==='existing-reception-effect';
    c.eq(namespace({...a.call,deployment:ref.deployment}),namespace({...b.call,deployment:ref.deployment,...(newKey?{clientKey:a.call.clientKey}:{})}),'intention.stable-namespace');
    const incompatible=o.variant==='incompatible';
    const known=o.incumbentComparisons?.find(x=>x.callId===b.call.callId);
    if(known)c.eq(known.outcome,incompatible?'incompatible':'compatible','incumbent.independent-request-compatibility');
    c.eq(a.call.canonicalPayloadSha256===b.call.canonicalPayloadSha256,!incompatible,'intention.reference-compatibility');
    c.eq({status:incompatible?rb.status:success(rb),same:a.row.operationId===b.row.operationId,outcome:b.compared.outcome,receipts:o.after.receipts.length,jobs:o.after.jobs.length},{status:incompatible?409:true,same:true,outcome:newKey?'new':incompatible?'incompatible':'compatible',receipts:1,jobs:1},'intention.outcome-namespace-and-effects');
    h.oneReceipt(c,o);
    if(o.variant==='compatible'&&o.interfaceAddendum==='3.3'&&o.phaseLineage.priorUploads.length)compatiblePriorReplay(c,o,a,b,ra,rb);
  }
}
