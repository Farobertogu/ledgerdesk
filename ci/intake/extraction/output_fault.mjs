// Owned test control, not a serving operation. Preserve both original and fault.
import fs from 'node:fs';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
import {uuid,json,readBounded,artifact,durable} from './storage.mjs';
const input=JSON.parse(process.argv[2]??'{}');
if(process.platform!=='linux'||process.getuid()!==1000||Object.keys(input).sort().join(',')!=='channel,faultId,mode'||
  !uuid(input.channel)||!uuid(input.faultId)||!['missing','corrupt','restore'].includes(input.mode))throw Error('EXTRACTION_FAULT_SCOPE');
const directory='/output/bundles/'+input.channel,manifest=json(directory+'/manifest.json');
if(manifest.id!==input.channel)throw Error('EXTRACTION_FAULT_ASSOCIATION');
const target=directory+'/normalized.bin',prefix=directory+'/fault-'+input.faultId;
if(input.mode==='restore'){
  const recorded=json(prefix+'.json');
  if(recorded.channel!==input.channel||!artifact(manifest.normalized,readBounded(prefix+'.original',EXTRACTION_BOUNDS.normalizedBytes)))throw Error('EXTRACTION_FAULT_PREDECESSOR');
  if(fs.existsSync(target))fs.renameSync(target,prefix+'.injected');
  fs.renameSync(prefix+'.original',target);
}else{
  if(fs.existsSync(prefix+'.json')||!artifact(manifest.normalized,readBounded(target,EXTRACTION_BOUNDS.normalizedBytes)))throw Error('EXTRACTION_FAULT_PREDECESSOR');
  durable(prefix+'.json',Buffer.from(JSON.stringify({...input,original:manifest.normalized})));
  fs.renameSync(target,prefix+'.original');
  if(input.mode==='corrupt'){
    const bytes=readBounded(prefix+'.original',EXTRACTION_BOUNDS.normalizedBytes);bytes[Math.floor(bytes.length/2)]^=1;
    durable(target,bytes);
  }
}
console.log(JSON.stringify({ok:true,...input,original:manifest.normalized}));
