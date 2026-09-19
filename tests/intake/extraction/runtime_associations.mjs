import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {readWorkerReply} from '../../../src/contracts/intake_extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');

export async function extractionAssociationCases(t,{env,intake,client,request}){
  await extractionControl(env,{allFormats:true});const observations=[],text='Equal visible text does not identify its received original.\n';
  let a,b,first,current,acceptedA,acceptedB,rawA;
  const state=async()=>(await env.admin.query(`SELECT j.id,j.state,j.accepted_result,
    (SELECT count(*)::int FROM intake_trial.extraction_output WHERE job_id=j.id) outputs,
    (SELECT count(*)::int FROM intake_trial.extraction_result WHERE job_id=j.id) results
    FROM intake_trial.extraction_job j ORDER BY j.id`)).rows;
  try{
    await t.test('ASSOC01 two real equal-text originals have different jobs, profiles and assigned worker channels',async()=>{
      a=await receivedOriginal(request,client,Buffer.from(text),{name:'first.md',format:'markdown-inert/1',media:'text/markdown'});
      const sa=new ExtractionService(intake),call=sa.extraction.call.bind(sa.extraction);
      sa.extraction.call=async command=>{const reply=await call(command);if(command.action==='read'&&reply.ok)rawA=Buffer.from(reply.data,'base64');return reply;};
      first=await sa.dispatch(a.work.id);acceptedA=await sa.accept(a.work.id);
      const qa=await request('/api/intake/extractions/'+a.work.id,{client});assert.equal(qa.status,200);
      assert.equal(qa.body.result.content.elements.map(e=>e.text).join(''),text);
      b=await receivedOriginal(request,client,Buffer.from(text),{name:'second.txt'});
      assert.notEqual(a.original.id,b.original.id);assert.equal(a.original.sha256,b.original.sha256);
      assert.equal((await administration('fail-next-extraction-input',{})).ok,true);
      const sb=new ExtractionService(intake),interrupted=await sb.dispatch(b.work.id);assert.equal(interrupted.metadata.reason,'input_failure');
      current=await sb.retry(b.work.id,1);assert.equal(current.metadata.reason,null);
      assert.notEqual(first.binding.job.id,current.binding.job.id);assert.notEqual(first.binding.channel_id,current.binding.channel_id);
      assert.deepEqual([first.binding.attempt_generation,current.binding.attempt_generation],[1,2]);
      assert.deepEqual(readWorkerReply(rawA).binding,first.binding);
      observations.push({case:'ASSOC01',first,current,originalA:a.original,originalB:b.original,acceptedA});
    });
    if(!current||!rawA)throw Error('ASSOCIATION_ACTUAL_PREDECESSORS_REQUIRED');
    const alternatives=[['original',first.binding.original],['job',first.binding.job],['attempt_generation',first.binding.attempt_generation],
      ['format_profile',first.binding.format_profile],['output_namespace','intake_restore'],['channel_id',first.binding.channel_id]];
    for(const [field,value]of alternatives)await t.test('ASSOC '+field+' cannot substitute an intact alternative at the internal acceptance boundary',async()=>{
      const before=await state();let reached=0,reference;
      globalThis.__t03AssociationInput=(raw,expected,channel)=>{
        reached++;assert.deepEqual(expected,current.binding);assert.equal(channel,current.binding.channel_id);
        const envelope=readWorkerReply(raw);envelope.binding[field]=structuredClone(value);
        const changed=Buffer.from(JSON.stringify(envelope)+'\n');readWorkerReply(changed);
        reference={field,value,before:{bytes:raw.length,sha256:hash(raw)},after:{bytes:changed.length,sha256:hash(changed)},expected,channel};
        return{raw:changed,channel};
      };
      try{await assert.rejects(new ExtractionService(intake).accept(b.work.id),/EXTRACTION_OUTPUT_ASSOCIATION/);}
      finally{delete globalThis.__t03AssociationInput;}
      assert.equal(reached,1);assert.deepEqual(await state(),before);observations.push(reference);
    });
    await t.test('ASSOC02 the intact other worker body is refused, then the real current body is conserved exactly',async()=>{
      let reached=0;const before=await state();
      globalThis.__t03AssociationInput=()=>{reached++;return{raw:rawA,channel:current.binding.channel_id};};
      try{await assert.rejects(new ExtractionService(intake).accept(b.work.id),/EXTRACTION_OUTPUT_ASSOCIATION/);}
      finally{delete globalThis.__t03AssociationInput;}
      assert.equal(reached,1);assert.deepEqual(await state(),before);
      acceptedB=await new ExtractionService(intake).accept(b.work.id);
      for(const [receipt,effect]of [[a,acceptedA],[b,acceptedB]]){
        const q=await request('/api/intake/extractions/'+receipt.work.id,{client});
        assert.deepEqual({status:q.status,id:q.body.result?.id,original:q.body.original,text:q.body.result?.content.elements.map(e=>e.text).join('')},
          {status:200,id:effect.resultId,original:receipt.original,text});
      }
      observations.push({case:'ASSOC02',before,after:await state(),acceptedA,acceptedB});
    });
  }finally{delete globalThis.__t03AssociationInput;writeFileSync('/work/output/extraction-associations.json',JSON.stringify({observations,
    scope:'Real received originals, real worker channels and closed generations; service-copy injection after native raw integrity verification and before internal binding validation. Negative envelopes retain valid encoding and independently observed recalculated size/hash. No claim that recomputed integrity authenticates them.',
    destinationLimit:'intake_restore is the other contract-valid destination, not an enabled dispatch namespace in this group. Its anchored historical query positive belongs to the populated restore group; this does not authorize new processing in the restore namespace.'},null,2),{flag:'wx'});}
}
