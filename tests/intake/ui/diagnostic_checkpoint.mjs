import {writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';

export const checkpointCases = Object.freeze(['W01', 'W14-prepared', 'W14-difference', 'W15', 'W16',
  'W17-false', 'W17-true', 'W18', 'W19-same-account', 'W19-other-account', 'W20']);
export const preparationCases = Object.freeze(['W01','W09','W10','W11-relationship','W11-collision','W12','W13']);
export const preparationTestNames=Object.freeze({
  W01:'W01 identified real Next route receives an original through HTTPS and durable storage',
  W09:'W09 real human preparation persists exact original provenance, a correction and its difference',
  W10:'W10 exact inspected proposal constitutes one candidate and neither approves nor publishes',
  'W11-relationship':'W11 relationship is a distinct real disposition without another candidate',
  'W11-collision':'W11 collision is a distinct real disposition without another candidate',
  W12:'W12 visible Markdown, CSV and XLSX preserve independent lexical, cache and context facts',
  W13:'W13 lost staging reply recovers current staged state and explicitly finalizes without reupload',
});
const preparationStages=new Set(['dispatch_enter','phase_committed','input_dispatch_enter','parser_launch_observed','dispatch_returned','accept_enter','accept_returned']);
const uuid=value=>value===null||typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const caseStages = new Set(['action_started', 'action_returned', 'action_threw', 'observer_settled']);
const segmentStages = new Set(['workspace_enter', 'app_prepare_enter', 'chromium_launch_enter', 'protection_enter',
  'context_close_enter', 'browser_close_enter', 'server_close_enter', 'app_close_enter', 'workspace_closed']);
export const checkpointFailureMarker = 'INTAKE_WORKSPACE_CHECKPOINT_WRITE_FAILED';
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
const allowed = (caseId, stage, group='ui-protection') => caseId === null ? segmentStages.has(stage)||group==='ui-preparation'&&stage==='preparation_enter' :
  (group==='ui-preparation'?preparationCases:checkpointCases).includes(caseId) && (caseStages.has(stage)||group==='ui-preparation'&&preparationStages.has(stage));

export function validateCheckpoint(value) {
  if(value?.group==='ui-preparation'){
    if(!exact(value,['profile','group','events','overflow','lastEvent','lastOperation'])||value.profile!=='intake-workspace-checkpoints/2'||
      !Array.isArray(value.events)||value.events.length>64||!Number.isSafeInteger(value.overflow)||value.overflow<0)throw Error('WORKSPACE_CHECKPOINT_INVALID');
    const valid=(e,seq)=>exact(e,['seq','caseId','stage','jobId','phaseId'])&&e.seq===seq&&allowed(e.caseId,e.stage,value.group)&&uuid(e.jobId)&&uuid(e.phaseId)&&
      (e.jobId===null?e.phaseId===null:true);
    if(value.events.some((e,i)=>!valid(e,i+1))||!valid(value.lastEvent,value.events.length+value.overflow)||
      !value.overflow&&JSON.stringify(value.lastEvent)!==JSON.stringify(value.events.at(-1))||value.lastOperation!==null&&
      (!Number.isSafeInteger(value.lastOperation?.seq)||value.lastOperation.seq<1||value.lastOperation.seq>value.events.length+value.overflow||
      !valid(value.lastOperation,value.lastOperation.seq)||!preparationStages.has(value.lastOperation.stage)))throw Error('WORKSPACE_CHECKPOINT_INVALID');
    return structuredClone(value);
  }
  if (!exact(value, ['profile', 'group', 'events', 'overflow']) || value.profile !== 'intake-workspace-checkpoints/1' ||
      value.group !== 'ui-protection' || !Array.isArray(value.events) || value.events.length > 64 ||
      !Number.isSafeInteger(value.overflow) || value.overflow < 0) throw Error('WORKSPACE_CHECKPOINT_INVALID');
  if (value.events.some((event, i) => !exact(event, ['seq', 'caseId', 'stage']) || event.seq !== i + 1 ||
      !allowed(event.caseId, event.stage))) throw Error('WORKSPACE_CHECKPOINT_INVALID');
  return {profile: value.profile, group: value.group,
    events: value.events.map(({seq, caseId, stage}) => ({seq, caseId, stage})), overflow: value.overflow};
}

function atomicWrite(directory, bytes) {
  const pending = path.join(directory, 'workspace-checkpoints.pending');
  writeFileSync(pending, bytes);
  renameSync(pending, path.join(directory, 'workspace-checkpoints.json'));
}

// Fixed boundaries only. Diagnostic failure must neither replace an action's
// error nor turn it into success; the fixed marker invalidates a stale file.
export function createWorkspaceCheckpoint(directory, {persist = atomicWrite, report = console.log, group='ui-protection'} = {}) {
  if(!['ui-protection','ui-preparation'].includes(group))throw Error('WORKSPACE_CHECKPOINT_GROUP');
  const preparation=group==='ui-preparation';
  const state = {profile: preparation?'intake-workspace-checkpoints/2':'intake-workspace-checkpoints/1', group, events: [], overflow: 0,
    ...(preparation?{lastEvent:null,lastOperation:null}:{})};
  let failed = false,currentCase=null,currentJob=null,currentPhase=null;
  function mark(stage, caseId = null, association={jobId:null,phaseId:null}) {
    try {
      if (!allowed(caseId, stage,group)||!uuid(association.jobId)||!uuid(association.phaseId)) throw Error('WORKSPACE_CHECKPOINT_INVALID');
      const event={seq:state.events.length+state.overflow+1,caseId,stage,...(preparation?association:{})};
      if(preparation)state.lastEvent=event;
      if(preparation&&preparationStages.has(stage))state.lastOperation=event;
      if (state.events.length < 64) state.events.push(event);
      else state.overflow = Math.min(Number.MAX_SAFE_INTEGER, state.overflow + 1);
      const bytes = Buffer.from(JSON.stringify(state) + '\n');
      if (bytes.length > 16384) throw Error('WORKSPACE_CHECKPOINT_BOUND');
      persist(directory, bytes);
    } catch {
      if (!failed) {failed = true; try {report(checkpointFailureMarker);} catch { /* Preserve the existing outcome. */ }}
    }
  }
  mark('workspace_enter');
  return {mark,stage:(stage,jobId,phaseId=null)=>{
    if(currentJob!==jobId||['dispatch_enter','accept_enter'].includes(stage))currentPhase=null;
    currentJob=jobId;if(phaseId!==null)currentPhase=phaseId;
    mark(stage,currentCase,{jobId,phaseId:currentPhase});
  },wrap(observer) {
    return {mark: (...args) => observer.mark(...args), async run(name, action) {
      try {
        currentCase=name;
        return await observer.run(name, async () => {
          mark('action_started', name);
          try {const result = await action(); mark('action_returned', name); return result;}
          catch (error) {mark('action_threw', name); throw error;}
        });
      } finally {mark('observer_settled', name);currentCase=null;}
    }};
  }};
}
