import {createHash} from 'node:crypto';
import {record} from '../../contracts/intake.ts';
import {readWorkerReply, workerBindingMatches, EXTRACTION_BOUNDS, type WorkerBinding} from '../../contracts/intake_extraction.ts';
import {projectExtractionObservation, trialFailure} from '../../contracts/intake_mapping.ts';
import {EXTRACTION_CONTENT} from '../../contracts/intake_extraction_view.ts';

export type ExtractionMaterial = {
  outcome:'completed'|'partial'|'failed';raw:Buffer;normalized:Buffer;
  rawSha256:string;normalizedSha256:string;aggregateBytes:number;
};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Supervisor facts do not pretend to be a reply emitted by the producer. */
export function materializeSupervisorFailure(raw:Buffer,expected:WorkerBinding,actualChannel:string,reason:string):ExtractionMaterial {
  if(actualChannel!==expected.channel_id||!['worker_timeout','output_limit','invalid_output_utf8','process_exit','input_failure','stopped'].includes(reason))
    throw Error('EXTRACTION_FAILURE_ASSOCIATION');
  return materializeFailure(raw,expected,reason,false);
}
/** A completed producer is not retroactively failed when its projection is too large. */
function materializeFailure(raw:Buffer,expected:WorkerBinding,reason:string,normalization:boolean):ExtractionMaterial {
  if(raw.length>EXTRACTION_BOUNDS.stdoutBytes)throw Error('EXTRACTION_RAW_LIMIT');
  const rawSha256=hash(raw),component=normalization?'normalization':'extraction',incident=normalization?'normalization-failure':'supervisor-failure';
  const content={profile:'intake-extraction-content/1',original:expected.original,
    source:{id:expected.channel_id,revision:expected.attempt_generation,sha256:rawSha256},format_profile:expected.format_profile,
    outcome:'failed',elements:[],relations:[],resources:[],inventory:'unknown',current_use:'not_evaluated',
    components:[...(normalization?[{id:'extraction',execution:'completed',coverage:'unknown',fidelity:'unchecked',limitations:['raw-observation-retained','semantic-fidelity-unverified'],incidents:[]}]:[]),
      {id:component,execution:'failed',coverage:'unknown',fidelity:'unchecked',
      limitations:['no-complete-result','semantic-fidelity-unverified'],incidents:[incident]}],
    incidents:[{id:incident,component,cause:'technical_failure',code:reason}]};
  if(!EXTRACTION_CONTENT(content))throw Error('EXTRACTION_CONTENT_SHAPE');
  const normalized=Buffer.from(JSON.stringify(content)),aggregateBytes=raw.length+normalized.length;
  if(normalized.length>EXTRACTION_BOUNDS.failureBytes||aggregateBytes>EXTRACTION_BOUNDS.conservedBytes)throw Error('EXTRACTION_FAILURE_RESERVE');
  return {outcome:'failed',raw,normalized,rawSha256,normalizedSha256:hash(normalized),aggregateBytes};
}
/** Called only after read/processing admission. The two conserved artifacts are distinct. */
export function materializeExtraction(raw:Buffer,expected:WorkerBinding,actualChannel:string):ExtractionMaterial {
  const reply=readWorkerReply(raw);
  if(!workerBindingMatches(expected,reply.binding,actualChannel))throw Error('EXTRACTION_OUTPUT_ASSOCIATION');
  const rawSha256=hash(raw),source={id:expected.channel_id,revision:expected.attempt_generation,sha256:rawSha256};
  const original={id:expected.original.id,revision:expected.original.generation,sha256:expected.original.sha256};
  let body:any,outcome:ExtractionMaterial['outcome'];
  if(reply.outcome.kind==='produced') {
    const observation=reply.outcome.observation;
    if(!record(observation)||!record(observation.extraction)||!record(observation.extraction.original)||
      observation.extraction.original.bytes!==expected.original.bytes||observation.extraction.original.sha256!==expected.original.sha256||
      observation.extraction.profile!==({'text-utf8/1':'text','markdown-inert/1':'text','csv-utf8/1':'csv','xlsx-cells/1':'xlsx'}[expected.format_profile]))
      throw Error('EXTRACTION_CONTENT_ASSOCIATION');
    body=projectExtractionObservation(observation,original,source);
    outcome=observation.extraction.outcome as 'completed'|'partial';
  }else {
    const failed=trialFailure({error:reply.outcome.producer_code,detail:''});
    body={elements:[],relations:[],resources:[],inventory:'unknown',current_use:'not_evaluated',
      components:[{id:'extraction',execution:'failed',coverage:'unknown',fidelity:'unchecked',
        limitations:['no-complete-result','semantic-fidelity-unverified'],incidents:['producer-failure']}],
      incidents:[{id:'producer-failure',component:'extraction',cause:failed.cause==='unclassified'?'unknown':failed.cause,
        code:reply.outcome.producer_code}]};
    outcome='failed';
  }
  const content={profile:'intake-extraction-content/1',original:expected.original,source,format_profile:expected.format_profile,outcome,...body};
  if(!EXTRACTION_CONTENT(content))throw Error('EXTRACTION_CONTENT_SHAPE');
  const normalized=Buffer.from(JSON.stringify(content));
  if(normalized.length>EXTRACTION_BOUNDS.normalizedBytes)return materializeFailure(raw,expected,'normalized_output_limit',reply.outcome.kind==='produced');
  const aggregateBytes=raw.length+normalized.length;
  if(aggregateBytes>EXTRACTION_BOUNDS.conservedBytes)throw Error('EXTRACTION_CONSERVED_LIMIT');
  return {outcome,raw,normalized,rawSha256,normalizedSha256:hash(normalized),aggregateBytes};
}
