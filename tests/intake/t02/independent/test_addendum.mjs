import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertCase } from './index.mjs';
import { callReferencePath } from './request_boundary.mjs';

export function registerAddendumTests({specimen,json,event}) {
  const run=x=>assertCase(x.o.caseId,x.o.variant,x.o,x.locations);
  const editRef=(x,name,change)=>{const p=path.join(x.locations.fixtureRoot,name),r=JSON.parse(readFileSync(p));change(r);writeFileSync(p,JSON.stringify(r));};
  function pair(name,make,change,rule){test(name,()=>{
    const x=make(),positive=run(x);json(x.locations.evidenceRoot,'r32-positive.json',{observation:x.o,result:positive});
    const bad={o:structuredClone(x.o),locations:x.locations};change(bad);let caught;
    assert.throws(()=>run(bad),e=>{caught=e;return e instanceof assert.AssertionError&&e.message.includes(rule);});
    json(x.locations.evidenceRoot,'r32-negative.json',{observation:bad.o,expectedRule:rule,observedRule:caught.message});
  });}
  function otherCall(){
    const x=specimen('IC08','query-denied'),{o}=x,base=o.requestBoundaries[0];
    o.requestBoundaries.push({...structuredClone(base),callId:'other-call',label:'other',responseLabel:'other',client:{...base.client,port:49999},server:{...base.server,peerPort:49999}});
    o.responses.push({...structuredClone(o.responses[0]),label:'other',status:200});
    const read={...event(o,'read',{evidenceId:'other-admission',artifactId:'admitted-sibling',generation:2}),callId:'other-call'};o.storage.push(read);
    o.evidence.push({origin:'sql-observer',id:'other-admission',phase:'read_admission',operationId:o.input.subject.queryIntentionId,artifactId:read.artifactId,generation:2,principal:o.input.principal,status:200,atMs:read.atMs-1,backendPid:41,transactionOpen:false,callId:'other-call',receptionId:o.input.subject.receptionId});
    editRef(x,callReferencePath(o),r=>r.calls.push({...structuredClone(r.calls[0]),label:'other',allowedAccess:[{kind:'read',artifactId:'admitted-sibling',generation:2}]}));return x;
  }
  pair('R3.2: legitimate independently admitted other-call read stays separate',otherCall,x=>x.o.storage[0].callId=x.o.input.subject.callId,'denial.outcome-and-effects-and-access');
  pair('R3.2: an invented other call cannot hide a protected read',otherCall,x=>x.o.storage[0].callId='unobserved-call','request.event-actual-call-required');
  pair('R3.2: known other call alone does not authorize its sibling target',otherCall,x=>x.o.storage[0].artifactId='unpermitted-sibling','request.other-call-independent-object-scope');
  pair('R3.2: accepted other-call label cannot substitute prior SQL admission',otherCall,x=>x.o.evidence.find(e=>e.id==='other-admission').atMs=x.o.storage[0].atMs+1,'request.other-call-prior-evidence');
  pair('R3.2: unrelated sockets cannot be joined by timestamps',otherCall,x=>x.o.requestBoundaries[1].server.peerPort++,'request.observed-reversed-sockets');
  pair('R3.2: mismatched HTTP ordinals cannot identify a request',otherCall,x=>x.o.requestBoundaries[1].server.requestOrdinal++,'request.observed-ordinal');
  pair('R3.2: admitted query cannot be relabelled as loading',()=>specimen('IC08','query-without-load'),x=>x.o.requestBoundaries[0].requestClass='canonical-act','request.independent-semantics');
  pair('R3.2: actual canonical comparison cannot be hidden behind a query',()=>specimen('IC04','compatible'),x=>{const b=x.o.requestBoundaries.find(b=>b.callId===x.o.invocations[0].callId);b.method='GET';b.route='/api/intake/receptions/operation-1';b.requestClass='noncanonical-query';x.o.responses.find(r=>r.label===b.responseLabel).route=b.route;editRef(x,callReferencePath(x.o),r=>Object.assign(r.calls.find(r=>r.label===b.label),{method:b.method,route:b.route,requestClass:b.requestClass}));},'request.noncanonical-no-invented-intention');
  function newKey(){
    const x=specimen('IC04','compatible'),call=x.o.invocations[1],cmp=x.o.comparisons[1],co=x.o.correlations[1],known=x.o.incumbentComparisons[0];
    call.clientKey='new-client-key';cmp.clientKey=call.clientKey;cmp.row='absent';cmp.outcome='new';cmp.operationId=null;cmp.storedPayloadDigest=null;
    co.namespace.clientKey=call.clientKey;co.observation.resolution='existing-reception-effect';co.observation.matchedIntentionIds=[];co.observation.comparedIncumbentCanonicalSha256=call.canonicalPayloadSha256;
    known.selection='existing-reception-effect';known.requestClientKey=call.clientKey;
    editRef(x,`references/IC04/compatible.json`,r=>r.invocations[1].clientKey=call.clientKey);return x;
  }
  pair('R3.2: a new key can reconcile an actual retained finalization',newKey,x=>x.o.incumbentComparisons=[],'incumbent.executed-comparison-required');
  pair('R3.2: new-key reconciliation cannot substitute another receipt',newKey,x=>x.o.correlations[1].observation.receiptId='wrong-receipt','correlation.finalization-effect-linkage');
  pair('R3.2: namespace comparison is not an incumbent observation',newKey,x=>x.o.incumbentComparisons=[{...x.o.comparisons[1],phase:'incumbent-payload'}],'incumbent.keys');
  pair('R3.2: successful replay requires its executed known comparison',()=>specimen('IC04','compatible'),x=>x.o.incumbentComparisons=[],'incumbent.executed-comparison-required');
  pair('R3.2: a copied earlier comparison cannot acquire a later boundary time',()=>specimen('IC04','compatible'),x=>x.o.incumbentComparisons[0].observedAtMs=1800000000001,'incumbent.actual-boundary-order');
  pair('M04: a not-started transaction can be proved absent without borrowing SQL IDs',()=>{const x=specimen('IC05','invalid-linkage');Object.assign(x.o.correlations[0].observation,{transactionOutcome:'not-started',producerBackendPid:null,transactionId:null});return x;},x=>x.o.correlations[0].observation.producerBackendPid=41,'correlation.no-started-transaction');
  pair('Compatibility: R3.1 is not silently accepted as R3.2',()=>specimen('IC01','round-trip'),x=>x.o.interfaceAddendum='3.1','envelope.interfaceAddendum');
  pair('Compatibility: R2 cannot silently reuse revised SQL semantics',()=>specimen('IC01','round-trip'),x=>x.o.interfaceRevision=2,'coverage.legacy-observation-not-revised-acceptance');
  pair('IC11/missing: actual unavailable response preserves failed-open discrimination',()=>{const x=specimen('IC11','missing');x.o.responses[0].status=503;return x;},x=>x.o.storage=[],'availability.actual-failed-open');
  pair('R3.2: a keyed incumbent digest remains distinct from the independent canonical hash',()=>{const x=specimen('IC04','compatible');assert.notEqual(x.o.correlations[0].observation.storedPayloadDigest,x.o.invocations[0].canonicalPayloadSha256);return x;},x=>x.o.incumbentComparisons[0].storedPayloadDigest=x.o.invocations[0].canonicalPayloadSha256,'incumbent.actual-row-request-and-effect');
  pair('R3.2: a redundant noncanonical query record has no loading identity',()=>{const x=specimen('IC08','query-without-load'),b=x.o.requestBoundaries[0];x.o.invocations=[{origin:'https-client-and-request-observer',label:b.label,callId:b.callId,principal:b.principal,clientKey:null,act:'CONSULTAR_RECEPCION',variant:'get_reception',target:{receptionId:b.receptionId,artifactId:null,generation:null,expectedRevision:null},subject:cloneSubject(x.o.input.subject),wireBodySha256:null,canonicalPayloadSha256:null,canonicalProfile:null,keyVersion:null,responseLabel:b.responseLabel}];return x;},x=>x.o.invocations[0].clientKey='invented-key','request.noncanonical-no-invented-intention');
  pair('M04: uncertain reconciliation is not a known no-row outcome',()=>specimen('IC05','invalid-linkage'),x=>{const c=x.o.correlations[0];c.outcome='uncertain';c.observation={resolution:'unresolved',operationId:null,receptionId:null,storedPayloadDigest:null,lastObservedAtMs:c.atMs,reason:'connection-lost',terminalOutcomeEstablished:false,namespaceFenceEstablished:false};},'correlation.uncertain-is-not-confirmed-acceptance');
}
const cloneSubject=x=>structuredClone(x);
