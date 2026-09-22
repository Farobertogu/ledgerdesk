import assert from 'node:assert/strict';
import https from 'node:https';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {uiOrigin} from '../../access/journey_environment.mjs';
import {PrivateIntakePort} from '../../../src/server/intake/ports.ts';
import {treatment} from './fixtures.mjs';
import {administration} from './recovery_cases.mjs';
import {fenceLossCase} from './fence_loss_cases.mjs';
import {fenceAckCase} from './fence_ack_cases.mjs';
import {fenceCommitCase} from './fence_commit_cases.mjs';
import {fenceContinuationCase} from './fence_continuation_cases.mjs';
import {fenceIpcCase} from './fence_ipc_cases.mjs';
import {fenceRestoreCase} from './fence_restore_cases.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
async function bounded(promise,label,ms=4000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function eventually(read,accept,label){const end=Date.now()+4000;let result;do{result=await read();if(accept(result))return result;await delay(25);}while(Date.now()<end);assert.fail(label+': '+JSON.stringify(result));}

export async function streamCases(t,context){
  const {env,intake,client,request,setBarrier,storage,barriers,admissions}=context,observations=[];
  const text=readFileSync(new URL('../t01/fixtures/text.txt',import.meta.url));
  const declare=(bytes,name='text.txt',format='text-utf8/1')=>({profile:'intake/1',original:{name,bytes:bytes.length,sha256:digest(bytes),
    declared_media_type:format==='xlsx-cells/1'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':format==='csv-utf8/1'?'text/csv':format==='markdown-inert/1'?'text/markdown':'text/plain'},format_profile:format,
    receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}});
  const reserve=async declaration=>{const result=await request('/api/intake/receptions',{body:declaration,client,key:randomUUID()});assert.equal(result.status,202,JSON.stringify(result.body));return result.body;};
  const records=async id=>({reception:(await env.admin.query('SELECT * FROM intake_trial.reception WHERE id=$1',[id])).rows[0],
    attempts:(await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[id])).rows,
    receipts:(await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows,
    jobs:(await env.admin.query('SELECT w.* FROM intake_trial.work w JOIN intake_trial.receipt e ON e.id=w.receipt_id WHERE e.reception_id=$1',[id])).rows});
  function partial(reception,bytes){
    let call,received=0;
    const response=new Promise(resolve=>{
      call=https.request({host:'127.0.0.1',port:9443,servername:'api.inc02.test',ca:env.ca,
        path:`/api/intake/receptions/${reception.reception_id}/attempts/1/original`,method:'POST',
        headers:{host:'api.inc02.test:9443',origin:uiOrigin,cookie:client.cookie,'x-ledgerdesk-csrf':client.csrf,
          'content-type':'application/octet-stream','content-length':String(bytes.length)}},reply=>{
        const chunks=[];reply.on('data',chunk=>{received+=chunk.length;chunks.push(chunk);});
        reply.once('end',()=>resolve({status:reply.statusCode,bytes:received,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
        reply.once('error',()=>resolve({status:null,bytes:received,interrupted:true}));
      });
      call.once('error',()=>resolve({status:null,bytes:received,interrupted:true}));call.setTimeout(8000,()=>call.destroy(Error('BOUNDED_SYNTHETIC_STREAM')));
      call.write(bytes.subarray(0,41));
    });
    return{response,end:()=>call.end(bytes.subarray(41)),destroy:()=>call.destroy()};
  }
  async function paused(reception,bytes){
    const reached=deferred(),release=deferred();
    setBarrier(async(label,event)=>{if(label==='between_chunks'&&event.receptionId===reception.reception_id&&event.consumed===41){reached.resolve(event);await release.promise;}});
    const stream=partial(reception,bytes);
    try{await bounded(reached.promise,'FIRST_CHUNK_NOT_OBSERVED');}
    catch(error){release.resolve();stream.destroy();setBarrier(async()=>{});throw error;}
    return{...stream,release:()=>{release.resolve();setBarrier(async()=>{});}};
  }
  await t.test('interrupted real transfer resumes as a new fenced physical generation',async()=>{
    const r=await reserve(declare(text)),transfer=await paused(r,text);
    let cut;
    try{cut=await records(r.reception_id);assert.equal(cut.attempts[0].actual_bytes,41);transfer.destroy();}
    finally{transfer.release();}
    const disconnected=await bounded(transfer.response,'DISCONNECT_NOT_OBSERVED');assert.equal(disconnected.status,null);
    const incomplete=await eventually(()=>records(r.reception_id),value=>value.reception.state==='interrupted','TRANSFER_NOT_CLASSIFIED');
    assert.deepEqual([incomplete.receipts.length,incomplete.jobs.length,incomplete.attempts[0].actual_bytes],[0,0,41]);
    const current=await request(`/api/intake/receptions/${r.reception_id}`,{client});assert.equal(current.status,200);
    const expectedActivation={status:409,state:'interrupted',actualBytes:41,receipts:0,jobs:0};
    writeFileSync('/work/output/incomplete-activation-reference.json',JSON.stringify({expected:expectedActivation,declaredBytes:text.length}),{flag:'wx'});
    const premature=await request(`/api/intake/receptions/${r.reception_id}/finalize`,{body:{profile:'intake/1',
      expected_revision:current.body.revision,original:r.original,format_profile:'text-utf8/1'},client,key:randomUUID()});
    const retained=await records(r.reception_id);
    const observedActivation={status:premature.status,state:retained.reception.state,actualBytes:retained.attempts[0].actual_bytes,
      receipts:retained.receipts.length,jobs:retained.jobs.length};
    writeFileSync('/work/output/incomplete-activation-observed.json',JSON.stringify({observed:observedActivation,declaredBytes:text.length,
      receiptBytes:retained.receipts.map(row=>row.bytes),attemptState:retained.attempts[0].state}),{flag:'wx'});
    assert.deepEqual(observedActivation,expectedActivation,'INCOMPLETE_ACTIVATION: interrupted bytes cannot acquire a durable receipt and work');
    const resumed=await request(`/api/intake/receptions/${r.reception_id}/resume`,{body:{profile:'intake/1',expected_revision:current.body.revision,
      expected_generation:1,cause:'interrupted',original:r.original},client,key:randomUUID()});assert.equal(resumed.status,202,JSON.stringify(resumed.body));
    const oldEvidence=storage.find(e=>e.artifactId===r.original.id&&e.kind==='capture').evidenceId;
    const oldPort=new PrivateIntakePort(intake.brokerSocket,1500000,1000,intake.namespace);
    const late=[];
    for(const action of ['append','seal','read_stage'])late.push(await oldPort.call({action,original:r.original,incarnation:intake.incarnation,evidenceId:oldEvidence,
      ...(action==='append'?{offset:41,data:text.subarray(41).toString('base64')}:{})}));
    assert.deepEqual(late.map(x=>({ok:x.ok,outcome:x.outcome})),Array.from({length:3},()=>({ok:false,outcome:'denied'})));
    const staged=await request(`/api/intake/receptions/${r.reception_id}/attempts/2/original`,{bytes:text,client});assert.equal(staged.status,200,JSON.stringify(staged.body));
    const done=await request(`/api/intake/receptions/${r.reception_id}/finalize`,{body:{profile:'intake/1',expected_revision:staged.body.revision,
      original:staged.body.original,format_profile:'text-utf8/1'},client,key:randomUUID()});assert.equal(done.status,200,JSON.stringify(done.body));
    const served=await request(`/api/intake/receptions/${r.reception_id}/original`,{client});
    const after=await records(r.reception_id);
    assert.deepEqual({status:served.status,bytes:served.bytes,receipts:after.receipts.length,jobs:after.jobs.length,
      attempts:after.attempts.map(a=>({generation:a.generation,state:a.state,bytes:a.actual_bytes}))},
    {status:200,bytes:text,receipts:1,jobs:1,attempts:[{generation:1,state:'fenced',bytes:41},{generation:2,state:'sealed',bytes:text.length}]});
    assert.equal(after.reception.principal,cut.reception.principal);assert.equal(after.reception.origin_session,cut.reception.origin_session);
    assert.deepEqual(after.reception.declaration,cut.reception.declaration);assert.notEqual(after.attempts[0].artifact_id,after.attempts[1].artifact_id);
    observations.push({case:'partial-resumed',cut,incomplete,after,late,servedSha256:digest(served.bytes)});
  });
  await t.test('a treatment writer completes between chunks and the old stream captures no later bytes',async()=>{
    const r=await reserve(declare(text)),transfer=await paused(r,text);
    const before=await records(r.reception_id),captureBefore=storage.filter(e=>e.artifactId===r.original.id).length;
    let writer;
    try{
      const started=Date.now();
      // This completes while the application is still paused at the first chunk.
      await bounded(env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]),'WRITER_HELD_BY_REMOTE_WAIT',2000);
      writer={startedAtMs:started,completedAtMs:Date.now(),control:(await env.admin.query('SELECT * FROM intake_control.treatment_current')).rows[0]};
      assert.equal(writer.control.enabled,false);transfer.end();transfer.release();
      const response=await bounded(transfer.response,'WITHDRAWN_STREAM_NOT_REFUSED');
      const after=await records(r.reception_id);
      assert.deepEqual({status:response.status,newCaptures:storage.filter(e=>e.artifactId===r.original.id).length-captureBefore,
        bytes:after.attempts[0].actual_bytes,state:after.reception.state,receipts:after.receipts.length,jobs:after.jobs.length},
      {status:404,newCaptures:0,bytes:41,state:'interrupted',receipts:0,jobs:0});
      observations.push({case:'writer-between-chunks',before,writer,response,after});
    }finally{transfer.release();transfer.destroy();await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);}
  });
  await t.test('withdrawn treatment before capture leaves the original and application unread',async()=>{
    const r=await reserve(declare(text)),start=storage.length;
    try{
      await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]);
      const response=await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{bytes:text,client});
      const after=await records(r.reception_id);
      assert.deepEqual({status:response.status,captures:storage.length-start,bytes:after.attempts[0].actual_bytes,receipts:after.receipts.length},
        {status:404,captures:0,bytes:0,receipts:0});observations.push({case:'withdrawn-before-capture',response,after});
    }finally{await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);}
  });
  for(const [name,format] of [['inert.md','markdown-inert/1'],['table.csv','csv-utf8/1'],['baseline.xlsx','xlsx-cells/1']]){
    await t.test(`real minimum verification preserves the exact ${format} original`,async()=>{
      const bytes=readFileSync(new URL('../t01/fixtures/'+name,import.meta.url)),r=await reserve(declare(bytes,name,format));
      const staged=await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{bytes,client});assert.equal(staged.status,200,JSON.stringify(staged.body));
      const finalized=await request(`/api/intake/receptions/${r.reception_id}/finalize`,{body:{profile:'intake/1',expected_revision:staged.body.revision,
        original:staged.body.original,format_profile:format},client,key:randomUUID()});assert.equal(finalized.status,200,JSON.stringify(finalized.body));
      const served=await request(`/api/intake/receptions/${r.reception_id}/original`,{client});assert.deepEqual({status:served.status,bytes:served.bytes},{status:200,bytes});
      observations.push({case:'profile-round-trip',name,format,after:await records(r.reception_id),servedBytes:served.bytes.length,servedSha256:digest(served.bytes)});
    });
  }
  if(process.env.LEDGERDESK_INTAKE_FENCE_LOSS)await fenceLossCase(t,{...context,reserve,paused,declare,text});
  if(process.env.LEDGERDESK_INTAKE_FENCE_ACK)await fenceAckCase(t,{...context,reserve,declare,text});
  if(process.env.LEDGERDESK_INTAKE_FENCE_COMMIT)await fenceCommitCase(t,{...context,reserve,declare,text});
  if(process.env.LEDGERDESK_INTAKE_FENCE_CONTINUATION)await fenceContinuationCase(t,context);
  if(process.env.LEDGERDESK_INTAKE_FENCE_IPC)await fenceIpcCase(t,context);
  if(process.env.LEDGERDESK_INTAKE_FENCE_RESTORE)await fenceRestoreCase(t,context);
  if(process.env.LEDGERDESK_INTAKE_FENCING_PROBE==='1')await t.test('stalled storage cannot append after its caller releases admission and treatment is withdrawn',async()=>{
    const r=await reserve(declare(text)),transfer=await paused(r,text);
    let resumed=false;
    try{
      const before=await records(r.reception_id);assert.equal(before.attempts[0].actual_bytes,41);
      assert.equal((await administration('arm-stall',{artifactId:r.original.id,generation:1,offset:41})).ok,true);
      transfer.end();transfer.release();
      const response=await bounded(transfer.response,'STALLED_PORT_DID_NOT_TERMINATE',6000);
      assert.equal(response.status,503,JSON.stringify(response));
      const stalled=await administration('stall-state',{});assert.equal(stalled.reached,true,'FAULT_MUST_REACH_VALID_APPEND_BEFORE_WRITE');
      await bounded(env.admin.query('SELECT intake_control.set_treatment($1,$2,false)',[treatment.id,treatment.revision]),'WRITER_CANNOT_COMPLETE_AFTER_PRIVATE_TIMEOUT',2000);
      const withdrawalAtMs=Date.now(),withdrawn=(await env.admin.query('SELECT * FROM intake_control.treatment_current')).rows[0];
      assert.equal(withdrawn.enabled,false);
      const continued=await administration('continue-broker',{});resumed=true;
      const stored=await administration('inspect',{}),after=await records(r.reception_id);
      const actual=stored.objects.find(x=>x.name===r.original.id+'-1.stage');assert.ok(actual);
      const capture=barriers.filter(e=>e.label==='before_capture'&&e.artifactId===r.original.id).at(-1);
      const completion=stalled.lifecycle.filter(e=>e.kind==='closed'&&e.evidenceId===capture.evidenceId).at(-1)??null;
      const release=admissions.find(e=>e.kind==='release-requested'&&e.backendPid===capture.backendPid)??null;
      const quiescent=!!completion&&!!release&&completion.signal==='SIGKILL'&&completion.reason==='deadline'&&completion.closedAtMs<=release.atMs;
      const result={case:'stalled-private-append',before,response,stalled,withdrawalAtMs,withdrawn,continued,after,actual,capture,completion,release,
        expectedStoredBytes:41,fencingConformity:actual.bytes===41&&quiescent,temporalConformityClaim:false};
      writeFileSync('/work/output/fencing-probe.json',JSON.stringify(result,null,2));
      assert.deepEqual({bytes:actual.bytes,quiescentBeforeRelease:quiescent},{bytes:41,quiescentBeforeRelease:true},'STORAGE_APPEND_AFTER_CALLER_RELEASE_AND_CURRENT_WITHDRAWAL');
    }finally{
      transfer.release();transfer.destroy();
      if(!resumed)await administration('continue-broker',{});
      await env.admin.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);
    }
  });
  writeFileSync('/work/output/stream-observations.json',JSON.stringify(observations,null,2));
}
