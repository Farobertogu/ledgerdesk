import assert from 'node:assert/strict';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {preparationTreatment} from './runtime_control.mjs';
import {persistDocument,constituteDocument,preparationAxis as axis} from './runtime_helpers.mjs';
import {assertScopedCoverage} from './references/assertions.mjs';

/** Controlled A-D observations reuse the preserved T03 instrumented branch.
 * The E edge is a separately attributable preparation statement, not extraction. */
export async function preparationMixedCases(t,{env,intake,client,request,call,check,counts,controlled,record}){
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const ids={A:'source:extraction',B:'source:damaged-cell',C:'source:visual-region',D:'source:notes-stage',E:'statement:remainder'};
  const incidentIds={B:'source:damaged-cell-incident',C:'source:visual-region-incident',D:'source:notes-stage-incident'};
  for(const variant of ['known','unknown','unknown-with-known-interruption']){
    await t.test('M-'+variant+' preserves component causes through actual preparation and candidate retention',async()=>{
      const known=variant==='known',withEdge=variant!=='unknown';
      const text=known?'Known component source.\n':'Unknown component source.\n';
      const receipt=await receivedOriginal(request,client,Buffer.from(text),{name:'mixed-'+variant+'.txt',treatmentRevision:preparationTreatment});
      const service=new ExtractionService(intake);await service.dispatch(receipt.work.id);await service.accept(receipt.work.id);
      const queried=await request('/api/intake/extractions/'+receipt.work.id,{client});check(queried,200);
      const accepted=queried.body.result;
      assert.deepEqual(accepted.content.incidents.map(i=>[i.component,i.cause]),[
        ['damaged-cell','unreadable'],['visual-region','route_unoffered'],['notes-stage','technical_failure']]);
      assert.equal(accepted.content.inventory,known?'known':'unknown');
      const document={profile:'preparation-document/1',transformation:withEdge?'correction':'exact_selection',
        elements:[{id:'A',kind:'text',text,antecedents:[{input_id:'source',kind:'bytes',coordinates:'original:0..'+Buffer.byteLength(text),
          byte_range:[0,Buffer.byteLength(text)],code_point_range:[0,[...text].length]}]}],relations:[],conditions:[],
        units:[{id:'Mixed',elements:['A'],conditions:[],inseparable_group:null,
          classification:{function:axis('factual'),basis:axis('non_authoritative_reference'),scope:axis('situated')},
          examination:{outcome:'classifiable',reason:'Only the actual text component is selected.'},
          coverage:{components:[ids.A],complete_source_claim:false,reason:'No claim that failed or unattempted components were examined.'}}],
        differences:withEdge?[{before:['source'],method:'correction',transformation:'cleanup',
          affected:[{kind:'coverage',id:'remainder'}],reason:'Record the independently stated unattempted E interruption without reclassifying D or the extractor.'}]:[]};
      if(withEdge)document.observation={components:[{id:'remainder',execution:'not_attempted',coverage:'none',fidelity:'unchecked',
        limitations:['preparation-statement'],incidents:[]}],incidents:[],inventory:known?'known':'unknown',
        interruptions:[{component:'remainder',incident_id:incidentIds.D}]};
      const prepared=await persistDocument({call,check,document,inputs:[{id:'source',kind:'extraction',job_id:receipt.work.id,reference:accepted.effect}],
        selection:[{input_id:'source',element_id:'line-1',local_id:'A'}]});
      const stage=prepared.attempt.document,edgeSource={id:stage.id,revision:stage.generation,sha256:stage.sha256};
      function verify(payload){
        const observed={preparation:prepared.reference,...payload,selected_coverage:{components:[ids.A],complete_source_claim:false}};
        if(variant==='unknown-with-known-interruption'){
          // The frozen unknown fixture has no E observation. Do not apply it to a
          // different source that independently supplies E; retain both facts.
          assert.equal(payload.inventory,'unknown');
          assert.equal(payload.components.length,5);
          assert.deepEqual(payload.interruptions,[{component:ids.E,incident_id:incidentIds.D,source:edgeSource,origin:'preparation_annotation'}]);
          assert.equal(payload.components.find(c=>c.id===ids.E).execution,'not_attempted');
          assert.deepEqual(payload.incidents.map(i=>i.cause),['unreadable','route_unoffered','technical_failure']);
        }else assertScopedCoverage(observed,{preparation:prepared.reference,component_ids:ids,incident_ids:incidentIds,
          ...(withEdge?{interruption_source:edgeSource}:{})},'mixed-'+variant);
        assert.equal(payload.elements[0].text,text);
        assert.equal(payload.current_use,'not_evaluated');
      }
      verify(prepared.record.payload);
      const before=await counts(),effect=await constituteDocument({call,check,prepared,unit:'Mixed'});
      const candidate=effect.constitution.result.candidates[0];
      const saved=(await env.admin.query(`SELECT p.payload,c.editorial_state FROM intake_trial.candidate c
        JOIN intake_trial.preparation p ON p.id=c.preparation_id AND p.revision=c.preparation_revision
        WHERE c.unit_id=$1 AND c.version=$2`,[candidate.id,candidate.revision])).rows[0];
      verify(JSON.parse(saved.payload.toString()));assert.equal(saved.editorial_state,'candidate');
      assert.deepEqual(await counts(),{candidates:before.candidates+1,outcomes:before.outcomes+1,effects:before.effects+1});
      record('mixed-components',{variant,preparation:prepared.reference,candidate,interruptionSource:withEdge?edgeSource:null,
        components:prepared.record.payload.components,incidents:prepared.record.payload.incidents,
        inventory:prepared.record.payload.inventory,scope:'Instrumented component outcomes; no native semantic discovery claim.'});
    });
  }
}
