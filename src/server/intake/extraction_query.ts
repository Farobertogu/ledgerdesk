import {createHash} from 'node:crypto';
import {decodeExtractionContent} from '../../contracts/intake_extraction.ts';
import {EXTRACTION_CONTENT,EXTRACTION_RESPONSE} from '../../contracts/intake_extraction_view.ts';
import {PrivateExtractionPort,extractionSubject} from './extraction_ports.ts';
import {extractionPhase} from './extraction_phase.ts';
import {exact} from './reception.ts';
import {IntakeFailure,type ReceptionRequest} from './protocol.ts';
import type {ReceptionService,PreparedIntake} from './service.ts';
import type {Admission} from './authority.ts';

/** Consultation is neither dispatch nor a repeated acceptance. */
export async function readExtraction(service:ReceptionService,a:Admission,request:ReceptionRequest,
  project?: (body:any, context:any) => Promise<unknown>):Promise<PreparedIntake>{
  if(service.config.extraction!=='intake-execution/1')throw new IntakeFailure(400);
  const context=await service.authority.beforeExtractionSelection(a),db=a.db;
  const j=(await db.query(`SELECT j.*,r.context,r.principal,rcp.id AS receipt_id,rcp.effect_id AS receipt_effect,
    rcp.reception_id,rcp.artifact_id,rcp.generation,rcp.bytes,rcp.sha256
    FROM $INTAKE.extraction_job j JOIN $INTAKE.work w ON w.id=j.id JOIN $INTAKE.receipt rcp ON rcp.id=w.receipt_id
    JOIN $INTAKE.reception r ON r.id=rcp.reception_id WHERE j.id=$1 AND r.context->>'scope_id'=$2 AND r.context->>'purpose_id'=$3`,
    [request.parameters.id,context.scope_id,context.purpose_id])).rows[0];
  if(!j)throw new IntakeFailure(404);
  const reception={id:j.reception_id,principal:j.principal,context:j.context};
  await service.authority.resolve(a,'extraction',undefined,reception);
  const body:any={profile:'intake/1',representation:'intake-extraction/1',view:a.extractionView,
    extraction:{id:j.id,revision:j.revision,state:j.state,attempt_generation:j.attempt_generation},
    receipt:exact(j.receipt_id,1,{id:j.receipt_id,effectId:j.receipt_effect}),
    original:{id:j.artifact_id,generation:j.generation,bytes:j.bytes,sha256:j.sha256},result:null};
  const subject={receptionId:j.reception_id,artifactId:j.artifact_id,generation:j.generation};
  if(a.extractionView==='metadata'){
    // Result identity is a historical fact, not proof of available content. Do
    // not select output locations, raw diagnostics or any protected body here.
    if(j.state==='accepted'){
      const r=(await db.query('SELECT id,effect_id,attempt_generation FROM $INTAKE.extraction_result WHERE id=$1 AND job_id=$2',
        [j.accepted_result,j.id])).rows[0];
      if(!r)throw new IntakeFailure(503);
      body.result={id:r.id,effect:exact(r.effect_id,1,{effectId:r.effect_id}),attempt_generation:r.attempt_generation};
    }
    await service.evidence(a,'extraction','query',subject);
    if(!EXTRACTION_RESPONSE(body))throw new IntakeFailure(503);
    return service.prepared(a,request,200,project ? await project(body,j.context) : body,null,subject);
  }
  if(j.state==='accepted'){
    const r=(await db.query(`SELECT r.*,o.location_binding,o.normalized_sha256,o.normalized_bytes,o.raw_sha256,
      a.binding,to_jsonb(o) AS output_record FROM $INTAKE.extraction_result r JOIN $INTAKE.extraction_output o ON o.id=r.output_id
      JOIN $INTAKE.extraction_attempt a ON a.job_id=r.job_id AND a.attempt_generation=r.attempt_generation
      WHERE r.id=$1 AND r.job_id=$2`,[j.accepted_result,j.id])).rows[0];
    if(!r)throw new IntakeFailure(503);
    const event=await service.evidence(a,'extraction','read_admission',subject);
    const outputs=new PrivateExtractionPort('outputs'),bundle=JSON.parse(r.location_binding);
    let restoreAnchor:{id:string;sha256:string}|undefined;
    if(bundle.namespace!==service.config.namespace){
      if(service.config.namespace!=='intake_restore'||bundle.namespace!=='intake_trial')throw new IntakeFailure(503);
      const retained=(await db.query(`SELECT n.backup_anchor,c.output_manifest_sha256,o.original_row
        FROM intake_control.namespace_admission n JOIN intake_control.extraction_restore_cut c ON c.anchor_id=n.backup_anchor
        JOIN intake_control.extraction_restore_output o ON o.anchor_id=c.anchor_id
        WHERE n.namespace=$1 AND c.target_namespace=n.namespace AND n.enabled AND o.output_id=$2
          AND o.original_row=$3::jsonb`,[service.config.namespace,r.output_id,JSON.stringify(r.output_record)])).rows[0];
      if(!retained)throw new IntakeFailure(503);
      restoreAnchor={id:retained.backup_anchor,sha256:retained.output_manifest_sha256};
    }
    const read=await extractionPhase({db,config:service.config,deadline:a.deadline,binding:r.binding,jobId:j.id,evidenceId:event.id,
      plan:{outputs:['read']},releaseAdmission:false,ports:{outputs},
      clock:label=>service.clock(a,label,'extraction'),barrier:service.hooks.barrier},async phaseId=>{
      await service.hooks.barrier?.('before_extraction_query_read',{jobId:j.id,evidenceId:event.id,backendPid:event.pid});
      await service.clock(a,'extraction-query-read','extraction');
      return outputs.call({profile:'intake-extraction-private/1',action:'read',phaseId,incarnation:service.config.incarnation,
        namespace:service.config.namespace,original:body.original,evidenceId:event.id,subject:extractionSubject(r.binding),bundle,
        ...(restoreAnchor?{restore_anchor:restoreAnchor}:{})});
    });
    const bytes=read.value.ok&&typeof read.value.data==='string'?Buffer.from(read.value.data,'base64'):null;
    if(!bytes||bytes.length!==r.normalized_bytes||createHash('sha256').update(bytes).digest('hex')!==r.normalized_sha256)throw new IntakeFailure(503);
    const content:any=decodeExtractionContent(bytes);
    if(!EXTRACTION_CONTENT(content)||content.source.id!==r.binding.channel_id||content.source.revision!==r.attempt_generation||
      content.source.sha256!==r.raw_sha256)throw new IntakeFailure(503);
    body.result={id:r.id,effect:exact(r.effect_id,1,{effectId:r.effect_id}),attempt_generation:r.attempt_generation,content};
    a.now=await db.now();await service.authority.resolve(a,'extraction',undefined,reception);
  }else await service.evidence(a,'extraction','query',subject);
  if(!EXTRACTION_RESPONSE(body))throw new IntakeFailure(503);
  return service.prepared(a,request,200,project ? await project(body,j.context) : body,null,subject);
}
