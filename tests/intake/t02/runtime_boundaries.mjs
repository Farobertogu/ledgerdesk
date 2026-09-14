import assert from 'node:assert/strict';
import tls from 'node:tls';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {uiOrigin} from '../../access/journey_environment.mjs';
import {treatment} from './fixtures.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixture=name=>readFileSync(new URL('../t01/fixtures/'+name,import.meta.url));
const media=format=>format==='xlsx-cells/1'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':format==='csv-utf8/1'?'text/csv':'text/plain';
const output='/work/output/boundaries';

/** Independent original bytes and expectations precede every producer call. */
export async function runtimeBoundaries(t,{env,client,request,requestEvents,storage}){
  mkdirSync(output,{recursive:true});
  const cases=[
    {id:'empty',bytes:Buffer.alloc(0),format:'text-utf8/1',status:200},
    {id:'at-byte-limit',bytes:Buffer.alloc(1048576,0x78),format:'text-utf8/1',status:200},
    {id:'invalid-utf8',bytes:Buffer.from([0x61,0xc3,0x28]),format:'text-utf8/1',status:415},
    {id:'truncated-utf8',bytes:Buffer.from([0x61,0xe2,0x82]),format:'csv-utf8/1',status:415},
    {id:'pdf-as-xlsx',bytes:Buffer.from('%PDF-1.4\n%%EOF\n'),format:'xlsx-cells/1',status:415},
    {id:'empty-zip-as-xlsx',bytes:Buffer.from('504b0506000000000000000000000000000000000000','hex'),format:'xlsx-cells/1',status:415},
    {id:'zip-traversal',bytes:fixture('zip-traversal.xlsx'),format:'xlsx-cells/1',status:415},
    {id:'zip-member-limit',bytes:fixture('zip-member-limit.xlsx'),format:'xlsx-cells/1',status:413},
    {id:'zip-expansion-limit',bytes:fixture('zip-expansion-limit.xlsx'),format:'xlsx-cells/1',status:413},
    {id:'legitimate-xlsx',bytes:fixture('baseline.xlsx'),format:'xlsx-cells/1',status:200},
  ];
  const references=cases.map(({id,bytes,format,status})=>({id,bytes:bytes.length,sha256:hash(bytes),format,status}));
  for(const row of cases)writeFileSync(output+'/'+row.id+'.bin',row.bytes,{flag:'wx'});
  writeFileSync(output+'/references.json',JSON.stringify({profile:'intake-boundary-references/1',fixedAtMs:Date.now(),
    originals:references,chunkMaximum:65536,commandMaximum:65536,originalMaximum:1048576},null,2),{flag:'wx'});
  const observations=[];
  function readObservation(start){
    const reads=requestEvents.slice(start).filter(e=>e.kind==='application-read');
    const discarded=reads.filter(e=>e.diagnosticReadOrigin==='node-http-discard');
    // Preserve every raw read. Unknown provenance counts against the admission
    // assertion; it is never silently excluded as supposed transport reception.
    return {consumed:reads.filter(e=>e.diagnosticReadOrigin!=='node-http-discard').reduce((sum,e)=>sum+e.bytes,0),
      rawReadBytes:reads.reduce((sum,e)=>sum+e.bytes,0),transportDiscardBytes:discarded.reduce((sum,e)=>sum+e.bytes,0)};
  }
  const declare=(bytes,name,format='text-utf8/1')=>({profile:'intake/1',original:{name,bytes:bytes.length,sha256:hash(bytes),declared_media_type:media(format)},
    format_profile:format,receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}});
  const reserve=async body=>{const result=await request('/api/intake/receptions',{body,client,key:randomUUID()});assert.equal(result.status,202,JSON.stringify(result.body));return result.body;};
  const state=async id=>({attempts:(await env.admin.query('SELECT generation,state,actual_bytes,actual_sha256 FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[id])).rows,
    artifacts:(await env.admin.query('SELECT id,generation,bytes,sha256,verification FROM intake_trial.artifact WHERE reception_id=$1',[id])).rows,
    receipts:(await env.admin.query('SELECT id,effect_id,artifact_id FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows,
    jobs:(await env.admin.query('SELECT w.id,w.dispatchable,w.state FROM intake_trial.work w JOIN intake_trial.receipt r ON r.id=w.receipt_id WHERE r.reception_id=$1',[id])).rows});
  try{
    for(const row of cases)await t.test('actual bounded intake: '+row.id,async()=>{
      const r=await reserve(declare(row.bytes,row.id+'.bin',row.format)),start=requestEvents.length,captureStart=storage.length;
      const path=`/api/intake/receptions/${r.reception_id}/attempts/1/original`,sentAtMs=Date.now();
      const reply=await request(path,{bytes:row.bytes,client}),events=requestEvents.slice(start),reads=events.filter(e=>e.kind==='application-read');
      const consumed=Buffer.concat(reads.map(e=>Buffer.from(e.data))),captured=storage.slice(captureStart).filter(e=>e.kind==='capture');
      const after=await state(r.reception_id);
      const observation={case:row.id,receptionId:r.reception_id,sentAtMs,status:reply.status,consumed:{bytes:consumed.length,sha256:hash(consumed)},
        captures:captured.map(({bytes,offset,evidenceId,atMs})=>({bytes,offset,evidenceId,atMs})),after};observations.push(observation);
      // Status and actual consumption/persistence are observed together, even on failure.
      assert.deepEqual({status:reply.status,exactBytes:consumed.equals(row.bytes),consumedBytes:consumed.length,
        boundedChunks:captured.every(e=>e.bytes>0&&e.bytes<=65536),receipts:after.receipts.length,jobs:after.jobs.length},
        {status:row.status,exactBytes:true,consumedBytes:row.bytes.length,boundedChunks:true,receipts:0,jobs:0});
      assert.equal(captured.reduce((sum,e)=>sum+e.bytes,0),row.bytes.length);
      if(row.status===200){
        assert.equal(after.artifacts.length,1);assert.deepEqual([after.artifacts[0].bytes,after.artifacts[0].sha256],[row.bytes.length,hash(row.bytes)]);
        assert.equal(after.artifacts[0].verification.scope,'minimum-form-only');
        const finalized=await request(`/api/intake/receptions/${r.reception_id}/finalize`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:reply.body.revision,
          original:reply.body.original,format_profile:row.format}});assert.equal(finalized.status,200,JSON.stringify(finalized.body));
        const served=await request(`/api/intake/receptions/${r.reception_id}/original`,{client});
        assert.deepEqual({status:served.status,bytes:served.bytes},{status:200,bytes:row.bytes});
        observation.final=await state(r.reception_id);observation.delivered={bytes:served.bytes.length,sha256:hash(served.bytes)};
        assert.deepEqual({receipts:observation.final.receipts.length,jobs:observation.final.jobs.length,dispatchable:observation.final.jobs[0]?.dispatchable},
          {receipts:1,jobs:1,dispatchable:false});
      }else assert.deepEqual({artifacts:after.artifacts.length,state:after.attempts[0].state},{artifacts:0,state:'interrupted'});
    });
    await t.test('structured metadata at 65536 bytes is admitted; the next byte is rejected before consumption',async()=>{
      const body=declare(Buffer.from('x'),'metadata-limit.txt'),text=Buffer.from(JSON.stringify(body));
      const at=Buffer.concat([text,Buffer.alloc(65536-text.length,0x20)]),over=Buffer.concat([at,Buffer.from(' ')]);
      for(const [name,bytes,expected,expectedReads] of [['at',at,202,65536],['over',over,413,0]]){
        const start=requestEvents.length,prior=(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.reception')).rows[0].n;
        const reply=await request('/api/intake/receptions',{bytes,headers:{'content-type':'application/json'},client,key:randomUUID()});
        const {consumed,...readFacts}=readObservation(start);
        const next=(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.reception')).rows[0].n;
        observations.push({case:'metadata-'+name,status:reply.status,consumed,...readFacts,newReceptions:next-prior});
        assert.deepEqual({status:reply.status,consumed,newReceptions:next-prior},{status:expected,consumed:expectedReads,newReceptions:expected===202?1:0});
      }
    });
    await t.test('actual original declaration over the cap is refused before application capture',async()=>{
      const bytes=Buffer.alloc(1048577,0x78),r=await reserve(declare(bytes.subarray(0,1048576),'over-bound.txt'));
      const start=requestEvents.length,captureStart=storage.length;
      const reply=await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`,{bytes,client});
      const {consumed,...readFacts}=readObservation(start),after=await state(r.reception_id);
      observations.push({case:'original-over-declared',status:reply.status,sentBytes:bytes.length,consumed,...readFacts,after});
      assert.deepEqual({status:reply.status,consumed,captures:storage.length-captureStart,actual:after.attempts[0].actual_bytes,receipts:after.receipts.length},
        {status:413,consumed:0,captures:0,actual:0,receipts:0});
    });
    await t.test('real TLS framing negatives retain a legitimate counterpart and no application reads',async()=>{
      const bytes=Buffer.from('frame\n'),r=await reserve(declare(bytes,'frame.txt')),path=`/api/intake/receptions/${r.reception_id}/attempts/1/original`;
      for(const [name,method,extra,status] of [
        ['duplicate-length','POST',['Content-Length: 6','Content-Length: 6'],400],
        ['length-and-transfer','POST',['Content-Length: 6','Transfer-Encoding: chunked'],400],
        ['encoded','POST',['Content-Length: 6','Content-Encoding: gzip'],400],
        ['wrong-method','PUT',['Content-Length: 6'],400],
        ['wrong-media','POST',['Content-Length: 6'],415],
      ]){
        const start=requestEvents.length,captureStart=storage.length;
        // Credentials are used on the real TLS socket but never persisted in diagnostics.
        const header=[`${method} ${path} HTTP/1.1`,'Host: api.inc02.test:9443',`Origin: ${uiOrigin}`,`Cookie: ${client.cookie}`,
          `X-Ledgerdesk-Csrf: ${client.csrf}`,'Content-Type: '+(name==='wrong-media'?'text/plain':'application/octet-stream'),...extra,'Connection: close','',''].join('\r\n');
        const actual=await rawTls(env,Buffer.concat([Buffer.from(header),bytes]));
        const {consumed,...readFacts}=readObservation(start);
        observations.push({case:'framing-'+name,status:actual.status,consumed,...readFacts,captures:storage.length-captureStart,headers:extra.map(line=>line.split(':')[0])});
        assert.deepEqual({status:actual.status,consumed,captures:storage.length-captureStart},{status,consumed:0,captures:0});
      }
      const good=await request(path,{bytes,client});assert.equal(good.status,200,JSON.stringify(good.body));
      const after=await state(r.reception_id);assert.deepEqual({bytes:after.artifacts[0].bytes,sha256:after.artifacts[0].sha256,receipts:after.receipts.length},
        {bytes:bytes.length,sha256:hash(bytes),receipts:0});observations.push({case:'framing-legitimate',status:good.status,after});
    });
  }finally{
    writeFileSync(output+'/observations.json',JSON.stringify(observations,null,2),{flag:'wx'});
    writeFileSync(output+'/request-reads.json',JSON.stringify(requestEvents.filter(e=>e.kind==='application-read')
      .map(({data,...record})=>record),null,2),{flag:'wx'});
    writeFileSync(output+'/request-discards.json',JSON.stringify(requestEvents.filter(e=>e.kind==='request-discard-start'),null,2),{flag:'wx'});
  }
}

async function rawTls(env,bytes){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,done=false;
    const socket=tls.connect({host:'127.0.0.1',port:9443,servername:'api.inc02.test',ca:env.ca},()=>socket.write(bytes));
    const finish=error=>{if(done)return;done=true;socket.destroy();if(error){reject(error);return;}
      const response=Buffer.concat(chunks),match=response.toString('latin1').match(/^HTTP\/1\.1 (\d{3}) /);
      if(!match){reject(Error('FRAMING_RESPONSE_MISSING'));return;}resolve({status:Number(match[1])});};
    socket.setTimeout(5000,()=>finish(Error('FRAMING_SOCKET_TIMEOUT')));
    socket.on('data',chunk=>{size+=chunk.length;if(size>16384)finish(Error('FRAMING_RESPONSE_LIMIT'));else chunks.push(chunk);});
    socket.once('error',finish);socket.once('end',()=>finish());socket.once('close',()=>{if(!done)finish();});
  });
}
