import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {preparationTreatment} from './runtime_control.mjs';
import {persistDocument,preparationProfile as profile} from './runtime_helpers.mjs';

/** Actual accepted receipts, preparation producers and C9 transactions. No seeded
 * candidate, relationship or outcome row supplies an expected result. */
export async function preparationIdentityCases(t,{env,intake,client,request,call,check,counts,controlled,record,
  original,document,reservation,prepared,constitution}){
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const first=constitution.result.candidates[0];
  const firstBefore=(await env.admin.query('SELECT * FROM intake_trial.candidate WHERE unit_id=$1',[first.id])).rows[0];
  let incoming;
  const create=async(change=()=>{})=>{
    const doc=structuredClone(document);change(doc);
    return persistDocument({call,check,document:doc,inputs:[incoming],selection:reservation.selection});
  };
  const target=(kind,version=first)=>({kind,unit_id:version.id,version,declaration:'Explicit governed identity and exact immutable version.'});
  const judgment=(kind,version=first)=>({kind,reason:'Recorded synthetic comparison; no name, similarity or digest-only identity decision.',evidence:version});
  const propose=async(p,target,judgment,status=200)=>{
    const r=p.reference;
    const result=await call(`/preparations/${r.id}/revisions/${r.revision}/proposals`,{key:randomUUID(),body:{...profile,unit:'AZ17',target,judgment}});
    check(result,status);return result.body;
  };
  const confirm=async(proposal,key=randomUUID(),status=200)=>{
    const result=await call('/constitutions',{key,body:{...profile,proposal:proposal.result.proposal,mode:'person'}});
    check(result,status);return result.body;
  };
  const relationshipCount=async()=>(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.candidate_relationship')).rows[0].n;
  await t.test('C01 authenticated repetition relates a second actual receipt without another version or merged provenance',async()=>{
    const receipt=await receivedOriginal(request,client,original,{name:'text.txt',treatmentRevision:preparationTreatment});
    const extractor=new ExtractionService(intake);await extractor.dispatch(receipt.work.id);await extractor.accept(receipt.work.id);
    const extraction=await request('/api/intake/extractions/'+receipt.work.id,{client});check(extraction,200);
    incoming={id:'source',kind:'extraction',job_id:receipt.work.id,reference:extraction.body.result.effect};
    const p=await create(),before=await counts();
    const proposed=await propose(p,target('relationship'),judgment('same_version'));
    const result=await confirm(proposed),after=await counts();
    assert.deepEqual({outcome:result.result.outcome,candidates:result.result.candidates,relation:result.result.relationships[0].version,
      candidatesDelta:after.candidates-before.candidates,relationships:await relationshipCount()},
      {outcome:'relationship_recorded',candidates:[],relation:first,candidatesDelta:0,relationships:1});
    const saved=(await env.admin.query('SELECT * FROM intake_trial.candidate_relationship WHERE outcome_id=$1',[result.result.outcome_id])).rows[0];
    const receiptRow=(await env.admin.query('SELECT id FROM intake_trial.receipt WHERE reception_id=$1',[receipt.reception_id])).rows[0];
    assert.equal(saved.provenance.inputs[0].receipt.id,receiptRow.id);
    assert.notEqual(saved.provenance.inputs[0].receipt.id,firstBefore.provenance.inputs[0].receipt.id);
    assert.deepEqual((await env.admin.query('SELECT * FROM intake_trial.candidate WHERE unit_id=$1',[first.id])).rows[0],firstBefore);
    record('c9-repetition',{first,preparation:p.reference,effect:result.effect,counts:after});
  });
  if(!incoming)throw Error('IDENTITY_RECEIPT_PREREQUISITE');
  for(const kind of ['content','condition'])await t.test('C02 '+kind+' incompatibility blocks the claimed version without overwrite',async()=>{
    const p=await create(doc=>{
      if(kind==='content')doc.elements[0].text='For procedure AZ-17, receipt T is required.';
      else doc.conditions[0].text='Only applies during synthetic interval W.';
      doc.differences[0].reason='Explicit '+kind+' correction in this operation, not a rewrite of its original.';
    });
    const before=await counts(),proposed=await propose(p,target('relationship'),judgment('same_version'));
    const result=await confirm(proposed),after=await counts();
    assert.deepEqual({outcome:result.result.outcome,block:result.result.block_kind,candidates:result.result.candidates,
      delta:after.candidates-before.candidates,destination:result.result.blocks[0]?.destination.state ?? null},
      {outcome:'blocked',block:'identity_collision',candidates:[],delta:0,destination:'vacant'});
    const replay=await confirm(proposed);
    assert.deepEqual({operation:replay.operation_id,effect:replay.effect,counts:await counts()},
      {operation:result.operation_id,effect:result.effect,counts:after});
    await propose(p,{kind:'new',declaration:'A fresh wrapper must not evade this item collision.'},
      {kind:'distinct',reason:'Attempt to bypass a blocked item.'},409);
    assert.deepEqual(await counts(),after);
    record('c9-collision',{kind,preparation:p.reference,effect:result.effect,block:result.result.blocks[0]});
  });
  await t.test('C03 possible duplicate remains unresolved; changed explanatory prose is not a new effect slot',async()=>{
    const p=await create(),before=await counts();
    const proposed=await propose(p,target('relationship'),judgment('possible_duplicate'));
    const result=await confirm(proposed),after=await counts();
    assert.deepEqual({outcome:result.result.outcome,block:result.result.block_kind,candidates:after.candidates-before.candidates,
      continuation:result.result.blocks[0].continuation},
      {outcome:'blocked',block:'possible_duplicate',candidates:0,continuation:'awaiting_separate_adjudication'});
    const rewrapped=await propose(p,{...target('relationship'),declaration:'Different prose, same target.'},
      {...judgment('same_version'),reason:'This new wrapper does not adjudicate the previous unresolved disposition.'});
    const replay=await confirm(rewrapped);
    assert.deepEqual({effect:replay.effect,result:replay.result,counts:await counts()},
      {effect:result.effect,result:result.result,counts:after});
  });
  await t.test('C04 equal bytes can support a declared distinct identity; a successor is explicit and never overwrites the predecessor',async()=>{
    const p=await create(),before=await counts();
    const proposed=await propose(p,{kind:'new',declaration:'Independent synthetic identity despite equal bytes.'},
      {kind:'distinct',reason:'Explicit distinction rather than hash identity.'});
    const distinct=await confirm(proposed),newUnit=distinct.result.candidates[0];
    assert.notEqual(newUnit.id,first.id);assert.equal(newUnit.revision,1);
    const next=await create(doc=>{doc.elements[0].text='For procedure AZ-17, receipt V is required.';});
    const successor=await propose(next,target('successor',newUnit),judgment('distinct',newUnit));
    const revised=await confirm(successor);
    assert.deepEqual({id:revised.result.candidates[0].id,revision:revised.result.candidates[0].revision,candidates:(await counts()).candidates-before.candidates},
      {id:newUnit.id,revision:2,candidates:2});
    const historical=(await env.admin.query('SELECT reference FROM intake_trial.candidate WHERE unit_id=$1 ORDER BY version',[newUnit.id])).rows;
    assert.deepEqual(historical.map(r=>r.reference),[newUnit,revised.result.candidates[0]]);
    const stale=await create();const staleProposal=await propose(stale,target('successor',newUnit),judgment('distinct',newUnit));
    const currentCounts=await counts();await confirm(staleProposal,randomUUID(),409);assert.deepEqual(await counts(),currentCounts);
    assert.deepEqual((await env.admin.query('SELECT * FROM intake_trial.candidate WHERE unit_id=$1',[first.id])).rows[0],firstBefore);
  });
  await t.test('C05 matching text is not authenticated comparison evidence; altered exact reference is rejected',async()=>{
    const p=await create(),before=await counts();
    await propose(p,target('relationship'),{kind:'same_version',reason:'The same bytes alone are not a provenance credential.'},409);
    const forged={...first,sha256:'0'.repeat(64)};
    await propose(p,target('relationship',forged),judgment('same_version',forged),409);
    assert.deepEqual(await counts(),before);
  });
}
