import {randomUUID} from 'node:crypto';
import {WORKER_BINDING,type WorkerBinding,type WorkerRequest,WORKER_PROTOCOL,EXTRACTION_BOUNDS} from '../../contracts/intake_extraction.ts';
import type {ExtractionStatus} from '../../contracts/intake_reception_v2.ts';
import type {ExtractionAdmission} from './extraction_authority.ts';
import {exact} from './reception.ts';
import {IntakeFailure} from './protocol.ts';
import type {IntakeStore} from './postgres/store.ts';

/** Separate original generation from the producer attempt and immutable effects. */
export async function extractionStatus(db:IntakeStore,workId:string):Promise<ExtractionStatus|null> {
  const row=(await db.query('SELECT id,revision,state,attempt_generation,effect_slot,accepted_result FROM $INTAKE.extraction_job WHERE id=$1',[workId])).rows[0];
  return row?{id:row.id,revision:row.revision,state:row.state,attempt_generation:row.attempt_generation,
    result_effect:row.accepted_result?exact(row.effect_slot,1,{effectId:row.effect_slot}):null}:null;
}
export async function admitJob(a:ExtractionAdmission) {
  if(a.job)return a.job;
  const count=Number((await a.db.query('SELECT count(*) FROM $INTAKE.extraction_job')).rows[0].count);
  if(count>=32)throw new IntakeFailure(429);
  const d=a.declaration;
  a.job=(await a.db.query(`INSERT INTO $INTAKE.extraction_job(id,declaration_id,declaration_revision,declaration_sha256,format,state,effect_slot,created_at)
    VALUES($1,$2,$3,$4,$5,'eligible',$6,$7) RETURNING *`,[a.work.id,d.id,d.revision,d.sha256,d.format,randomUUID(),a.now])).rows[0];
  return a.job;
}
export function extractionRequest(a:ExtractionAdmission):WorkerRequest {
  if(!a.job||a.job.state!=='eligible'||a.job.attempt_generation>=EXTRACTION_BOUNDS.maximumAttempts)throw new IntakeFailure(409);
  const d=a.declaration,attempt=a.job.attempt_generation+1,dispatch=randomUUID();
  const binding:WorkerBinding={deployment:a.reception.deployment,
    control:exact(a.control.source_id,a.control.revision,{source:a.control.source_id,incarnation:a.control.incarnation,generation:a.control.generation}),
    job:exact(a.job.id,a.job.revision,{id:a.job.id,revision:a.job.revision}),
    receipt:exact(a.receipt.id,1,{id:a.receipt.id,effectId:a.receipt.effect_id}),
    request:d.request,plan:d.plan,assignment:d.assignment,worker:d.worker,configuration:d.configuration,limits:d.limits,
    dispatch_effect:exact(dispatch,1,{effectId:dispatch}),attempt_generation:attempt,claim_id:randomUUID(),channel_id:randomUUID(),
    original:{id:a.receipt.artifact_id,generation:a.receipt.generation,bytes:a.receipt.bytes,sha256:a.receipt.sha256},
    format_profile:d.format,output_namespace:a.db.namespace};
  if(!WORKER_BINDING(binding))throw new IntakeFailure(503);
  return {profile:WORKER_PROTOCOL,kind:'extract',binding,input_path:'/input/original',limits:EXTRACTION_BOUNDS};
}
export async function claimJob(a:ExtractionAdmission,request:WorkerRequest,evidenceId:string) {
  const b=request.binding;
  if(!a.job)throw new IntakeFailure(503);
  let claimed;
  try{claimed=await a.db.query('SELECT $INTAKE.claim_extraction($1,$2,$3,$4,$5,$6,$7,$8) AS generation',
    [a.job.id,a.job.revision,b.claim_id,b.channel_id,b.dispatch_effect.id,JSON.stringify(b),evidenceId,a.deadline]);}
  catch(error){if((error as {code?:string}).code==='53400')throw new IntakeFailure(429);throw error;}
  if(claimed.rows[0].generation!==b.attempt_generation)throw new IntakeFailure(503);
  a.job=(await a.db.query('SELECT * FROM $INTAKE.extraction_job WHERE id=$1',[a.work.id])).rows[0];
}
export async function extractionEvent(a:ExtractionAdmission,kind:'launch'|'termination'|'uncertain'|'stop_requested'|'rejected'|'staged'|'accepted'|'reconciled',
  observation:Record<string,unknown>,evidenceId:string|null=null) {
  if(!a.job||a.job.attempt_generation<1)throw new IntakeFailure(503);
  const id=randomUUID();
  await a.db.query('INSERT INTO $INTAKE.extraction_event VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id,a.job.id,a.job.attempt_generation,kind,JSON.stringify(observation),evidenceId,await a.db.now()]);
  return id;
}
export async function advanceJob(a:ExtractionAdmission,next:string) {
  if(!a.job)throw new IntakeFailure(503);
  await a.db.query('SELECT $INTAKE.advance_extraction($1,$2,$3,$4,$5)',[a.job.id,a.job.revision,a.job.attempt_generation,a.job.state,next]);
  a.job=(await a.db.query('SELECT * FROM $INTAKE.extraction_job WHERE id=$1',[a.work.id])).rows[0];
}
