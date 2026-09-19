import {randomUUID} from 'node:crypto';
import {PrivateExtractionPort,extractionSubject} from './extraction_ports.ts';
import {IntakeFailure,type ReceptionRequest} from './protocol.ts';
import type {Admission} from './authority.ts';
import type {ReceptionService,PreparedIntake} from './service.ts';
import {projection} from './reception.ts';
import {reconcileClosedStop} from './extraction_stop_recovery.ts';
import {finishClosedExtractionStop} from './extraction_stop_completion.ts';

/** Caller has already resolved the existing cancel faculty, exact reception,
 * expected revision and canonical intention. This is not a new public route. */
export async function stopExtraction(service:ReceptionService,a:Admission,request:ReceptionRequest,body:any,reception:any,attempt:any,canonical:string,
  token:string|null,onLoss:()=>void):Promise<PreparedIntake|null>{
  if(service.config.extraction!=='intake-execution/1'||reception.state!=='received')return null;
  const job=(await a.db.query(`SELECT j.* FROM $INTAKE.extraction_job j JOIN $INTAKE.work w ON w.id=j.id
    JOIN $INTAKE.receipt r ON r.id=w.receipt_id WHERE r.reception_id=$1`,[reception.id])).rows[0];
  if(!job||job.state==='accepted'||job.state==='stopped')return null;
  if(job.attempt_generation<1)throw new IntakeFailure(409);
  service.expected(body,reception,attempt);
  const producer=(await a.db.query('SELECT binding FROM $INTAKE.extraction_attempt WHERE job_id=$1 AND attempt_generation=$2',[job.id,job.attempt_generation])).rows[0];
  if(!producer)throw new IntakeFailure(503);
  const event=await service.evidence(a,'cancel_reception','effect',{receptionId:reception.id,artifactId:attempt.artifact_id,generation:attempt.generation});
  const intentionId=await service.insertIntention(a,request,canonical,reception.id);
  if(job.state!=='stopping'){
    await a.db.query('SELECT $INTAKE.advance_extraction($1,$2,$3,$4,$5)',[job.id,job.revision,job.attempt_generation,job.state,'stopping']);
    job.revision++;job.state='stopping';
  }
  await a.db.query('INSERT INTO $INTAKE.extraction_event VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(),job.id,job.attempt_generation,'stop_requested',{intentionId,subject:extractionSubject(producer.binding)},event.id,await a.db.now()]);
  const active=(await a.db.query('SELECT active_phase FROM intake_control.fence_head')).rows[0]?.active_phase;
  const ended=(await a.db.query("SELECT observation FROM $INTAKE.extraction_event WHERE job_id=$1 AND attempt_generation=$2 AND kind='termination'",
    [job.id,job.attempt_generation])).rows[0];
  if(!active&&ended?.observation.observed==='closed'){
    await finishClosedExtractionStop(a.db,job);reception.state='stopped';reception.stopped=true;reception.revision++;
    return service.prepared(a,request,200,await projection(a.db,reception,attempt,intentionId,request.representation),intentionId,{receptionId:reception.id});
  }
  // Release the metadata transaction/admission before cessation IPC. The
  // dispatch continuation needs that admission to record actual closure.
  await service.clock(a,'extraction-stop-request','cancel_reception');await a.db.commit();await a.db.close();
  const confirmed=await new PrivateExtractionPort('extraction').stop(extractionSubject(producer.binding));
  if(confirmed.completion)await reconcileClosedStop(service.config,producer.binding,confirmed.completion);
  // Current query admission and the stored intention decide disclosure. A
  // successful stop request is still stopping, never presumed stopped.
  const fresh=await service.authority.open(request,token,[],onLoss,'inc03_intake_reader');
  try{
    await service.authority.beforeMetadata(fresh,'lookup_operation');
    const intention=(await fresh.db.query('SELECT * FROM $INTAKE.intention WHERE id=$1 AND principal=$2',[intentionId,fresh.session.account_id])).rows[0];
    if(!intention)throw new IntakeFailure(404);
    const result=await service.known(fresh,request,intention,canonical);
    return result;
  }
  catch(error){await fresh.db.close();throw error;}
}
