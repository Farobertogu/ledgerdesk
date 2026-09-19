import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {PREPARATION_BOUNDS as B} from '../../../src/contracts/intake_preparation.ts';
import {preparationProfile as profile,preparationHash as hash,preparationAxis as axis} from './runtime_helpers.mjs';
import {preparationTreatment} from './runtime_control.mjs';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {REFERENCES} from './references/cases.mjs';

/** Fixed synthetic bounds, not a throughput benchmark or a new extractor profile. */
export async function preparationBoundsCases(t,{env,intake,client,request,call,check,counts,record,prepared,document,reservation,
  accepted,storage,application,constitution}){
  const root='/work/output/preparation-bounds';mkdirSync(root,{recursive:true});
  const initial=await counts(),old=prepared.result.preparation,oldQuery=await call(`/preparations/${old.id}/revisions/1`);check(oldQuery,200);
  const historical=(await env.admin.query('SELECT * FROM material_trial.material ORDER BY 1,2,3')).rows;
  const observations=[];
  const note=(name,data)=>{observations.push({name,...data});record(name,data);};
  const capacity=async()=>Number((await env.admin.query('SELECT charged_bytes FROM intake_trial.preparation_capacity')).rows[0].charged_bytes);
  async function stage(bytes,inputs=reservation.inputs,selection=reservation.selection){
    const reserved=await call('/preparation-attempts',{key:randomUUID(),body:{...reservation,inputs,selection,base:null,
      document:{bytes:bytes.length,sha256:hash(bytes)}}});check(reserved,202);
    const attempt=reserved.body.result,reply=await call(`/preparation-attempts/${attempt.attempt_id}/content`,{bytes});
    return {attempt,reply};
  }
  async function finalize(staged){return call(`/preparation-attempts/${staged.attempt.attempt_id}/finalize`,{key:randomUUID(),body:{...profile,
    expected_revision:staged.attempt.preparation.revision,document:staged.reply.body.result.document,differences:[]}});}
  try{
    await t.test('L01 a genuinely accepted larger T03 result is not silently narrowed into the preparation representation',async()=>{
      const original=Buffer.alloc(75000,10),expected={bytes:original.length,sha256:hash(original),elements:75000};
      writeFileSync(root+'/dense-reference.json',JSON.stringify(expected,null,2),{flag:'wx'});
      const receipt=await receivedOriginal(request,client,original,{name:'dense-preparation-limit.txt',treatmentRevision:preparationTreatment});
      const extractor=new ExtractionService(intake);await extractor.dispatch(receipt.work.id);await extractor.accept(receipt.work.id);
      const result=await request('/api/intake/extractions/'+receipt.work.id,{client});check(result,200);
      const content=result.body.result.content;
      assert.deepEqual({outcome:content.outcome,elements:content.elements.length,text:content.elements.map(e=>e.text).join('')},
        {outcome:'completed',elements:expected.elements,text:original.toString()});
      const normalized=(await env.admin.query('SELECT normalized_bytes FROM intake_trial.extraction_output WHERE job_id=$1',[receipt.work.id])).rows[0].normalized_bytes;
      assert.ok(normalized>B.payloadBytes,'The real accepted source must exceed the preparation byte budget.');
      // All entries are explicitly selected. This finite profile cannot represent
      // that closure or its command: refusal is not a truncated success.
      const before=storage.length,reply=await call('/preparation-attempts',{key:randomUUID(),body:{...reservation,
        inputs:[{id:'dense',kind:'extraction',job_id:receipt.work.id,reference:result.body.result.effect}],
        selection:Array.from({length:75000},(_,i)=>({input_id:'dense',element_id:'line-'+(i+1),local_id:'line-'+(i+1)}))}});
      assert.deepEqual({status:reply.status,reads:storage.length,counts:await counts()}, {status:413,reads:before,counts:initial});
      note('larger-accepted-source',{expected,normalizedBytes:normalized,status:reply.status,
        limit:'This operation exceeds command and selected-entry bounds; no claim that it reached the prepared-byte constructor.'});
    });
    await t.test('L02 exact prepared payload byte boundary succeeds and one additional byte is explicitly refused',async()=>{
      const input=oldQuery.body.preparation.payload.inputs[0];
      const localIds=Array.from({length:8},(_,i)=>'piece-'+i),aliases=localIds.map((_,i)=>'input-'+i);
      const sourceLine=REFERENCES['F-T'].lines.find(l=>l.role==='rule');
      const baseElement=(id,i)=>({id,kind:'text',text:'',antecedents:[{input_id:aliases[i],kind:'nonliteral',coordinates:'original:'+sourceLine.bytes.join('..'),
        byte_range:sourceLine.bytes,code_point_range:sourceLine.code_points}]});
      const elements=localIds.map(baseElement),units=[{id:'Bounded',elements:localIds,conditions:[],inseparable_group:null,
        classification:{function:axis('factual'),basis:axis('non_authoritative_reference'),scope:axis('situated')},
        examination:{outcome:'classifiable',reason:'Synthetic authored byte boundary, not an approval or fidelity judgment.'},
        coverage:{components:aliases.map(id=>id+':extraction'),complete_source_claim:false,reason:'Only the explicitly selected source statements.'}}];
      // Only opaque identities and already observed source metadata are bound at
      // runtime. New authored content and the numeric boundary are fixed here,
      // independently of the preparation constructor.
      const expected={profile:'preparation-content/1',inputs:aliases.map(id=>({...input,id})),elements,relations:[],resources:[],resource_associations:[],conditions:[],units,
        components:aliases.flatMap(id=>accepted.content.components.map(c=>({...c,id:id+':'+c.id,incidents:c.incidents.map(x=>id+':'+x)}))),
        incidents:[],inventory:accepted.content.inventory,current_use:'not_evaluated',interruptions:[]};
      let remaining=B.payloadBytes-Buffer.byteLength(JSON.stringify(expected));
      for(const e of elements){const length=Math.min(1048576,remaining);e.text='A'.repeat(length);remaining-=length;}
      assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(expected)),B.payloadBytes);
      const stagedDocument={profile:'preparation-document/1',transformation:'correction',elements,relations:[],conditions:[],units,
        // Eight aliases select one exact historical source. The difference
        // identifies that antecedent once, not eight duplicate references.
        differences:[{before:[aliases[0]],method:'correction',transformation:'redaction',reason:'Deliberately authored synthetic boundary content with exact source attribution.',
          affected:localIds.map(id=>({kind:'element',id}))}]};
      const inputs=aliases.map(id=>({...reservation.inputs[0],id}));
      const selection=aliases.map((input_id,i)=>({input_id,element_id:reservation.selection.find(s=>s.local_id==='rule').element_id,local_id:localIds[i]}));
      const bytes=Buffer.from(JSON.stringify(stagedDocument));assert.ok(bytes.length<B.documentBytes);
      writeFileSync(root+'/payload-bound-reference.json',JSON.stringify({bytes:B.payloadBytes,documentBytes:bytes.length,
        texts:elements.map(e=>({id:e.id,characters:e.text.length,sha256:hash(Buffer.from(e.text))})),inputAliases:aliases},null,2),{flag:'wx'});
      const staged=await stage(bytes,inputs,selection);check(staged.reply,200);const finalized=await finalize(staged);check(finalized,200);
      const target=finalized.body.result.preparation,queried=await call(`/preparations/${target.id}/revisions/1`);check(queried,200);
      assert.deepEqual(queried.body.preparation.payload,expected);
      assert.equal(queried.body.preparation.descriptor.payload.bytes,B.payloadBytes);
      elements.at(-1).text+='A';const tooLarge=Buffer.from(JSON.stringify(stagedDocument));assert.ok(tooLarge.length<B.documentBytes);
      const next=await stage(tooLarge,inputs,selection);check(next.reply,200);
      const before=(await env.admin.query('SELECT count(*)::int n FROM intake_trial.preparation')).rows[0].n,failed=await finalize(next);
      assert.deepEqual({status:failed.status,code:failed.body.code,preparations:(await env.admin.query('SELECT count(*)::int n FROM intake_trial.preparation')).rows[0].n,counts:await counts()},
        {status:413,code:'input_limit',preparations:before,counts:initial});
      note('prepared-byte-bound',{target,bytes:B.payloadBytes,oneOverStatus:failed.status,stagedBytes:bytes.length});
    });
    await t.test('L03 full retained byte pool rejects the next stage without deleting prior work',async()=>{
      const minimum=Buffer.from(JSON.stringify(document)),stages=[];
      while(await capacity()<B.poolBytes){
        const remaining=B.poolBytes-await capacity(),length=Math.min(B.documentBytes,remaining);
        assert.ok(length>=minimum.length,'The independently sized filling stage must remain a valid document.');
        const bytes=Buffer.alloc(length,32);minimum.copy(bytes);const staged=await stage(bytes);check(staged.reply,200);
        stages.push({attempt:staged.attempt.attempt_id,bytes:length,charged:await capacity()});
      }
      assert.equal(await capacity(),B.poolBytes);
      const refused=await stage(minimum);assert.deepEqual({status:refused.reply.status,code:refused.reply.body.code,charged:await capacity(),counts:await counts()},
        {status:429,code:'capacity_unavailable',charged:B.poolBytes,counts:initial});
      const oldResult=await call(`/preparations/${old.id}/revisions/1`);check(oldResult,200);assert.deepEqual(oldResult.body,oldQuery.body);
      note('retained-pool-full',{stages,refused:refused.attempt.attempt_id,charged:await capacity()});
    });
    await t.test('L04 the optional preparation gate closes, while candidates remain outside material reading',async()=>{
      const closed={...intake};delete closed.preparation;const before=storage.length;
      await application.restart(closed);
      try{const denied=await call(`/preparations/${old.id}/revisions/1`);assert.notEqual(denied.status,200);assert.equal(storage.length,before);}
      finally{await application.restart(intake);}
      const positive=await call(`/preparations/${old.id}/revisions/1`);check(positive,200);
      const candidate=constitution.result.candidates[0];
      const material=await request(`/api/v1/material/${candidate.id}/versions/${candidate.revision}`,{client});
      assert.notEqual(material.status,200);assert.deepEqual((await env.admin.query('SELECT * FROM material_trial.material ORDER BY 1,2,3')).rows,historical);
      assert.deepEqual(await counts(),initial);note('closed-gate-candidate-only',{materialStatus:material.status,counts:initial});
    });
  }finally{writeFileSync(root+'/observations.json',JSON.stringify({bounds:B,observations,
    limitations:['Finite synthetic capacity and representation tests, not a physical RSS guarantee or production sizing.']},null,2),{flag:'wx'});}
}
