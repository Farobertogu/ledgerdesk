import {closed,choice,identifier,record,artifactReference} from '../../../src/contracts/intake.ts';
import {WORKER_REQUEST_V3,EXTRACTION_BOUNDS,EXTRACTION_RAW,EXTRACTION_NORMALIZED} from '../../../src/contracts/intake_extraction.ts';
import {uuid,subjectMatches} from './storage.mjs';

const subject=v=>record(v)&&subjectMatches(v,v)&&uuid(v.job_id)&&uuid(v.channel_id)&&
  [1,2].includes(v.attempt_generation)&&/^[a-f0-9]{64}$/.test(v.binding_sha256);
const base64=maximum=>v=>{
  if(typeof v!=='string'||v.length%4||v.length>4*Math.ceil(maximum/3))return false;
  const padding=v.endsWith('==')?2:v.endsWith('=')?1:0;
  for(let i=0;i<v.length-padding;i++){const c=v.charCodeAt(i);
    if(!(c>=65&&c<=90||c>=97&&c<=122||c>=48&&c<=57||c===43||c===47))return false;}
  return true;
};
const original=v=>artifactReference(v)&&v.bytes<=EXTRACTION_BOUNDS.originalBytes;
const common={id:uuid,profile:choice('intake-extraction-private/1'),phaseId:uuid,incarnation:identifier,
  namespace:choice('intake_trial','intake_restore'),original,evidenceId:uuid,subject};
const bundle=closed({id:uuid,raw:EXTRACTION_RAW,normalized:EXTRACTION_NORMALIZED,
  namespace:choice('intake_trial','intake_restore'),subject});
/** Closed field sets bound the metadata reserved around the two base64 payloads. */
export function extractionDataRequest(request,participant){
  if(participant==='extraction')return closed({...common,action:choice('run'),request:WORKER_REQUEST_V3,
    image:v=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v),data:base64(EXTRACTION_BOUNDS.originalBytes)})(request)||
    closed({...common,action:choice('read'),raw:EXTRACTION_RAW})(request);
  return participant==='outputs'&&(closed({...common,action:choice('read'),bundle})(request)||
    closed({...common,namespace:choice('intake_restore'),action:choice('read'),bundle,
      restore_anchor:closed({id:uuid,sha256:v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)})})(request)||
    closed({...common,action:choice('seal'),raw:EXTRACTION_RAW,normalized:EXTRACTION_NORMALIZED,
      data:base64(EXTRACTION_BOUNDS.stdoutBytes),normalizedData:base64(EXTRACTION_BOUNDS.normalizedBytes)})(request));
}
