import test from 'node:test';
import assert from 'node:assert/strict';
import {BINDINGS,BINDING_DECLARATION,PROCESSING_RESOLUTION,bindingConsistent,bindingRequirements} from '../../../src/contracts/intake_bindings.ts';
import {ref,resource} from './fixtures.mjs';
import {pair,loads,workers,resolution} from './binding_fixtures.mjs';

test('Independent approved loading modes cannot be widened by agreeing generated fixtures',()=>{
 // Literal B1 section 3.4 expectation, independent of registry and current.
 for(const op of loads){
  assert.deepEqual(BINDINGS[op].modes,['person']);
  const {binding,current}=pair(op);binding.mode='authorized_consequence';binding.load.mode='authorized_consequence';binding.signature.autonomy='authorized_consequence';
  current.load.mode='authorized_consequence';current.signature.autonomy='authorized_consequence';
  assert.equal(bindingConsistent(binding,current),false);
 }
});
test('Worker acceptance cannot be relabeled as a second personal loading act',()=>{
 for(const op of workers){
  assert.equal(BINDINGS[op].basis,'intake-extraction-resolution/1');assert.deepEqual(BINDINGS[op].modes,[]);
  const {binding,current}=pair(op);binding.kind='personal_load_phase';binding.basis='CARGAR_MATERIAL';binding.mode='person';
  assert.equal(bindingConsistent(binding,current),false);
 }
});
test('All eight processing dimensions have independent expectations even when current agrees',()=>{
 assert.deepEqual(PROCESSING_RESOLUTION,resolution);
 for(const op of workers){
  for(const key of ['objects','transitions','affected','surfaces','autonomy','limits','residues']){
   const {binding,current}=pair(op);const bad=key==='autonomy'?'authorized_consequence':key==='limits'?ref('unbounded'):['expanded'];
   binding.signature[key]=bad;current.signature[key]=structuredClone(bad);assert.equal(bindingConsistent(binding,current),false,key);
  }
  const {binding,current}=pair(op);binding.signature.purpose='other';current.signature.purpose='other';assert.equal(bindingConsistent(binding,current),false,'purpose');
  for(const field of ['profile','operation','scope','adoption','sources']){
   const {binding,current}=pair(op);binding.resolution[field]=field==='sources'?[]:'unresolved';current.resolution[field]=binding.resolution[field];assert.equal(bindingConsistent(binding,current),false,field);
  }
 }
});
test('One exact human intention survives loading phases without claiming completed processing',()=>{
 const observations=loads.map(op=>pair(op).binding);
 assert.ok(observations.every(b=>b.load.person.id==='P-17'&&b.load.intention.id==='I-17'&&b.load.receipt_effect.id==='E-receipt-17'));
 assert.deepEqual(observations.map(b=>b.effect),['reserve-one-original','stage-exact-original-attempt','commit-one-receipt-and-job','advance-attempt-after-authoritative-absence','stop-uncompleted-dependent-work']);
 for(const op of loads){const {binding,current}=pair(op);delete binding.load.original;delete current.load.original;assert.equal(bindingConsistent(binding,current),false,'generic reservation cannot choose later');}
 const {binding,current}=pair('reserve_reception');binding.load.original.bytes=1048577;current.load.original.bytes=1048577;assert.equal(bindingConsistent(binding,current),false,'original limit is not the larger output limit');
});
test('Exact actor intention original profile destination and attempt match independent current facts',()=>{
 for(const op of [...loads,...workers]){
  for(const key of ['person','intention','original','format','configuration','destination','session','receipt_effect']){
   const {binding,current}=pair(op);binding.load[key]=key==='format'?'csv-utf8/1':key==='original'?resource('O-18',1):ref('other');assert.equal(bindingConsistent(binding,current),false,op+':'+key);
  }
  for(const key of ['executor','reservation','attempt','predecessor']){const {binding,current}=pair(op);binding.phase[key]=key==='attempt'?4:ref('other');assert.equal(bindingConsistent(binding,current),false,key);}
 }
});
test('A service executor never becomes the human loader',()=>{
 for(const revision of [1,2]){const {binding,current}=pair('finalize_reception');binding.phase.executor=ref('P-17',revision);current.phase.executor=ref('P-17',revision);assert.equal(bindingConsistent(binding,current),false);}
 const {binding,current}=pair('dispatch_extraction');binding.work.worker=ref('P-17');current.work.worker=ref('P-17');binding.signature.affected[2]='P-17';current.signature.affected[2]='P-17';assert.equal(bindingConsistent(binding,current),false);
});
test('Receipt job and result acceptance keep distinct identities and exact worker lineage',()=>{
 for(const op of workers){
  const good=pair(op);assert.equal(good.binding.load.receipt_effect.id,'E-receipt-17');assert.equal(good.binding.work.acceptance_effect.id,'E-accept-17');assert.ok(bindingConsistent(good.binding,good.current));
  for(const key of ['id','generation','originating_act','receipt','request','plan','worker','acceptance_effect','expires_at','session_dependency']){
   const {binding,current}=pair(op);binding.work[key]=key==='generation'?2:key==='expires_at'?3000:key==='session_dependency'?'origin_session':ref('other');assert.equal(bindingConsistent(binding,current),false,key);
  }
  for(const revision of [1,2]){const {binding,current}=pair(op);binding.work.acceptance_effect=ref('E-receipt-17',revision);current.work.acceptance_effect=ref('E-receipt-17',revision);assert.equal(bindingConsistent(binding,current),false);}
 }
 const {binding,current}=pair('accept_extraction_result');binding.result=resource('other-output');assert.equal(bindingConsistent(binding,current),false);
});
test('A technical predecessor alone never authorizes processing or a consequence',()=>{
 for(const op of workers){const {binding,current}=pair(op);delete binding.work.request;delete current.work.request;assert.equal(bindingConsistent(binding,current),false);}
 const good=pair('constitute','authorized_consequence');assert.ok(bindingConsistent(good.binding,good.current));
 const {binding,current}=pair('constitute','authorized_consequence');delete binding.authorization;delete current.authorization;binding.predecessor=ref('technical-event');current.predecessor=ref('technical-event');assert.equal(bindingConsistent(binding,current),false);
});
test('Shared preparation and constitution consumers retain their conditions',()=>{
 for(const [op,mode] of [['constitute','person'],['constitute','authorized_consequence'],['reserve_preparation','person'],['upload_preparation','authorized_consequence'],['finalize_preparation','person']]){const {binding,current}=pair(op,mode);assert.ok(bindingConsistent(binding,current));}
});
test('Session dependency and current processing authority remain separate obligations',()=>{
 const {binding,current}=pair('dispatch_extraction');assert.ok(bindingConsistent(binding,current));
 const r=bindingRequirements(binding,'new');assert.ok(!r.checks.includes('current-origin-session'));
 for(const c of ['current-exercise-authority','current-support','current-treatment','current-processing-authority','current-service-assignment','current-job-generation','job-expiry','before-protected-read','before-effect'])assert.ok(r.checks.includes(c));
 assert.deepEqual({disconnect:r.sessionDisconnect,history:r.history,temporal:r.temporalConformity},{disconnect:'not-revocation',history:'preserve-receipt',temporal:'not-established'});
 binding.work.session_dependency='origin_session';assert.ok(bindingRequirements(binding,'new').checks.includes('current-origin-session'));
 delete binding.work.session_dependency;assert.throws(()=>bindingRequirements(binding,'new'));
 for(const op of loads)assert.ok(bindingRequirements(pair(op).binding,'new').checks.includes('current-origin-session'));
});
test('Known effects require query not creation and never redispatch or reactivate',()=>{
 for(const op of ['finalize_reception',...workers,'constitute'])for(const disposition of ['known','incompatible','uncertain']){
  const r=bindingRequirements(pair(op).binding,disposition);assert.deepEqual({effect:r.effect,checks:r.checks,dispatch:r.dispatch,reactivate:r.reactivate},{effect:'none',checks:['current-query-authority'],dispatch:false,reactivate:false});
 }
});
test('A new session or retry key cannot substitute the admitted logical effect',()=>{
 const {binding,current}=pair('finalize_reception');binding.load.session=ref('new-session');current.load.session=ref('new-session');assert.ok(bindingConsistent(binding,current));
 assert.equal(binding.load.receipt_effect.id,'E-receipt-17');assert.equal(binding.load.intention.id,'I-17');
 assert.equal(BINDING_DECLARATION({...binding,client_key:'new-key'}),false);
 binding.load.receipt_effect=ref('another-effect');assert.equal(bindingConsistent(binding,current),false);
});
test('Old profile rejection is not the semantic test',()=>{
 const {binding,current}=pair('finalize_reception');assert.ok(bindingConsistent(binding,current));assert.equal(bindingConsistent({...binding,profile:'intake-binding/1'},current),false);assert.equal(bindingConsistent(binding,undefined),false);
});
test('A processing operation cannot borrow the generic branch to omit processing obligations',()=>{
 const {binding}=pair('profiles');binding.operation='dispatch_extraction';
 assert.equal(BINDING_DECLARATION(binding),false);assert.throws(()=>bindingRequirements(binding,'new'));
 const personal=pair('finalize_reception').binding;personal.operation='accept_extraction_result';assert.equal(BINDING_DECLARATION(personal),false);
});
