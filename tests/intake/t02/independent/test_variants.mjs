import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertCase } from './index.mjs';
import { digest } from './observation.mjs';
import { callReferencePath,requestClass } from './request_boundary.mjs';
import { illustrateBoundaries,eventR3 } from './illustrative_revision3.mjs';

// These are offline, explicitly invented observer records and independent
// reference bytes. They do not claim a socket, process or database was run.
export function registerVariantTests(h) {
  const {specimen,json,put,response,lost,event,evidence,terminal,epoch}=h;
  const at=n=>epoch+n,clone=structuredClone;
  const run=x=>assertCase(x.o.caseId,x.o.variant,x.o,x.locations);
  const ref=(x,name,value)=>json(x.locations.fixtureRoot,`references/${name}.json`,value);
  const file=(x,name,bytes,root='evidence')=>{put(x.locations[root==='fixture'?'fixtureRoot':'evidenceRoot'],name,bytes);return {root,file:name,bytes:bytes.length,sha256:digest(bytes)};};
  function rename(x,caseId,variant){x.o.caseId=caseId;x.o.variant=variant;return x;}
  function boundaries(x,methods={}){
    illustrateBoundaries(x.o,x.locations);
    const p=path.join(x.locations.fixtureRoot,callReferencePath(x.o)),r=JSON.parse(readFileSync(p));
    for(const b of x.o.requestBoundaries){
      b.method=methods[b.label]??b.method;b.requestClass=requestClass(b.method,b.route);
      const e=r.calls.find(v=>v.label===b.label);Object.assign(e,{method:b.method,requestClass:b.requestClass});
      e.allowedAccess=x.o.storage.filter(s=>s.callId===b.callId&&['capture','append','seal','open','read','restore_write'].includes(s.kind)).map(s=>({kind:s.kind,artifactId:s.artifactId,generation:s.generation}));
    }
    writeFileSync(p,JSON.stringify(r));
  }
  function packet(x,label,callId,original,bytes,declared=original,receptionId='operation-1'){
    return {origin:'client-stream-and-owned-object-observers',callId,receptionId,artifactId:original.id,generation:original.generation,
      declared:{origin:'independent-reservation-sql',observedAtMs:at(1),original:declared,declarationFile:file(x,`${label}-declaration.json`,Buffer.from(JSON.stringify({original:declared})),'fixture')},
      sent:{origin:'https-client-body',observedAtMs:at(2),body:file(x,`${label}-sent.bin`,bytes),ended:true},
      consumed:{origin:'application-stream-boundary',firstReadAtMs:at(3),lastReadAtMs:at(4),body:file(x,`${label}-consumed.bin`,bytes),bytes:bytes.length,sha256:digest(bytes),completed:true},
      staged:{origin:'owned-physical-object-observer',observedAtMs:at(5),present:true,body:file(x,`${label}-staged.bin`,bytes),artifactId:original.id,generation:original.generation}};
  }
  function late(x,old,bytes,callId='response-interrupted'){
    return ['append','seal'].map((action,i)=>({origin:'private-command-and-object-observers',callId,requestId:`late-${action}`,receptionId:old.receptionId,original:{id:old.artifactId,generation:old.generation,bytes:old.reservedBytes,sha256:digest(readFileSync(path.join(x.locations.fixtureRoot,'bom.txt')))},incarnation:old.incarnation,evidenceId:`late-evidence-${i}`,action,outcome:action==='append'?'failed-write':'failed-seal',replyOk:false,replyOutcome:action==='append'?'failed-write':'failed-seal',offset:action==='append'?10:null,submittedBytes:action==='append'?7:0,startedAtMs:at(35+i),endedAtMs:at(36+i),beforeObject:file(x,`late-${i}-before.bin`,bytes),afterObject:file(x,`late-${i}-after.bin`,bytes)}));
  }
  function corrupt(){
    const x=rename(specimen('IC11','intact'),'IC11','corrupt'),{o}=x,bytes=readFileSync(path.join(x.locations.fixtureRoot,'bom.txt')),changed=Buffer.from(bytes);changed[changed.length-1]^=1;
    o.responses=[{...response('subject',409,{error:'unavailable'},40),route:o.responses[0].route},{...clone(o.responses[0]),label:'positive',atMs:at(10)},response('lookup',200,{receiptId:'receipt-1'},42)];
    const before=file(x,'before-fault.bin',bytes),after=file(x,'after-fault.bin',changed);
    o.objectFault={origin:'owned-object-observer',artifactId:o.input.artifactId,generation:1,beforeFile:before.file,beforeBytes:before.bytes,beforeSha256:before.sha256,changedFile:after.file,changedBytes:after.bytes,changedSha256:after.sha256,persistedBytes:bytes.length,persistedSha256:digest(bytes),injectedAtMs:at(20)};
    o.storage=[eventR3(event('open',29,0)),eventR3(event('read',30,17)),eventR3(event('read',9,17,{evidenceId:'e-positive'}),'operation-1','response-positive')];
    // The independently fixed unavailable tuple below is 409, including the
    // preparation actually selected for this completed error handoff.
    o.evidence=[eventR3(evidence('read_admission','e-read',28)),eventR3(evidence('delivery','e-delivery',31,{status:409})),eventR3(evidence('read_admission','e-positive',8),'operation-1','response-positive')];
    o.transport=[eventR3(terminal(o.responses[0].route,39,o.responses[0].bytes))];
    const r=o.responses[0];ref(x,'IC11/corrupt',{unavailable:{status:409,headers:{'content-type':'application/json','cache-control':'no-store'},body:{error:'unavailable'},bytes:Buffer.byteLength('{"error":"unavailable"}'),sha256:digest(Buffer.from('{"error":"unavailable"}')),bodyFile:null}});
    boundaries(x);return x;
  }
  function framing(kind='http-parser'){
    const x=rename(specimen('IC08','query-denied'),'IC02','framing'),{o}=x;
    const route='/api/intake/receptions/operation-1/attempts/1/original';
    o.responses=[{...response('subject',400,{error:'invalid-framing'},30),route},response('positive',200,{result:'admitted'},6)];
    const header=kind==='http-parser'?'Content-Length: 17\r\nContent-Length: 18':'Content-Length: 17\r\nContent-Encoding: gzip';
    const body=Buffer.alloc(17,120),wire=Buffer.concat([Buffer.from(`POST ${route} HTTP/1.1\r\nHost: trial.invalid\r\n${header}\r\nCookie: [REDACTED]\r\nX-CSRF-Token: [REDACTED]\r\n\r\n`),body]),f=file(x,'framing-template.bin',wire);
    boundaries(x,{subject:'POST'});const b=o.requestBoundaries[0];b.server.boundary=kind;b.admission={result:'denied',source:kind==='http-parser'?'http-parser':'transport-envelope',observedAtMs:at(2),backendPid:null,controlSourceId:null,controlRevision:null};
    o.ingress={origin:'tls-client-and-terminal-observer',callId:b.callId,method:'POST',route,framingCase:kind==='http-parser'?'duplicate-length':'encoded-upload',clientWireKind:'sanitized-template',clientWireFile:f.file,clientWireBytes:f.bytes,clientWireSha256:f.sha256,exactAuthenticatedRequestSha256:null,clientFacts:{contentLengthValues:kind==='http-parser'?['17','18']:['17'],transferEncodingValues:[],contentEncodingValues:kind==='http-parser'?[]:['gzip'],bodyBytesWritten:17,bodySha256:digest(body),cookiePresent:true,csrfPresent:true},serverBoundary:kind,serverFacts:{headersObserved:kind!=='http-parser',contentLengthValues:kind==='http-parser'?[]:['17'],transferEncodingValues:[],contentEncodingValues:kind==='http-parser'?[]:['gzip'],applicationBytesRead:0,parserErrorCode:kind==='http-parser'?'HPE_UNEXPECTED_CONTENT_LENGTH':null},terminalReached:kind!=='http-parser',ended:true,interrupted:false,atMs:at(3)};
    ref(x,'IC02/framing',{framingCase:o.ingress.framingCase,serverBoundary:kind});return x;
  }
  function mismatch(){
    const x=rename(specimen('IC08','query-denied'),'IC02','digest-mismatch'),{o}=x;
    const expected=readFileSync(new URL('../../t01/fixtures/baseline.xlsx',import.meta.url)),wrong=readFileSync(new URL('../../t01/fixtures/cache-discrepant.xlsx',import.meta.url));
    file(x,'baseline.xlsx',expected,'fixture');file(x,'cache-discrepant.xlsx',wrong,'fixture');o.input.fixture='baseline.xlsx';
    for(const s of[o.before,o.after]){
      s.receptions.push({...clone(s.receptions[0]),id:'operation-2'});s.intentions.push({...clone(s.intentions[0]),id:'reserve-operation-2',receptionId:'operation-2',clientKey:'reservation-2'});
      s.attempts[0].actualBytes=expected.length;s.attempts[0].reservedBytes=expected.length;s.attempts[0].actualSha256=digest(expected);
      s.receipts[0].bytes=expected.length;s.receipts[0].sha256=digest(expected);
      s.attempts.push({...clone(s.attempts[0]),receptionId:'operation-2',artifactId:'original-2',state:'pending',actualBytes:0,actualSha256:null});s.counts.receptions=2;
    }
    o.input.artifactId='original-2';o.input.subject={receptionId:'operation-2',callId:'subject-call',queryIntentionId:'reserve-operation-2',finalizationIntentionId:null};
    o.responses=[{...response('subject',409,{error:'digest'},30),route:'/api/intake/receptions/operation-2/attempts/1/original'},response('transfer-positive',200,{received:true},15),{...response('positive',200,null,16),route:'/api/intake/receptions/operation-1/original',body:null,bodyFile:file(x,'matching-original.bin',expected).file,bytes:expected.length,sha256:digest(expected)}];
    o.responses[1].route='/api/intake/receptions/operation-1/attempts/1/original';
    o.byteTransfers=[packet(x,'wrong','subject-call',{id:'original-2',generation:1,bytes:expected.length,sha256:digest(expected)},wrong,undefined,'operation-2'),packet(x,'matching','response-transfer-positive',{id:'original-1',generation:1,bytes:expected.length,sha256:digest(expected)},expected)];
    boundaries(x,{subject:'POST','transfer-positive':'POST'});
    for(const label of['transfer-positive','positive']){const b=o.requestBoundaries.find(x=>x.label===label);b.receptionId='operation-1';}
    const p=path.join(x.locations.fixtureRoot,callReferencePath(o)),r=JSON.parse(readFileSync(p));for(const f of r.calls)if(f.label!=='subject')f.receptionId='operation-1';writeFileSync(p,JSON.stringify(r));return x;
  }
  function resumeCall(x){
    const {o}=x,body={profile:'intake/1',expected_revision:1,original:{id:'original-1',generation:1}},target={receptionId:'operation-1',artifactId:'original-1',generation:1,expectedRevision:1};
    const wire=Buffer.from('{"profile":"intake/1","expected_revision":1,"original":{"id":"original-1","generation":1}}');
    const canonical=Buffer.from('{"body":{"expected_revision":1,"original":{"generation":1,"id":"original-1"},"profile":"intake/1"},"contract":"intake/1","path":{"parameters":{"id":"operation-1"},"template":"/api/intake/receptions/:id/resume"},"profile":"canon_m09_1","query":{},"variant":"resume_reception"}');
    file(x,'resume-wire.json',wire,'fixture');file(x,'resume-canonical.json',canonical,'fixture');
    const fields={label:'resume',principal:'person-1',clientKey:'resume-key',act:'CARGAR_MATERIAL',variant:'resume_reception',target,canonicalProfile:'canon_m09_1',keyVersion:1};
    o.invocations=[{origin:'https-client-and-request-observer',...fields,callId:'resume-call',subject:{receptionId:'operation-1',callId:'resume-call',queryIntentionId:'reserve-operation-1',finalizationIntentionId:null},wireBodySha256:digest(wire),canonicalPayloadSha256:digest(canonical),responseLabel:'resume'}];
    o.comparisons=[{origin:'canonical-comparison-boundary',label:'resume',callId:'resume-call',principal:'person-1',act:fields.act,variant:fields.variant,clientKey:fields.clientKey,canonicalProfile:fields.canonicalProfile,keyVersion:1,comparedCanonicalSha256:digest(canonical),phase:'namespace-lookup',row:'absent',operationId:null,storedPayloadDigest:null,outcome:'new',atMs:at(12)}];
    const row={id:'resume-intention',receptionId:'operation-1',deployment:'deployment-1',principal:'person-1',act:fields.act,variant:fields.variant,clientKey:fields.clientKey,canonicalProfile:fields.canonicalProfile,keyVersion:1,storedPayloadDigest:digest(canonical),effectId:null,createdAtMs:at(14)};o.after.intentions.push(row);
    o.correlations=[{origin:'independent-sql-observer',callId:'resume-call',atMs:at(30),namespace:{deployment:row.deployment,principal:row.principal,act:row.act,variant:row.variant,clientKey:row.clientKey},outcome:'confirmed',observation:{resolution:'same-namespace',operationId:row.id,receptionId:row.receptionId,storedPayloadDigest:row.storedPayloadDigest,effectId:null,receiptId:null,jobId:null,observerBackendPid:42,transactionSnapshot:'resume-snapshot',matchedIntentionIds:[row.id]}}];
    ref(x,'IC06/resumed.intentions',{executorRef:'executor-1',deployment:'deployment-1',invocations:[{...fields,wireFile:'resume-wire.json',canonicalFile:'resume-canonical.json'}]});
  }
  function resumed(){
    const x=rename(specimen('IC01','round-trip'),'IC06','resumed'),{o}=x,bytes=readFileSync(path.join(x.locations.fixtureRoot,'bom.txt')),old=o.before.attempts[0];
    old.actualBytes=10;old.actualSha256=digest(bytes.subarray(0,10));
    o.after.attempts.unshift(clone(old));const current=o.after.attempts[1];current.artifactId='original-2';current.generation=2;current.incarnation='incarnation-2';
    o.after.receptions[0].generation=2;o.input.artifactId='original-2';o.input.generation=2;
    o.after.receipts[0].artifactId='original-2';o.after.receipts[0].generation=2;o.after.jobs[0].originalId='original-2';o.after.jobs[0].generation=2;
    o.responses=[{...o.responses[0],atMs:at(49)},{...lost('interrupted'),atMs:at(9),route:'/api/intake/receptions/operation-1/attempts/1/original'},{...response('resume',200,{resumed:true},32),route:'/api/intake/receptions/operation-1/resume'},{...response('completed',200,{received:true},40),route:'/api/intake/receptions/operation-1/attempts/2/original'}];
    o.storage=[eventR3(event('read',45,17,{artifactId:'original-2',generation:2,incarnation:'incarnation-2'}))];o.evidence=[eventR3(evidence('read_admission','e-read',44,{artifactId:'original-2',generation:2}))];o.transport=[];
    const declaration={receptionId:'operation-1',principal:'person-1',personId:'person-1',originSessionId:'session-1',name:'bom.txt',bytes:17,sha256:digest(bytes),declaredMediaType:'text/plain',formatProfile:'text-utf8/1',scopeId:'scope-1',purposeId:'purpose-1',treatmentRevision:{id:'treatment-1',revision:1,sha256:'c'.repeat(64)}};
    const limits={maximumStorageBytes:1024,maximumAttempts:3,maximumReceptions:5,reference:{id:'limits-1',revision:1,sha256:'d'.repeat(64)}};
    const quota=count=>({origin:'independent-sql-observer',logicalDeclaredBytes:17,subjectReservedBytes:17*count,subjectAttemptCount:count,globalReservedBytes:17*count,globalReceptionCount:1,maximumStorageBytes:limits.maximumStorageBytes,maximumAttempts:limits.maximumAttempts,maximumReceptions:limits.maximumReceptions,limitsReference:limits.reference});
    o.continuation={origin:'sql-and-private-command-observers',receptionId:'operation-1',interruptedCallId:'response-interrupted',resumeCallId:'resume-call',completedCallId:'response-completed',before:{observedAtMs:at(10),declaration:clone(declaration),quota:quota(1)},after:{observedAtMs:at(48),declaration:clone(declaration),quota:quota(2)},lateCommands:late(x,old,bytes.subarray(0,10))};
    o.byteTransfers=[packet(x,'complete','response-completed',{id:'original-2',generation:2,bytes:17,sha256:digest(bytes)},bytes)];
    Object.assign(o.byteTransfers[0].declared,{observedAtMs:at(32)});o.byteTransfers[0].sent.observedAtMs=at(33);o.byteTransfers[0].consumed.firstReadAtMs=at(34);o.byteTransfers[0].consumed.lastReadAtMs=at(35);o.byteTransfers[0].staged.observedAtMs=at(36);
    ref(x,'IC06/resumed',{declaration,limits});resumeCall(x);boundaries(x,{interrupted:'POST',completed:'POST'});
    // The subject is the final original GET, not the separate resume call.
    o.requestBoundaries.find(b=>b.label==='subject').callId='subject-call';o.requestBoundaries.find(b=>b.label==='resume').client.observedAtMs=at(11);return x;
  }
  function restart(){
    const x=rename(specimen('IC11','intact'),'IC12','restart'),{o}=x,bytes=readFileSync(path.join(x.locations.fixtureRoot,'bom.txt'));
    for(const s of[o.before,o.after]){s.receptions.push({...clone(s.receptions[0]),id:'partial-2',state:'pending',stopped:s===o.after});s.intentions.push({...clone(s.intentions[0]),id:'reserve-partial-2',receptionId:'partial-2',clientKey:'partial-key'});s.attempts.push({...clone(s.attempts[0]),receptionId:'partial-2',artifactId:'partial-original',state:'pending',actualBytes:10,actualSha256:digest(bytes.subarray(0,10))});s.counts.receptions=2;}
    const identity=pid=>({kind:'os-process',containerId:null,pid,startTicks:String(pid*100),bootId:'boot-one',pidNamespace:'namespace-one'});
    o.processes=[{origin:'owned-process-controller',role:'intake-terminal',processRef:identity(100),incarnation:'incarnation-1',startedAtMs:at(0),endedAtMs:at(5),exitCode:0,sourceSha256:'e'.repeat(64)},{origin:'owned-process-controller',role:'intake-terminal',processRef:identity(101),incarnation:'incarnation-2',startedAtMs:at(6),endedAtMs:null,exitCode:null,sourceSha256:'e'.repeat(64)}];
    o.startup={origin:'startup-and-sql-observer',processRef:identity(101),incarnation:'incarnation-2',currentSourceId:'live-control',currentGeneration:2,atMs:at(7),admitted:true,namespace:o.after.schema};
    o.responses=[{...o.responses[0],atMs:at(40)},{...response('incomplete',200,{receptionId:'partial-2',status:'pending'},41),route:'/api/intake/receptions/partial-2'},response('unavailable',503,{error:'unavailable'},42)];
    o.storage=[eventR3(event('read',39,17,{incarnation:'incarnation-2'})),eventR3(event('failed_write',35,0,{artifactId:'partial-original',incarnation:'incarnation-1'}),'partial-2','response-incomplete')];o.evidence=[eventR3(evidence('read_admission','e-read',38))];o.transport=[];
    o.storage[1].operationId=null;o.storage[1].evidenceId=null;
    const beforeFile=file(x,'partial-before-restart.bin',bytes.subarray(0,10)),afterFile=file(x,'partial-after-restart.bin',bytes.subarray(0,10));
    o.control=[{origin:'current-control',label:'source-unavailable',sourceId:'live-control',sourceSchema:'intake_control',revision:2,atMs:at(41),available:false,gate:'current-source',action:'unavailable',objectId:'original-1'}];
    ref(x,'IC12/restart',{currentSourceId:'live-control',currentGeneration:2,incompleteReceptionId:'partial-2',incompleteResponse:{status:200,body:{receptionId:'partial-2',status:'pending'}},partialObjects:{beforeFile:beforeFile.file,afterFile:afterFile.file}});
    boundaries(x);
    for(const b of o.requestBoundaries){b.server.observedAtMs=at(8);b.client.observedAtMs=at(8);b.admission.observedAtMs=at(9);}
    o.requestBoundaries.find(b=>b.label==='incomplete').receptionId='partial-2';
    const callsPath=path.join(x.locations.fixtureRoot,callReferencePath(o)),calls=JSON.parse(readFileSync(callsPath));calls.calls.find(b=>b.label==='incomplete').receptionId='partial-2';writeFileSync(callsPath,JSON.stringify(calls));
    o.requestBoundaries.find(b=>b.label==='unavailable').admission.result='denied';return x;
  }
  function pair(name,make,change,rule){test(name,()=>{const x=make(),positive=run(x);json(x.locations.evidenceRoot,'variant-positive.json',{observation:x.o,result:positive});const bad={o:clone(x.o),locations:x.locations};change(bad);let caught;assert.throws(()=>run(bad),e=>{caught=e;return e instanceof assert.AssertionError&&e.message.includes(rule);});json(x.locations.evidenceRoot,'variant-negative.json',{observation:bad.o,expectedRule:rule,observedRule:caught.message});});}
  pair('IC11/corrupt: altered body reached, safe error delivered, original stays fixed',corrupt,x=>{x.o.responses[0].body={raw:'altered bytes'};},'corruption.no-altered-original-delivery');
  pair('IC11/corrupt: a rewritten persisted digest cannot redefine the original',corrupt,x=>x.o.objectFault.persistedSha256=x.o.objectFault.changedSha256,'corruption.trusted-association-not-rewritten');
  pair('IC11/corrupt: early refusal is not a tested corrupt-object read',corrupt,x=>x.o.storage=[],'corruption.actual-authorized-body-read');
  pair('IC02/framing: parser rejection is not application enforcement',()=>framing(),x=>x.o.ingress.terminalReached=true,'framing.truthful-reached-component');
  pair('IC02/framing: application envelope refuses content encoding before reads',()=>framing('application-envelope'),x=>x.o.ingress.serverFacts.applicationBytesRead=17,'framing.refusal-consumption-and-effects');
  pair('IC02/framing: duplicate lengths cannot be collapsed',()=>framing(),x=>x.o.ingress.clientFacts.contentLengthValues=['17'],'framing.duplicate-occurrences-preserved');
  pair('IC02/framing: sanitized bytes are not an authenticated request hash',()=>framing(),x=>x.o.ingress.exactAuthenticatedRequestSha256=x.o.ingress.clientWireSha256,'framing.no-template-as-authenticated-request');
  pair('IC02/digest-mismatch: fixed FX/FXD difference reaches actual consumption',mismatch,x=>{x.o.responses[0].status=200;},'digest.mismatch-outcome-and-no-effect');
  pair('IC02/digest-mismatch: sent evidence is not consumed evidence',mismatch,x=>{x.o.byteTransfers[0].consumed.body=x.o.byteTransfers[0].sent.body;},'transfer.sent-is-not-consumption-capture');
  pair('IC02/digest-mismatch: sent evidence is not staged evidence',mismatch,x=>{x.o.byteTransfers[0].staged.body=x.o.byteTransfers[0].sent.body;},'transfer.staged-is-separate-observation');
  pair('IC02/digest-mismatch: a permission refusal cannot pass as digest rejection',mismatch,x=>x.o.requestBoundaries[0].admission.result='denied','variant.admitted-actual-consumer');
  pair('IC06/resumed: retains interrupted bytes, retransmits completely, old append/seal fail',resumed,x=>x.o.continuation.lateCommands=[],'continuation.real-late-commands-required');
  pair('IC06/resumed: retained physical quota cannot count only one logical original',resumed,x=>x.o.continuation.after.quota.subjectReservedBytes=17,'continuation.actual-physical-quota-not-logical');
  pair('IC06/resumed: predecessor cannot disappear after continuation',resumed,x=>{x.o.after.attempts.shift();},'continuation.predecessor-retained');
  pair('IC06/resumed: failed append cannot substitute failed seal',resumed,x=>{x.o.continuation.lateCommands[1].outcome='failed-write';x.o.continuation.lateCommands[1].replyOutcome='failed-write';},'late-command.exact-private-failure');
  pair('IC06/resumed: full retransmission cannot be an old suffix',resumed,x=>x.o.byteTransfers[0].consumed.completed=false,'continuation.complete-not-suffix-retransmission');
  pair('IC12/restart: process identity changes over preserved complete and partial rows',restart,x=>{x.o.processes[1].processRef=clone(x.o.processes[0].processRef);x.o.startup.processRef=clone(x.o.processes[0].processRef);},'restart.distinct-os-process-not-label');
  pair('IC12/restart: live predecessor is not process replacement',restart,x=>x.o.processes[0].endedAtMs=null,'restart.actual-exit-before-replacement');
  pair('IC12/restart: reordering identity fields cannot manufacture a new process',restart,x=>{x.o.processes[1].processRef=Object.fromEntries(Object.entries(x.o.processes[0].processRef).reverse());x.o.startup.processRef=clone(x.o.processes[1].processRef);},'restart.distinct-os-process-not-label');
  pair('IC12/restart: changing the identity representation is not an observed restart',restart,x=>{x.o.processes[1].processRef={kind:'container-process-set',containerId:'a'.repeat(64),imageId:'synthetic-image',initHostPid:101,startedAt:'synthetic-time'};},'restart.comparable-process-identities');
  pair('IC02/digest-mismatch: valid wrong consumed bytes cannot replace the declaration',mismatch,x=>{x.o.byteTransfers[0].declared.original.sha256=x.o.byteTransfers[0].consumed.sha256;},'transfer.fixed-declaration');
  pair('IC02/digest-mismatch: declared byte length cannot stand in for actual reads',mismatch,x=>{const t=x.o.byteTransfers[0];t.consumed.bytes=0;t.consumed.sha256=digest(Buffer.alloc(0));t.consumed.body=null;t.consumed.firstReadAtMs=null;t.consumed.lastReadAtMs=null;},'digest.negative-actual-consumption');
  pair('IC06/resumed: changed treatment cannot silently inherit the old declaration',resumed,x=>x.o.continuation.after.declaration.treatmentRevision.revision++,'continuation.independent-unchanged-declaration');
  pair('IC06/resumed: replaying an earlier transfer is not retransmission after resume',resumed,x=>x.o.byteTransfers[0].sent.observedAtMs=1800000000002,'transfer.observed-order');
  pair('IC12/restart: stale admission cannot be borrowed from before process death',restart,x=>x.o.requestBoundaries.find(b=>b.label==='subject').admission.observedAtMs=1800000000002,'restart.query-from-replacement-window');
  pair('IC12/restart: a query response cannot replace actual current-source failure',restart,x=>x.o.control=[],'restart.observed-current-source-failure');
  pair('IC12/restart: omitted old-handle probe is not a successful fence test',restart,x=>x.o.storage=x.o.storage.filter(e=>e.kind!=='failed_write'),'restart.late-owner-reached-storage');
  pair('IC06/resumed: a later successful seal defeats the old-handle negative',resumed,x=>{Object.assign(x.o.continuation.lateCommands[1],{replyOk:true,outcome:'completed',replyOutcome:'completed'});},'late-command.exact-private-failure');
  pair('IC12/restart: unresolved owner cannot become reconciled by renaming a process',restart,x=>x.o.after.receptions[1].stopped=false,'restart.owner-generation-reconciled');
  pair('IC12/restart: unavailable current source cannot admit the replacement query',restart,x=>x.o.responses.find(r=>r.label==='unavailable').status=200,'restart.current-source-unavailable-fails-closed');
}
