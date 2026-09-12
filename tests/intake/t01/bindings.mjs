import test from 'node:test';
import assert from 'node:assert/strict';
import {BINDINGS,bindingConsistent,bindingInventoryComplete,operationRequirements} from '../../../src/contracts/intake_bindings.ts';
import {pair,selector,rows} from './binding_fixtures.mjs';
import './binding_regressions.mjs';
test('Every public route and both worker ports have an explicit effect contract',()=>{assert.equal(bindingInventoryComplete(),true);assert.deepEqual(Object.keys(BINDINGS).sort(),Object.keys(rows).sort());});
for(const operation of Object.keys(rows))test('Binding '+operation+' resolves exact references, never a blanket permission',()=>{
 const {current,binding}=pair(operation);assert.equal(bindingConsistent(binding,current),true);
 for(const key of ['catalog','entry','permission','support','scope','route','treatment','admission']){
  assert.equal(bindingConsistent(binding,{...current,[key]:{...current[key],revision:2}}),false,key);
 }
 assert.equal(bindingConsistent({...binding,effect:'publish'},current),false);
 assert.equal(bindingConsistent({...binding,authorized:true},current),false);
 assert.equal(bindingConsistent({...binding,faculty:'grant'},current),false);
 assert.equal(bindingConsistent({...binding,purpose:'other'},current),false);
 for(const key of ['objects','transitions','affected','surfaces','residues'])assert.equal(bindingConsistent({...binding,signature:{...binding.signature,[key]:['widened']}},current),false,key);
 assert.equal(bindingConsistent({...binding,view_partitions:[selector('other-partition')]},current),false);
 for(const key of ['predecessor','authorization','comparison','load','phase','work','resolution','result'])if(binding[key]){const b=structuredClone(binding);delete b[key];assert.equal(bindingConsistent(b,current),false,key);}
});
test('Constitution modes stay distinct; a prior act cannot manufacture preparation or reading authority',()=>{
 const {current,binding}=pair('constitute','authorized_consequence');assert.ok(bindingConsistent(binding,current));
 const wrong={...binding,operation:'original'};assert.equal(bindingConsistent(wrong,current),false);
 assert.deepEqual(BINDINGS.constitute.modes,['person','authorized_consequence']);
 assert.deepEqual(BINDINGS.reserve_preparation.modes,['person']);
 assert.deepEqual(BINDINGS.original.reads,['whole-original']);
});
test('A known constitution is queried with current query authority, not rerun after faculty withdrawal',()=>{
 assert.deepEqual(operationRequirements('constitute','known'),{effect:'none',binding:'lookup_operation',disclose:'current-query-only',preserve:'historical-effect'});
 assert.equal(operationRequirements('constitute','new').binding,'constitute');
 assert.equal(operationRequirements('constitute','uncertain').effect,'none');
 assert.equal(operationRequirements('constitute','incompatible').preserve,'original-intention');
 assert.throws(()=>operationRequirements('arbitrary','new'));
});
