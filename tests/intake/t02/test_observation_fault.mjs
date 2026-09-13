import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {observationFaultCopy} from '../../../ci/intake/reception/observation_fault.mjs';

test('observation faults change exactly one actual terminal anchor, never other source',()=>{
  const target='src/server/intake/terminal.ts',text=readFileSync(new URL('../../../'+target,import.meta.url),'utf8');
  for(const name of ['drop-fallback','destroy-after-observation']){
    const changed=observationFaultCopy(target,text,name);assert.notEqual(changed,text);
    assert.equal(observationFaultCopy('src/server/intake/service.ts',text,name),text);
    assert.throws(()=>observationFaultCopy(target,'',name),/OBSERVATION_FAULT_ANCHOR/);
    assert.throws(()=>observationFaultCopy(target,text+text,name),/OBSERVATION_FAULT_ANCHOR/);
  }
  assert.throws(()=>observationFaultCopy(target,text,'arbitrary'),/OBSERVATION_FAULT_SCOPE/);
});
