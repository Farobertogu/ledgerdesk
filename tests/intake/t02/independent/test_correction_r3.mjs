import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCase } from './index.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const attacks=[
  ['02-authorized-sibling','04-capture-evidence-for-read.json','f95c0823beae2151f04d057956cc0fdc9771944c013faca6dd9f25f08e75fd68','request.other-call-applicable-evidence'],
  ['02-authorized-sibling','05-admission-after-read.json','4f7da7e03d32aeba9bc63f89b15c8a6a6d1f9f8ff698280b06473880514f9706','request.other-call-admission-before-operation'],
  ['02-authorized-sibling','06-same-observed-request-twice.json','463e4b92a66d51ae30ed1028f77fb8a1e7e72e867e12f6e5fb0825555c5d54a0','request.unique-observed-connection-request'],
  ['12-framing-application','03-other-successful-physical-write.json','9f5577f35293d4bad95a3eb0f9e32960d7a17a9227af08863999d03dc7925ae2','framing.refusal-consumption-and-effects'],
  ['09-rollback-proved-absent','05-wrong-reconciled-reception.json','fc254bc55235f23419547dab9ce81517f641305af8e70e1d1c05ca2bcea6e264','correlation.absent-selected-reception'],
  ['15-actual-resumption','04-commands-before-resume.json','91edf5436a3ec998ded6221f09ecf2d103b42d5eef080b056b98dedfcb8fe2ae','late-command.after-completed-resume'],
  ['18-restart-identity','04-same-os-identity-leading-zero-ticks.json','06efb3d03bb48659ac396894d00322f0e35be38dda6aa94a4781a5bc05ca8a9c','restart.distinct-os-process-not-label'],
];
const json=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2),{flag:'wx'});
const read=p=>JSON.parse(readFileSync(p));
function differences(a,b,at='') {
  if(JSON.stringify(a)===JSON.stringify(b))return [];
  if(a&&b&&typeof a==='object'&&typeof b==='object')return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>differences(a[k],b[k],`${at}/${k}`));
  return [{path:at,before:a,after:b}];
}
function copyTree(source,destination,identities=[]) {
  assert.equal(lstatSync(source).isSymbolicLink(),false,'Never traverse an evidence junction.');
  mkdirSync(destination,{recursive:true});
  for(const name of readdirSync(source)){
    const from=path.join(source,name),to=path.join(destination,name),stat=lstatSync(from);
    assert.equal(stat.isSymbolicLink(),false,'Never traverse an evidence junction.');
    if(stat.isDirectory())copyTree(from,to,identities);
    else {assert.ok(stat.isFile());const b=readFileSync(from);writeFileSync(to,b,{flag:'wx'});identities.push({source:from,bytes:b.length,sha256:sha(b)});}
  }
  return identities;
}
function invoke(module,o,locations) {
  try{return {accepted:true,result:module.assertCase(o.caseId,o.variant,o,locations)};}
  catch(e){assert.ok(e instanceof assert.AssertionError,`Not an acceptance assertion: ${e.stack}`);return {accepted:false,error:e.message,actual:e.actual,expected:e.expected};}
}
function rejected(result,rule){assert.equal(result.accepted,false,JSON.stringify(result));assert.ok(result.error.includes(rule),result.error);}

export function registerCorrectionR3(root) {
  const sources=process.env.T02_R2_SOURCES,probes=process.env.T02_R2_PROBES,followups=process.env.T02_R2_FOLLOWUPS;
  let serial=0,oldPromise;
  async function oldModule(){
    assert.ok(sources&&probes&&followups,'Supply the three explicit read-only R2 roots through run_self.');
    if(!oldPromise){
      const b=readFileSync(path.join(sources,'..','run.json'));
      assert.equal(sha(b),'c8e1f1b7752944007a78b434fec8d0470bda1a7382aecf1dcb085e53d6783d6e');
      const manifest=JSON.parse(b);assert.equal(manifest.sources.length,17);
      for(const file of manifest.sources){const actual=readFileSync(path.join(sources,file.name));assert.equal(actual.length,file.bytes);assert.equal(sha(actual),file.sha256);}
      oldPromise=import(pathToFileURL(path.join(sources,'index.mjs')).href);
    }
    return oldPromise;
  }
  function specimen(group,from=probes,file='auditor-positive.json'){
    assert.ok(from,'Missing explicit input root.');
    const source=path.join(from,group),out=path.join(root,'correction-r3',`${++serial}-${group}`);mkdirSync(out,{recursive:true});
    const identities=[...copyTree(path.join(source,'fixtures'),path.join(out,'fixtures')),...copyTree(path.join(source,'capture'),path.join(out,'capture'))];
    const b=readFileSync(path.join(source,file));writeFileSync(path.join(out,'input.json'),b,{flag:'wx'});
    identities.push({source:path.join(source,file),bytes:b.length,sha256:sha(b)});json(path.join(out,'input-identities.json'),identities);
    return {o:JSON.parse(b),out,locations:{fixtureRoot:path.join(out,'fixtures'),evidenceRoot:path.join(out,'capture')}};
  }
  for(const [group,file,hash,rule]of attacks)test(`R3 preserved counterexample: ${file}`,async()=>{
    const old=await oldModule(),x=specimen(group),raw=readFileSync(path.join(probes,group,file));assert.equal(sha(raw),hash);
    const packet=JSON.parse(raw),before=invoke(old,x.o,x.locations),attackBefore=invoke(old,packet.observation,x.locations);
    writeFileSync(path.join(x.out,'exact-counterexample.json'),raw,{flag:'wx'});
    const delta=differences(x.o,packet.observation);assert.ok(delta.length>0);
    assert.equal(before.accepted,true);assert.equal(attackBefore.accepted,true);
    const after=invoke({assertCase},x.o,x.locations),attackAfter=invoke({assertCase},packet.observation,x.locations);
    json(path.join(x.out,'replay.json'),{file,hash,rule,delta,oldPositive:before,oldAttack:attackBefore,newPositive:after,newAttack:attackAfter});
    assert.equal(after.accepted,true,JSON.stringify(after));rejected(attackAfter,rule);
  });
  const controls=['01-complete-denied-call','03-durable-correspondence','04-independent-keyed-digest','05-new-key-existing-effect','06-new-finalization','07-auditor-distinct-actors','08-lawful-same-string-actor','10-not-started-proved-absent','11-legitimate-uncertain-query','13-framing-parser','14-digest-mismatch','16-corrupt-original','17-missing-original-503','19-historical-prefix-preserved','20-strict-current-profile'];
  // Identify actual group directory names; the numeric prefix is fixed, never
  // inferred from the acceptance result or changed to bypass a failing group.
  function fixedCorruptPreparation(x,original,name) {
    const o=structuredClone(original);
    if(o.caseId!=='IC11'||o.variant!=='corrupt')return o;
    const reference=read(path.join(x.locations.fixtureRoot,'references/IC11/corrupt.json'));
    assert.equal(reference.unavailable.status,409,'The pre-existing independent safe error is 409.');
    const selected=o.evidence.find(e=>e.id==='e-delivery'&&e.callId===o.input.subject.callId);
    assert.ok(o.transport.some(t=>t.kind==='handoff'&&t.evidenceId===selected?.id));
    assert.equal(selected.status,200,'Preserved illustration originally claimed preparation 200.');
    selected.status=409;
    json(path.join(x.out,`fixture-correction-${name}.json`),{basis:'references/IC11/corrupt.json unavailable.status = 409, fixed before evaluation',delta:differences(original,o),observation:o});
    return o;
  }
  for(const named of controls)test(`R3 preserves the reviewed control ${named}`,async()=>{
    const old=await oldModule(),prefix=named.slice(0,2)+'-',matches=readdirSync(probes).filter(n=>n.startsWith(prefix));assert.equal(matches.length,1);
    const x=specimen(matches[0]),oldPositive=invoke(old,x.o,x.locations);
    const positive=invoke({assertCase},fixedCorruptPreparation(x,x.o,'positive'),x.locations);
    const negativeResults=[];
    for(const name of readdirSync(path.join(probes,matches[0])).filter(n=>/^\d\d-.*\.json$/.test(n))){
      const packet=read(path.join(probes,matches[0],name));
      if(packet.result.actual.accepted)continue; // The seven attacks and withdrawn staging hypothesis are separate.
      const result=invoke({assertCase},fixedCorruptPreparation(x,packet.observation,name),x.locations);
      negativeResults.push({name,rule:packet.result.expectedRule,result});
      json(path.join(x.out,name),packet);
    }
    json(path.join(x.out,'controls.json'),{oldPositive,positive,negativeResults});assert.equal(oldPositive.accepted,true);assert.equal(positive.accepted,true,JSON.stringify(positive));
    for(const n of negativeResults)rejected(n.result,n.rule);
  });
  for(const name of ['same-connection-distinct-request-ordinal','late-probes-after-complete-retransmission','legitimate-reused-pid-new-start-ticks','absent-stage-declared-observer-limit','read-evidence-explicitly-uncommitted','same-process-zero-padding-confirmation'])test(`R3 preserved followup: ${name}`,async()=>{
    const old=await oldModule(),x=specimen(name,followups,'observation.json'),before=invoke(old,x.o,x.locations),after=invoke({assertCase},x.o,x.locations);
    json(path.join(x.out,'followup.json'),{before,after});
    if(name==='read-evidence-explicitly-uncommitted'){rejected(before,'request.other-call-prior-evidence');rejected(after,'request.other-call-prior-evidence');}
    else {assert.equal(before.accepted,true);if(name==='same-process-zero-padding-confirmation')rejected(after,'restart.distinct-os-process-not-label');else assert.equal(after.accepted,true,JSON.stringify(after));}
  });
  function pair(x,name,mutate,rule){
    json(path.join(x.out,'fixed-positive.json'),x.o);
    const positive=invoke({assertCase},x.o,x.locations),changed=structuredClone(x.o);mutate(changed);
    const negative=invoke({assertCase},changed,x.locations);
    json(path.join(x.out,'directed.json'),{name,rule,positive,negative,delta:differences(x.o,changed)});
    json(path.join(x.out,'changed-observation.json'),changed);
    assert.equal(positive.accepted,true,JSON.stringify(positive));rejected(negative,rule);
  }
  function callReference(x,change){
    const p=path.join(x.locations.fixtureRoot,`references/${x.o.caseId}/${x.o.variant}.calls.json`),value=read(p);change(value);
    // This owned illustrative setup is fixed before either checker invocation.
    writeFileSync(p,JSON.stringify(value,null,2));json(path.join(x.out,'fixed-call-reference.json'),value);
  }
  for(const kind of ['capture','append','seal'])test(`R3 applicable capture treatment preserves an admitted ${kind}`,()=>{
    const x=specimen('02-authorized-sibling'),b=x.o.requestBoundaries.find(b=>b.callId==='other-call');
    b.method='POST';b.route='/api/intake/receptions/operation-1/attempts/3/original';b.requestClass='binary-transfer';
    x.o.responses.find(r=>r.label===b.responseLabel).route=b.route;
    x.o.storage.find(e=>e.callId==='other-call').kind=kind;
    x.o.evidence.find(e=>e.callId==='other-call').phase='capture_admission';
    callReference(x,r=>{const row=r.calls.find(r=>r.label===b.label);Object.assign(row,{method:b.method,route:b.route,requestClass:b.requestClass});row.allowedAccess[0].kind=kind;});
    pair(x,kind,o=>{o.evidence.find(e=>e.callId==='other-call').phase='read_admission';},'request.other-call-applicable-evidence');
  });
  test('R3 other-call restoration cannot borrow capture admission for an unsupported exclusion',()=>{
    const x=specimen('02-authorized-sibling');
    callReference(x,r=>r.calls.find(r=>r.label==='other').allowedAccess.push({kind:'restore_write',artifactId:'audit-sibling-original',generation:3}));
    pair(x,'other-restore',o=>{const e=o.evidence.find(e=>e.callId==='other-call');e.phase='capture_admission';o.storage.find(e=>e.callId==='other-call').kind='restore_write';},'request.other-call-restore-exclusion-unsupported');
  });
  test('R3 actual request identity preserves another peer and normalizes mapped spelling without editing capture',()=>{
    const x=specimen('02-authorized-sibling'),b=x.o.requestBoundaries[1];
    b.client.address='127.0.0.3';b.server.peerAddress='::ffff:127.0.0.3';b.client.port=41000;b.server.peerPort=41000;
    pair(x,'mapped-duplicate',o=>{o.requestBoundaries[1].client.address='::ffff:127.0.0.2';o.requestBoundaries[1].server.peerAddress='127.0.0.2';},'request.unique-observed-connection-request');
  });
  test('R3 changing request timestamps alone cannot separate a duplicate observed tuple and ordinal',()=>{
    const x=specimen('02-authorized-sibling');
    pair(x,'timestamp-label',o=>{const b=o.requestBoundaries[1];b.client.port=41000;b.server.peerPort=41000;b.client.observedAtMs+=1;b.server.observedAtMs+=1;},'request.unique-observed-connection-request');
  });
  test('R3 admission at the operation millisecond is representable but a later admission is not',()=>{
    const x=specimen('02-authorized-sibling'),b=x.o.requestBoundaries[1];b.admission.observedAtMs=x.o.storage.find(e=>e.callId===b.callId).atMs;
    pair(x,'admission-boundary',o=>{o.requestBoundaries[1].admission.observedAtMs+=1;},'request.other-call-admission-before-operation');
  });
  test('R3 a previously selected reception cannot become null in the terminal absence proof',()=>{
    const x=specimen('09-rollback-proved-absent');pair(x,'selected-to-null',o=>{o.correlations[0].observation.receptionId=null;},'correlation.absent-selected-reception');
  });
  test('R3 a truthful no-selection not-started outcome keeps null without fabricating reception allocation',()=>{
    const x=specimen('10-not-started-proved-absent'),call=x.o.invocations[0];
    x.o.input.subject.receptionId=null;x.o.input.subject.queryIntentionId=null;
    call.subject.receptionId=null;call.subject.queryIntentionId=null;
    x.o.requestBoundaries.find(b=>b.callId===call.callId).receptionId=null;
    x.o.correlations[0].observation.receptionId=null;
    callReference(x,r=>{r.calls.find(r=>r.label===call.label).receptionId=null;});
    pair(x,'unselected-to-invented',o=>{o.correlations[0].observation.receptionId='invented-before-allocation';},'correlation.absent-selected-reception');
  });
  test('R3 an applicable but denied evidence row cannot justify an admitted sibling access',()=>{
    const x=specimen('02-authorized-sibling');pair(x,'denied-evidence',o=>{o.evidence.find(e=>e.callId==='other-call').status=403;},'request.other-call-prior-evidence');
  });
  test('R3 other-call JSON handoff must follow its actual admission even without an original read',()=>{
    const x=specimen('02-authorized-sibling'),b=x.o.requestBoundaries[1],r=x.o.responses.find(r=>r.label===b.responseLabel),e=x.o.evidence.find(e=>e.callId===b.callId);
    x.o.storage=[];e.phase='delivery';callReference(x,ref=>{ref.calls.find(r=>r.label===b.label).allowedAccess=[];});
    x.o.transport=[{origin:'terminal-boundary',route:b.route,operationId:e.operationId,evidenceId:e.id,kind:'handoff',bytes:r.bytes,atMs:e.atMs+1,callId:b.callId,receptionId:b.receptionId}];
    pair(x,'handoff-admission',o=>{o.requestBoundaries[1].admission.observedAtMs=o.transport[0].atMs+1;},'request.other-call-delivery-admission-before-operation');
  });
  test('R3 actual SQL admission cannot precede its observed server request boundary',()=>{
    const x=specimen('02-authorized-sibling');pair(x,'admission-before-call',o=>{o.requestBoundaries[1].admission.observedAtMs=o.requestBoundaries[1].server.observedAtMs-1;},'request.other-call-admission-before-operation');
  });
  for(const action of ['append','seal'])test(`R3 ${action} must start after completed resume, not merely after the request started`,()=>{
    const x=specimen('15-actual-resumption'),b=x.o.requestBoundaries.find(b=>b.callId===x.o.continuation.resumeCallId),finished=x.o.responses.find(r=>r.label===b.responseLabel).atMs;
    for(const command of x.o.continuation.lateCommands){command.startedAtMs=finished;command.endedAtMs=finished;}
    pair(x,`resume-${action}`,o=>{const c=o.continuation.lateCommands.find(c=>c.action===action);c.startedAtMs=finished-1;c.endedAtMs=finished;},'late-command.after-completed-resume');
  });
  for(const [label,before,after,mutated]of [
    ['beyond-safe-integer','9007199254740992','9007199254740993','0009007199254740992'],
    ['zero','0','1','0000'],
    ['long-decimal','123456789012345678901234567890','123456789012345678901234567891','000123456789012345678901234567890'],
  ])test(`R3 tick normalization preserves precision and lawful PID reuse: ${label}`,()=>{
    const x=specimen('18-restart-identity'),old=x.o.processes[0],next=x.o.processes[1];
    old.processRef.startTicks=before;next.processRef={...old.processRef,startTicks:after};x.o.startup.processRef=structuredClone(next.processRef);
    pair(x,label,o=>{o.processes[1].processRef.startTicks=mutated;o.startup.processRef.startTicks=mutated;},'restart.distinct-os-process-not-label');
  });
  for(const group of ['12-framing-application','13-framing-parser'])for(const kind of ['capture','append','seal','restore_write'])test(`R3 ${group} refuses every protected write kind: ${kind}`,()=>{
    const x=specimen(group),example=read(path.join(probes,'12-framing-application','03-other-successful-physical-write.json')).observation.storage.find(e=>e.kind==='restore_write');
    pair(x,kind,o=>{o.storage.push({...example,callId:o.input.subject.callId,receptionId:o.input.subject.receptionId,kind,generation:99});},'framing.refusal-consumption-and-effects');
  });
}
