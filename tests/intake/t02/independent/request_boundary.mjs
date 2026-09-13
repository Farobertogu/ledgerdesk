import { shape, rows, success } from './observation.mjs';
import { fixedReference } from './revision3.mjs';
import { isIP } from 'node:net';
import { protectedAccessKinds, applicableAdmissionPhase } from './protected_access.mjs';
import { validatePhaseLineage } from './phase_lineage.mjs';

const id=x=>typeof x==='string'&&x.length>0&&x.length<=512;
const n=x=>Number.isSafeInteger(x)&&x>=0, pos=x=>n(x)&&x>0;
const nullable=f=>x=>x===null||f(x), word=(...xs)=>x=>xs.includes(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const protectedKinds=new Set(protectedAccessKinds);
// Normalize only explicit dotted IPv4-mapped addresses for identity comparison.
// Keep the original client/server strings in the packet and captured evidence.
const address=x=>/^::ffff:/i.test(x)&&isIP(x.slice(7))===4?x.slice(7):x;
const endpoints=b=>[address(b.client.address),b.client.port,address(b.client.peerAddress),b.client.peerPort];
const connection=b=>JSON.stringify(endpoints(b));
export const callReferencePath=o=>`references/${o.caseId}/${o.variant}.calls.json`;

export function requestClass(method,route) {
  if(method==='POST'&&(/^\/api\/intake\/receptions$/.test(route)||/^\/api\/intake\/receptions\/[^/]+\/(finalize|resume|cancel)$/.test(route)))return 'canonical-act';
  if(method==='POST'&&/^\/api\/intake\/receptions\/[^/]+\/attempts\/\d+\/original$/.test(route))return 'binary-transfer';
  if((method==='GET'&&/^\/api\/intake\/(profiles|receptions\/[^/]+(?:\/original)?|operations\/[^/]+)$/.test(route))||(method==='POST'&&route==='/api/intake/operations/lookup'))return 'noncanonical-query';
  return 'unresolved-envelope';
}

export function validateBoundaries(c,o,locations) {
  rows(c,o.requestBoundaries,{origin:word('https-client-and-server-boundary'),callId:id,label:id,requestClass:word('canonical-act','noncanonical-query','binary-transfer','unresolved-envelope'),method:id,route:id,client:object,server:object,correlationMode:word('connection-and-request','single-call-connection'),principal:nullable(id),receptionId:nullable(id),admission:object,responseLabel:id},'request-boundaries');
  const reference=fixedReference(c,locations,callReferencePath(o));
  shape(c,reference,{calls:Array.isArray},'request-reference');
  rows(c,reference.calls,{label:id,method:id,route:id,requestClass:id,principal:nullable(id),receptionId:nullable(id),allowedAccess:Array.isArray},'request-reference.calls');
  for(const key of ['callId','label','responseLabel'])c.eq(new Set(o.requestBoundaries.map(x=>x[key])).size,o.requestBoundaries.length,`request-boundaries.unique-${key}`);
  c.eq(new Set(reference.calls.map(x=>x.label)).size,reference.calls.length,'request-reference.unique-label');
  c.eq(reference.calls.length,o.requestBoundaries.length,'request-boundaries.complete-independent-set');
  c.eq(o.responses.length,o.requestBoundaries.length,'request-boundaries.complete-responses');
  const byCall=new Map(o.requestBoundaries.map(x=>[x.callId,x]));
  c.ok(byCall.has(o.input.subject.callId),'request-boundaries.subject-required');
  const subject=byCall.get(o.input.subject.callId);
  const observedRequests=new Set();
  c.eq(subject.receptionId,o.input.subject.receptionId,'request.subject-reception');
  if(subject.principal!==null)c.eq(subject.principal,o.input.principal,'request.subject-principal');
  for(const b of o.requestBoundaries) {
    shape(c,b.client,{address:id,port:pos,peerAddress:id,peerPort:pos,requestOrdinal:pos,observedAtMs:n},'request.client');
    shape(c,b.server,{address:id,port:pos,peerAddress:id,peerPort:pos,requestOrdinal:nullable(pos),observedAtMs:n,boundary:word('tls','http-parser','application-envelope','application-consumer')},'request.server');
    shape(c,b.admission,{result:word('accepted','denied','not-evaluated'),source:word('current-sql-admission','transport-envelope','http-parser','tls'),observedAtMs:n,backendPid:nullable(pos),controlSourceId:nullable(id),controlRevision:nullable(pos)},'request.admission');
    c.eq(endpoints(b),[address(b.server.peerAddress),b.server.peerPort,address(b.server.address),b.server.port],'request.observed-reversed-sockets');
    if(b.correlationMode==='connection-and-request')c.eq(b.server.requestOrdinal,b.client.requestOrdinal,'request.observed-ordinal');
    else c.eq({ordinal:b.server.requestOrdinal,single:o.requestBoundaries.filter(x=>connection(x)===connection(b)).length,early:['tls','http-parser'].includes(b.server.boundary)},{ordinal:null,single:1,early:true},'request.single-call-early-boundary');
    const actualRequest=JSON.stringify([...endpoints(b),b.client.requestOrdinal]);
    c.ok(!observedRequests.has(actualRequest),'request.unique-observed-connection-request');
    observedRequests.add(actualRequest);
    const ref=reference.calls.find(x=>x.label===b.label);
    c.ok(ref,'request.independent-call-required');
    c.eq([b.method,b.route,b.requestClass,b.principal,b.receptionId],[ref.method,ref.route,ref.requestClass,ref.principal,ref.receptionId],'request.independent-semantics');
    c.eq(b.requestClass,requestClass(b.method,b.route),'request.route-classification');
    const r=o.responses.find(x=>x.label===b.responseLabel);
    c.ok(r,'request.actual-response-required');c.eq(r.route,b.route,'request.actual-response-route');
    if(b.requestClass==='unresolved-envelope')c.ok(!success(r)&&b.admission.result!=='accepted','request.unresolved-not-admitted');
    if(b.admission.result==='accepted')c.ok(b.admission.source==='current-sql-admission'&&pos(b.admission.backendPid)&&id(b.admission.controlSourceId)&&pos(b.admission.controlRevision)&&id(b.principal),'request.actual-current-admission');
    if(b.requestClass==='canonical-act'&&b.admission.result==='accepted')c.ok((o.invocations??[]).some(x=>x.callId===b.callId),'request.accepted-canonical-invocation-required');
    if(['tls','http-parser'].includes(b.admission.source))c.eq([b.admission.backendPid,b.admission.controlSourceId,b.admission.controlRevision],[null,null,null],'request.no-fabricated-sql-admission');
    rows(c,ref.allowedAccess,{kind:word(...protectedKinds),artifactId:id,generation:pos},'request-reference.allowed-access');
  }
  const phase=validatePhaseLineage(c,o,locations);
  for(const [kind,events]of [['storage',o.storage],['evidence',o.evidence],['transport',o.transport],['invocations',o.invocations??[]],['comparisons',o.comparisons??[]],['correlations',o.correlations??[]],['incumbentComparisons',o.incumbentComparisons??[]]])for(const e of events) {
    const b=byCall.get(e.callId);c.ok(b,'request.event-actual-call-required');
    if(['comparisons','correlations','incumbentComparisons'].includes(kind))c.eq(b.requestClass,'canonical-act','request.canonical-not-relabelled-query');
    if(kind==='invocations'&&b.requestClass!=='canonical-act') {
      c.eq([e.clientKey,e.wireBodySha256,e.canonicalPayloadSha256,e.canonicalProfile,e.keyVersion],[null,null,null,null,null],'request.noncanonical-no-invented-intention');
      shape(c,e,{origin:word('https-client-and-request-observer'),label:id,callId:id,principal:id,clientKey:word(null),act:id,variant:id,target:object,subject:object,wireBodySha256:word(null),canonicalPayloadSha256:word(null),canonicalProfile:word(null),keyVersion:word(null),responseLabel:id},'request.noncanonical-invocation');
      c.ok(e.act!=='CARGAR_MATERIAL','request.noncanonical-actual-semantics');
      c.eq([e.callId,e.principal,e.subject.callId,e.subject.receptionId,e.responseLabel],[b.callId,b.principal,b.callId,b.receptionId,b.responseLabel],'request.noncanonical-selected-subject');
    }
    if(kind==='invocations'&&b.requestClass==='canonical-act')c.eq([e.principal,e.subject?.receptionId,e.responseLabel],[b.principal,b.receptionId,b.responseLabel],'request.invocation-selected-subject');
    if(['storage','evidence','transport'].includes(kind)&&e.callId!==o.input.subject.callId) {
      if(!(kind==='evidence'&&phase.metadataIds.has(e.id)))c.eq(e.receptionId,b.receptionId,'request.other-call-reception');
      if(kind==='evidence')c.eq(e.principal,b.principal,'request.other-call-principal');
      if(kind==='storage'&&protectedKinds.has(e.kind)) {
        c.eq(b.admission.result,'accepted','request.other-call-independent-admission');
        c.ok(b.server.observedAtMs<=b.admission.observedAtMs&&b.admission.observedAtMs<=e.atMs,'request.other-call-admission-before-operation');
        const ref=reference.calls.find(x=>x.label===b.label);
        c.ok(ref.allowedAccess.some(x=>x.kind===e.kind&&x.artifactId===e.artifactId&&x.generation===e.generation),'request.other-call-independent-object-scope');
        const requiredPhase=phase.seals.has(e)?'read_admission':applicableAdmissionPhase(e.kind);
        c.ok(requiredPhase!==null,'request.other-call-restore-exclusion-unsupported');
        const applicable=o.evidence.filter(x=>x.callId===e.callId&&x.id===e.evidenceId&&x.phase===requiredPhase);
        c.ok(applicable.length>0,'request.other-call-applicable-evidence');
        c.ok(applicable.some(x=>x.atMs<=e.atMs&&x.artifactId===e.artifactId&&x.generation===e.generation&&x.principal===b.principal&&x.receptionId===b.receptionId&&x.status>=200&&x.status<300&&x.transactionOpen===false),'request.other-call-prior-evidence');
      }
      if(kind==='transport'&&e.kind==='handoff') {
        const response=o.responses.find(x=>x.label===b.responseLabel);
        c.eq(e.route,b.route,'request.other-call-delivery-route');
        c.eq(e.bytes,response.bytes,'request.other-call-observed-transfer-bytes');
        if(success(response)){
          c.eq(b.admission.result,'accepted','request.other-call-delivery-admitted');
          c.ok(b.server.observedAtMs<=b.admission.observedAtMs&&b.admission.observedAtMs<=e.atMs,'request.other-call-delivery-admission-before-operation');
          c.ok(o.evidence.some(x=>x.callId===e.callId&&x.id===e.evidenceId&&x.phase==='delivery'&&x.atMs<=e.atMs&&!x.transactionOpen&&x.principal===b.principal),'request.other-call-delivery-evidence');
          if(response.bodyFile!==null)c.ok(o.storage.some(x=>x.callId===e.callId&&x.kind==='read'),'request.other-call-binary-read-scope');
        }
      }
    }
  }
}
