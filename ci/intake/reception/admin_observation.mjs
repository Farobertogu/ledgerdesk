// Private test-bridge observation permissions, never operational API authority.
const priorGroups=new Set(['observer','observer-canonical','runtime','phase-lineage','integrity','authority','missing-catalog','transitions','neutrality','original-scope','fragment-permissions','privileges','transactions','delivery-order']);
const fenceGroups=new Set(['fencing-probe','fence-sql','fence-loss','fence-ack','fence-commit','fence-continuation','fence-ipc','fence-restore']);

export function observationActions(group){
  if(priorGroups.has(group))return ['observe-events','arm-observer'];
  return fenceGroups.has(group)?['observe-events']:[];
}

export function eventObservationTarget(group,body){
  if(!observationActions(group).includes('observe-events')||body===null||typeof body!=='object'||
    Array.isArray(body)||Object.getPrototypeOf(body)!==Object.prototype)throw Error('EVENT_OBSERVER_SCOPE');
  const keys=Object.keys(body);
  if(keys.length===0)return 'objects';
  if(keys.length===1&&keys[0]==='participant'&&body.participant==='verifier'&&
    (group==='runtime'||fenceGroups.has(group)))return 'verifier';
  throw Error('EVENT_OBSERVER_SCOPE');
}
