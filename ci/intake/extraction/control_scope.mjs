import {uuid,subjectMatches} from './storage.mjs';

/** These metadata controls cannot carry bodies, actions, paths or authority. */
export function extractionControlRequest(request,kind){
  if(!request||!uuid(request.id)||!subjectMatches(request.subject,request.subject))return false;
  const subject=request.subject;
  if(!uuid(subject.job_id)||!uuid(subject.channel_id)||![1,2].includes(subject.attempt_generation)||
    !/^[a-f0-9]{64}$/.test(subject.binding_sha256??''))return false;
  const keys=Object.keys(request).sort().join(',');
  return kind==='stop'
    ? request.profile==='intake-extraction-stop/1'&&keys==='id,profile,subject'
    : kind==='observation'&&request.profile==='intake-extraction-observation/1'&&uuid(request.phaseId)&&keys==='id,phaseId,profile,subject';
}
