import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export const phaseEvidenceDirectory=relative=>new RegExp('^intake-t02-[A-Za-z0-9-]+/phase-prototype/phase-prototype-'+uuid+'$').test(relative);
export const corruptionObservationName='retained-corruption.json';
const member='control/corrupt-journal/phases.json',expectedBytes=Buffer.from('{broken');
const digest=b=>createHash('sha256').update(b).digest('hex');
const expectedDigest=digest(expectedBytes);
const fail=reason=>{throw Object.assign(Error(reason),{evidenceReason:reason});};
/** A fixed test case reference, never an exemption selected by the retained file. */
export async function retainedCorruptionObservation(folder){
  const observation=path.join(folder,corruptionObservationName);
  let stat;try{stat=await fs.lstat(observation);}catch{fail('corruption-observation-missing');}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2048)fail('corruption-observation-invalid');
  let record;try{record=JSON.parse(await fs.readFile(observation,'utf8'));}catch{fail('corruption-observation-invalid');}
  const expected={profile:'intake-retained-corruption/1',scenario:'corrupt-retained-control',fixture:path.basename(folder),member,
    bytes:expectedBytes.length,sha256:expectedDigest,reopen:'SyntaxError',replacement:'EEXIST',preserved:true};
  if(!record||Array.isArray(record)||Object.keys(record).sort().join(',')!==Object.keys(expected).sort().join(',')||
    Object.entries(expected).some(([key,value])=>record[key]!==value))fail('corruption-observation-binding');
  // Check every private path component before reading; a matching digest cannot justify a link.
  let current=folder;
  for(const part of member.split('/')){current=path.join(current,part);let item;try{item=await fs.lstat(current);}catch{fail('corruption-fixture-missing');}
    if(item.isSymbolicLink()||(part==='phases.json'?!item.isFile():!item.isDirectory()))fail('corruption-fixture-type');}
  const retained=await fs.stat(current);if(retained.size!==expectedBytes.length)fail('corruption-fixture-bytes');
  const bytes=await fs.readFile(current);if(!bytes.equals(expectedBytes)||digest(bytes)!==expectedDigest)fail('corruption-fixture-bytes');
  return expected;
}
