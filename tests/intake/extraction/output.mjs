import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {materializeExtraction,materializeSupervisorFailure} from '../../../src/server/intake/extraction_output.ts';
import {decodeObservedJson,decodeIntake,decodePreparedJson} from '../../../src/contracts/intake.ts';
import {requestFixture} from './interface_fixtures.mjs';
import {EXTRACTION_BOUNDS,readWorkerReply} from '../../../src/contracts/intake_extraction.ts';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function retained(name) {
  const root=new URL('../t01/mapping-inputs/',import.meta.url);
  const extraction=JSON.parse(await readFile(new URL(name+'-extraction.json',root),'utf8'));
  const raw=JSON.parse(await readFile(new URL(name+'-raw.json',root),'utf8'));
  const binding=requestFixture().binding;
  binding.original.bytes=extraction.original.bytes;binding.original.sha256=extraction.original.sha256;
  binding.format_profile={text:'text-utf8/1',csv:'csv-utf8/1',xlsx:'xlsx-cells/1'}[extraction.profile];
  const reply={profile:'intake-worker/3',kind:'result',binding,outcome:{kind:'produced',observation:{raw,extraction,runtime:{node:'v22.16.0',sheetjs:'0.20.3',rssBytes:123}}}};
  return {reply,binding,bytes:Buffer.from(JSON.stringify(reply)+'\n')};
}
test('observation JSON allows finite decimals without weakening command canonicalization',()=>{
  const bytes=Buffer.from('{"n":12.5,"z":-0,"e":1e2}');
  assert.deepEqual(decodeObservedJson(bytes),{n:12.5,z:-0,e:100});
  assert.throws(()=>decodeIntake(bytes),/INTAKE_INTEGER/);assert.throws(()=>decodePreparedJson(bytes),/INTAKE_INTEGER/);
  for(const source of ['{"x":1,"x":2}','{"n":NaN}','{"n":1e999}','{"n":01}','{"s":"\\ud800"}'])
    assert.throws(()=>decodeObservedJson(Buffer.from(source)));
});
test('retained text observation projects without an invented preparation or candidate',async()=>{
  const {bytes,binding}=await retained('T01'),result=materializeExtraction(bytes,binding,binding.channel_id);
  const normalized=JSON.parse(result.normalized);
  assert.equal(result.outcome,'completed');assert.equal(result.rawSha256,hash(bytes));assert.deepEqual(result.raw,bytes);
  assert.equal(normalized.elements[2].text,'Under condition Z, receipt R replaces receipt Q.\r\n');
  for(const key of ['preparation','candidate','approval','trial_mapping','raw'])assert.equal(Object.hasOwn(normalized,key),false);
  assert.equal(result.aggregateBytes,result.raw.length+result.normalized.length);
});
test('X07 limitation and affected component survive when visible cell text stays unchanged',async()=>{
  const {bytes,binding}=await retained('X07'),result=materializeExtraction(bytes,binding,binding.channel_id),body=JSON.parse(result.normalized);
  assert.equal(result.outcome,'partial');assert.equal(body.components[0].coverage,'partial');
  assert.ok(body.incidents.some(i=>i.cause==='route_unoffered'&&i.detail==='xl/media/image1.svg'));
  assert.ok(body.components.some(c=>c.execution==='not_attempted'&&c.coverage==='none'&&c.incidents.length>0));
});
test('an intact different original and a forged channel are rejected against the preserved operation',async()=>{
  const original=await retained('T01'),other=await retained('T02');
  assert.throws(()=>materializeExtraction(other.bytes,original.binding,original.binding.channel_id),/ASSOCIATION/);
  assert.throws(()=>materializeExtraction(original.bytes,original.binding,'different-channel'),/ASSOCIATION/);
  const substituted=structuredClone(other.reply);substituted.binding=original.binding;
  assert.throws(()=>materializeExtraction(Buffer.from(JSON.stringify(substituted)),original.binding,original.binding.channel_id),/CONTENT_ASSOCIATION/);
  assert.equal(materializeExtraction(other.bytes,other.binding,other.binding.channel_id).outcome,'completed');
});
test('unknown failure preserves its code without asserting unreadability or observed coverage',()=>{
  const binding=requestFixture().binding;
  const raw=Buffer.from(JSON.stringify({profile:'intake-worker/3',kind:'result',binding,outcome:{kind:'failed',producer_code:'unrecognized_17'}}));
  const body=JSON.parse(materializeExtraction(raw,binding,binding.channel_id).normalized);
  assert.equal(body.outcome,'failed');assert.equal(body.inventory,'unknown');assert.equal(body.components[0].coverage,'unknown');
  assert.deepEqual(body.incidents,[{id:'producer-failure',component:'extraction',cause:'unknown',code:'unrecognized_17'}]);
});
test('closed supervisor failure conserves invalid bytes without fabricating a producer reply',()=>{
  const binding=requestFixture().binding,raw=Buffer.from([0xc3]);
  const result=materializeSupervisorFailure(raw,binding,binding.channel_id,'invalid_output_utf8'),body=JSON.parse(result.normalized);
  assert.deepEqual(result.raw,raw);assert.equal(body.inventory,'unknown');assert.equal(body.components[0].coverage,'unknown');
  assert.deepEqual(body.incidents,[{id:'supervisor-failure',component:'extraction',cause:'technical_failure',code:'invalid_output_utf8'}]);
  assert.throws(()=>materializeSupervisorFailure(raw,binding,'other-channel','invalid_output_utf8'),/ASSOCIATION/);
  assert.throws(()=>materializeSupervisorFailure(raw,binding,binding.channel_id,'EXTRACTION_CHANNEL_BINDING'),/ASSOCIATION/);
});

test('raw exactly at its cap has a separate bounded failure reserve',()=>{
  const binding=requestFixture().binding,raw=Buffer.alloc(EXTRACTION_BOUNDS.stdoutBytes,65);
  const result=materializeSupervisorFailure(raw,binding,binding.channel_id,'output_limit');
  assert.equal(result.raw,raw);assert.equal(result.rawSha256,hash(raw));
  assert.ok(result.normalized.length<=EXTRACTION_BOUNDS.failureBytes);
  assert.ok(result.aggregateBytes<=EXTRACTION_BOUNDS.conservedBytes);
  assert.equal(JSON.parse(result.normalized).incidents[0].code,'output_limit');
  assert.throws(()=>materializeSupervisorFailure(Buffer.alloc(EXTRACTION_BOUNDS.stdoutBytes+1),binding,binding.channel_id,'output_limit'),/RAW_LIMIT/);
});

test('direct observations keep decimals but binding revisions retain lexical integer checks',async()=>{
  const {reply}=await retained('T01');reply.outcome.observation.raw={number:12.5};
  const bytes=Buffer.from(JSON.stringify(reply));assert.equal(readWorkerReply(bytes).outcome.observation.raw.number,12.5);
  for(const value of ['1.0','1e0'])assert.throws(()=>readWorkerReply(Buffer.from(bytes.toString().replace('"revision":1','"revision":'+value))),/INTAKE_INTEGER/);
  assert.throws(()=>readWorkerReply(Buffer.from(JSON.stringify({...reply,profile:'intake-worker/2'}))),/EXTRACTION_REPLY/);
  assert.throws(()=>readWorkerReply(Buffer.from(JSON.stringify({...reply,outcome:{kind:'produced',observation_json:'{}'}}))),/EXTRACTION_REPLY/);
});

test('dense text preserves each literal element and both ranges without repeated original identities',async()=>{
  // Pure projection fixture, not a claim about an actual parser or physical peak.
  const {reply,binding}=await retained('T01');const x=reply.outcome.observation.extraction,n=60000;
  binding.original.bytes=n;x.original.bytes=n;
  x.elements=Array.from({length:n},(_,i)=>({id:'line-'+i,type:'text',text:'\n',
    locator:{original:x.original.sha256,byteRange:[i,i+1],codePointRange:[i,i+1]}}));
  x.inventory={bytes:n,decodedCodePoints:n,elements:n,bomBytes:0};reply.outcome.observation.raw={};
  const raw=Buffer.from(JSON.stringify(reply));assert.ok(raw.length<EXTRACTION_BOUNDS.stdoutBytes);
  const result=materializeExtraction(raw,binding,binding.channel_id),body=JSON.parse(result.normalized);
  assert.deepEqual(result.raw,raw);assert.ok(result.normalized.length<=EXTRACTION_BOUNDS.normalizedBytes);
  assert.equal(body.outcome,'completed');assert.equal(body.elements.length,n);
  assert.equal(body.elements.map(e=>e.text).join(''),'\n'.repeat(n));
  for(let i=0;i<n;i++)assert.deepEqual(body.elements[i],{id:'line-'+i,kind:'text',text:'\n',
    original_range:{bytes:[i,i+1],code_points:[i,i+1]}});
  assert.equal(body.components.find(c=>c.id==='extraction').execution,'completed');
  assert.deepEqual(body.incidents,[]);
});
