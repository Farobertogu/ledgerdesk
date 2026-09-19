import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';
import {preparationControl,preparationContext,preparationTreatment} from './runtime_control.mjs';
import {REFERENCES} from './references/cases.mjs';
import {assertPreparedText} from './references/assertions.mjs';

const profile={profile:'intake/1',representation:'intake-preparation/1'};
const accept='application/vnd.ledgerdesk.intake-preparation+json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const axis=value=>({value,reason:null});

export async function preparationRuntimeCases(t,{env,intake,client,request,diagnostics,storage,admissions,setBarrier,login,clientCalls,requestEvents,
  application,digestSession,post,master,flow,messages}){
  const started=performance.now(),observations=[];
  const controlled=await preparationControl(env,{allFormats:process.env.LEDGERDESK_PREPARATION_CASES==='formats'});
  const call=(path,options={})=>request('/api/intake'+path,{client,...options,headers:{accept,...options.headers}});
  const extraction=new ExtractionService(intake);
  let receipt,accepted,original,document,reservation,reserved,staged,prepared,proposed,constitution;
  const check=(reply,status)=>assert.equal(reply.status,status,JSON.stringify({body:reply.body,diagnostics:diagnostics.slice(-3)}));
  const counts=async()=>(await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_trial.candidate) AS candidates,
    (SELECT count(*)::int FROM intake_trial.constitution_outcome) AS outcomes,
    (SELECT count(*)::int FROM intake_trial.editorial_effect WHERE operation='constitute') AS effects`)).rows[0];
  const record=(name,data)=>observations.push({name,...data});
  try{
    await t.test('P01 actual accepted text precedes preparation; original and source are independently anchored',async()=>{
      const reference=REFERENCES['F-T']; original=readFileSync(new URL('../t01/fixtures/text.txt',import.meta.url));
      assert.deepEqual({bytes:original.length,sha256:hash(original),text:original.toString('utf8')},
        {bytes:reference.bytes,sha256:reference.sha256,text:reference.text});
      receipt=await receivedOriginal(request,client,original,{treatmentRevision:preparationTreatment});
      await extraction.dispatch(receipt.work.id);await extraction.accept(receipt.work.id);
      const result=await request('/api/intake/extractions/'+receipt.work.id,{client});check(result,200);
      accepted=result.body.result;
      assert.equal(accepted.content.elements.map(e=>e.text).join(''),reference.text);
      const selected=reference.lines.filter(line=>['rule','exception'].includes(line.role));
      const selection=selected.map(line=>{
        const element=accepted.content.elements.find(e=>e.original_range?.bytes[0]===line.bytes[0]);
        assert.ok(element);assert.deepEqual({text:element.text,range:element.original_range},{text:line.text,range:{bytes:line.bytes,code_points:line.code_points}});
        return {input_id:'source',element_id:element.id,local_id:line.role};
      });
      document={profile:'preparation-document/1',transformation:'correction',
        elements:selected.map(line=>({id:line.role,kind:'text',text:REFERENCES['F-P'][line.role],
          antecedents:[{input_id:'source',kind:'bytes',coordinates:'original:'+line.bytes.join('..'),byte_range:line.bytes,code_point_range:line.code_points}]})),
        relations:[{id:'rule-condition',...REFERENCES['F-P'].relation,origin:'prepared'}],
        conditions:[{id:'condition-Z',text:'Under condition Z, receipt R replaces receipt Q.',scope:'AZ-17'}],
        units:[{id:'AZ17',elements:['rule','exception'],conditions:['condition-Z'],inseparable_group:null,
          classification:{function:axis('normative'),basis:axis('domain_adoption'),scope:axis('reusable_with_conditions')},
          examination:{outcome:'classifiable',reason:'Explicit synthetic preparation judgment; no approval.'},
          coverage:{components:['source:extraction'],complete_source_claim:false,reason:'Selected AZ-17 statements, not the entire source.'}}],
        differences:[{before:['source'],method:'correction',transformation:'cleanup',
          reason:'Remove terminal CRLF from the selected statements and record their preparation-established dependency.',
          affected:[{kind:'element',id:'rule'},{kind:'element',id:'exception'},{kind:'relation',id:'rule-condition'},{kind:'condition',id:'condition-Z'}]}]};
      const bytes=Buffer.from(JSON.stringify(document));
      reservation={...profile,inputs:[{id:'source',kind:'extraction',job_id:receipt.work.id,reference:accepted.effect}],base:null,
        selection,document:{bytes:bytes.length,sha256:hash(bytes)},context:preparationContext};
      assert.deepEqual(await counts(),{candidates:0,outcomes:0,effects:0});
      record('accepted-source',{original:receipt.original,accepted:accepted.effect,selection,document:reservation.document});
    });
    if(!reservation)throw Error('PREPARATION_SOURCE_PREREQUISITE');
    await t.test('P02 withdrawn preparation treatment prevents protected source reads and reservation; positive remains useful',async()=>{
      const reads=async()=>(await administration('observe-extraction',{participant:'outputs'})).events.filter(e=>e.kind==='protected-normalized-read').length;
      const before=await reads();
      await env.admin.query('SELECT intake_control.set_treatment($1,1,false)',[preparationTreatment.id]);
      try{
        const negative=await call('/preparation-attempts',{body:reservation,key:randomUUID()});
        assert.deepEqual({status:negative.status,reads:await reads(),attempts:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.preparation_attempt')).rows[0].n},
          {status:404,reads:before,attempts:0});
      }finally{await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[preparationTreatment.id]);}
      const positive=await call('/preparation-attempts',{body:reservation,key:randomUUID()});check(positive,202);reserved=positive.body;
      assert.equal(reserved.result.state,'reserved');assert.equal(reserved.result.preparation.revision,1);
      assert.ok(await reads()>before,'Positive must reach the protected source body.');
      record('reservation',{operation:reserved.operation_id,target:reserved.result.preparation});
    });
    if(!reserved)throw Error('PREPARATION_RESERVATION_PREREQUISITE');
    await t.test('P03 exact staged bytes become immutable preparation and associated differences, not a candidate',async()=>{
      const upload=await call(`/preparation-attempts/${reserved.result.attempt_id}/content`,{bytes:Buffer.from(JSON.stringify(document))});check(upload,200);staged=upload.body;
      const finalized=await call(`/preparation-attempts/${reserved.result.attempt_id}/finalize`,{key:randomUUID(),
        body:{...profile,expected_revision:1,document:staged.result.document,differences:[]}});check(finalized,200);prepared=finalized.body;
      const target=prepared.result.preparation;
      assert.deepEqual({id:target.id,revision:target.revision},reserved.result.preparation);
      const queried=await call(`/preparations/${target.id}/revisions/${target.revision}`);check(queried,200);
      const observed=queried.body.preparation;
      assertPreparedText({preparation:observed.reference,...observed.payload},
        {preparation:target,inputs:{original:'source'},elements:{rule:'rule',exception:'exception'}},'az17');
      const saved=(await env.admin.query('SELECT * FROM intake_trial.preparation WHERE id=$1 AND revision=1',[target.id])).rows[0];
      assert.equal(hash(saved.payload),saved.payload_sha256);assert.equal(saved.bytes,saved.payload.length);
      assert.deepEqual(JSON.parse(saved.payload.toString()).elements,document.elements);
      assert.equal(observed.differences.length,1);assert.deepEqual(observed.differences[0].body.after,{id:target.id,revision:1,payload:observed.descriptor.payload});
      assert.deepEqual(await counts(),{candidates:0,outcomes:0,effects:0});
      record('preparation',{reference:target,bytes:saved.bytes,difference:observed.differences[0].reference});
    });
    if(!prepared)throw Error('PREPARATION_PERSISTENCE_PREREQUISITE');
    await t.test('P04 actual proposal inspects the exact closed item before constitution',async()=>{
      const r=prepared.result.preparation;
      const result=await call(`/preparations/${r.id}/revisions/1/proposals`,{key:randomUUID(),body:{...profile,unit:'AZ17',
        target:{kind:'new',declaration:'A distinct synthetic AZ-17 knowledge unit.'},judgment:{kind:'distinct',reason:'First explicit item in this empty synthetic domain.'}}});
      check(result,200);proposed=result.body;
      assert.deepEqual(proposed.inspection.proposal.preparation,r);
      assert.deepEqual(proposed.inspection.proposal.selected,['rule','exception']);
      assert.deepEqual(await counts(),{candidates:0,outcomes:0,effects:0});
      record('proposal',{reference:proposed.result.proposal});
    });
    if(!proposed)throw Error('PREPARATION_PROPOSAL_PREREQUISITE');
    await t.test('P05 response loss after durable constitution recovers one effect without current constitution faculty',async()=>{
      let activeRequest,cut;
      setBarrier(async(label,event)=>{
        if(label!=='before_handoff'||event.route!=='constitute')return;
        cut=(await env.admin.query(`SELECT e.status,a.state,a.xact_start FROM intake_trial.evidence e
          JOIN pg_stat_activity a ON a.pid=e.backend_pid WHERE e.id=$1`,[event.evidenceId])).rows[0];
        assert.deepEqual(cut,{status:200,state:'idle',xact_start:null});
        assert.deepEqual(await counts(),{candidates:1,outcomes:1,effects:1});
        activeRequest.destroy(Error('EXPECTED_PREPARATION_REPLY_LOSS'));
      });
      const key=randomUUID(),body={...profile,proposal:proposed.result.proposal,mode:'person'};
      try{await assert.rejects(call('/constitutions',{key,body,onRequest:r=>{activeRequest=r;}}),/EXPECTED_PREPARATION_REPLY_LOSS/);}
      finally{setBarrier(async()=>{});}
      assert.ok(cut,'The physical client loss must happen after the actual commit.');
      // Wait for the interrupted server observation, not a repeated constitution attempt.
      const until=Date.now()+2000;let closed=0;
      while(Date.now()<until){closed=(await env.admin.query(`SELECT count(*)::int AS n FROM intake_trial.transport t
        JOIN intake_trial.evidence e ON e.id=t.evidence_id WHERE e.route='constitute' AND t.outcome='interrupted'`)).rows[0].n;if(closed)break;await delay(10);}
      assert.equal(closed,1);
      await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
      const recovered=await call('/constitutions',{key,body});check(recovered,200);constitution=recovered.body;
      assert.equal(constitution.state,'known_effect');assert.equal(constitution.result.outcome,'constituted');
      assert.deepEqual(await counts(),{candidates:1,outcomes:1,effects:1});
      const protectedReads=()=>storage.filter(e=>e.origin!=='preparation-receiver-boundary').length;
      const readCount=protectedReads(),incompatible=await call('/constitutions',{key,
        body:{...body,proposal:{...body.proposal,sha256:'0'.repeat(64)}}});
      assert.deepEqual({status:incompatible.status,counts:await counts(),protectedReads:protectedReads()},
        {status:409,counts:{candidates:1,outcomes:1,effects:1},protectedReads:readCount});
      const queried=await call('/operations/lookup',{body:{...profile,operation_id:constitution.operation_id}});check(queried,200);
      assert.deepEqual(queried.body.result,constitution.result);
      const saved=(await env.admin.query('SELECT editorial_state,preparation_id,preparation_revision,conditions FROM intake_trial.candidate')).rows;
      assert.deepEqual(saved,[{editorial_state:'candidate',preparation_id:prepared.result.preparation.id,preparation_revision:1,
        conditions:[{id:'condition-Z',text:'Under condition Z, receipt R replaces receipt Q.',scope:'AZ-17'}]}]);
      record('constitution',{operation:constitution.operation_id,candidate:constitution.result.candidates[0],cut,counts:await counts()});
    });
    if(!constitution)throw Error('PREPARATION_CONSTITUTION_PREREQUISITE');
    if(process.env.LEDGERDESK_PREPARATION_CASES==='fidelity'){
      const {preparationFidelityCases}=await import('./runtime_fidelity.mjs');
      await preparationFidelityCases(t,{env,call,check,prepared,counts,storage,record});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='formats'){
      const {preparationFormatCases}=await import('./runtime_formats.mjs');
      await preparationFormatCases(t,{env,intake,client,request,call,check,counts,controlled,record});
    }
    if(['resources','recovery'].includes(process.env.LEDGERDESK_PREPARATION_CASES)){
      const {preparationResourceCases}=await import('./runtime_resources.mjs');
      await preparationResourceCases(t,{env,intake,client,request,call,check,counts,controlled,storage,record});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='mixed'){
      const {preparationMixedCases}=await import('./runtime_mixed.mjs');
      await preparationMixedCases(t,{env,intake,client,request,call,check,counts,controlled,record});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='identity'){
      const {preparationIdentityCases}=await import('./runtime_identity.mjs');
      await preparationIdentityCases(t,{env,intake,client,request,call,check,counts,controlled,record,
        original,document,reservation,prepared,constitution});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='concurrency'){
      const {preparationConcurrencyCases}=await import('./runtime_concurrency.mjs');
      await preparationConcurrencyCases(t,{env,client,request,call,check,counts,controlled,record,
        document,reservation,setBarrier,login});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='prior-act'){
      const {preparationPriorActCases}=await import('./runtime_prior_act.mjs');
      await preparationPriorActCases(t,{env,intake,call,check,counts,controlled,record,document,reservation,storage});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='temporal'){
      const {preparationTemporalCases}=await import('./runtime_temporal.mjs');
      await preparationTemporalCases(t,{env,call,check,controlled,record,document,reservation,prepared,setBarrier,clientCalls});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='ordering'){
      const {preparationOrderingCases}=await import('./runtime_ordering.mjs');
      await preparationOrderingCases(t,{env,call,check,controlled,record,document,reservation,prepared,setBarrier,clientCalls,storage});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='units'){
      const {preparationUnitCases}=await import('./runtime_units.mjs');
      await preparationUnitCases(t,{env,intake,client,request,call,check,counts,controlled,record});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='recovery'){
      const {preparationRecoveryCases}=await import('./runtime_recovery.mjs');
      await preparationRecoveryCases(t,{env,intake,client,request,call,check,prepared,constitution,controlled,record,
        application,digestSession,post,master,flow,messages});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='disclosure'){
      const {preparationDisclosureCases}=await import('./runtime_disclosure.mjs');
      await preparationDisclosureCases(t,{env,intake,client,request,call,check,counts,controlled,record,
        original,document,reservation,constitution,storage,login});
    }
    if(process.env.LEDGERDESK_PREPARATION_CASES==='bounds'){
      const {preparationBoundsCases}=await import('./runtime_bounds.mjs');
      await preparationBoundsCases(t,{env,intake,client,request,call,check,counts,record,prepared,document,reservation,
        accepted,storage,application,constitution});
    }
  }finally{
    setBarrier(async()=>{});
    writeFileSync('/work/output/preparation-first-slice.json',JSON.stringify({profile:'preparation-first-slice-observation/1',
      elapsedMs:performance.now()-started,observations,diagnostics,storage,admissions,
      scope:'Actual bounded Linux HTTP/SQL/extraction slice; no hosted execution or full T04/R24 acceptance.'},null,2));
  }
}
