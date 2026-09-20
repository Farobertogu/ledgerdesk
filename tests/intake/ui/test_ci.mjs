import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseWorkflow,verifyWiring} from '../../../ci/intake_ci_check.mjs';
import {readingPassed,readingDependencies} from '../../../ci/reading_result_gate.mjs';
import {workspaceGuard} from '../../../ci/intake_workspace_guards.mjs';
import {qualifyExtractionGuard} from '../../../ci/intake_extraction_guard_checks.mjs';

test('both workspace jobs and every finite command are mandatory alongside retained producers',async()=>{
  const workflow=parseWorkflow(await fs.readFile(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8'));
  assert.equal(verifyWiring(workflow),true);
  const needs=Object.fromEntries(readingDependencies.map(name=>[name,{result:'success'}]));
  assert.equal(readingPassed(needs,'success'),true);
  for(const name of ['intake-workspace-behavior','intake-workspace-admission']){
    for(const result of ['failure','cancelled','skipped'])assert.equal(readingPassed({...needs,[name]:{result}},'success'),false);
    const absent=structuredClone(needs);delete absent[name];assert.equal(readingPassed(absent,'success'),false);
    for(let i=0;i<workflow.jobs[name].steps.length;i++){
      const step=workflow.jobs[name].steps[i];if(!step.run)continue;
      const removed=structuredClone(workflow);removed.jobs[name].steps.splice(i,1);assert.throws(()=>verifyWiring(removed));
      if(step.run==='node ci/intake_extraction_artifacts.mjs')continue;
      const skipped=structuredClone(workflow);skipped.jobs[name].steps[i].if='false';assert.throws(()=>verifyWiring(skipped));
      const advisory=structuredClone(workflow);advisory.jobs[name].steps[i]['continue-on-error']=true;assert.throws(()=>verifyWiring(advisory));
    }
  }
});

test('the response-adoption mutation requires its own assertion, exact fault and cleanup',()=>{
  const manifest={completed:false,failure:{message:'T02_RUNTIME_FAILED'},resources:[{removed:true}]};
  const source={files:[{fault:workspaceGuard.name}]};
  const log=`    not ok 1 - ${workspaceGuard.tests[0]}\n      code: 'ERR_ASSERTION'\nACCESS_PG_CLEANED\nINTAKE_T02_RUNTIME_CLEANED\n# cancelled 0`;
  assert.equal(qualifyExtractionGuard(workspaceGuard,manifest,source,log),true);
  for(const changed of [log.replace('ERR_ASSERTION','ETIMEDOUT'),log.replace(workspaceGuard.tests[0],'unrelated check'),
    log.replace('INTAKE_T02_RUNTIME_CLEANED',''),log+'\ntestTimeoutFailure'])
    assert.throws(()=>qualifyExtractionGuard(workspaceGuard,manifest,source,changed));
  assert.throws(()=>qualifyExtractionGuard(workspaceGuard,manifest,{files:[{fault:'another-fault'}]},log));
});
