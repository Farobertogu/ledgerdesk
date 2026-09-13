import { createHash, randomUUID } from 'node:crypto';
import type { ExactReference, OriginalReference, ReceptionResponse } from '../../contracts/intake_reception.ts';
import { RECEPTION_RESPONSE } from '../../contracts/intake_reception.ts';
import { canonicalValue } from '../../contracts/access_canonical.ts';
import type { Admission } from './authority.ts';
import type { IntakeConfig } from './config.ts';
import { RECEPTION_BOUNDS } from './config.ts';
import { IntakeFailure } from './protocol.ts';
import type { IntakeStore } from './postgres/store.ts';

export function exact(id:string,revision:number,value:unknown):ExactReference {
  return {id,revision,sha256:createHash('sha256').update(canonicalValue(value)).digest('hex')};
}
export function newReception(config:IntakeConfig,admission:Admission,body:any) {
  const id=randomUUID(),operationId=randomUUID(),artifactId=randomUUID(),effectId=randomUUID();
  const original:OriginalReference={id:artifactId,generation:1,bytes:body.original.bytes,sha256:body.original.sha256};
  const treatment=body.receiving_context.treatment_revision;
  const load={code:'CARGAR_MATERIAL',mode:'person',person:exact(admission.session.person_ref,admission.session.account_revision,{account:admission.session.account_id}),
    intention:exact(operationId,1,{operationId}),original,format:body.format_profile,configuration:config.configuration,
    destination:treatment,limits:config.limits,session:exact('session:'+admission.session.digest,admission.session.revision,{digest:admission.session.digest}),
    receipt_effect:exact(effectId,1,{effectId})};
  const reception={id,deployment:config.deployment,principal:admission.session.account_id,person_ref:admission.session.person_ref,
    origin_session:admission.session.digest,revision:1,generation:1,state:'reserved',declaration:body.original,
    format:body.format_profile,context:body.receiving_context,load_reference:load,configuration:config.configuration,
    effect_slot:effectId,stopped:false,created_at:admission.now};
  const attempt={reception_id:id,generation:1,artifact_id:artifactId,incarnation:config.incarnation,state:'reserved',
    expires_at:admission.deadline,reserved_bytes:body.original.bytes,actual_bytes:0,actual_sha256:null};
  return {reception,attempt,operationId};
}
export function phase(admission:Admission,reception:any,attempt:any) {
  return {executor:admission.executor,reservation:exact(reception.id,reception.revision,{id:reception.id,revision:reception.revision}),
    attempt:attempt.generation,predecessor:reception.load_reference.intention};
}
export async function selected(db:IntakeStore,id:string,principal:string,context?:{scope_id:string;purpose_id:string}) {
  const reception=(await db.query(context
    ?"SELECT * FROM $INTAKE.reception WHERE id=$1 AND principal=$2 AND context->>'scope_id'=$3 AND context->>'purpose_id'=$4"
    :'SELECT * FROM $INTAKE.reception WHERE id=$1 AND principal=$2',
    context?[id,principal,context.scope_id,context.purpose_id]:[id,principal])).rows[0];
  if(!reception)throw new IntakeFailure(404);
  const attempt=(await db.query('SELECT * FROM $INTAKE.attempt WHERE reception_id=$1 AND generation=$2',[id,reception.generation])).rows[0];
  if(!attempt)throw new IntakeFailure(503);
  return {reception,attempt};
}
export async function projection(db:IntakeStore,reception:any,attempt:any,operationId:string):Promise<ReceptionResponse> {
  const receipt=(await db.query('SELECT * FROM $INTAKE.receipt WHERE reception_id=$1',[reception.id])).rows[0];
  const work=receipt?(await db.query('SELECT id,state,dispatchable FROM $INTAKE.work WHERE receipt_id=$1',[receipt.id])).rows[0]:null;
  const availability=receipt?(await db.query('SELECT outcome FROM $INTAKE.availability WHERE artifact_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1',[receipt.artifact_id])).rows[0]?.outcome:null;
  const response:ReceptionResponse={profile:'intake/1',representation:'intake-reception/1',operation_id:operationId,reception_id:reception.id,
    revision:reception.revision,state:reception.state,original:{id:attempt.artifact_id,generation:attempt.generation,bytes:reception.declaration.bytes,sha256:reception.declaration.sha256},
    availability:availability??(attempt.state==='sealed'&&!receipt?'verified_staged':'not_observed'),format_profile:reception.format,
    configuration:reception.configuration,attempt_expires_at:Number(attempt.expires_at),
    effect:receipt?exact(receipt.effect_id,1,{effectId:receipt.effect_id}):null,work:work??null};
  if(!RECEPTION_RESPONSE(response))throw new IntakeFailure(503);
  return response;
}
