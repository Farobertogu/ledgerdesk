import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {durable,readBounded,json,hash,uuid,artifact,subjectMatches,sameStructure} from './storage.mjs';

import {EXTRACTION_BOUNDS,decodeExtractionPrivate} from '../../../src/contracts/intake_extraction.ts';
import {extractionDataRequest} from './data_scope.mjs';
import {sealOutput} from './seal.mjs';
const mode=process.argv[2];
if(process.platform!=='linux'||process.getuid()!==1000||!['extraction','outputs'].includes(mode))throw Error('EXTRACTION_STORAGE_IDENTITY');
const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>EXTRACTION_BOUNDS.privateBytes)throw Error('EXTRACTION_STORAGE_INPUT_LIMIT');chunks.push(chunk);}
const request=decodeExtractionPrivate(Buffer.concat(chunks));chunks.length=0;
if(!extractionDataRequest(request,mode))throw Error('EXTRACTION_STORAGE_SCOPE');
const q=request.subject;if(!q||!uuid(q.channel_id)||!uuid(q.job_id)||![1,2].includes(q.attempt_generation))throw Error('EXTRACTION_STORAGE_SUBJECT');
const directory='/output/'+(request.namespace==='intake_restore'?'restored/':'')+(mode==='extraction'?'queue':'bundles')+'/'+q.channel_id;
const event=value=>fs.appendFileSync('/output/events.ndjson',JSON.stringify({requestId:request.id,phaseId:request.phaseId,subject:q,atMs:Date.now(),...value})+'\n');
let reply;
if(mode==='extraction'&&request.action==='run'){
  const bytes=Buffer.from(request.data??'','base64');
  if(!request.request||bytes.toString('base64')!==request.data||bytes.length!==request.original.bytes||hash(bytes)!==request.original.sha256)throw Error('EXTRACTION_INPUT_ASSOCIATION');
  durable(directory+'/original',bytes);
  durable(directory+'/request.json',Buffer.from(JSON.stringify({id:request.id,subject:q,request:request.request,image:request.image})));
  event({kind:'queued',bytes:bytes.length});
  const until=Date.now()+80000;
  while(!fs.existsSync(directory+'/completion.json')){if(Date.now()>until)throw Error('EXTRACTION_COMPLETION_UNKNOWN');await delay(20);}
  const completion=json(directory+'/completion.json');
  if(!subjectMatches(q,completion.subject)||completion.requestId!==request.id||!completion.closed)throw Error('EXTRACTION_COMPLETION_ASSOCIATION');
  // This acknowledges the closed controlled execution, not semantic success.
  // A failed producer still has a real immutable observation to classify.
  reply={id:request.id,ok:completion.metadata!==null,metadata:completion.metadata,parserClosed:true};
}else if(mode==='extraction'&&request.action==='read'){
  const completion=json(directory+'/completion.json');
  if(!completion.closed||!subjectMatches(q,completion.subject)||!completion.metadata?.raw||
    !sameStructure(request.raw,completion.metadata.raw))throw Error('EXTRACTION_RAW_ASSOCIATION');
  event({kind:'protected-raw-read',artifactId:request.raw.id});
  const raw=readBounded(directory+'/raw.bin',EXTRACTION_BOUNDS.stdoutBytes);if(!artifact(request.raw,raw))throw Error('EXTRACTION_RAW_INTEGRITY');
  event({kind:'protected-raw-read-complete',artifactId:request.raw.id,bytes:raw.length,sha256:hash(raw)});
  reply={id:request.id,ok:true,data:raw.toString('base64')};
}else if(mode==='outputs'&&request.action==='seal'){
  const raw=Buffer.from(request.data??'','base64'),normal=Buffer.from(request.normalizedData??'','base64');
  if(raw.toString('base64')!==request.data||normal.toString('base64')!==request.normalizedData||
    !artifact(request.raw,raw)||!artifact(request.normalized,normal)||request.raw.id===request.normalized.id||
    raw.length>EXTRACTION_BOUNDS.stdoutBytes||normal.length>EXTRACTION_BOUNDS.normalizedBytes||raw.length+normal.length>EXTRACTION_BOUNDS.conservedBytes)throw Error('EXTRACTION_OUTPUT_INTEGRITY');
  const bundle={id:q.channel_id,raw:request.raw,normalized:request.normalized,namespace:request.namespace,subject:q};
  sealOutput(directory,bundle,raw,normal);
  event({kind:'sealed',raw:bundle.raw,normalized:bundle.normalized});reply={id:request.id,ok:true,bundle};
}else if(mode==='outputs'&&request.action==='read'){
  const bundle=json(directory+'/manifest.json');
  if(bundle.namespace!==request.namespace){
    const retained=json('/output/restored/anchor.json');
    if(request.namespace!=='intake_restore'||bundle.namespace!=='intake_trial'||
      !sameStructure(request.restore_anchor,retained))throw Error('EXTRACTION_RESTORE_ASSOCIATION');
  }else if(request.restore_anchor)throw Error('EXTRACTION_UNEXPECTED_RESTORE_ANCHOR');
  if(!subjectMatches(q,bundle.subject)||!sameStructure(bundle,request.bundle))throw Error('EXTRACTION_OUTPUT_ASSOCIATION');
  event({kind:'protected-normalized-read',artifactId:bundle.normalized.id});
  const bytes=readBounded(directory+'/normalized.bin',EXTRACTION_BOUNDS.normalizedBytes);if(!artifact(bundle.normalized,bytes))throw Error('EXTRACTION_OUTPUT_INTEGRITY');
  event({kind:'protected-normalized-read-complete',artifactId:bundle.normalized.id,bytes:bytes.length,sha256:hash(bytes)});
  reply={id:request.id,ok:true,data:bytes.toString('base64')};
}else throw Error('EXTRACTION_STORAGE_ACTION');
process.stdout.write(JSON.stringify(reply));
