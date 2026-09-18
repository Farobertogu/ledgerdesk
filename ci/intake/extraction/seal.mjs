import fs from 'node:fs';
import {durable,readBounded,json,artifact,sameStructure} from './storage.mjs';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';

/** Reconcile only the exact, currently admitted seal intention. Partial files
 * are never overwritten or treated as a complete accepted result. */
export function sealOutput(directory,bundle,raw,normal){
  if(fs.existsSync(directory+'/manifest.json')){
    if(!sameStructure(json(directory+'/manifest.json'),bundle))throw Error('EXTRACTION_OUTPUT_CONFLICT');
    if(!artifact(bundle.raw,readBounded(directory+'/raw.bin',EXTRACTION_BOUNDS.stdoutBytes))||
      !artifact(bundle.normalized,readBounded(directory+'/normalized.bin',EXTRACTION_BOUNDS.normalizedBytes)))throw Error('EXTRACTION_OUTPUT_INTEGRITY');
    return;
  }
  if(fs.existsSync(directory)){
    if(!sameStructure(json(directory+'/seal-intent.json'),bundle))throw Error('EXTRACTION_OUTPUT_CONFLICT');
  }else{
    fs.mkdirSync(directory,{mode:0o700});
    durable(directory+'/seal-intent.json',Buffer.from(JSON.stringify(bundle)));
  }
  for(const [name,value,bytes,limit]of [['raw.bin',bundle.raw,raw,EXTRACTION_BOUNDS.stdoutBytes],
    ['normalized.bin',bundle.normalized,normal,EXTRACTION_BOUNDS.normalizedBytes]]){
    if(fs.existsSync(directory+'/'+name)){
      if(!artifact(value,readBounded(directory+'/'+name,limit)))throw Error('EXTRACTION_OUTPUT_INTEGRITY');
    }else durable(directory+'/'+name,bytes);
  }
  durable(directory+'/manifest.json',Buffer.from(JSON.stringify(bundle)));
}
