import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {compareTiming,TIMING_PROTOCOL} from '../../reading/timing_comparison.mjs';
import {persistDocument,preparationProfile as profile,constituteDocument} from './runtime_helpers.mjs';
import {preparationTreatment,preparationContext} from './runtime_control.mjs';
import {recipientEmail} from '../../access/journey_environment.mjs';
import {administration} from '../t02/recovery_cases.mjs';

export async function preparationDisclosureCases(t,{env,intake,client,request,call,check,counts,controlled,record,
  original,document,reservation,constitution,storage,login}){
  const root='/work/output/preparation-disclosure';mkdirSync(root,{recursive:true});
  writeFileSync(root+'/reference.json',JSON.stringify({protocol:TIMING_PROTOCOL,classes:['hidden','absent'],
    expectedStatus:404,expectedTargetReads:0,positive:'Actual C9 relationship to the admitted first candidate',
    shiftedControlMs:100,scope:'Finite synthetic comparison classes, not universal timing indistinguishability'},null,2),{flag:'wx'});
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const otherTreatment={id:preparationTreatment.id,revision:2,sha256:'2'.repeat(64)};let hidden;
  await env.admin.query(`INSERT INTO intake_control.treatment SELECT id,2,$1,scope_ref,purpose_ref,fields,actions,
    receiver,storage,processor,response_destination,disposition_ref,expires_at FROM intake_control.treatment WHERE id=$2 AND revision=1`,
    [otherTreatment.sha256,preparationTreatment.id]);
  await env.admin.query('SELECT intake_control.set_treatment($1,2,true)',[preparationTreatment.id]);
  try{
    const receipt=await receivedOriginal(request,client,original,{name:'hidden-comparison.txt',treatmentRevision:otherTreatment});
    const extractor=new ExtractionService(intake);await extractor.dispatch(receipt.work.id);await extractor.accept(receipt.work.id);
    const extraction=await request('/api/intake/extractions/'+receipt.work.id,{client});check(extraction,200);
    const selected=document.elements.map(e=>{
      const expected=e.antecedents[0].byte_range,actual=extraction.body.result.content.elements.find(x=>x.original_range?.bytes[0]===expected[0]);
      assert.deepEqual(actual.original_range.bytes,expected);return {input_id:'source',element_id:actual.id,local_id:e.id};
    });
    const p=await persistDocument({call,check,document:structuredClone(document),inputs:[{id:'source',kind:'extraction',job_id:receipt.work.id,reference:extraction.body.result.effect}],
      selection:selected,context:{...preparationContext,treatment_revision:otherTreatment}});
    const result=await constituteDocument({call,check,prepared:p,unit:'AZ17'});
    hidden={preparation:p.reference,candidate:result.constitution.result.candidates[0]};
  }finally{await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[preparationTreatment.id]);}
  const incoming=await persistDocument({call,check,document:structuredClone(document),inputs:reservation.inputs,selection:reservation.selection});
  const absent={id:randomUUID(),revision:1,sha256:'9'.repeat(64)};
  const compare=target=>call(`/preparations/${incoming.reference.id}/revisions/1/proposals`,{key:randomUUID(),body:{...profile,unit:'AZ17',
    target:{kind:'relationship',unit_id:target.id,version:target,declaration:'Explicit exact-version comparison.'},
    judgment:{kind:'same_version',evidence:target,reason:'A governed comparison, not identity inferred from a digest.'}}});
  const targetReads=()=>storage.filter(e=>e.origin==='prepared-record-boundary'&&e.preparationId===hidden.preparation.id ||
    e.origin==='preparation-comparison-boundary'&&e.unitId===hidden.candidate.id);
  await t.test('DISC01 hidden and absent comparison targets have identical responses and no target materialization',async()=>{
    const before=await counts(),reads=targetReads().length;
    const hiddenResponse=await compare(hidden.candidate),absentResponse=await compare(absent);
    const projection=r=>({status:r.status,headers:r.headers,body:r.body,bytes:r.bytes.toString('base64')});
    assert.equal(hiddenResponse.status,404);assert.deepEqual(projection(hiddenResponse),projection(absentResponse));
    assert.deepEqual({counts:await counts(),reads:targetReads().length},{counts:before,reads});
    record('comparison-neutrality',{hidden,absent,projection:projection(hiddenResponse),before,targetReads:0});
  });
  await t.test('DISC02 the declared timing protocol measures comparison classes with a detected shifted control',async()=>{
    const before=await counts(),reads=targetReads().length,samples={hidden:[],absent:[]};
    let random=TIMING_PROTOCOL.seed;
    for(let round=-TIMING_PROTOCOL.warmupRounds;round<TIMING_PROTOCOL.rounds;round++){
      random=(Math.imul(random,1664525)+1013904223)>>>0;
      const order=random&1?['hidden','absent']:['absent','hidden'];
      for(const kind of order){const result=await compare(kind==='hidden'?hidden.candidate:absent);check(result,404);if(round>=0)samples[kind].push(result.elapsedMs);}
    }
    const result=compareTiming(samples),shifted=compareTiming({hidden:samples.hidden,absent:samples.absent.map(n=>n+100)});
    const observed={samples,result,shifted,counts:await counts(),targetReads:targetReads().length-reads};
    writeFileSync(root+'/timing.json',JSON.stringify(observed,null,2),{flag:'wx'});record('comparison-timing',observed);
    assert.deepEqual({detected:result.signalDetected,shiftedDetected:shifted.signalDetected,counts:observed.counts,targetReads:observed.targetReads},
      {detected:false,shiftedDetected:true,counts:before,targetReads:0});
  });
  await t.test('DISC03 an admitted comparison actually yields a relationship, not blanket denial',async()=>{
    const first=constitution.result.candidates[0],proposed=await compare(first);check(proposed,200);
    const before=await counts(),result=await call('/constitutions',{key:randomUUID(),body:{...profile,proposal:proposed.body.result.proposal,mode:'person'}});check(result,200);
    const after=await counts();assert.deepEqual({outcome:result.body.result.outcome,candidates:after.candidates-before.candidates,
      version:result.body.result.relationships[0].version},{outcome:'relationship_recorded',candidates:0,version:first});
    record('comparison-positive',{proposal:proposed.body.result.proposal,result:result.body.result});
  });
  await t.test('DISC04 historical query denial retains effects; a new session uses the same stable principal',async()=>{
    const before=await counts(),permission=(await env.admin.query("SELECT permission_id FROM intake_control.catalog_entry WHERE operation='lookup_operation'")).rows[0].permission_id;
    const grants=(await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id=$2 AND NOT withdrawn RETURNING id',[controlled.account.id,permission])).rows;
    assert.ok(grants.length);const reads=storage.length;
    try{const denied=await call('/operations/lookup',{body:{...profile,operation_id:constitution.operation_id}});
      assert.deepEqual({status:denied.status,counts:await counts(),reads:storage.length},{status:404,counts:before,reads});
    }finally{for(const g of grants)await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=false WHERE id=$1',[g.id]);}
    await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
    const other=await login(recipientEmail);assert.notEqual(other.cookie,client.cookie);
    const recovered=await request('/api/intake/operations/lookup',{client:other,headers:{accept:'application/vnd.ledgerdesk.intake-preparation+json'},
      body:{...profile,operation_id:constitution.operation_id}});check(recovered,200);
    assert.deepEqual({result:recovered.body.result,counts:await counts()},{result:constitution.result,counts:before});
    record('new-session-known-effect',{effect:recovered.body.effect,counts:before});
  });
  await t.test('DISC05 personal loading authority does not grant preparation or proposal',async()=>{
    const grants=(await env.admin.query(`UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND NOT withdrawn
      AND permission_id IN ('intake_prepare','intake_prepared_read','intake_difference_read','intake_resource_read') RETURNING id`,[controlled.account.id])).rows;
    // Command reception is separately admitted and observed. The denied
    // operation must not read a retained original, preparation or comparison.
    const protectedReads=()=>storage.filter(e=>e.origin!=='preparation-receiver-boundary').length;
    const sourceReads=async()=>(await administration('observe-extraction',{participant:'outputs'})).events
      .filter(e=>e.kind==='protected-normalized-read').length;
    const before=await counts(),reads=protectedReads(),normalized=await sourceReads();
    try{
      const reserve=await call('/preparation-attempts',{key:randomUUID(),body:reservation});
      const proposal=await compare(constitution.result.candidates[0]);
      assert.deepEqual({reserve:reserve.status,proposal:proposal.status,counts:await counts(),reads:protectedReads(),normalized:await sourceReads()},
        {reserve:404,proposal:404,counts:before,reads,normalized});
    }finally{for(const g of grants)await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=false WHERE id=$1',[g.id]);}
    const positive=await call(`/preparations/${incoming.reference.id}/revisions/1`);check(positive,200);
    assert.ok(protectedReads()>reads);
    const sourcePositive=await call('/preparation-attempts',{key:randomUUID(),body:reservation});check(sourcePositive,202);
    assert.ok(await sourceReads()>normalized,'The restored faculty must reach the same protected normalized-source port.');
    record('loader-not-preparer',{deniedBeforeProtectedReads:true,counts:before,normalizedReadsBefore:normalized,
      normalizedReadsAfterPositive:await sourceReads()});
  });
}
