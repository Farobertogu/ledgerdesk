import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {EXTRACTION_CONTENT} from '../../../src/contracts/intake_extraction_view.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {original as originalFile} from './references/cases.mjs';

export async function extractionSemanticCases(t,{env,intake,client,request}){
  await extractionControl(env,{allFormats:true});const observations=[];
  // These references exist before any worker invocation and are never changed
  // by the mutation driver. They are not reconstructed from a returned manifest.
  const text='AZ-17\nReceipt Q is required.\nUnder condition Z, receipt R replaces receipt Q.\n';
  const references={text,limitations:['syntactic-profile-only','raw-properties-retained-not-interpreted','semantic-fidelity-unverified'],
    part:'xl/media/image1.svg',cause:'route_unoffered',execution:'not_attempted',coverage:'none',formula:'B2*C2',cache:'25.00'};
  writeFileSync('/work/output/semantic-references.json',JSON.stringify(references,null,2),{flag:'wx'});
  try{
    for(const [name,format,media]of [['semantic.txt','text-utf8/1','text/plain'],
      ['unsupported-part.xlsx','xlsx-cells/1','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]){
      await t.test('SEM '+name+' preserves the independent content and coverage after real persistence and query',async()=>{
        const bytes=name==='semantic.txt'?Buffer.from(text):(await originalFile(name)).bytes;
        const reference={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
        const receipt=await receivedOriginal(request,client,bytes,{name,format,media}),jobId=receipt.work.id;
        const service=new ExtractionService(intake);await service.dispatch(jobId);const accepted=await service.accept(jobId);
        const q=await request('/api/intake/extractions/'+jobId,{client});
        const row=(await env.admin.query(`SELECT j.state,j.accepted_result,r.effect_id,o.normalized_sha256,o.normalized_bytes,
          (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=j.id) AS outputs,
          (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) AS results
          FROM intake_trial.extraction_job j JOIN intake_trial.extraction_result r ON r.id=j.accepted_result
          JOIN intake_trial.extraction_output o ON o.id=r.output_id WHERE j.id=$1`,[jobId])).rows[0];
        const entry={name,reference,jobId,accepted,row,status:q.status,body:q.body};observations.push(entry);
        // All mutations must get this far: valid public projection, real SQL
        // acceptance and useful content, not an unrelated authorization denial.
        assert.equal(q.status,200,JSON.stringify(q.body));assert.equal(EXTRACTION_CONTENT(q.body.result.content),true);
        assert.deepEqual({state:row.state,result:row.accepted_result,effect:row.effect_id,outputs:row.outputs,results:row.results},
          {state:'accepted',result:accepted.resultId,effect:accepted.effectId,outputs:1,results:1});
        const content=q.body.result.content;
        assert.deepEqual({bytes:content.original.bytes,sha256:content.original.sha256},reference);
        if(name==='semantic.txt'){
          assert.deepEqual({text:content.elements.map(e=>e.text).join(''),limitations:content.components[0].limitations},
            {text:references.text,limitations:references.limitations});
        }else{
          const incident=content.incidents.find(i=>i.detail===references.part),component=content.components.find(c=>c.id===incident?.component);
          const cell=content.elements[0].cells.find(c=>c.address==='D2');
          assert.deepEqual({outcome:content.outcome,limitations:content.components[0].limitations,part:incident?.detail,cause:incident?.cause,
            execution:component?.execution,coverage:component?.coverage,formula:cell.formula,cache:cell.cached.lexical},
            {outcome:'partial',limitations:references.limitations,part:references.part,cause:references.cause,
              execution:references.execution,coverage:references.coverage,formula:references.formula,cache:references.cache});
        }
      });
    }
  }finally{
    writeFileSync('/work/output/extraction-semantics.json',JSON.stringify({references,observations,
      meaning:'Actual worker, admitted storage and query compared against references fixed before dispatch. A code mutation failing here is a test discriminator, not a universal semantic defense.',
      limitations:['No inferred indispensable relation or nonempty resource is attributed to these adapters.']},null,2),{flag:'wx'});
  }
}
