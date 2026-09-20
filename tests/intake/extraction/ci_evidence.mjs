import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {extractionPublicSummary,exportExtractionEvidence} from '../../../ci/intake_extraction_artifacts.mjs';
import {parseWorkflow,verifyWiring} from '../../../ci/intake_ci_check.mjs';
import {extractionGuards,qualifyExtractionGuard} from '../../../ci/intake_extraction_guard_checks.mjs';

const runId='intake-extraction-2026-09-15T12-34-56-123Z-1234abcd';
const manifest=()=>({runId,group:'extraction',completed:false,commands:[{file:'001-command.json',code:1,reason:null}],resources:[{removed:true}]});
test('closed public projection cannot export private bodies, metadata, commands or failures',()=>{
  const secret='PRIVATE_EXTRACTION_CANARY_7683981',m=manifest();
  Object.assign(m,{body:secret,data:secret,raw_base64:secret,unknown:secret,failure:{message:secret},sources:[{path:secret}],resources:[{removed:true,name:secret}]});
  Object.assign(m.commands[0],{args:[secret],stdout:secret,headers:{cookie:secret}});
  const out=extractionPublicSummary(m,'a'.repeat(64),[{stdout:secret+'\n# tests 3\n# pass 2\n# fail 1\n# tests 3 '+secret,stderr:secret}]);
  assert.equal(JSON.stringify(out).includes(secret),false);
  assert.deepEqual({completed:out.completed,exit:out.commands[0].exitCode,counts:out.counts},
    {completed:false,exit:1,counts:[{observation:1,tests:3,pass:2,fail:1}]});
});
test('actual exporter preserves a failed result, reads no private sidecar and fails closed on missing evidence',async()=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'extraction-export-'));
  try{
    const input=path.join(temporary,'input'),folder=path.join(input,runId),output=path.join(temporary,'output');
    await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest()));
    await fs.writeFile(path.join(folder,'001-command.json'),JSON.stringify({stdout:'# tests 1\n# fail 1\n',body:'PRIVATE_CANARY'}));
    await fs.writeFile(path.join(folder,'raw-worker.json'),'INVALID_PRIVATE_BYTES');
    assert.equal(await exportExtractionEvidence(input,output),true);
    const names=await fs.readdir(output);assert.deepEqual(names.sort(),['PUBLIC-MANIFEST.json',runId+'.json'].sort());
    assert.equal(JSON.parse(await fs.readFile(path.join(output,runId+'.json'))).completed,false);
    await fs.unlink(path.join(folder,'001-command.json'));
    const second=path.join(temporary,'missing');assert.equal(await exportExtractionEvidence(input,second),false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(second,'PUBLIC-MANIFEST.json'))).rows,[{runId,exported:false}]);
  }finally{
    assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('extraction-export-'));
    await fs.rm(temporary,{recursive:true});
  }
});
test('a command reference cannot make the exporter open another private object',()=>{
  const m=manifest();m.commands[0].file='../raw.json';assert.throws(()=>extractionPublicSummary(m,'a'.repeat(64)),/PUBLIC_COMMAND_REFERENCE/);
});
test('the retained jobs and workspace jobs coexist, and all six extraction groups require every execution step',async()=>{
  const workflow=parseWorkflow(await fs.readFile(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(workflow.jobs).sort(),['check','reading','reading-foundations','intake-reception-behavior',
    'intake-reception-recovery','intake-reception-mutations','intake-extraction','intake-extraction-recovery',
    'intake-extraction-admission','intake-extraction-boundaries','intake-extraction-resource-guards','intake-extraction-format-guards',
    'intake-preparation-behavior','intake-preparation-admission','intake-preparation-guards',
    'intake-workspace-behavior','intake-workspace-admission','db','app'].sort());
  assert.equal(verifyWiring(workflow),true);
  const unqualified=structuredClone(workflow);
  const memory=unqualified.jobs['intake-extraction'].steps.find(step=>step.run==='npm run test:intake:extraction:worker -- --qualified-memory');
  assert.ok(memory,'The existing worker job must require current-image memory');
  memory.run='npm run test:intake:extraction:worker';
  assert.throws(()=>verifyWiring(unqualified),/extraction obligation list/,'Removing qualification is not a successful worker result');
  for(const name of ['intake-extraction','intake-extraction-recovery','intake-extraction-admission','intake-extraction-boundaries','intake-extraction-resource-guards','intake-extraction-format-guards'])for(let i=0;i<workflow.jobs[name].steps.length;i++)if(workflow.jobs[name].steps[i].run){
    const copy=structuredClone(workflow);copy.jobs[name].steps.splice(i,1);assert.throws(()=>verifyWiring(copy));
  }
});
test('a failed mutation needs its own assertion, exact source fault and cleanup, not merely nonzero exit',()=>{
  const c=extractionGuards.resources[1],m=manifest();m.failure={message:'T02_RUNTIME_FAILED'};
  const s={files:[{fault:c.name}]};
  const lines=c.tests.map((name,i)=>"    not ok "+(i+1)+" - "+name+"\n      ---\n      code: 'ERR_ASSERTION'\n      ...").join('\n');
  const logs=lines+'\nACCESS_PG_CLEANED\nINTAKE_T02_RUNTIME_CLEANED\n# cancelled 0';
  assert.equal(qualifyExtractionGuard(c,m,s,logs),true);
  for(const bad of [logs.replace(c.tests[1],'different property'),logs.replaceAll("code: 'ERR_ASSERTION'","code: 'ETIMEDOUT'"),
    logs+'\ntestTimeoutFailure',logs+'\nExtraction capacity occupied',logs.replace('INTAKE_T02_RUNTIME_CLEANED',''),logs.replace('# cancelled 0','# cancelled 1')])
    assert.throws(()=>qualifyExtractionGuard(c,m,s,bad));
  assert.throws(()=>qualifyExtractionGuard(c,m,{files:[]},logs));
  assert.throws(()=>qualifyExtractionGuard(c,{...m,resources:[{removed:false}]},s,logs));
});
