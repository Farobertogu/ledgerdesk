import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assertCase } from './index.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p));
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
function copyTree(from,to,identities=[]) {
  assert.ok(lstatSync(from).isDirectory()&&!lstatSync(from).isSymbolicLink());mkdirSync(to,{recursive:false});
  for(const name of readdirSync(from).sort()) {
    const a=path.join(from,name),b=path.join(to,name),s=lstatSync(a);assert.equal(s.isSymbolicLink(),false);
    if(s.isDirectory())copyTree(a,b,identities);
    else {assert.ok(s.isFile());const bytes=readFileSync(a);writeFileSync(b,bytes,{flag:'wx'});identities.push({source:a,copy:b,bytes:bytes.length,sha256:hash(bytes)});}
  }
  return identities;
}
function evaluate(api,x) {
  const before=JSON.stringify(x.o);let outcome;
  try{outcome={accepted:true,result:api.assertCase(x.o.caseId,x.o.variant,x.o,x.locations)};}
  catch(e){assert.ok(e instanceof assert.AssertionError,e.stack);outcome={accepted:false,error:e.message,actual:e.actual,expected:e.expected};}
  assert.equal(JSON.stringify(x.o),before);return outcome;
}
export function registerCorrectionR6(root) {
  const prior=process.env.T02_R5_SOURCES,real=process.env.T02_R6_REAL_REPLAY;
  assert.ok(root&&path.isAbsolute(root)&&prior&&real);
  const manifest=readFileSync(path.join(prior,'..','run.json'));
  assert.equal(hash(manifest),'a8f462c317c57d24d462cf8819a03be81c821ff467bb1070de3c26a719fba212');
  const sources=JSON.parse(manifest).sources;assert.equal(sources.length,23);
  for(const s of sources){const b=readFileSync(path.join(prior,s.name));assert.equal(b.length,s.bytes);assert.equal(hash(b),s.sha256);}
  const replayBytes=readFileSync(path.join(real,'replay.json'));
  assert.equal(hash(replayBytes),'9da550e6bbc8211eaf57e77669ef0c3ebad90492642a06fa0de8caccee59b399');
  for(const s of JSON.parse(replayBytes).inputs){const b=readFileSync(s.copy);assert.equal(b.length,s.bytes);assert.equal(hash(b),s.sha256);}
  const old=import(pathToFileURL(path.join(prior,'index.mjs')).href),api={assertCase};let serial=0;
  function capture(which='IC04') {
    const out=path.join(root,'compatible-prior',String(++serial)+'-'+which);mkdirSync(out,{recursive:true});
    const locations={fixtureRoot:path.join(out,'fixed'),evidenceRoot:path.join(out,'observed')};
    const identities=copyTree(path.join(real,'fixed'),locations.fixtureRoot);copyTree(path.join(real,'observed'),locations.evidenceRoot,identities);
    const name=which==='IC04'?'IC04-compatible-packet.json':'IC05-receipt-packet.json';
    const raw=readFileSync(path.join(locations.evidenceRoot,name));
    assert.equal(hash(raw),which==='IC04'?'b6f6b33a6ab558b3b89db4df553760fada443e53af90c594597f479e9f77692a':'b692a7431e87c1c80a61e03174a57fdc90857e0e96be1c62fd8154263e537ea2');
    save(path.join(out,'input-identities.json'),identities);
    return {o:JSON.parse(raw),out,locations,identities,proofSerial:0};
  }
  function intact(x) {
    for(const s of x.identities)for(const p of [s.source,s.copy]){const b=readFileSync(p);assert.equal(b.length,s.bytes);assert.equal(hash(b),s.sha256,p);}
  }
  const priorWindow=x=>x.o.phaseLineage.priorUploads[0];
  const boundary=x=>x.o.requestBoundaries.find(b=>b.label==='reconcile');
  const query=x=>x.o.evidence.find(e=>e.callId===boundary(x).callId&&e.phase==='query');
  const delivery=x=>x.o.evidence.find(e=>e.id===x.o.transport.find(t=>t.callId===boundary(x).callId&&t.kind==='handoff').evidenceId);
  function editProof(x,field,change) {
    const p=priorWindow(x)[field];let value=read(path.join(x.locations.evidenceRoot,p.file));
    for(const key of p.pointer.slice(1).split('/'))value=value[key.replaceAll('~1','/').replaceAll('~0','~')];
    value=structuredClone(value);change(value);
    const file='mutated-proof-'+(++x.proofSerial)+'.json';save(path.join(x.locations.evidenceRoot,file),value);
    const bytes=readFileSync(path.join(x.locations.evidenceRoot,file));priorWindow(x)[field]={file,bytes:bytes.length,sha256:hash(bytes),pointer:''};
  }
  for(const which of ['IC04','IC05'])test('R6 exact real '+which+' old and new exported consumer',async()=>{
    const x=capture(which),result={kind:'exact-retained-real-packet-no-reprojection',old:evaluate(await old,x),current:evaluate(api,x)};
    save(path.join(x.out,'exact-replay.json'),result);
    assert.equal(result.current.accepted,true,JSON.stringify(result.current));
    if(which==='IC04'){assert.equal(result.old.accepted,false);assert.ok(result.old.error.includes('prior.distinct-window-classes'));}
    else assert.equal(result.old.accepted,true,JSON.stringify(result.old));
    intact(x);
  });
  function pair(name,mutate,rule) {
    test('R6 '+name,()=>{
      const x=capture(),positive=evaluate(api,x);const original=JSON.stringify(x.o);mutate(x);
      const negative=evaluate(api,x);save(path.join(x.out,'changed-packet.json'),x.o);
      save(path.join(x.out,'result.json'),{kind:'exact-real-positive-and-directed-packet-mutation',name,rule,positive,negative});
      assert.equal(positive.accepted,true,JSON.stringify(positive));assert.equal(negative.accepted,false,JSON.stringify(negative));assert.ok(negative.error.includes(rule),negative.error);
      assert.notEqual(JSON.stringify(x.o),original);intact(x);
    });
  }
  for(const [name,mutate,rule]of [
    ['prior cannot select reconciliation as finalizer',x=>{priorWindow(x).finalizeCallId=boundary(x).callId;},'prior.independent-window'],
    ['prior upload must be inventoried',x=>{priorWindow(x).uploadCallId='unknown';},'prior.upload-boundary'],
    ['binary upload cannot become canonical',x=>{x.o.requestBoundaries[0].requestClass='canonical-act';},'request.independent-semantics'],
    ['prior original remains exact',x=>{x.o.storage[priorWindow(x).sealIndex].artifactId='foreign';},'prior.selected-physical-seal'],
    ['prior generation remains exact',x=>{x.o.storage[priorWindow(x).sealIndex].generation++;},'prior.selected-physical-seal'],
    ['prior actor remains exact',x=>editProof(x,'phase',v=>{v.row.principal='foreign';}),'prior.durable-seal-capability'],
    ['prior executor remains exact',x=>editProof(x,'sqlEvidence',v=>{v.binding.phase.executor.id='foreign';}),'prior.actual-evidence-binding'],
    ['prior must retain seal capability',x=>editProof(x,'phase',v=>{delete v.row.participant_plan;}),'prior.durable-seal-capability'],
    ['ordinary read plan cannot seal',x=>editProof(x,'phase',v=>{v.row.participant_plan={objects:['read'],verifier:['verify']};}),'prior.durable-seal-capability'],
    ['prior admission cannot be missing',x=>{const id=x.o.storage[priorWindow(x).sealIndex].evidenceId;x.o.evidence=x.o.evidence.filter(e=>e.id!==id);},'prior.selected-evidence'],
    ['dispatch must select its phase',x=>editProof(x,'dispatch',v=>{v.phaseId='other';}),'prior.actual-seal-dispatch'],
    ['physical seal must match private command',x=>editProof(x,'artifact',v=>{v.seal.requestId='other';}),'prior.actual-object-dispatch-link'],
    ['seal must precede phase deadline',x=>editProof(x,'phase',v=>{v.row.deadline_ms=x.o.storage[priorWindow(x).sealIndex].atMs;}),'prior.window-and-admitted-order'],
    ['prior seal cannot replace fresh read',x=>{x.o.storage.find(s=>s.callId===x.o.input.subject.callId&&s.kind==='read').evidenceId=x.o.storage[priorWindow(x).sealIndex].evidenceId;},'prior.fresh-current-authority'],
    ['finalizer still needs admission',x=>{x.o.requestBoundaries.find(b=>b.callId===x.o.input.subject.callId).admission.result='denied';},'prior.both-currently-admitted'],
    ['reconciliation still needs its admission',x=>{boundary(x).admission.result='denied';},'request.other-call-delivery-admitted'],
    ['reconciliation still needs own query',x=>{const e=query(x);x.o.evidence=x.o.evidence.filter(v=>v!==e);},'replay.own-query-evidence'],
    ['query cannot borrow upload intention',x=>{query(x).operationId=x.o.evidence.find(e=>e.callId===priorWindow(x).uploadCallId&&e.phase==='delivery').operationId;},'replay.current-query-scope'],
    ['query needs its own backend',x=>{query(x).backendPid++;},'replay.current-query-scope'],
    ['query must follow current admission',x=>{query(x).atMs=boundary(x).admission.observedAtMs-1;},'replay.current-query-order'],
    ['delivery cannot borrow prior read',x=>{x.o.transport.find(t=>t.callId===boundary(x).callId).evidenceId=x.o.storage[priorWindow(x).sealIndex].evidenceId;},'request.other-call-delivery-evidence'],
    ['replay canonical payload remains fixed',x=>{x.o.invocations[1].canonicalPayloadSha256='0'.repeat(64);},'invocations.independent-request-identity'],
    ['replay namespace remains fixed',x=>{x.o.invocations[1].clientKey='other';},'invocations.independent-request-identity'],
    ['replay actual comparison remains fixed',x=>{x.o.comparisons[1].comparedCanonicalSha256='0'.repeat(64);},'invocations.actual-canonical-comparison'],
    ['replay cannot swap incumbent',x=>{x.o.incumbentComparisons[0].operationId='other';},'incumbent.actual-row-request-and-effect'],
    ['replay must execute incumbent comparison',x=>{x.o.incumbentComparisons=[];},'incumbent.executed-comparison-required'],
    ['replay must retain compatible outcome',x=>{x.o.incumbentComparisons[0].outcome='incompatible';},'incumbent.observed-comparator-consistency'],
    ['replay durable correlation remains fixed',x=>{x.o.correlations[1].observation.effectId='other';},'correlation.actual-durable-linkage'],
    ['replay returned effect remains fixed',x=>{x.o.responses.find(r=>r.label==='reconcile').body.effect.id='other';},'replay.returned-known-effect'],
    ['first returned effect remains fixed',x=>{x.o.responses.find(r=>r.label==='subject').body.effect.id='other';},'replay.returned-known-effect'],
    ['replay returned original remains fixed',x=>{x.o.responses.find(r=>r.label==='reconcile').body.original.generation++;},'replay.returned-known-effect'],
    ['replay returned work remains unexecuted',x=>{x.o.responses.find(r=>r.label==='reconcile').body.work.state='completed';},'replay.returned-known-effect'],
    ['duplicate receipt remains invalid',x=>{x.o.after.receipts.push({...x.o.after.receipts[0],id:'extra'});x.o.after.counts.receipts++;},'after.receipts.unique-effectId'],
    ['duplicate job remains invalid',x=>{x.o.after.jobs.push({...x.o.after.jobs[0],id:'extra'});x.o.after.counts.jobs++;},'prior.new-linked-job'],
    ['processing is not part of reception',x=>{x.o.after.counts.extractions++;},'after.no-later-effects'],
    ['replay cannot add original access',x=>{x.o.storage.push({...x.o.storage.find(s=>s.kind==='read'),callId:boundary(x).callId,evidenceId:query(x).id,atMs:query(x).atMs});},'phase.independent-protected-scope'],
    ['metadata cannot grant storage',x=>{x.o.storage.find(s=>s.callId===x.o.input.subject.callId).evidenceId=x.o.phaseLineage.metadata[0].evidenceId;},'metadata.never-protected-admission'],
    ['metadata cannot grant replay handoff',x=>{x.o.transport.find(t=>t.callId===boundary(x).callId).evidenceId=x.o.phaseLineage.metadata[1].evidenceId;},'metadata.never-protected-admission'],
    ['M07 protects the selected replay delivery',x=>{delivery(x).status=500;},'delivery.selected-completed-status'],
    ['upload cannot invent canonical comparison',x=>{x.o.comparisons.push({...x.o.comparisons[0],label:'binary',callId:priorWindow(x).uploadCallId});},'request.canonical-not-relabelled-query'],
  ])pair(name,mutate,rule);
  for(const variant of ['incompatible','concurrent'])pair('unsupported prior composition '+variant,x=>{
    for(const suffix of ['.json','.calls.json','.phases.json']){
      const from=path.join(x.locations.fixtureRoot,'references/IC04/compatible'+suffix),to=path.join(x.locations.fixtureRoot,'references/IC04/'+variant+suffix);
      writeFileSync(to,readFileSync(from),{flag:'wx'});
    }
    x.o.variant=variant;
  },'prior.supported-composition');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))registerCorrectionR6(process.env.T02_SELF_RUN_ROOT);

