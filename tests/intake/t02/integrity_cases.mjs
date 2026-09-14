import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {administration} from './recovery_cases.mjs';
import {treatment} from './fixtures.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function integrityCases(t,{env,intake,client,request,getProcess,restart}){
  const output='/work/output/integrity';mkdirSync(output,{recursive:true});const records=[];
  const original=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex'),reference={bytes:17,sha256:'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9'};
  assert.equal(sha(original),reference.sha256);
  writeFileSync(output+'/original.bin',original,{flag:'wx'});
  writeFileSync(output+'/reference.json',JSON.stringify({fixedAtMs:Date.now(),original:reference,expectedFaultBytes:17},null,2),{flag:'wx'});
  async function receive(name){
    const key=randomUUID(),reserved=await request('/api/intake/receptions',{client,key,body:{profile:'intake/1',original:{name,...reference,declared_media_type:'text/plain'},
      format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}}});
    assert.equal(reserved.status,202);const r=reserved.body;
    const uploaded=await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{client,bytes:original});assert.equal(uploaded.status,200);
    const final=await request(`/api/intake/receptions/${r.reception_id}/finalize`,{client,key:randomUUID(),body:{profile:'intake/1',
      expected_revision:uploaded.body.revision,original:uploaded.body.original,format_profile:'text-utf8/1'}});assert.equal(final.status,200);
    return {key,...final.body};
  }
  const snapshot=async id=>({receipts:(await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows,
    jobs:(await env.admin.query('SELECT w.* FROM intake_trial.work w JOIN intake_trial.receipt r ON r.id=w.receipt_id WHERE r.reception_id=$1',[id])).rows,
    attempts:(await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[id])).rows});
  try{
    for(const mode of ['corrupt','missing'])await t.test('actual '+mode+' original does not erase receipt or manufacture bytes',async()=>{
      const r=await receive(mode+'.txt'),url=`/api/intake/receptions/${r.reception_id}`,before=await snapshot(r.reception_id);
      const good=await request(url+'/original',{client});assert.deepEqual({status:good.status,bytes:good.bytes},{status:200,bytes:original});
      const fault=await administration('fault-original',{artifactId:r.original.id,generation:1,...reference,mode});
      assert.equal(fault.ok,true);assert.equal(fault.before.sha256,reference.sha256);assert.equal(fault.retainedSha256,reference.sha256);
      if(mode==='corrupt')assert.deepEqual({bytes:fault.after.bytes,sha:sha(Buffer.from(fault.after.data,'base64')),different:fault.after.sha256!==reference.sha256},
        {bytes:17,sha:fault.after.sha256,different:true});else assert.equal(fault.present,false);
      const eventStart=(await administration('observe-events',{})).events.length;
      const record=await request(url,{client}),afterQuery=(await administration('observe-events',{})).events;
      assert.equal(record.status,200);assert.deepEqual(record.body.effect,r.effect);
      assert.equal(afterQuery.length,eventStart,'Historical record query must not inspect the faulted object');
      const bad=await request(url+'/original',{client}),events=(await administration('observe-events',{})).events.slice(eventStart);
      const objectEvents=events.filter(e=>e.origin==='object-boundary'&&e.artifactId===r.original.id);
      const actual=await snapshot(r.reception_id);
      const observation={case:mode,receptionId:r.reception_id,original:r.original,before,fault,recordStatus:record.status,status:bad.status,
        objectEvents,actual,bodyIsOriginal:bad.bytes.equals(original)};records.push(observation);
      writeFileSync(output+'/'+mode+'.json',JSON.stringify(observation,null,2),{flag:'wx'});
      assert.deepEqual({status:bad.status,bodyIsOriginal:observation.bodyIsOriginal,history:actual},{status:503,bodyIsOriginal:false,history:before});
      if(mode==='corrupt')assert.deepEqual(objectEvents.map(e=>({kind:e.kind,bytes:e.bytes})),[{kind:'open',bytes:0},{kind:'read',bytes:17}]);
      else assert.deepEqual(objectEvents.map(e=>e.kind),['failed_open']);
    });
    await t.test('a new application process and controlled incarnation read the same durable effect without reseeding',async()=>{
      const r=await receive('restart.txt'),before=await snapshot(r.reception_id),old=getProcess(),controlBefore=(await env.admin.query('SELECT * FROM intake_control.live')).rows[0];
      const first=await request(`/api/intake/receptions/${r.reception_id}/original`,{client});assert.deepEqual(first.bytes,original);
      await env.admin.query("UPDATE intake_control.live SET incarnation='intake-runtime-2',generation=generation+1,revision=revision+1");
      const replacement=await restart({...intake,incarnation:'intake-runtime-2',generation:2});
      assert.deepEqual(replacement.previous,old);assert.notDeepEqual(replacement.current,old);
      const oldEvents=JSON.parse(readFileSync('/work/output/application-'+old.pid+'-'+old.startTicks+'.json','utf8'));
      const closed=oldEvents.find(e=>e.kind==='closed');assert.ok(closed);assert.deepEqual({code:closed.code,signal:closed.signal},{code:0,signal:null});
      // An updated process/control generation alone is insufficient. Keep the
      // mismatched namespace as an explicit denied control before admitting it.
      const priorEvents=(await administration('observe-events',{})).events.length;
      const mismatched=await request(`/api/intake/receptions/${r.reception_id}/original`,{client});
      assert.deepEqual({status:mismatched.status,newEvents:(await administration('observe-events',{})).events.length-priorEvents},{status:503,newEvents:0});
      await env.admin.query("UPDATE intake_control.namespace_admission SET generation=2 WHERE namespace='intake_trial' AND generation=1");
      const history=await request(`/api/intake/receptions/${r.reception_id}`,{client});
      const served=await request(`/api/intake/receptions/${r.reception_id}/original`,{client}),after=await snapshot(r.reception_id);
      records.push({case:'application-restart',before,after,old,new:replacement.current,closed,controlBefore,mismatchedNamespaceStatus:mismatched.status,
        namespaceAfter:(await env.admin.query("SELECT * FROM intake_control.namespace_admission WHERE namespace='intake_trial'")).rows[0],
        controlAfter:(await env.admin.query('SELECT * FROM intake_control.live')).rows[0],status:served.status,bytes:served.bytes.length,sha256:sha(served.bytes)});
      writeFileSync(output+'/restart.json',JSON.stringify(records.at(-1),null,2),{flag:'wx'});
      assert.deepEqual({status:served.status,bytes:served.bytes,historyStatus:history.status,effect:history.body.effect,rows:after},
        {status:200,bytes:original,historyStatus:200,effect:r.effect,rows:before});
    });
  }finally{writeFileSync(output+'/observations.json',JSON.stringify(records,null,2),{flag:'wx'});}
}
