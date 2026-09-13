import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readingPassed,readingDependencies} from '../../../ci/reading_result_gate.mjs';
import {parseWorkflow,verifyWiring,verifyCoupledInventory,verifyReadingExpressionContexts} from '../../../ci/intake_ci_check.mjs';
import {plans} from '../../../ci/intake/t02_plan.mjs';
import {producerFaultGroups} from '../../../ci/intake/reception/producer_fault.mjs';
import {publicEvidence,eligibleEvidence,collectPublicEvidence} from '../../../ci/intake_t02_artifacts.mjs';
const text=fs.readFileSync(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8');
const expectedProducers=['reading-foundations','intake-reception-behavior','intake-reception-recovery','intake-reception-mutations'];
const success=()=>Object.fromEntries(expectedProducers.map(n=>[n,{result:'success'}]));
const root=fileURLToPath(new URL('../../../',import.meta.url));
function gateProcess(env,script=path.join(root,'ci/reading_result_gate.mjs')){
  const environment={...process.env};delete environment.READING_NEEDS;delete environment.READING_JOB_STATUS;delete environment.READING_CANCELLED;
  for(const [key,value]of Object.entries(env))if(value!==undefined)environment[key]=String(value);
  const result=spawnSync(process.execPath,[script],{cwd:root,env:environment,encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.stderr,'');
  assert.ok([0,1].includes(result.status));
  assert.match(result.stdout,/^(All four mandatory reading producers succeeded\.|Reading verification is incomplete, failed or cancelled\.)\s*$/);
  return result.status;
}
// This is a bounded transport fixture, not the Actions expression engine.
// It consumes the actual step, models its explicit/implicit status condition,
// expands its two supported env references, and executes its real entry point.
function workflowGate(workflow,needs,jobStatus,script){
  // The caller has already admitted/runs the job; this helper only exercises
  // final-step transport. Running cancellation selection has its own model.
  assert.ok(['${{ always() }}','${{ !cancelled() }}'].includes(workflow.jobs.reading.if));
  const step=workflow.jobs.reading.steps.at(-1);
  assert.equal(step.run,'node ci/reading_result_gate.mjs');
  assert.ok(step.if===undefined||['${{ always() }}','${{ success() }}'].includes(step.if));
  if(step.if!=='${{ always() }}'&&jobStatus!=='success')return {invoked:false,exit:null};
  const env={};for(const [key,value]of Object.entries(step.env)){
    if(value==='${{ toJSON(needs) }}')env[key]=JSON.stringify(needs);
    else if(value==='${{ job.status }}')env[key]=jobStatus;
    else {assert.ok(!value.includes('${{'),'Unsupported transport expression');env[key]=value;}
  }
  return {invoked:true,exit:gateProcess(env,script)};
}
// Bounded model of an ALREADY RUNNING aggregate after successful setup.
// Independent platform rule: on global cancellation, re-evaluate running job
// conditions and send cancellation to jobs not retained by a true condition.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation
// The selector and terminal conclusion below are documentary models, not
// observed Actions behavior. Environment expansion and the gate subprocess
// use the actual workflow. Delayed delivery cannot change an earlier env.
function runningCancellationRoute(workflow,{globalCancellationRequested,delivery='before-env',needs=success()}){
  assert.equal(typeof globalCancellationRequested,'boolean');assert.ok(['before-env','after-env'].includes(delivery));
  const condition=workflow.jobs.reading.if;assert.ok(['${{ always() }}','${{ !cancelled() }}'].includes(condition));
  const conditionResult=condition==='${{ always() }}'||!globalCancellationRequested;
  const cancellationSelected=globalCancellationRequested&&!conditionResult;
  const statusAtEnv=cancellationSelected&&delivery==='before-env'?'cancelled':'success';
  const gate=workflowGate(workflow,needs,statusAtEnv);
  assert.equal(gate.invoked,true);
  const modelledJobConclusion=cancellationSelected?'cancelled':gate.exit===0?'success':'failure';
  return {conditionResult,cancellationSelected,statusAtEnv,gateExit:gate.exit,modelledJobConclusion};
}
test('the actual workflow retains every mapped command, scenario and artifact',()=>assert.equal(verifyWiring(parseWorkflow(text)),true));
test('only four explicit producer successes and successful current-job status pass the helper',()=>{
  assert.deepEqual(readingDependencies,expectedProducers);
  assert.equal(readingPassed(success(),'success'),true);assert.equal(readingPassed(success(),'cancelled'),false);
  for(const name of readingDependencies)for(const state of ['failure','cancelled','skipped','unknown',null,undefined]){
    const needs=success();needs[name]={result:state};assert.equal(readingPassed(needs,'success'),false,name+':'+state);
  }
  for(const name of readingDependencies){const n=success();delete n[name];assert.equal(readingPassed(n,'success'),false);}
  for(const value of [null,{},[],{unrelated:{result:'success'}}])assert.equal(readingPassed(value,'success'),false);
});
test('the supported-context profile rejects the published status function in steps.env',()=>{
  assert.equal(verifyReadingExpressionContexts(parseWorkflow(text)),true);
  for(const expression of ['${{ cancelled() }}','${{ CANCELLED () }}','${{ !cancelled() }}','${{ success() }}','${{ failure() }}','${{ always() }}']){
    const copy=parseWorkflow(text);copy.jobs.reading.steps.at(-1).env.READING_CANCELLED=expression;
    assert.throws(()=>verifyReadingExpressionContexts(copy),/steps\.2\.env\.READING_CANCELLED: status function .* is unavailable/);
    copy.jobs.reading.steps.at(-1).if=expression;delete copy.jobs.reading.steps.at(-1).env.READING_CANCELLED;
    assert.equal(verifyReadingExpressionContexts(copy),true,'The same status function is supported in step if');
  }
  const unsupported=parseWorkflow(text);unsupported.jobs.reading.steps.at(-1).env.READING_JOB_STATUS='${{ job.status || \'success\' }}';
  assert.throws(()=>verifyReadingExpressionContexts(unsupported),/unsupported expression/);
});
test('CI-CANCEL-01: global cancellation selects the running aggregate; reverting always loses rejection in the bounded model',t=>{
  const workflow=parseWorkflow(text);
  const failed=success();failed['reading-foundations'].result='failure';
  const missing=success();delete missing['intake-reception-recovery'];
  const ordinary={conditionResult:true,cancellationSelected:false,statusAtEnv:'success',gateExit:0,modelledJobConclusion:'success'};
  const rejectedProducer={...ordinary,gateExit:1,modelledJobConclusion:'failure'};
  const rejectedCancellation={conditionResult:false,cancellationSelected:true,statusAtEnv:'cancelled',gateExit:1,modelledJobConclusion:'cancelled'};
  const rows=[
    {name:'normal-four-success',input:{globalCancellationRequested:false},expected:ordinary},
    {name:'failed-producer-still-runs',input:{globalCancellationRequested:false,needs:failed},expected:rejectedProducer},
    {name:'missing-producer-still-runs',input:{globalCancellationRequested:false,needs:missing},expected:rejectedProducer},
    {name:'global-cancel-before-env',input:{globalCancellationRequested:true},expected:rejectedCancellation},
    {name:'global-cancel-after-env',input:{globalCancellationRequested:true,delivery:'after-env'},expected:{...rejectedCancellation,statusAtEnv:'success',gateExit:0}}
  ];
  for(const row of rows){
    const actual=runningCancellationRoute(workflow,row.input);assert.deepEqual(actual,row.expected,row.name);
    t.diagnostic(JSON.stringify({case:row.name,globalCancellationRequested:row.input.globalCancellationRequested,delivery:row.input.delivery??'before-env',
      evidenceClass:'documentary running-job model plus actual gate process',expected:row.expected,actual}));
  }
  const reverted=structuredClone(workflow);reverted.jobs.reading.if='${{ always() }}';
  assert.equal(verifyReadingExpressionContexts(reverted),true,'The reversion is valid syntax, not an expression-context fault');
  const positive=runningCancellationRoute(reverted,{globalCancellationRequested:false});assert.deepEqual(positive,ordinary);
  const counterexample=runningCancellationRoute(reverted,{globalCancellationRequested:true});assert.deepEqual(counterexample,ordinary);
  assert.throws(()=>assert.deepEqual(counterexample,rejectedCancellation),{code:'ERR_ASSERTION'});
  assert.throws(()=>verifyWiring(reverted),/running aggregate must be cancellable/);
  t.diagnostic(JSON.stringify({case:'reverted-always-positive',globalCancellationRequested:false,actual:positive}));
  t.diagnostic(JSON.stringify({case:'reverted-always-global-cancel',globalCancellationRequested:true,
    evidenceClass:'documentary running-job model plus actual gate process',expected:rejectedCancellation,actual:counterexample,expectedRejectionAssertion:'failed as intended'}));
});
test('the actual workflow transport and gate reject every non-success producer and current-job status',t=>{
  const workflow=parseWorkflow(text),cases=[{label:'four successes',needs:success(),status:'success',exit:0}];
  for(const name of expectedProducers)for(const state of ['failure','cancelled','skipped','unknown',null,undefined]){
    const needs=success();needs[name]={result:state};cases.push({label:name+':'+state,needs,status:'success',exit:1});
  }
  for(const name of expectedProducers){const needs=success();delete needs[name];cases.push({label:'missing '+name,needs,status:'success',exit:1});}
  for(const status of ['cancelled','failure','skipped','unknown','',undefined,null,'false','true','Success','success '])
    cases.push({label:'four successes with current status '+status,needs:success(),status,exit:1});
  for(const needs of [null,{},[],false,'success',{unrelated:{result:'success'}}])cases.push({label:'malformed needs '+JSON.stringify(needs),needs,status:'success',exit:1});
  for(const row of cases){
    const observed=workflowGate(workflow,row.needs,row.status);
    assert.deepEqual(observed,{invoked:true,exit:row.exit},row.label);
    t.diagnostic(JSON.stringify({case:row.label,expectedExit:row.exit,...observed}));
  }
});
test('the real gate rejects malformed or absent transport fields and the obsolete cancellation flag',()=>{
  assert.equal(gateProcess({READING_NEEDS:JSON.stringify(success()),READING_JOB_STATUS:'success'}),0);
  for(const needs of ['{','undefined','',undefined])assert.equal(gateProcess({READING_NEEDS:needs,READING_JOB_STATUS:'success'}),1);
  assert.equal(gateProcess({READING_NEEDS:JSON.stringify(success()),READING_CANCELLED:'false'}),1);
  assert.equal(gateProcess({READING_NEEDS:JSON.stringify(success()),READING_JOB_STATUS:'${{ job.status }}'}),1);
});
test('removing always restores implicit success and loses the required cancellation gate execution',()=>{
  const workflow=parseWorkflow(text);
  assert.deepEqual(workflowGate(workflow,success(),'cancelled'),{invoked:true,exit:1});
  delete workflow.jobs.reading.steps.at(-1).if;
  assert.deepEqual(workflowGate(workflow,success(),'cancelled'),{invoked:false,exit:null});
  assert.throws(()=>verifyWiring(workflow),/explicit always gate/);
});
test('freezing the transported status to success is rejected even with an intact gate executable',()=>{
  const workflow=parseWorkflow(text);
  assert.deepEqual(workflowGate(workflow,success(),'success'),{invoked:true,exit:0});
  assert.deepEqual(workflowGate(workflow,success(),'cancelled'),{invoked:true,exit:1});
  workflow.jobs.reading.steps.at(-1).env.READING_JOB_STATUS='success';
  assert.deepEqual(workflowGate(workflow,success(),'cancelled'),{invoked:true,exit:0});
  assert.throws(()=>verifyWiring(workflow),/explicit always gate/);
});
test('a directed gate mutation loses cancellation rejection with all four producers still successful',t=>{
  const original=fs.readFileSync(path.join(root,'ci/reading_result_gate.mjs'),'utf8'),target="jobStatus==='success'&&";
  assert.equal(original.split(target).length,2,'Exactly the current-job guard is targeted');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reading-gate-mutation-'));
  try{
    const script=path.join(temp,'reading_result_gate.mjs');fs.writeFileSync(script,original.replace(target,''));
    const workflow=parseWorkflow(text);
    assert.deepEqual(workflowGate(workflow,success(),'success',script),{invoked:true,exit:0});
    assert.deepEqual(workflowGate(workflow,success(),'cancelled'),{invoked:true,exit:1});
    const observed=workflowGate(workflow,success(),'cancelled',script);
    assert.deepEqual(observed,{invoked:true,exit:0});
    assert.throws(()=>assert.deepEqual(observed,{invoked:true,exit:1}),{code:'ERR_ASSERTION'});
    const failed=success();failed['reading-foundations'].result='failure';
    assert.deepEqual(workflowGate(workflow,failed,'success',script),{invoked:true,exit:1});
    t.diagnostic('remove-current-job-status: positive exit 0; cancelled clean exit 1; cancelled mutant exit 0; failed-producer mutant exit 1');
  }finally{
    assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('reading-gate-mutation-'));
    fs.rmSync(temp,{recursive:true});
  }
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
