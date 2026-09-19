import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Real controlled processes and durable outputs; the flood is explicitly injected. */
export async function extractionBudgetCases(t,{env,intake,client,request}){
  await extractionControl(env);const observations=[];
  const cases=[
    {name:'positive',bytes:Buffer.from('A bounded extraction remains usable.\n'),outcome:'completed'},
    {name:'supervised-output-limit',bytes:Buffer.from('T03 supervised output reserve\n'),outcome:'failed'},
    {name:'dense-line-representation',bytes:Buffer.alloc(60000,10),outcome:'completed'},
  ];
  try{for(const reference of cases)await t.test('BUDGET '+reference.name+' keeps exact raw and its distinct observed outcome',async()=>{
    const row={name:reference.name,original:{bytes:reference.bytes.length,sha256:hash(reference.bytes)},
      evidenceClass:reference.name==='supervised-output-limit'?'Instrumented producer copy with actual supervisor, storage, SQL and HTTPS':'Actual unchanged extractor path'};
    observations.push(row);
    const receipt=await receivedOriginal(request,client,reference.bytes),service=new ExtractionService(intake);row.jobId=receipt.work.id;
    const dispatched=await service.dispatch(receipt.work.id);row.metadata=dispatched.metadata;
    if(reference.name==='supervised-output-limit'){
      const expected=Buffer.alloc(EXTRACTION_BOUNDS.stdoutBytes,65);expected[expected.length-1]=0xc3;
      assert.deepEqual({reason:dispatched.metadata.reason,bytes:dispatched.metadata.raw.bytes,sha256:dispatched.metadata.raw.sha256,
        encodingError:dispatched.metadata.diagnostics.stdoutEncodingError},
      {reason:'output_limit',bytes:expected.length,sha256:hash(expected),encodingError:true});
      assert.ok(dispatched.metadata.diagnostics.stdoutReceivedBytes>expected.length);
      row.rawReference={bytes:expected.length,sha256:hash(expected),construction:'65 repeated cap-minus-one times followed by byte 195; next emitted byte 169 is beyond the retained cap'};
    }else assert.equal(dispatched.metadata.reason,null,JSON.stringify(dispatched.metadata));
    const accepted=await service.accept(receipt.work.id);row.accepted=accepted;
    const output=(await env.admin.query(`SELECT raw_bytes,raw_sha256,normalized_bytes,normalized_sha256,bytes
      FROM intake_trial.extraction_output WHERE job_id=$1`,[receipt.work.id])).rows[0];row.output=output;
    const response=await request('/api/intake/extractions/'+receipt.work.id,{client});
    assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.result.id,accepted.resultId);
    const content=response.body.result.content,normalized=Buffer.from(JSON.stringify(content));row.content=content;row.queryBytes=response.bytes.length;
    assert.equal(content.outcome,reference.outcome);
    assert.deepEqual(output,{raw_bytes:dispatched.metadata.raw.bytes,raw_sha256:dispatched.metadata.raw.sha256,
      normalized_bytes:normalized.length,normalized_sha256:hash(normalized),bytes:dispatched.metadata.raw.bytes+normalized.length});
    assert.ok(output.bytes<=EXTRACTION_BOUNDS.conservedBytes);
    if(reference.outcome==='completed'){
      assert.equal(content.elements.map(e=>e.text).join(''),reference.bytes.toString());
      if(reference.name==='dense-line-representation'){
        assert.equal(row.original.sha256,'b7d8e5f977566123c9512161e183e335020cbee7916412416b09e05d4c7a60d4');
        assert.equal(content.elements.length,60000);
        for(let i=0;i<60000;i++)assert.deepEqual(content.elements[i].original_range,{bytes:[i,i+1],code_points:[i,i+1]});
      }
    }
    else{
      assert.ok(normalized.length<=EXTRACTION_BOUNDS.failureBytes);assert.deepEqual(content.elements,[]);
      if(reference.name==='supervised-output-limit'){
        assert.equal(content.incidents[0].code,'output_limit');
        assert.equal(content.components[0].coverage,'unknown');
      }
    }
    row.outcome='passed';
  });}finally{writeFileSync('/work/output/extraction-budgets.json',JSON.stringify({observations,
    limits:EXTRACTION_BOUNDS,limitations:['The flood is an identified source-copy injection, not behavior attributed to the real extractor.',
      'Retained-byte encoding error can be caused by supervisor truncation; output_limit remains the primary cause.',
      'These finite cases do not establish a universal physical peak or semantic completeness.']},null,2));}
}
