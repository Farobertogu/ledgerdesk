import {randomUUID} from 'node:crypto';
import {extractionSubject,type PrivateExtractionPort} from './extraction_ports.ts';
import type {PrivateIntakePort} from './ports.ts';
import type {IntakeStore} from './postgres/store.ts';
import type {IntakeConfig} from './config.ts';
import type {WorkerBinding} from '../../contracts/intake_extraction.ts';
import {IntakeFailure} from './protocol.ts';

/** One durable phase protocol for processing and its separately admitted query. */
export async function extractionPhase<T>(options:{db:IntakeStore;config:IntakeConfig;deadline:number;binding:WorkerBinding;
  jobId:string;evidenceId:string;plan:Record<string,string[]>;releaseAdmission:boolean;
  ports:Record<string,PrivateIntakePort|PrivateExtractionPort>;clock:(label:string)=>Promise<void>;
  barrier?:(label:string,event:Record<string,unknown>)=>Promise<void>},work:(phaseId:string)=>Promise<T>){
  const {db,config,binding,jobId,evidenceId,plan}=options;
  const phaseId=randomUUID(),subject=extractionSubject(binding),backendPid=db.backendPid;
  const participants=Object.keys(plan).map(name=>({name,port:options.ports[name]}));
  if(participants.some(p=>!p.port))throw new IntakeFailure(503);
  await db.query('SELECT intake_control.begin_extraction_phase($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [phaseId,config.namespace,evidenceId,config.controlSource,config.incarnation,jobId,binding.attempt_generation,JSON.stringify(plan),options.deadline]);
  await db.commit();if(options.releaseAdmission)await db.releaseAdmission();
  let value:T|undefined,failure:unknown;
  try{
    await options.barrier?.('extraction_phase_committed',{phaseId,evidenceId,jobId,backendPid});
    for(const {name,port}of participants){
      await options.clock('before_extraction_phase_open');
      const base={id:phaseId,incarnation:config.incarnation,namespace:config.namespace,original:binding.original,evidenceId,actions:plan[name]};
      if(name==='objects')await (port as PrivateIntakePort).openPhase({...base,participant:'objects'});
      else await (port as PrivateExtractionPort).openPhase({...base,participant:name as 'extraction'|'outputs',subject});
    }
    value=await work(phaseId);
  }catch(error){failure=error;}
  const acknowledgments:Record<string,unknown>={};let closureFailure:unknown;
  for(const {name,port}of participants)try{acknowledgments[name]=await port.closePhase(phaseId);}catch(error){closureFailure=error;}
  if(closureFailure||!db.healthy)throw new IntakeFailure(503);
  const retired=(await db.query('SELECT intake_control.finish_phase($1,$2,$3,$4,$5) AS epoch',
    [phaseId,config.controlSource,config.incarnation,evidenceId,JSON.stringify(acknowledgments)])).rows[0]?.epoch;
  if(!retired)throw new IntakeFailure(503);
  if(options.releaseAdmission)await db.reacquireAdmission(true);
  await db.begin([]);await db.query('SELECT intake_control.assert_fence_epoch($1)',[retired]);
  if(failure)throw failure;
  return {value:value as T,phaseId};
}
