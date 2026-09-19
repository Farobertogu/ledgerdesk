import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseWorkflow,verifyWiring} from '../../../ci/intake_ci_check.mjs';
import {preparationGuards} from '../../../ci/intake_preparation_guards.mjs';
import {qualifyExtractionGuard} from '../../../ci/intake_extraction_guard_checks.mjs';

test('the three preparation jobs are required without losing a retained producer',async()=>{
  const workflow=parseWorkflow(await fs.readFile(new URL('../../../.github/workflows/ci.yml',import.meta.url),'utf8'));
  assert.equal(verifyWiring(workflow),true);
  for(const name of ['intake-preparation-behavior','intake-preparation-admission','intake-preparation-guards']){
    assert.ok(workflow.jobs.reading.needs.includes(name));
    for(let i=0;i<workflow.jobs[name].steps.length;i++){
      const step=workflow.jobs[name].steps[i];if(!step.run)continue;
      const removed=structuredClone(workflow);removed.jobs[name].steps.splice(i,1);assert.throws(()=>verifyWiring(removed));
      if(step.run==='node ci/intake_extraction_artifacts.mjs')continue;
      const skipped=structuredClone(workflow);skipped.jobs[name].steps[i].if='false';assert.throws(()=>verifyWiring(skipped));
    }
  }
});

test('all eight construction negatives require their own assertion and exact captured fault',()=>{
  assert.deepEqual(preparationGuards.map(c=>c.name),['drop-retained-context','drop-retained-limitation',
    'swap-resource-at-birth','swap-resource-at-consume','flatten-component-causes','ignore-c9-conditions','drop-item-lock','drop-prior-target']);
  for(const c of preparationGuards){
    const manifest={completed:false,failure:{message:'T02_RUNTIME_FAILED'},resources:[{removed:true}]};
    const source={files:[{fault:c.name}]};
    const logs=c.tests.map(n=>`    not ok 1 - ${n}\n      code: 'ERR_ASSERTION'`).join('\n')+
      '\nACCESS_PG_CLEANED\nINTAKE_T02_RUNTIME_CLEANED\n# cancelled 0';
    assert.equal(qualifyExtractionGuard(c,manifest,source,logs),true);
    for(const changed of [logs.replace('ERR_ASSERTION','ETIMEDOUT'),logs.replace(c.tests[0],'unrelated property'),
      logs.replace('INTAKE_T02_RUNTIME_CLEANED',''),logs+'\ntestTimeoutFailure'])
      assert.throws(()=>qualifyExtractionGuard(c,manifest,source,changed));
    assert.throws(()=>qualifyExtractionGuard(c,manifest,{files:[{fault:'different-source'}]},logs));
  }
});
