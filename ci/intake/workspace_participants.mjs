const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const status=v=>['present','absent','invalid','truncated'].includes(v)?v:'invalid';
const reason=v=>v===null?null:['deadline','worker_timeout','output_limit','output-limit','input-failed','spawn-failed',
  'process_exit','stop_requested','stopped','invalid_utf8','invalid-utf8'].includes(v)?v:'other';
const sameSubject=(a,b)=>a&&b&&['job_id','attempt_generation','channel_id','binding_sha256'].every(k=>a[k]===b[k]);
// A later read of accepted output is a different private request, not a second
// parser launch. Do not bind its relay closure to the dispatch bridge record.
export const dispatchPhases=checkpoint=>[...checkpoint.events,checkpoint.lastOperation].filter(e=>e?.phaseId&&
  ['input_dispatch_enter','parser_launch_observed','dispatch_returned'].includes(e.stage));

/** Read-only projection, not a new source of worker authority or closure. */
export function preparationParticipants(checkpoint,input){
  const unknown={status:'unavailable',observations:[],overflow:0};
  if(!checkpoint||checkpoint.group!=='ui-preparation')return unknown;
  if(!input)return unknown;
  if(input.events?.status!=='present')return {...unknown,status:status(input.events?.status)};
  if(!Array.isArray(input.events.value))return {...unknown,status:'invalid'};
  const phases=dispatchPhases(checkpoint),observations=[];let overflow=0,invalid=false;
  for(const event of input.events.value){
    if(event?.kind!=='private-worker-closed')continue;
    const phase=phases.find(p=>p.phaseId===event.phaseId&&p.jobId===event.subject?.job_id);
    if(!phase)continue;
    const subject=event.subject,stop=event.termination;
    if(!uuid(subject?.channel_id)||!uuid(stop?.requestId)||!Number.isInteger(subject.attempt_generation)||
      !/^[a-f0-9]{64}$/.test(subject.binding_sha256??'')||stop.profile!=='intake-child-stop/1'||
      integer(stop.startedAtMs)===null||integer(stop.closedAtMs)===null||stop.closedAtMs<stop.startedAtMs||
      integer(stop.workerPid)===null||typeof event.parserConfirmed!=='boolean'){invalid=true;continue;}
    if(observations.length===16){overflow++;continue;}
    const bridge=input.bridges?.[subject.channel_id];
    let bridgeState={request:status(bridge?.request?.status??'absent'),completion:status(bridge?.completion?.status??'absent'),
      closed:null,failed:null,exitCode:null,reason:null};
    if(bridge?.request?.status==='present'){
      const request=bridge.request.value;
      if(request?.id!==stop.requestId||request.channel!==subject.channel_id||!sameSubject(request.subject,subject)){
        bridgeState.request='invalid';bridgeState.completion='invalid';
      }else if(bridge?.completion?.status==='present'){
        const completed=bridge.completion.value;
        if(completed?.requestId!==request.id||!sameSubject(completed.subject,subject)||typeof completed.closed!=='boolean'||typeof completed.failed!=='boolean'||
          completed.metadata!==null&&completed.metadata?.channel_id!==subject.channel_id)bridgeState.completion='invalid';
        else bridgeState={...bridgeState,closed:completed.closed,failed:completed.failed,
          exitCode:Number.isInteger(completed.metadata?.exit_code)?completed.metadata.exit_code:null,
          reason:completed.metadata?reason(completed.metadata.reason):'unknown'};
      }
    }else if(bridgeState.completion==='present')bridgeState.completion='invalid';
    observations.push({caseId:phase.caseId,jobId:phase.jobId,phaseId:phase.phaseId,channelId:subject.channel_id,requestId:stop.requestId,
      privateWorker:{closed:true,parserConfirmed:event.parserConfirmed,workerPid:stop.workerPid,startedAtMs:stop.startedAtMs,closedAtMs:stop.closedAtMs,
        exitCode:Number.isInteger(stop.exitCode)?stop.exitCode:null,signal:stop.signal===null?null:['SIGKILL','SIGTERM'].includes(stop.signal)?stop.signal:'other',
        reason:reason(stop.reason),failureCode:event.failureCode===null?null:['EXTRACTION_PRIVATE_FAILURE','EXTRACTION_STOPPED_BEFORE_CREATE',
          'EXTRACTION_COMPLETION_TIMEOUT','EXTRACTION_COMPLETION_FAILED'].includes(event.failureCode)?event.failureCode:'other'},bridge:bridgeState});
  }
  return {status:invalid?'invalid':overflow?'truncated':observations.length?'present':'no_correlated_observation',observations,overflow};
}
