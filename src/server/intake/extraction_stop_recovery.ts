import {randomUUID} from 'node:crypto';
import {IntakeStore} from './postgres/store.ts';
import {currentIntakeControl} from './authority.ts';
import {extractionSubject} from './extraction_ports.ts';
import {finishClosedExtractionStop} from './extraction_stop_completion.ts';
import type {IntakeConfig} from './config.ts';
import type {WorkerBinding} from '../../contracts/intake_extraction.ts';

/** Complete a durable stop after a lost dispatch observation. Both the actual
 * predecessor and its durable private phase must be known closed. */
export async function reconcileClosedStop(config:IntakeConfig,binding:WorkerBinding,completion:any){
  const subject=extractionSubject(binding),m=completion?.metadata;
  if(!m||!completion.subject||Object.keys(subject).some(k=>completion.subject[k]!==subject[k as keyof typeof subject])||
    m.channel_id!==binding.channel_id||m.raw?.id!==binding.channel_id||m.raw?.generation!==binding.attempt_generation||
    !/^[a-f0-9]{64}$/.test(m.container_id??'')||!Number.isSafeInteger(m.pid)||m.pid<=0||
    !Array.isArray(m.observations)||!m.observations.some((e:any)=>e.kind==='closed'&&e.id===m.container_id&&e.channel_id===m.channel_id))return false;
  const db=new IntakeStore(config,()=>{});
  try{
    await db.admit(true);await db.begin(['intake:extraction-capacity','intake:extraction:'+binding.job.id]);
    await currentIntakeControl(db,config,await db.now());
    const job=(await db.query(`SELECT j.*,d.image FROM $INTAKE.extraction_job j JOIN intake_control.processing_declaration d
      ON d.id=j.declaration_id AND d.revision=j.declaration_revision WHERE j.id=$1`,[binding.job.id])).rows[0];
    if(!job||job.state!=='stopping'||job.attempt_generation!==binding.attempt_generation||m.image!==job.image)return false;
    const actual=(await db.query('SELECT binding FROM $INTAKE.extraction_attempt WHERE job_id=$1 AND attempt_generation=$2',[job.id,job.attempt_generation])).rows[0];
    if(!actual||extractionSubject(actual.binding).binding_sha256!==subject.binding_sha256)return false;
    const active=(await db.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase;
    const closed=(await db.query(`SELECT p.id FROM intake_control.private_phase p JOIN intake_control.phase_completion c ON c.phase_id=p.id
      JOIN intake_control.extraction_phase_subject s ON s.phase_id=p.id WHERE s.job_id=$1 AND s.attempt_generation=$2 AND s.channel_id=$3
      AND p.namespace=$4 AND p.connection_role='inc03_intake_runtime' AND c.kind='participants_closed'
      AND p.participant_plan='{"objects":["read"],"extraction":["run"]}'::jsonb`,[job.id,job.attempt_generation,binding.channel_id,config.namespace])).rows;
    if(active||closed.length!==1)return false;
    const ended=(await db.query("SELECT id FROM $INTAKE.extraction_event WHERE job_id=$1 AND attempt_generation=$2 AND kind='termination'",[job.id,job.attempt_generation])).rows;
    if(!ended.length)await db.query('INSERT INTO $INTAKE.extraction_event VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(),job.id,job.attempt_generation,'termination',{observed:'closed',containerId:m.container_id,closedAt:m.closed_at,
        exitCode:m.exit_code,reason:m.reason,channelId:m.channel_id,raw:m.raw,reconciledFromPhase:closed[0].id},null,await db.now()]);
    await finishClosedExtractionStop(db,job);await db.commit();return true;
  }finally{await db.close();}
}
