import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertCase } from './index.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p));
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2),{flag:'wx'});
function tree(from,to,ids=[]) {
  assert.equal(lstatSync(from).isSymbolicLink(),false);mkdirSync(to,{recursive:true});
  for(const name of readdirSync(from)){
    const a=path.join(from,name),b=path.join(to,name),s=lstatSync(a);assert.equal(s.isSymbolicLink(),false);
    if(s.isDirectory())tree(a,b,ids);
    else {assert.ok(s.isFile());const bytes=readFileSync(a);writeFileSync(b,bytes,{flag:'wx'});ids.push({source:a,copy:b,bytes:bytes.length,sha256:hash(bytes)});}
  }
  return ids;
}
function call(api,o,x){
  const before=JSON.stringify(o);let result;
  try{result={accepted:true,result:api.assertCase(o.caseId,o.variant,o,x.locations)};}
  catch(e){assert.ok(e instanceof assert.AssertionError,e.stack);result={accepted:false,error:e.message,actual:e.actual,expected:e.expected};}
  assert.equal(JSON.stringify(o),before);return result;
}
function fail(r,rule){assert.equal(r.accepted,false,JSON.stringify(r));assert.ok(r.error.includes(rule),r.error);}
const api={assertCase};
export function registerPhaseLineageTests(root) {
  const audit=process.env.T02_SEAMS_ROOT,r4=process.env.T02_R4_SOURCES;
  let serial=0,old;
  async function baseline(){
    if(!old){
      assert.ok(audit&&r4);
      const raw=readFileSync(path.join(r4,'..','run.json'));assert.equal(hash(raw),'8b09976d67a79a22899f889b35f7fa3aafb13f3d56cd89f440d2761dac15cb36');
      const manifest=JSON.parse(raw);assert.equal(manifest.sources.length,21);
      for(const s of manifest.sources){const b=readFileSync(path.join(r4,s.name));assert.equal(b.length,s.bytes);assert.equal(hash(b),s.sha256);}
      old=import(pathToFileURL(path.join(r4,'index.mjs')).href);
    }
    return old;
  }
  function capture(which){
    assert.ok(audit);const from=path.join(audit,which),out=path.join(root,'phase-lineage',String(++serial)+'-'+which);mkdirSync(out,{recursive:true});
    const locations={fixtureRoot:path.join(out,'fixed'),evidenceRoot:path.join(out,'observed')};
    const identities=tree(path.join(from,'case','fixed'),locations.fixtureRoot);
    tree(path.join(from,'case','observed'),locations.evidenceRoot,identities);
    const observer=readFileSync(path.join(from,'run','observer-raw.json'));
    writeFileSync(path.join(locations.evidenceRoot,'runtime-raw.json'),observer,{flag:'wx'});
    identities.push({source:path.join(from,'run','observer-raw.json'),copy:path.join(locations.evidenceRoot,'runtime-raw.json'),bytes:observer.length,sha256:hash(observer)});
    const raw=readFileSync(path.join(locations.evidenceRoot,'packet.json'));
    assert.equal(hash(raw),which==='C1'?'a81d614758794c38e0dc1183aa20578f72dbda07dec5735026ee4d26cfde7885':'386bda80a86ef6ff824e0c3d77ca21a1f03c73af7cfa4252e0033d7aab87297c');
    save(path.join(out,'input-identities.json'),identities);
    return {o:JSON.parse(raw),out,locations,identities,proofSerial:0};
  }
  function pointer(x,file,pointer){const bytes=readFileSync(path.join(x.locations.evidenceRoot,file));return {file,bytes:bytes.length,sha256:hash(bytes),pointer};}
  function proof(x,value){const file='new-proof-'+(++x.proofSerial)+'.json';save(path.join(x.locations.evidenceRoot,file),value);return pointer(x,file,'');}
  function get(x,p){let v=read(path.join(x.locations.evidenceRoot,p.file));if(p.pointer)for(const k of p.pointer.slice(1).split('/'))v=v[k.replaceAll('~1','/').replaceAll('~0','~')];return v;}
  function editProof(x,holder,key,fn){const value=structuredClone(get(x,holder[key]));fn(value);holder[key]=proof(x,value);}
  function metadata(x){
    const raw=read(path.join(x.locations.evidenceRoot,'raw.json')),runtime=read(path.join(x.locations.evidenceRoot,'runtime-raw.json'));
    x.o.interfaceAddendum='3.3';x.o.phaseLineage={metadata:[],priorUploads:[]};
    const change=[];
    for(const e of x.o.evidence.filter(e=>[e.operationId,e.receptionId,e.artifactId,e.generation].every(v=>v===null))){
      const row=raw.retained.findIndex(v=>v.row.id===e.id);assert.ok(row>=0);
      const insert=runtime.evidenceInserts.findIndex(v=>v.id===e.id);
      const admission=runtime.admissions.findIndex(v=>v.kind==='metadata-admitted'&&v.callId===e.callId&&v.backendPid===e.backendPid);
      const consumption=runtime.requestEvents.findIndex(v=>v.kind==='application-read'&&v.callId===e.callId);
      const selection=runtime.selections.findIndex(v=>v.callId===e.callId);
      assert.ok([insert,admission,consumption,selection].every(v=>v>=0));
      x.o.phaseLineage.metadata.push({evidenceId:e.id,callId:e.callId,sql:pointer(x,'raw.json',`/retained/${row}/row`),insert:pointer(x,'runtime-raw.json',`/evidenceInserts/${insert}`),admission:pointer(x,'runtime-raw.json',`/admissions/${admission}`),consumption:pointer(x,'runtime-raw.json',`/requestEvents/${consumption}`),selection:pointer(x,'runtime-raw.json',`/selections/${selection}`),transaction:null});
      change.push({evidenceId:e.id,path:'transactionOpen',before:e.transactionOpen,after:null,reason:'The retained pause samples a different backend; no own-backend idle claim.'});e.transactionOpen=null;
    }
    const calls=read(path.join(x.locations.fixtureRoot,`references/${x.o.caseId}/${x.o.variant}.calls.json`));
    x.phaseRef={runId:x.o.runId,sourceManifestSha256:x.o.source.manifestSha256,metadataLabels:calls.calls.filter(b=>b.requestClass==='canonical-act').map(b=>b.label),priorUploads:[]};
    save(path.join(x.out,'metadata-mapping.json'),{kind:'mapped-retained-actual-facts-not-a-new-runtime',change,proofs:x.o.phaseLineage.metadata});
    return x;
  }
  function fix(x){save(path.join(x.locations.fixtureRoot,`references/${x.o.caseId}/${x.o.variant}.phases.json`),x.phaseRef);return x;}
  function intact(x){for(const s of x.identities)assert.equal(hash(readFileSync(s.copy)),s.sha256,'Retained input was changed.');}
  function pair(name,build,mutate,rule){
    test('R5 '+name,()=>{
      const x=build(),positive=call(api,x.o,x);save(path.join(x.out,'fixed-positive.json'),x.o);
      const prior=structuredClone(x.o);mutate(x);const negative=call(api,x.o,x);
      save(path.join(x.out,'changed-packet.json'),x.o);save(path.join(x.out,'result.json'),{name,kind:x.synthetic?'synthetic-prior-window-not-real-producer':'actual-C1-mapping-and-directed-negative',rule,positive,negative});
      assert.equal(positive.accepted,true,JSON.stringify(positive));fail(negative,rule);intact(x);assert.notDeepEqual(x.o,prior);
    });
  }
  for(const [which,rule]of [['C1','request.other-call-reception'],['C2','receipt.exact-seal-observed']])test('R5 preserves unchanged actual '+which+' rejection',async()=>{
    const x=capture(which),a=await baseline(),result={old:call(a,x.o,x),current:call(api,x.o,x)};
    save(path.join(x.out,'original-replay.json'),result);fail(result.old,rule);fail(result.current,rule);intact(x);
  });
  test('R5 actual C1 mapping admits both honest pre-selection metadata rows',()=>{
    const x=fix(metadata(capture('C1'))),result=call(api,x.o,x);save(path.join(x.out,'mapped-packet.json'),x.o);save(path.join(x.out,'result.json'),result);
    assert.equal(result.accepted,true,JSON.stringify(result));assert.equal(x.o.phaseLineage.metadata.length,2);
    assert.deepEqual([x.o.after.receipts.length,x.o.after.jobs.length],[1,1]);intact(x);
  });
  const c1=()=>fix(metadata(capture('C1')));
  for(const [name,mutate,rule]of [
    ['unknown metadata call',x=>{x.o.phaseLineage.metadata[0].callId='unknown';},'metadata.actual-call'],
    ['metadata foreign principal',x=>{x.o.evidence[0].principal='other-account';},'metadata.unselected-identity'],
    ['metadata nonnull identity',x=>{x.o.evidence[0].artifactId=x.o.input.artifactId;},'metadata.unselected-identity'],
    ['missing metadata proof',x=>{x.o.phaseLineage.metadata.pop();},'metadata.complete-fixed-set'],
    ['wrong metadata SQL scope',x=>editProof(x,x.o.phaseLineage.metadata[0],'sql',v=>{v.binding.scope='read';}),'metadata.actual-scope'],
    ['metadata relabelled query',x=>{x.o.evidence[0].phase='query';},'metadata.unselected-identity'],
    ['metadata raw row relabelled',x=>editProof(x,x.o.phaseLineage.metadata[0],'sql',v=>{v.phase='read_admission';}),'metadata.sql-evidence'],
    ['metadata after selection',x=>editProof(x,x.o.phaseLineage.metadata[0],'selection',v=>{v.atMs=x.o.evidence[0].atMs-1;}),'metadata.observed-phase-order'],
    ['metadata foreign insert',x=>editProof(x,x.o.phaseLineage.metadata[0],'insert',v=>{v.callId='foreign';}),'metadata.insert'],
    ['metadata guessed idle from later backend',x=>{const m=x.o.phaseLineage.metadata[0],e=x.o.evidence[0];e.transactionOpen=false;m.transaction=proof(x,{origin:'independent-backend-observer',backendPid:e.backendPid+1,atMs:e.atMs,transactionOpen:false});},'metadata.own-connection-sample'],
    ['metadata claims idle without sample',x=>{x.o.evidence[0].transactionOpen=false;},'metadata.unsampled-connection-is-unknown'],
    ['metadata cannot admit original read',x=>{x.o.storage[0].evidenceId=x.o.evidence[0].id;},'metadata.never-protected-admission'],
    ['metadata cannot admit handoff',x=>{x.o.transport[0].evidenceId=x.o.evidence[0].id;},'metadata.never-protected-admission'],
    ['selected evidence remains bound',x=>{x.o.evidence.find(e=>e.phase==='read_admission').receptionId=null;},'phase.selected-reception-and-principal'],
    ['subject sibling original not hidden',x=>{x.o.storage[0].artifactId='sibling';},'phase.independent-protected-scope'],
    ['subject generation not hidden',x=>{x.o.storage[0].generation=2;},'phase.independent-protected-scope'],
    ['metadata proof raw digest',x=>{x.o.phaseLineage.metadata[0].sql.sha256='0'.repeat(64);},'metadata.sql.file-identity'],
    ['metadata proof pointer cannot invent member',x=>{x.o.phaseLineage.metadata[0].sql.pointer='/missing';},'metadata.sql.pointer-member'],
    ['metadata actual bytes cannot be guessed',x=>editProof(x,x.o.phaseLineage.metadata[0],'consumption',v=>{v.data.data[0]=0;}),'metadata.body-observation-integrity'],
    ['metadata revision comes from its own SQL row',x=>editProof(x,x.o.phaseLineage.metadata[0],'admission',v=>{v.controlRevision++;}),'metadata.own-admission-revision'],
    ['selected read evidence cannot precede selection',x=>{x.o.evidence.find(e=>e.phase==='read_admission').atMs=x.o.evidence[0].atMs;},'phase.selected-evidence-after-selection'],
    ['selected storage cannot precede selection',x=>{x.o.storage[0].atMs=x.o.evidence[0].atMs;},'phase.protected-event-after-selection'],
    ['raw metadata proof cannot use prototype path',x=>{x.o.phaseLineage.metadata[0].sql.pointer='/__proto__';},'metadata.sql.pointer-member'],
    ['canonical namespace still checked',x=>{x.o.invocations[1].clientKey='different';},'invocations.independent-request-identity'],
    ['canonical payload still checked',x=>{x.o.comparisons[1].comparedCanonicalSha256='0'.repeat(64);},'invocations.actual-canonical-comparison'],
    ['correlation still independently bound',x=>{x.o.correlations[1].observation.operationId='invented';},'correlation.actual-durable-linkage'],
    ['duplicate effect still rejected',x=>{x.o.after.receipts.push({...x.o.after.receipts[0],id:'duplicate'});},'after.receipts.unique-effectId'],
  ])pair(name,c1,mutate,rule);
  test('R5 metadata own connection sample is distinct from the later command backend',()=>{
    const x=c1(),m=x.o.phaseLineage.metadata[0],e=x.o.evidence[0];
    e.transactionOpen=false;m.transaction=proof(x,{origin:'independent-backend-observer',backendPid:e.backendPid,atMs:e.atMs,transactionOpen:false});
    const good=call(api,x.o,x);save(path.join(x.out,'synthetic-own-backend-positive.json'),x.o);
    editProof(x,m,'transaction',v=>{v.backendPid++;});const bad=call(api,x.o,x);
    save(path.join(x.out,'own-backend-pair.json'),{kind:'synthetic-sample-control-not-actual-C1-sample',positive:good,negative:bad});assert.equal(good.accepted,true,JSON.stringify(good));fail(bad,'metadata.own-connection-sample');intact(x);
  });

  function priorFixture(){
    const x=metadata(capture('C2'));x.synthetic=true;
    const o=x.o,f=o.requestBoundaries[0],base=o.before.atMs-600,t=d=>base+d;
    const original={id:o.input.artifactId,generation:o.input.generation,bytes:17,sha256:'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260b'+'c86ea26b42f9'};
    const bytes=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');assert.equal(hash(bytes),original.sha256);
    const executor=o.after.receipts[0].executorRef,incarnation=o.before.attempts[0].incarnation;
    const upload={origin:'https-client-and-server-boundary',callId:'synthetic-prior-upload-R5',label:'prior-upload',requestClass:'binary-transfer',method:'POST',route:`/api/intake/receptions/${f.receptionId}/attempts/1/original`,client:{...f.client,port:55001,observedAtMs:t(0)},server:{...f.server,peerPort:55001,observedAtMs:t(1)},correlationMode:'connection-and-request',principal:f.principal,receptionId:f.receptionId,admission:{...f.admission,backendPid:701,observedAtMs:t(3)},responseLabel:'prior-upload'};
    const evidence={origin:'sql-observer',id:'synthetic-seal-evidence',phase:'read_admission',operationId:null,receptionId:f.receptionId,artifactId:original.id,generation:1,principal:f.principal,status:200,atMs:t(12),backendPid:701,transactionOpen:false,callId:upload.callId};
    const seal={origin:'object-boundary',kind:'seal',artifactId:original.id,generation:1,bytes:17,offset:0,evidenceId:evidence.id,atMs:t(20),incarnation,callId:upload.callId,receptionId:f.receptionId,operationId:null};
    const response={origin:'https-client',label:upload.responseLabel,route:upload.route,status:200,headers:{'content-type':'application/json','cache-control':'no-store'},body:{received:true},bodyFile:null,bytes:17,sha256:hash(Buffer.from('{"received":true}')),atMs:t(32)};
    response.bytes=Buffer.byteLength(JSON.stringify(response.body));
    const delivery={...evidence,id:'synthetic-upload-delivery',phase:'delivery',atMs:t(29)};
    const boundary={origin:'terminal-boundary',route:upload.route,operationId:null,evidenceId:delivery.id,kind:'handoff',bytes:response.bytes,atMs:t(30),callId:upload.callId,receptionId:f.receptionId};
    const captureEvidence={...evidence,id:'synthetic-capture-evidence',phase:'capture_admission',atMs:t(4)};
    o.storage.push({...seal,kind:'capture',bytes:0,evidenceId:captureEvidence.id,atMs:t(5)}, {...seal,kind:'append',evidenceId:captureEvidence.id,atMs:t(10)});
    const sealIndex=o.storage.length;o.storage.push(seal);o.evidence.push(captureEvidence,evidence,delivery);o.transport.push(boundary);o.responses.push(response);o.requestBoundaries.push(upload);
    const q={id:'synthetic-verification-phase',source_id:upload.admission.controlSourceId,incarnation,namespace:o.before.schema,reception_id:f.receptionId,artifact_id:original.id,generation:1,evidence_id:evidence.id,principal:f.principal,participant_plan:{objects:['create','read_stage','seal'],verifier:['verify']},connection_role:'inc03_intake_runtime',backend_pid:701,deadline_ms:t(100),started_at:t(14)};
    const sql={id:evidence.id,phase:evidence.phase,operation_id:null,reception_id:f.receptionId,artifact_id:original.id,generation:1,principal:f.principal,status:200,recorded_at:String(evidence.atMs),backend_pid:701,route:'upload_original',control_revision:upload.admission.controlRevision,binding:{phase:{executor:{id:executor}},load:{original}}};
    function captureFile(name,b,rootName='evidence'){const dir=x.locations[rootName==='evidence'?'evidenceRoot':'fixtureRoot'];writeFileSync(path.join(dir,name),b,{flag:'wx'});return {root:rootName,file:name,bytes:b.length,sha256:hash(b)};}
    const declaration=captureFile('prior-declaration.json',Buffer.from(JSON.stringify({original})),'fixture');
    const sent=captureFile('synthetic-prior-sent.bin',bytes),consumed=captureFile('synthetic-prior-consumed.bin',bytes),staged=captureFile('synthetic-prior-staged.bin',bytes);
    const transfer={origin:'client-stream-and-owned-object-observers',callId:upload.callId,receptionId:f.receptionId,artifactId:original.id,generation:1,declared:{origin:'independent-reservation-sql',observedAtMs:t(-1),original,declarationFile:declaration},sent:{origin:'https-client-body',observedAtMs:t(0),body:sent,ended:true},consumed:{origin:'application-stream-boundary',firstReadAtMs:t(8),lastReadAtMs:t(9),body:consumed,bytes:17,sha256:hash(bytes),completed:true},staged:{origin:'owned-physical-object-observer',observedAtMs:t(27),present:true,body:staged,artifactId:original.id,generation:1}};
    const p={uploadCallId:upload.callId,finalizeCallId:f.callId,startedAtMs:t(-1),completedAtMs:t(35),transfer,sealIndex,
      sqlEvidence:proof(x,sql),
      evidenceInsert:proof(x,{origin:'evidence-insert-boundary',id:evidence.id,callId:upload.callId,backendPid:701,atMs:t(13)}),
      phase:proof(x,{origin:'independent-sql-observer',runId:o.runId,observedAtMs:t(15),observerBackendPid:702,row:q}),
      dispatch:proof(x,{origin:'private-phase-dispatch-boundary',runId:o.runId,callId:upload.callId,phaseId:q.id,evidenceId:evidence.id,requestId:'synthetic-private-request',action:'seal',original,incarnation,atMs:t(18)}),
      completion:proof(x,{origin:'independent-sql-observer',runId:o.runId,observedAtMs:t(24),observerBackendPid:702,row:{phase_id:q.id,kind:'participants_closed',completed_at:String(t(22)),connection_role:q.connection_role,backend_pid:701,observation:Object.fromEntries(['objects','verifier'].map(k=>[k,{profile:'intake-phase-closed/1',id:q.id,participant:k}]))}}),
      artifact:proof(x,{origin:'independent-prior-artifact-observer',runId:o.runId,observedAtMs:t(28),seal:Object.fromEntries(Object.entries({...seal,requestId:'synthetic-private-request',workerPid:703}).filter(([k])=>!['callId','receptionId','operationId'].includes(k))),row:{id:original.id,reception_id:f.receptionId,generation:1,bytes:17,sha256:hash(bytes),created_at:String(t(26)),verification:{ok:true,bytes:17,sha256:hash(bytes)}}}),
      request:proof(x,{kind:'server-request',callId:upload.callId,method:upload.method,route:upload.route,atMs:upload.server.observedAtMs,socket:{address:upload.server.address,port:upload.server.port,peerAddress:upload.server.peerAddress,peerPort:upload.server.peerPort,requestOrdinal:upload.server.requestOrdinal}}),
      client:proof(x,{label:upload.label,method:upload.method,route:upload.route,socket:upload.client}),
      terminal:proof(x,{kind:'terminal-end',callId:upload.callId,atMs:t(31),status:200,bytes:response.bytes,sha256:response.sha256,destroyed:false,writableEnded:true})};
    o.phaseLineage.priorUploads=[p];
    x.phaseRef.priorUploads=[{uploadLabel:upload.label,finalizeLabel:f.label,principal:f.principal,executorRef:executor,original,incarnation,namespace:o.before.schema,controlSourceId:upload.admission.controlSourceId,controlRevision:upload.admission.controlRevision,connectionRole:q.connection_role,plan:q.participant_plan}];
    // This is an explicitly synthetic full observation, not a new acceptance
    // claim for C2's incomplete actual upload history. Preserve the old fixed
    // inventory and create this illustration's own independently chosen scope.
    const callsFile=path.join(x.locations.fixtureRoot,'references/IC05/receipt.calls.json'),calls=read(callsFile);
    calls.calls.push({label:upload.label,method:upload.method,route:upload.route,requestClass:'binary-transfer',principal:f.principal,receptionId:f.receptionId,allowedAccess:['capture','append','seal'].map(kind=>({kind,artifactId:original.id,generation:1}))});
    const priorCalls=readFileSync(callsFile);writeFileSync(path.join(x.out,'original-calls.json'),priorCalls,{flag:'wx'});
    writeFileSync(callsFile,JSON.stringify(calls,null,2));
    x.identities=x.identities.filter(s=>s.copy!==callsFile);
    save(path.join(x.out,'synthetic-window-not-real-runtime.json'),{reason:'Complete independent illustration; the original captured C2 lacks these witnesses and remains rejected.',uploadCallId:upload.callId,original,fixedCallsHash:hash(Buffer.from(JSON.stringify(calls,null,2)))});
    return fix(x);
  }
  test('R5 complete synthetic prior upload proves a precondition, not a second seal',()=>{
    const x=priorFixture(),r=call(api,x.o,x);save(path.join(x.out,'fixed-positive.json'),x.o);save(path.join(x.out,'result.json'),r);
    assert.equal(r.accepted,true,JSON.stringify(r));assert.equal(x.o.storage.filter(e=>e.kind==='seal'&&e.callId===x.o.input.subject.callId).length,0);
    assert.equal(x.o.before.receipts.length,0);intact(x);
  });
  const p=x=>x.o.phaseLineage.priorUploads[0];
  for(const [name,mutate,rule]of [
    ['prior seal missing',x=>{x.o.storage.splice(p(x).sealIndex,1);},'prior.exact-seal-required'],
    ['prior seal is not current read',x=>{p(x).sealIndex=0;},'prior.selected-physical-seal'],
    ['prior seal cannot be relabelled finalizer',x=>{x.o.storage[p(x).sealIndex].callId=x.o.input.subject.callId;},'prior.selected-physical-seal'],
    ['prior seal wrong digest',x=>editProof(x,p(x),'artifact',v=>{v.row.sha256='0'.repeat(64);}),'prior.verified-artifact'],
    ['prior seal wrong reception',x=>{x.o.storage[p(x).sealIndex].receptionId='foreign';},'prior.selected-physical-seal'],
    ['prior seal wrong generation',x=>{x.o.storage[p(x).sealIndex].generation=2;},'prior.selected-physical-seal'],
    ['prior seal wrong original',x=>{x.o.storage[p(x).sealIndex].artifactId='foreign';},'prior.selected-physical-seal'],
    ['prior seal wrong incarnation',x=>{x.o.storage[p(x).sealIndex].incarnation='old-process';},'prior.selected-physical-seal'],
    ['prior phase wrong actor',x=>editProof(x,p(x),'phase',v=>{v.row.principal='foreign';}),'prior.durable-seal-capability'],
    ['prior phase wrong executor',x=>editProof(x,p(x),'sqlEvidence',v=>{v.binding.phase.executor.id='foreign';}),'prior.actual-evidence-binding'],
    ['prior phase foreign run',x=>editProof(x,p(x),'phase',v=>{v.runId='foreign';}),'prior.phase.source'],
    ['prior phase generic read cannot authorize seal',x=>editProof(x,p(x),'phase',v=>{v.row.participant_plan={objects:['read']};}),'prior.durable-seal-capability'],
    ['prior dispatch other phase',x=>editProof(x,p(x),'dispatch',v=>{v.phaseId='foreign';}),'prior.actual-seal-dispatch'],
    ['prior dispatch read is not seal',x=>editProof(x,p(x),'dispatch',v=>{v.action='read';}),'prior.actual-seal-dispatch'],
    ['prior phase expired at seal',x=>editProof(x,p(x),'phase',v=>{v.row.deadline_ms=x.o.storage[p(x).sealIndex].atMs;}),'prior.window-and-admitted-order'],
    ['prior seal after before snapshot',x=>editProof(x,p(x),'artifact',v=>{v.observedAtMs=x.o.before.atMs+1;}),'prior.window-and-admitted-order'],
    ['prior unsampled client cannot be inferred',x=>{p(x).client.pointer='/absent';},'prior.client.pointer-member'],
    ['prior client socket actually checked',x=>editProof(x,p(x),'client',v=>{v.socket.port++;}),'prior.actual-client'],
    ['prior missing completion witness',x=>{p(x).completion.pointer='/absent';},'prior.completion.pointer-member'],
    ['prior completion wrong phase',x=>editProof(x,p(x),'completion',v=>{v.row.phase_id='foreign';}),'prior.retired-same-phase'],
    ['prior completion requires actual participant set',x=>editProof(x,p(x),'completion',v=>{delete v.row.observation.verifier;}),'prior.actual-acknowledgments'],
    ['prior superseded current attempt',x=>{x.o.before.receptions[0].generation=2;},'prior.sealed-current-precondition'],
    ['prior unknown upload cannot enter inventory',x=>{p(x).uploadCallId='unknown';},'prior.upload-boundary'],
    ['prior old seal cannot authorize current reader',x=>{x.o.storage.find(e=>e.kind==='read').evidenceId=x.o.storage[p(x).sealIndex].evidenceId;},'prior.fresh-current-authority'],
    ['prior finalizer read still mandatory',x=>{x.o.storage=x.o.storage.filter(e=>!(e.kind==='read'&&e.callId===x.o.input.subject.callId));p(x).sealIndex=x.o.storage.length-1;},'prior.fresh-finalizer-read-required'],
    ['prior finalizer current admission still mandatory',x=>{x.o.requestBoundaries[0].admission.result='denied';},'prior.both-currently-admitted'],
    ['prior duplicate receipt not history',x=>{x.o.after.receipts.push({...x.o.after.receipts[0],id:'extra'});},'after.receipts.unique-effectId'],
    ['prior upload cannot invent canonical comparator',x=>{x.o.comparisons.push({...x.o.comparisons[0],callId:p(x).uploadCallId,label:'binary'});},'request.canonical-not-relabelled-query'],
    ['prior selected error cannot borrow successful delivery',x=>{x.o.evidence.find(e=>e.id==='synthetic-upload-delivery').status=500;},'delivery.selected-completed-status'],
    ['prior future work cannot be presented as already run',x=>{x.o.after.jobs[0].state='completed';},'prior.work-not-executed'],
    ['prior unsealed attempt is not the precondition',x=>{x.o.before.attempts[0].state='partial';},'prior.sealed-current-precondition'],
    ['prior expired attempt cannot authorize finalization',x=>{x.o.before.attempts[0].expiresAtMs=x.o.requestBoundaries[0].server.observedAtMs;},'prior.current-attempt-not-expired'],
    ['prior generic evidence without phase proof',x=>{p(x).phase.pointer='/absent';},'prior.phase.pointer-member'],
    ['prior raw seal request must match dispatch',x=>editProof(x,p(x),'artifact',v=>{v.seal.requestId='different-command';}),'prior.actual-object-dispatch-link'],
    ['prior upload delivery must remain within its window',x=>{x.o.evidence.find(e=>e.id==='synthetic-upload-delivery').atMs=x.o.before.atMs;},'prior.complete-storage-window'],
    ['prior consumed same-size wrong bytes are not the original',x=>{
      const t=p(x).transfer,b=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');b[3]=0;
      const file='wrong-consumption.bin';writeFileSync(path.join(x.locations.evidenceRoot,file),b,{flag:'wx'});
      t.consumed.body={root:'evidence',file,bytes:b.length,sha256:hash(b)};t.consumed.sha256=hash(b);
    },'prior.exact-independent-bytes'],
    ['prior expected bytes cannot be learned from a changed digest',x=>{
      const t=p(x).transfer;t.declared.original.sha256='0'.repeat(64);
    },'transfer.fixed-declaration'],
  ])pair(name,priorFixture,mutate,rule);
}
