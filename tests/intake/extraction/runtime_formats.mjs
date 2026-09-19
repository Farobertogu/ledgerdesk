import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {original,BOUNDARIES,MARKDOWN} from './references/cases.mjs';
import {CSV_REFERENCES} from './references/csv.mjs';

function memory(pid){
  const status=readFileSync('/proc/'+pid+'/status','utf8');
  return {rssBytes:Number(status.match(/^VmRSS:\s*(\d+) kB/m)?.[1])*1024,
    processHighWaterBytes:Number(status.match(/^VmHWM:\s*(\d+) kB/m)?.[1])*1024};
}
function expectedProjection(name,bytes,content){
  assert.deepEqual(content.resources,[]);assert.deepEqual(content.relations,[]);
  assert.equal(content.current_use,'not_evaluated');assert.equal(content.inventory,'unknown');
  assert.ok(content.components.some(c=>c.limitations.includes('semantic-fidelity-unverified')));
  if(name==='lines-10001.txt'){
    assert.equal(bytes.equals(Buffer.alloc(10001,10)),true);assert.equal(content.elements.length,10001);
    assert.equal(content.elements.map(e=>e.text).join(''),'\n'.repeat(10001));
  }else if(name==='escaped-limit.csv'||name==='combined-limit.csv'){
    const count=name==='escaped-limit.csv'?16:1000,columns=name==='escaped-limit.csv'?1:64;
    const remainder=1048576-count*columns,base=Math.floor(remainder/count),extra=remainder%count;
    const table=content.elements[0];assert.equal(bytes.length,1048576);assert.equal(table.rows.length,count);
    assert.deepEqual(table.headers,['\u0001'.repeat(base+Number(extra>0)),...Array(columns-1).fill('')]);
    let offset=0;
    for(let i=0;i<count;i++){
      const fields=['\u0001'.repeat(base+Number(i<extra)),...Array(columns-1).fill('')],raw=fields.join(',')+'\n',end=offset+Buffer.byteLength(raw);
      assert.deepEqual(table.rows[i],{index:i,fields,raw,byte_range:[offset,end]});
      assert.deepEqual(bytes.subarray(offset,end),Buffer.from(raw));offset=end;
    }
    assert.equal(offset,1048576);
  }else if(name.startsWith('control-')){
    assert.equal(content.outcome,'completed','An admitted strict UTF-8 original must survive the technical output budget');
    assert.equal(bytes.equals(Buffer.alloc(bytes.length,1)),true);
    const recovered=Buffer.from(content.elements.map(e=>e.text).join(''));
    assert.deepEqual({bytes:recovered.length,sha256:createHash('sha256').update(recovered).digest('hex')},
      {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }else if(name==='inert.md'){
    assert.equal(bytes.toString(),MARKDOWN);assert.equal(content.elements.map(e=>e.text).join(''),MARKDOWN);
  }else if(name==='at-byte-limit.txt'){
    assert.equal(bytes.length,1048576);assert.equal(bytes.equals(Buffer.alloc(1048576,'x')),true);
    assert.equal(content.elements.map(e=>e.text).join(''),'x'.repeat(1048576));
  }else if(CSV_REFERENCES[name]){
    const reference=CSV_REFERENCES[name];assert.equal(bytes.toString(),reference.records.join(''));
    const table=content.elements[0];assert.deepEqual(table.headers,reference.fields[0]);let position=0;
    assert.deepEqual(table.rows,reference.records.map((raw,index)=>{
      const start=position;position+=Buffer.byteLength(raw);return{index,fields:reference.fields[index],raw,byte_range:[start,position]};
    }));assert.equal(position,bytes.length);
  }else{
    const boundary=BOUNDARIES.find(row=>row.file===name);
    if(boundary){
      assert.deepEqual(content.elements.map(e=>e.cells.length),boundary.counts);
      for(const [sheetIndex,sheet]of content.elements.entries()){
        assert.equal(sheet.sheet.name,'Part'+(sheetIndex+1));
        for(const [index,cell]of sheet.cells.entries())assert.deepEqual({address:cell.address,value:cell.value},
          {address:'A'+(index+1),value:{kind:'number_lexical',lexical:String(sheetIndex*100000+index+1)}});
      }
    }else{
      const sheet=content.elements[0],cell=sheet.cells.find(c=>c.address==='D2');
      assert.equal(cell.formula,'B2*C2');
      const cache={'baseline.xlsx':'25.00','cache-discrepant.xlsx':'24.00','cache-zero.xlsx':'0','unsupported-part.xlsx':'25.00'}[name];
      assert.deepEqual(cell.cached,cache===undefined?{kind:'missing',lexical:''}:{kind:'number_lexical',lexical:cache});
      assert.deepEqual(sheet.cells.find(c=>c.address==='A2').value,{kind:'text',lexical:'001'});
      if(name==='unsupported-part.xlsx'){
        assert.equal(content.outcome,'partial');
        const incident=content.incidents.find(i=>i.detail==='xl/media/image1.svg');assert.ok(incident);
        assert.equal(incident.cause,'route_unoffered');
        assert.ok(content.components.some(c=>c.id===incident.component&&c.execution==='not_attempted'&&c.coverage==='none'));
      }
    }
  }
  if(name!=='unsupported-part.xlsx')assert.equal(content.outcome,'completed');
}

/** Full receipt/storage/query paths. Original references precede each dispatch. */
export async function extractionFormatCases(t,{env,intake,client,request,terminal}){
  await extractionControl(env,{allFormats:true});
  const cases=[['inert.md','markdown-inert/1','text/markdown'],['table.csv','csv-utf8/1','text/csv'],
    ['unicode-records.csv','csv-utf8/1','text/csv'],
    ...['baseline.xlsx','cache-discrepant.xlsx','cache-missing.xlsx','cache-zero.xlsx','unsupported-part.xlsx',
      ...BOUNDARIES.filter(row=>row.expected==='completed').map(row=>row.file)]
      .map(name=>[name,'xlsx-cells/1','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    ['at-byte-limit.txt','text-utf8/1','text/plain'],['control-short.txt','text-utf8/1','text/plain'],
    ['control-at-byte-limit.txt','text-utf8/1','text/plain'],['lines-10001.txt','text-utf8/1','text/plain'],
    ['escaped-limit.csv','csv-utf8/1','text/csv'],['combined-limit.csv','csv-utf8/1','text/csv']];
  const observations=[];
  const selected=process.env.LEDGERDESK_EXTRACTION_FORMAT_CASE;
  if(selected&&!cases.some(row=>row[0]===selected))throw Error('EXTRACTION_FORMAT_CASE_UNKNOWN');
  try{for(const [name,format,media]of cases.filter(row=>!selected||row[0]===selected))await t.test('FMT '+name+' survives actual reception, extraction, storage and query',async()=>{
    let controlBytes=name.startsWith('control-')?Buffer.alloc(name==='control-short.txt'?131072:1048576,1):null;
    if(name==='lines-10001.txt')controlBytes=Buffer.alloc(10001,10);
    if(name==='escaped-limit.csv'||name==='combined-limit.csv'){
      const records=name==='escaped-limit.csv'?16:1000,columns=name==='escaped-limit.csv'?1:64,remainder=1048576-records*columns;
      controlBytes=Buffer.from(Array.from({length:records},(_,i)=>'\u0001'.repeat(Math.floor(remainder/records)+Number(i<remainder%records))+','.repeat(columns-1)+'\n').join(''));
    }
    const input=controlBytes?{bytes:controlBytes,reference:{name,bytes:controlBytes.length,sha256:createHash('sha256').update(controlBytes).digest('hex'),
      construction:'Deterministic literal input fixed before dispatch; byte/line/record/column expectations do not depend on the producer'}}:await original(name);
    const service=new ExtractionService(intake),started=performance.now();
    const observed={name,format,reference:input.reference,outcome:'pending',memoryBefore:{processing:memory(process.pid),query:memory(terminal.processRef.pid)}};
    observations.push(observed);
    try{
      const receipt=await receivedOriginal(request,client,input.bytes,{name,format,media});observed.jobId=receipt.work.id;
      const dispatched=await service.dispatch(receipt.work.id);observed.rawBytes=dispatched.metadata.raw.bytes;
      assert.equal(dispatched.metadata.reason,null,JSON.stringify(dispatched.metadata));
      const accepted=await service.accept(receipt.work.id);observed.result=accepted;
      const output=(await env.admin.query(`SELECT o.raw_bytes,o.normalized_bytes,o.bytes,o.normalized_sha256
        FROM intake_trial.extraction_output o WHERE o.job_id=$1`,[receipt.work.id])).rows[0];
      observed.output=output;
      const response=await request('/api/intake/extractions/'+receipt.work.id,{client});observed.queryBytes=response.bytes.length;
      assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.result.id,accepted.resultId);
      assert.equal(response.body.original.sha256,input.reference.sha256);assert.equal(response.body.original.bytes,input.reference.bytes);
      const content=response.body.result.content,normalized=Buffer.from(JSON.stringify(content));
      assert.deepEqual(output,{raw_bytes:observed.rawBytes,normalized_bytes:normalized.length,
        bytes:observed.rawBytes+normalized.length,normalized_sha256:createHash('sha256').update(normalized).digest('hex')});
      assert.ok(output.bytes<=EXTRACTION_BOUNDS.conservedBytes);observed.resourceBytes=0;
      expectedProjection(name,input.bytes,content);observed.outcome='passed';
    }catch(error){observed.outcome='failed';observed.failure={name:error.name,message:error.message};throw error;}
    finally{observed.milliseconds=performance.now()-started;observed.memoryAfter={processing:memory(process.pid),query:memory(terminal.processRef.pid)};}
  });}finally{
    writeFileSync('/work/output/extraction-formats.json',JSON.stringify({profile:'intake-extraction-format-journey/1',filter:selected??null,observations,
      memoryMeaning:'Linux per-process VmHWM is cumulative since process start, not a per-case isolated bound; processing and query processes are separate.',
      limitations:['No semantic completeness claim.','Real adapters expose no extracted resource bodies; nonempty resources require separately labeled cases.']},null,2));
  }
}
