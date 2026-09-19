import fs from 'node:fs';
/** Structural equality is insensitive to PostgreSQL jsonb member ordering. */
export function sameStructure(a,b){
  if(Object.is(a,b))return true;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>sameStructure(v,b[i]));
  return !!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Object.keys(a).length===Object.keys(b).length&&
    Object.keys(a).every(key=>Object.hasOwn(b,key)&&sameStructure(a[key],b[key]));
}
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export function durable(file,bytes){
  const pending=file+'.'+randomUUID()+'.pending',fd=fs.openSync(pending,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Publication is immutable. A hard link cannot silently replace an old object.
  fs.linkSync(pending,file);fs.unlinkSync(pending);
  const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
export function readBounded(file,maximum){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>maximum)throw Error('EXTRACTION_FILE_LIMIT');
    const bytes=fs.readFileSync(fd);if(bytes.length!==stat.size||bytes.length>maximum)throw Error('EXTRACTION_FILE_CHANGED');return bytes;
  }finally{fs.closeSync(fd);}
}
export const json=(file,max=65536)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBounded(file,max)));
export function artifact(value,bytes){return value&&uuid(value.id)&&[1,2].includes(value.generation)&&
  value.bytes===bytes.length&&value.sha256===hash(bytes);}
export function subjectMatches(a,b){return a&&b&&Object.keys(a).sort().join(',')==='attempt_generation,binding_sha256,channel_id,job_id'&&
  Object.keys(a).every(key=>a[key]===b[key]);}
