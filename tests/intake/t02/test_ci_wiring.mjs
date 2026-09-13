import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readingPassed,readingDependencies} from '../../../ci/reading_result_gate.mjs';
import {parseWorkflow,verifyWiring,verifyCoupledInventory} from '../../../ci/intake_ci_check.mjs';
import {plans} from '../../../ci/intake/t02_plan.mjs';
import {producerFaultGroups} from '../../../ci/intake/reception/producer_fault.mjs';
import {publicEvidence,eligibleEvidence,collectPublicEvidence} from '../../../ci/intake_t02_artifacts.mjs';
const text=fs.readFileSync(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8');
const success=()=>Object.fromEntries(readingDependencies.map(n=>[n,{result:'success'}]));
test('the actual workflow retains every mapped command, scenario and artifact',()=>assert.equal(verifyWiring(parseWorkflow(text)),true));
test('only four explicit successes without workflow cancellation pass',()=>{
  assert.equal(readingPassed(success(),false),true);assert.equal(readingPassed(success(),true),false);
  for(const name of readingDependencies)for(const state of ['failure','cancelled','skipped','unknown',null,undefined]){
    const needs=success();needs[name]={result:state};assert.equal(readingPassed(needs,false),false,name+':'+state);
  }
  for(const name of readingDependencies){const n=success();delete n[name];assert.equal(readingPassed(n,false),false);}
  for(const value of [null,{},[],{unrelated:{result:'success'}}])assert.equal(readingPassed(value,false),false);
});
test('removing, emptying or conditionally skipping any producer cannot satisfy the mapping',()=>{
  for(const name of readingDependencies)for(const change of ['remove','empty','skip','continue']){
    const w=parseWorkflow(text);if(change==='remove')delete w.jobs[name];if(change==='empty')w.jobs[name].steps=[];
    if(change==='skip')w.jobs[name].if='false';if(change==='continue')w.jobs[name]['continue-on-error']=true;
    assert.throws(()=>verifyWiring(w),name+':'+change);
  }
});
test('every actual behavior/recovery scenario has an independent required counterpart',()=>{
  for(const suite of ['behavior','recovery-with-access'])for(let i=0;i<plans[suite].length;i++){
    const copy=structuredClone(plans);copy[suite].splice(i,1);assert.throws(()=>verifyWiring(parseWorkflow(text),copy),suite+':'+i);
  }
  for(const name of Object.keys(producerFaultGroups)){const copy={...producerFaultGroups};delete copy[name];assert.throws(()=>verifyWiring(parseWorkflow(text),plans,copy),name);}
  const coupled=fs.readFileSync(new URL('../../../ci/intake_t02_check.mjs',import.meta.url),'utf8');assert.equal(verifyCoupledInventory(coupled),true);
  for(const item of ["runtime:'test_runtime.mjs',","invitations:'test_invitations.mjs',","reading:'test_authorized_reading.mjs',","administration:'test_administration.mjs',",",journey:'test_whole_journey.mjs'"]){
    assert.ok(coupled.includes(item));assert.throws(()=>verifyCoupledInventory(coupled.replace(item,'')),item);
  }
});
test('removing any foundation command, Chromium install or packaging step is detected',()=>{
  const w=parseWorkflow(text),steps=w.jobs['reading-foundations'].steps;
  for(let i=0;i<steps.length;i++)if(steps[i].run){const copy=structuredClone(w);copy.jobs['reading-foundations'].steps.splice(i,1);assert.throws(()=>verifyWiring(copy),steps[i].run);}
});
test('aggregate dependencies, conditions and producer artifacts cannot silently be shortened',()=>{
  const w=parseWorkflow(text);w.jobs.reading.needs.pop();assert.throws(()=>verifyWiring(w));
  for(const name of readingDependencies){const copy=parseWorkflow(text);copy.jobs[name].steps=copy.jobs[name].steps.filter(s=>s.uses!=='actions/upload-artifact@v4');assert.throws(()=>verifyWiring(copy),name);}
  assert.throws(()=>parseWorkflow(text+'\njobs: {}\n'));
});
test('public evidence excludes credential-bearing members and marks raw versus sanitized copies',()=>{
  const canary='CANARY_DO_NOT_EXPORT_123456';
  const result=publicEvidence({cookie:canary,csrf:canary,token:canary,password:canary,verifier:canary,
    body:{value:canary},headers:{authorization:canary},args:[canary],stdout:'secret '+canary+'\n# tests 3\n# fail 1\n',
    connectionString:'postgresql://u:'+canary+'@localhost/db',path:'/x?'+canary,status:403,actualBytes:17,complete:false,
    nested:{Config:{Env:[canary]},tls:canary,sha256:'a'.repeat(64)}});
  assert.equal(JSON.stringify(result).includes(canary),false);assert.equal(result.actualBytes,17);assert.equal(result.complete,false);
  assert.deepEqual(result.stdout,['# tests 3','# fail 1']);
  for(const p of ['source/code.json','control/anchor.json','runtime/backup-data.json','runtime/admin-response-id.json','runtime/key.pem'])assert.equal(eligibleEvidence(p),false,p);
  assert.equal(eligibleEvidence('intake-t02-id/coupled-journey/diagnostic.json'),true);
});
test('the real exporter retains failed results, coupled observations and an explicit incomplete export',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'intake-ci-artifacts-')),input=path.join(temp,'input'),output=path.join(temp,'output');
  try{
    fs.mkdirSync(path.join(input,'run/coupled-journey'),{recursive:true});
    fs.writeFileSync(path.join(input,'run/manifest.json'),JSON.stringify({completed:false,commands:[{code:1}],failure:{message:'T02_EVIDENCE_EXPORT_INCOMPLETE'}}));
    fs.writeFileSync(path.join(input,'run/coupled-journey/observations.json'),JSON.stringify({complete:true,cookie:'PRIVATE_CANARY',actualBytes:17}));
    const png=Buffer.from('89504e470d0a1a0a00000000','hex');fs.writeFileSync(path.join(input,'run/coupled-journey/synthetic.png'),png);
    fs.writeFileSync(path.join(input,'run/backup-data.json'),JSON.stringify({password:'PRIVATE_CANARY'}));
    assert.equal(await collectPublicEvidence(input,output,'recovery'),true);
    const m=JSON.parse(fs.readFileSync(path.join(output,'PUBLIC-MANIFEST.json')));assert.equal(m.files.length,3);assert.equal(m.omitted.length,1);
    assert.deepEqual(fs.readFileSync(path.join(output,'run/coupled-journey/synthetic.png')),png);
    const failed=JSON.parse(fs.readFileSync(path.join(output,'run/manifest.json')));assert.equal(failed.completed,false);assert.equal(failed.commands[0].code,1);
    assert.equal(fs.readFileSync(path.join(output,'run/coupled-journey/observations.json'),'utf8').includes('PRIVATE_CANARY'),false);
    fs.writeFileSync(path.join(input,'run/incomplete.json'),'{');
    assert.equal(await collectPublicEvidence(input,path.join(temp,'second'),'recovery'),false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'second/PUBLIC-MANIFEST.json'))).complete,false);
  }finally{
    assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('intake-ci-artifacts-'));
    fs.rmSync(temp,{recursive:true});
  }
});
