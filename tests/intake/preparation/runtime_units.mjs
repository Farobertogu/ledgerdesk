import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {persistDocument,preparationProfile as profile,preparationAxis as axis} from './runtime_helpers.mjs';
import {preparationTreatment} from './runtime_control.mjs';

const literals=[['rule','Rule A requires Q.\n'],['condition','Condition Z replaces Q with R.\n'],
  ['independent','Independent fact B.\n'],['unresolved','Unresolved note C.\n'],['divide','Divide section D.\n'],
  ['transform','Transform note E.\n'],['block','Blocked note F.\n'],['reject','Rejected note G.\n']];

export async function preparationUnitCases(t,{env,intake,client,request,call,check,counts,controlled,record}){
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const root='/work/output/preparation-units',original=Buffer.from(literals.map(([,text])=>text).join(''));
  mkdirSync(root,{recursive:true});let offset=0;
  const reference=literals.map(([id,text])=>{const bytes=[offset,offset+Buffer.byteLength(text)];offset=bytes[1];return {id,text,bytes};});
  writeFileSync(root+'/reference.json',JSON.stringify({reference,sha256:createHash('sha256').update(original).digest('hex'),
    effects:{divide:0,transform:0,block:0,reject:0,rule_and_condition:1,independent:1,unresolved:1},
    unresolvedIsNotApproved:true},null,2),{flag:'wx'});
  const receipt=await receivedOriginal(request,client,original,{name:'independent-units.txt',treatmentRevision:preparationTreatment});
  const extractor=new ExtractionService(intake);await extractor.dispatch(receipt.work.id);await extractor.accept(receipt.work.id);
  const extracted=await request('/api/intake/extractions/'+receipt.work.id,{client});check(extracted,200);
  const accepted=extracted.body.result,selection=reference.map(r=>{
    const element=accepted.content.elements.find(e=>e.original_range?.bytes[0]===r.bytes[0]);
    assert.deepEqual({text:element?.text,bytes:element?.original_range?.bytes},{text:r.text,bytes:r.bytes});
    return {input_id:'source',element_id:element.id,local_id:r.id};
  });
  const document={profile:'preparation-document/1',transformation:'correction',
    elements:reference.map(r=>({id:r.id,kind:'text',text:r.text,
      antecedents:[{input_id:'source',kind:'bytes',coordinates:'original:'+r.bytes.join('..'),byte_range:r.bytes,code_point_range:r.bytes}]})),
    relations:[{id:'A-Z',from:'rule',to:'condition',role:'indispensable',scope:'A under Z',origin:'prepared'}],
    conditions:[{id:'Z',text:'Condition Z replaces Q with R.',scope:'A'}],
    units:reference.map(r=>({id:r.id,elements:[r.id],conditions:['rule','condition'].includes(r.id)?['Z']:[],
      inseparable_group:['rule','condition'].includes(r.id)?'A-Z':null,
      classification:{function:r.id==='unresolved'?{value:null,reason:'The applicable function needs later examination.'}:axis('factual'),
        basis:axis('non_authoritative_reference'),scope:axis('situated')},
      examination:{outcome:['divide','transform','block','reject'].includes(r.id)?r.id:'classifiable',
        reason:'Attributed synthetic preparation examination, not approval.'},
      coverage:{components:['source:extraction'],complete_source_claim:false,reason:'One explicitly selected part, not the entire source.'}})),
    differences:[{before:['source'],method:'correction',transformation:'cleanup',reason:'State the indispensable A/Z relationship without changing the literal source.',
      affected:[{kind:'relation',id:'A-Z'},{kind:'condition',id:'Z'}]}]};
  const inputs=[{id:'source',kind:'extraction',job_id:receipt.work.id,reference:accepted.effect}];
  const prepared=await persistDocument({call,check,document,inputs,selection});
  const propose=async unit=>{
    const r=prepared.reference,response=await call(`/preparations/${r.id}/revisions/${r.revision}/proposals`,{key:randomUUID(),body:{...profile,unit,
      target:{kind:'new',declaration:'A separately examined synthetic logical item.'},judgment:{kind:'distinct',reason:'Explicit independent preparation judgment.'}}});
    check(response,200);return response.body;
  };
  const confirm=p=>call('/constitutions',{key:randomUUID(),body:{...profile,proposal:p.result.proposal,mode:'person'}});
  await t.test('U01 zero candidates for the four nonconstitutable examination outcomes, with reasons retained',async()=>{
    const before=await counts(),results=[];
    for(const unit of ['divide','transform','block','reject']){
      const p=await propose(unit),reply=await confirm(p);results.push({unit,status:reply.status});
      assert.equal(p.inspection.preparation.payload.units.find(u=>u.id===unit).examination.outcome,unit);
    }
    assert.deepEqual({results,counts:await counts()},{results:['divide','transform','block','reject'].map(unit=>({unit,status:409})),counts:before});
    record('unit-nonconstitutable',{results,before});
  });
  await t.test('U02 an inseparable group is one exact candidate across either selected member',async()=>{
    const before=await counts(),a=await propose('rule'),b=await propose('condition');
    assert.deepEqual(a.inspection.proposal.selected,['rule','condition']);
    assert.equal(a.inspection.proposal.item,'group:A-Z');assert.equal(b.inspection.proposal.slot_id,a.inspection.proposal.slot_id);
    const first=await confirm(a),second=await confirm(b);check(first,200);check(second,200);
    const after=await counts();assert.deepEqual({candidates:after.candidates-before.candidates,effects:after.effects-before.effects,outcomes:after.outcomes-before.outcomes},
      {candidates:1,effects:1,outcomes:1});assert.deepEqual(first.body.effect,second.body.effect);
    const candidate=(await env.admin.query('SELECT conditions,editorial_state FROM intake_trial.candidate WHERE unit_id=$1',[first.body.result.candidates[0].id])).rows[0];
    assert.deepEqual(candidate,{conditions:document.conditions,editorial_state:'candidate'});
    record('inseparable-candidate',{first:first.body,second:second.body,candidate});
  });
  await t.test('U03 multiple independent confirmations preserve unresolved classification without approval or invented defaults',async()=>{
    const before=await counts(),results=[];
    for(const unit of ['independent','unresolved']){
      const p=await propose(unit),reply=await confirm(p);check(reply,200);results.push({unit,result:reply.body.result});
    }
    const after=await counts();assert.deepEqual({candidates:after.candidates-before.candidates,effects:after.effects-before.effects}, {candidates:2,effects:2});
    const query=await call(`/preparations/${prepared.reference.id}/revisions/1`);check(query,200);
    assert.deepEqual(query.body.preparation.payload.units.find(u=>u.id==='unresolved').classification.function,
      {value:null,reason:'The applicable function needs later examination.'});
    const candidates=(await env.admin.query('SELECT unit_key,editorial_state FROM intake_trial.candidate WHERE preparation_id=$1 ORDER BY unit_key',[prepared.reference.id])).rows;
    assert.deepEqual(candidates,[{unit_key:'group:A-Z',editorial_state:'candidate'}, {unit_key:'unit:independent',editorial_state:'candidate'},
      {unit_key:'unit:unresolved',editorial_state:'candidate'}]);
    assert.equal(query.body.preparation.payload.units.every(u=>u.coverage.complete_source_claim===false),true);
    record('independent-unresolved-candidates',{results,candidates});
  });
  await t.test('U04 selecting only one member of the retained inseparable preparation cannot manufacture a split',async()=>{
    const partial=structuredClone(document);partial.elements=partial.elements.filter(e=>e.id==='rule');
    partial.elements[0].antecedents[0].input_id='base:source';partial.relations=[];partial.conditions=[];
    partial.units=[{...partial.units[0],conditions:[],inseparable_group:null,coverage:{...partial.units[0].coverage,components:['base:source:extraction']}}];
    partial.differences=[];partial.transformation='exact_selection';const before=await counts();
    await persistDocument({call,check,document:partial,inputs:[{id:'base',kind:'preparation',reference:prepared.reference}],
      selection:[{input_id:'base',element_id:'rule',local_id:'rule'}],base:prepared.reference,expectedStatus:409});
    assert.deepEqual(await counts(),before);record('forbidden-split',{status:409,counts:before});
  });
}
