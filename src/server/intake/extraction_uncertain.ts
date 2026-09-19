import {randomUUID} from 'node:crypto';
import {IntakeStore} from './postgres/store.ts';
import {currentIntakeControl} from './authority.ts';
import {extractionSubject} from './extraction_ports.ts';
import type {IntakeConfig} from './config.ts';
import type {WorkerBinding} from '../../contracts/intake_extraction.ts';

/** Record an interrupted, previously admitted dispatch. This preserves a fact;
 * it neither asserts termination nor authorizes body access or another attempt. */
export async function recordUncertainDispatch(config:IntakeConfig,binding:WorkerBinding){
  const db=new IntakeStore(config,()=>{});
  try{
    await db.admit(true);await db.begin(['intake:extraction-capacity','intake:extraction:'+binding.job.id]);
    await currentIntakeControl(db,config,await db.now());
    const row=(await db.query(`SELECT j.*,a.binding FROM $INTAKE.extraction_job j JOIN $INTAKE.extraction_attempt a
      ON a.job_id=j.id AND a.attempt_generation=j.attempt_generation WHERE j.id=$1`,[binding.job.id])).rows[0];
    if(!row||row.attempt_generation!==binding.attempt_generation||row.accepted_result||
      !['claimed','running','stopping'].includes(row.state))return;
    const actual=extractionSubject(row.binding),expected=extractionSubject(binding);
    if(Object.keys(expected).some(key=>actual[key as keyof typeof actual]!==expected[key as keyof typeof expected]))throw Error('EXTRACTION_UNCERTAIN_PREDECESSOR');
    await db.query("SELECT $INTAKE.advance_extraction($1,$2,$3,$4,'uncertain')",[row.id,row.revision,row.attempt_generation,row.state]);
    await db.query('INSERT INTO $INTAKE.extraction_event VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(),row.id,row.attempt_generation,'uncertain',{cause:'dispatch-not-reconciled',subject:expected},null,await db.now()]);
    await db.commit();
  }finally{await db.close();}
}
