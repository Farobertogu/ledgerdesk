import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCase } from './index.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const save=(p,x)=>writeFileSync(p,JSON.stringify(x,null,2),{flag:'wx'});
const read=p=>JSON.parse(readFileSync(p));
const rule='delivery.selected-completed-status';
function copyTree(source,destination,identities=[]) {
  assert.equal(lstatSync(source).isSymbolicLink(),false,'Never traverse an evidence link.');
  mkdirSync(destination,{recursive:true});
  for(const name of readdirSync(source)) {
    const from=path.join(source,name),to=path.join(destination,name),stat=lstatSync(from);
    assert.equal(stat.isSymbolicLink(),false,'Never traverse an evidence link.');
    if(stat.isDirectory())copyTree(from,to,identities);
    else {assert.ok(stat.isFile());const bytes=readFileSync(from);writeFileSync(to,bytes,{flag:'wx'});identities.push({source:from,copy:to,bytes:bytes.length,sha256:sha(bytes)});}
  }
  return identities;
}
function invoke(api,o,x) {
  const before=JSON.stringify(o);let result;
  try {result={accepted:true,result:api.assertCase(o.caseId,o.variant,o,x.locations)};}
  catch(error){assert.ok(error instanceof assert.AssertionError,`Not a semantic assertion: ${error.stack}`);result={accepted:false,error:error.message,actual:error.actual,expected:error.expected};}
  assert.equal(JSON.stringify(o),before,'Evaluation must not repair its input.');
  for(const id of x.identities??[])assert.equal(sha(readFileSync(id.copy)),id.sha256,'Evaluation must not repair fixed bytes.');
  return result;
}
function rejects(result,expected=rule){assert.equal(result.accepted,false,JSON.stringify(result));assert.ok(result.error.includes(expected),result.error);}
function delta(a,b,p='') {
  if(JSON.stringify(a)===JSON.stringify(b))return [];
  if(a&&b&&typeof a==='object'&&typeof b==='object')return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>delta(a[k],b[k],`${p}/${k}`));
  return [{path:p,before:a,after:b}];
}

export function registerCorrectionR4(root,h) {
  const sources=process.env.T02_R3_SOURCES,probes=process.env.T02_R3_PROBES,followups=process.env.T02_R3_FOLLOWUPS;
  let serial=0,oldPromise;
  async function oldModule(){
    assert.ok(sources&&probes&&followups,'Supply the three explicit read-only R3 roots through run_self.');
    if(!oldPromise){
      const raw=readFileSync(path.join(sources,'..','run.json'));
      assert.equal(sha(raw),'d354b9f8cb81ee2dd711ad42f5e9d0d4a0b8717a6a1e7b44d399eb0782fc1310');
      const manifest=JSON.parse(raw);assert.equal(manifest.sources.length,19);
      for(const file of manifest.sources){const bytes=readFileSync(path.join(sources,file.name));assert.equal(bytes.length,file.bytes);assert.equal(sha(bytes),file.sha256);}
      oldPromise=import(pathToFileURL(path.join(sources,'index.mjs')).href);
    }
    return oldPromise;
  }
  function specimen(group,from=probes,file='positive.json') {
    assert.ok(from);const source=path.join(from,group),out=path.join(root,'correction-r4',`${++serial}-${group}`);mkdirSync(out,{recursive:true});
    const identities=[...copyTree(path.join(source,'fixtures'),path.join(out,'fixtures')),...copyTree(path.join(source,'capture'),path.join(out,'capture'))];
    const raw=readFileSync(path.join(source,file));writeFileSync(path.join(out,'original-positive.json'),raw,{flag:'wx'});
    save(path.join(out,'input-identities.json'),{packet:{path:path.join(source,file),bytes:raw.length,sha256:sha(raw)},files:identities});
    return {o:JSON.parse(raw),out,identities,locations:{fixtureRoot:path.join(out,'fixtures'),evidenceRoot:path.join(out,'capture')}};
  }
  const attacks=[
    ['01-failed-delivery-status-403.json','a79abd03536dc16b2c09cbb8bf99a84380c45afcd0897f3f781ed43b2db2ee07'],
    ['02-failed-delivery-status-500.json','5f0b6ff6980985078eb3a2208a153a607954e49d1b73256f92e66d490dc08f54'],
    ['03-failed-delivery-status-null.json','2f2ad60873a899dd5a68e0af7125f6d2bd320b1c1a0da571059d82f2f5561c9d'],
    ['changed-observation.json','d4bb07d9cda652d01e985a78eb12020049c9270a88871ec757323cf2ff81d0e1'],
  ];
  for(const [file,hash]of attacks)test(`R4 exact selected-delivery attack: ${file}`,async()=>{
    const error=file==='changed-observation.json',group=error?'matching-governed-error-409':'03-json-handoff-no-read';
    const x=specimen(group,error?followups:probes,error?'fixed-positive.json':'positive.json'),old=await oldModule();
    const raw=readFileSync(path.join(error?followups:probes,group,file));assert.equal(sha(raw),hash);
    writeFileSync(path.join(x.out,'exact-counterexample.json'),raw,{flag:'wx'});
    const parsed=JSON.parse(raw),changed=error?parsed:parsed.observation;
    if(!error){assert.equal(x.o.storage.length,0);assert.equal(changed.storage.length,0);}
    const result={file,hash,rule,delta:delta(x.o,changed),oldPositive:invoke(old,x.o,x),oldAttack:invoke(old,changed,x),newPositive:invoke({assertCase},x.o,x),newAttack:invoke({assertCase},changed,x)};
    save(path.join(x.out,'replay.json'),result);
    assert.equal(result.oldPositive.accepted,true);assert.equal(result.oldAttack.accepted,true);
    assert.equal(result.newPositive.accepted,true,JSON.stringify(result.newPositive));rejects(result.newAttack);
  });
  for(const group of ['prepared200-no-governed-handoff-error503','prepared200-interrupted-no-client-reply'])test(`R4 preserves preparation without completed delivery: ${group}`,async()=>{
    const old=await oldModule(),x=specimen(group,followups,'fixed-positive.json');
    const result={old:invoke(old,x.o,x),current:invoke({assertCase},x.o,x)};save(path.join(x.out,'control.json'),result);
    assert.equal(result.old.accepted,true);assert.equal(result.current.accepted,true,JSON.stringify(result.current));
  });
  function pair(x,name,mutate,expected=rule) {
    save(path.join(x.out,'fixed-positive.json'),x.o);
    const positive=invoke({assertCase},x.o,x),changed=structuredClone(x.o);mutate(changed);
    const negative=invoke({assertCase},changed,x);
    save(path.join(x.out,'changed-observation.json'),changed);
    save(path.join(x.out,'directed.json'),{name,rule:expected,positive,negative,delta:delta(x.o,changed)});
    assert.equal(positive.accepted,true,JSON.stringify(positive));rejects(negative,expected);
  }
  const other=()=>specimen('03-json-handoff-no-read');
  const subjectError=()=>specimen('matching-governed-error-409',followups,'fixed-positive.json');
  const handoff=x=>x.o.transport.find(t=>t.kind==='handoff');
  const selected=x=>x.o.evidence.find(e=>e.id===handoff(x).evidenceId);
  function own(caseId,variant){
    const x=h.specimen(caseId,variant);x.out=path.join(root,'correction-r4',`${++serial}-${caseId}-${variant}`);mkdirSync(x.out,{recursive:true});return x;
  }
  for(const value of [403,500,null])test(`R4 subject success rejects selected preparation ${value}`,()=>{
    const x=own('IC15','prior-evidence');
    pair(x,`subject-200-vs-${value}`,o=>{o.evidence.find(e=>e.id==='e-delivery').status=value;});
  });
  for(const value of [409,500])test(`R4 other-call governed ${value} is not required to be 2xx`,()=>{
    const x=other(),t=handoff(x),b=x.o.requestBoundaries.find(b=>b.callId===t.callId),r=x.o.responses.find(r=>r.label===b.responseLabel);
    r.status=value;selected(x).status=value;
    // Fixed status before evaluation; this JSON observation is illustrative,
    // not a mutation of the independent IC11 safe-error tuple.
    pair(x,`other-governed-${value}`,o=>{o.evidence.find(e=>e.id===t.evidenceId).status=200;});
  });
  for(const side of ['subject','other'])for(const first of [true,false])test(`R4 ${side} selects evidence ID, not a matching unused row (${first?'first':'last'})`,()=>{
    const x=side==='subject'?subjectError():other(),chosen=selected(x);
    const unused={...chosen,id:'unused-preparation',status:null};
    if(first)x.o.evidence.unshift(unused);else x.o.evidence.push(unused);
    pair(x,`${side}-selection-${first}`,o=>{
      o.evidence.find(e=>e.id==='unused-preparation').status=chosen.status;
      o.evidence.find(e=>e.id===chosen.id).status=chosen.status===409?500:403;
    });
  });
  for(const side of ['subject','other'])test(`R4 ${side} governed error cannot select a non-delivery row`,()=>{
    const x=side==='subject'?subjectError():other(),chosen=selected(x);
    if(side==='other'){chosen.status=409;x.o.responses.find(r=>r.label==='other').status=409;}
    pair(x,`${side}-wrong-phase`,o=>{o.evidence.find(e=>e.id===chosen.id).phase='query';},'delivery.selected-preparation-association');
  });
  for(const [name,change,expected]of [
    ['open-transaction',e=>{e.transactionOpen=true;},'delivery.selected-preparation-association'],
    ['wrong-operation',e=>{e.operationId='unselected-operation';},'delivery.selected-preparation-association'],
    ['after-handoff',(e,t)=>{e.atMs=t.atMs+1;},'delivery.selected-observed-order'],
  ])test(`R4 governed error preserves selected preparation checks: ${name}`,()=>{
    const x=subjectError(),t=handoff(x);
    pair(x,name,o=>change(o.evidence.find(e=>e.id===t.evidenceId),t),expected);
  });
  test('R4 governed error with unknown selected evidence cannot borrow another row',()=>{
    const x=subjectError();pair(x,'unknown-selected-row',o=>{o.transport[0].evidenceId='not-observed';},'delivery.selected-evidence-required');
  });
  test('R4 subject completed handoff retains the selected reception association',()=>{
    const x=subjectError();pair(x,'handoff-other-reception',o=>{o.transport[0].receptionId='unselected-reception';},'delivery.selected-preparation-association');
  });
  for(const [variant,status]of [['uncertain',503],['lost-response',null]])test(`R4 subject preparation remains distinct from ${variant}`,()=>{
    const x=own('IC08',variant),r=x.o.responses.find(r=>r.label==='subject');assert.equal(r.status,status);assert.equal(x.o.transport.length,0);
    // The known synthetic subject preparation is unused: neither alternate
    // error nor lost reply claims its completed governed handoff.
    assert.ok(x.o.evidence.some(e=>e.phase==='delivery'&&e.status===200));
    save(path.join(x.out,'fixed-positive.json'),x.o);
    const result=invoke({assertCase},x.o,x);save(path.join(x.out,'control.json'),result);assert.equal(result.accepted,true,JSON.stringify(result));
  });
}
