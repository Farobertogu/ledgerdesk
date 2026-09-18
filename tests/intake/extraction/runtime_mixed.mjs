import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';

export async function extractionMixedCases(t,{env,intake,client,request}){
  await extractionControl(env);const text='Exact text from a real bounded worker.\n';
  const expected=[
    {component:'damaged-cell',execution:'failed',coverage:'unknown',cause:'unreadable',code:'invalid_cell_address'},
    {component:'visual-region',execution:'not_attempted',coverage:'none',cause:'route_unoffered',code:'unsupported_profile'},
    {component:'notes-stage',execution:'failed',coverage:'unknown',cause:'technical_failure',code:'worker_timeout'}];
  writeFileSync('/work/output/mixed-reference.json',JSON.stringify({text,expected,
    scope:'Independent expected tuple for a labeled instrumented component branch; not claims about parser discovery.'},null,2),{flag:'wx'});
  await t.test('MIX01 actual persistence and query preserve three distinct controlled causes without claiming the unknown remainder examined',async()=>{
    const receipt=await receivedOriginal(request,client,Buffer.from(text),{name:'instrumented-components.txt'});
    const service=new ExtractionService(intake);await service.dispatch(receipt.work.id);const accepted=await service.accept(receipt.work.id);
    const q=await request('/api/intake/extractions/'+receipt.work.id,{client});assert.equal(q.status,200);
    const content=q.body.result.content,actual=content.incidents.map(i=>{
      const c=content.components.find(c=>c.id===i.component);
      return{component:i.component,execution:c?.execution,coverage:c?.coverage,cause:i.cause,code:i.code};});
    const stored=(await env.admin.query('SELECT id,effect_id,outcome FROM intake_trial.extraction_result WHERE job_id=$1',[receipt.work.id])).rows;
    const observation={accepted,stored,body:q.body,actual};
    writeFileSync('/work/output/extraction-mixed.json',JSON.stringify(observation,null,2),{flag:'wx'});
    assert.deepEqual({actual,text:content.elements.map(e=>e.text).join(''),inventory:content.inventory,
      use:content.current_use,stored},{actual:expected,text,inventory:'unknown',use:'not_evaluated',
      stored:[{id:accepted.resultId,effect_id:accepted.effectId,outcome:'partial'}]});
    assert.deepEqual(content.components[0],{id:'extraction',execution:'completed',coverage:'complete',fidelity:'unchecked',
      limitations:['syntactic-profile-only','raw-properties-retained-not-interpreted','semantic-fidelity-unverified'],incidents:[]});
  });
}
