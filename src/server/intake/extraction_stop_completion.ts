import {randomUUID} from 'node:crypto';
import {IntakeFailure} from './protocol.ts';
import type {IntakeStore} from './postgres/store.ts';

/** Complete only the previously authorized, subtractive request. No body read,
 * phase OPEN, output acceptance or fabricated current browser identity. */
export async function finishClosedExtractionStop(db:IntakeStore,job:any){
  const stopped=(await db.query(`SELECT e.*,r.id AS reception_id,r.revision AS reception_revision,r.generation,r.state AS reception_state
    FROM $INTAKE.extraction_event e JOIN $INTAKE.work w ON w.id=e.job_id
    JOIN $INTAKE.receipt c ON c.id=w.receipt_id JOIN $INTAKE.reception r ON r.id=c.reception_id
    WHERE e.job_id=$1 AND e.attempt_generation=$2 AND e.kind='stop_requested' ORDER BY e.recorded_at LIMIT 1`,[job.id,job.attempt_generation])).rows[0];
  const ended=(await db.query("SELECT observation FROM $INTAKE.extraction_event WHERE job_id=$1 AND attempt_generation=$2 AND kind='termination'",
    [job.id,job.attempt_generation])).rows[0];
  if(job.state!=='stopping'||!stopped||ended?.observation.observed!=='closed'||stopped.reception_state!=='received')throw new IntakeFailure(503);
  // This path has an immutable received original, no open upload or append.
  // Its old staging phases and the actual extraction phase have closed. The
  // stop is not a deletion and must preserve authorized original consultation.
  await db.query('SELECT $INTAKE.stop_reception($1,$2,$3)',[stopped.reception_id,stopped.generation,stopped.reception_revision]);
  await db.query("SELECT $INTAKE.advance_extraction($1,$2,$3,'stopping','stopped')",[job.id,job.revision,job.attempt_generation]);
  await db.query('INSERT INTO $INTAKE.extraction_event VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(),job.id,job.attempt_generation,'reconciled',{transition:'stopped',stopRequest:stopped.id},stopped.evidence_id,await db.now()]);
}
