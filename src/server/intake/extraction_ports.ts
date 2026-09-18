import {createConnection} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import type {PrivatePhaseBinding} from './ports.ts';
import {decodeExtractionPrivate,EXTRACTION_BOUNDS} from '../../contracts/intake_extraction.ts';
import type {WorkerRequest,WorkerBinding,Artifact} from '../../contracts/intake_extraction.ts';

export type ExtractionSubject={job_id:string;attempt_generation:number;channel_id:string;binding_sha256:string};
export type ExtractionPhaseBinding=Omit<PrivatePhaseBinding,'participant'>&{participant:'extraction'|'outputs';subject:ExtractionSubject};
export function extractionSubject(binding:WorkerBinding):ExtractionSubject {
  const ordered=(value:any):any=>value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
  return{job_id:binding.job.id,attempt_generation:binding.attempt_generation,channel_id:binding.channel_id,
    binding_sha256:createHash('sha256').update(JSON.stringify(ordered(binding))).digest('hex')};
}
export type CompletedWorker={channel_id:string;container_id:string;image:string;exit_code:number|null;reason:string|null;
  raw:Artifact;started_at:string;closed_at:string;pid:number;observations:Record<string,unknown>[]};
export type SealedExtraction={id:string;raw:Artifact;normalized:Artifact;namespace:string;subject:ExtractionSubject};
export type ExtractionCommand={id?:string;profile:'intake-extraction-private/1';phaseId:string;incarnation:string;
  namespace:string;original:Artifact;evidenceId:string;subject:ExtractionSubject;action:'run'|'read'|'seal';
  request?:WorkerRequest;image?:string;data?:string;raw?:Artifact;normalized?:Artifact;normalizedData?:string;bundle?:SealedExtraction;
  restore_anchor?:{id:string;sha256:string}};

/** Fixed private endpoints; the parser never receives this channel. */
export class PrivateExtractionPort {
  private poisoned=false;
  readonly participant:'extraction'|'outputs';
  constructor(participant:'extraction'|'outputs') {
    if(!['extraction','outputs'].includes(participant))throw Error('EXTRACTION_PRIVATE_PARTICIPANT');
    this.participant=participant;
  }
  private exchange(body:Record<string,unknown>,control=false):Promise<any> {
    if(this.poisoned&&!control)return Promise.reject(Error('EXTRACTION_PRIVATE_UNRECONCILED'));
    const id=randomUUID(),bytes=Buffer.from(JSON.stringify({id,...body}));
    if(bytes.length>EXTRACTION_BOUNDS.privateBytes)throw Error('EXTRACTION_PRIVATE_REQUEST_LIMIT');
    return new Promise((resolve,reject)=>{
      const connection=createConnection({path:'/run/intake-t03/'+this.participant+'/channel.sock'});
      const chunks:Buffer[]=[];let length=0,done=false;
      const finish=(error:Error|null,value?:unknown)=>{if(done)return;done=true;clearTimeout(timer);connection.destroy();
        if(error){this.poisoned=true;reject(error);}else resolve(value);};
      const timer=setTimeout(()=>finish(Error('EXTRACTION_PRIVATE_UNCERTAIN')),control?12000:90000);
      connection.once('connect',()=>connection.end(bytes));
      connection.on('data',chunk=>{length+=chunk.length;if(length>EXTRACTION_BOUNDS.privateBytes)finish(Error('EXTRACTION_PRIVATE_REPLY_LIMIT'));else chunks.push(chunk);});
      connection.once('error',()=>finish(Error('EXTRACTION_PRIVATE_UNAVAILABLE')));
      connection.once('end',()=>{try{
        const value:any=decodeExtractionPrivate(Buffer.concat(chunks));
        if(value.id!==id||typeof value.ok!=='boolean')throw Error('EXTRACTION_PRIVATE_REPLY');
        if(!control&&value.ok&&(value.termination?.profile!=='intake-child-stop/1'||value.termination.requestId!==id||
          !Number.isSafeInteger(value.termination.closedAtMs)||value.termination.closedAtMs<value.termination.startedAtMs))throw Error('EXTRACTION_PRIVATE_CLOSURE');
        finish(null,value);
      }catch{finish(Error('EXTRACTION_PRIVATE_REPLY'));}});
      connection.once('close',()=>{if(!done)finish(Error('EXTRACTION_PRIVATE_INTERRUPTED'));});
    });
  }
  async openPhase(binding:ExtractionPhaseBinding){
    if(binding.participant!==this.participant)throw Error('EXTRACTION_PHASE_PARTICIPANT');
    const r=await this.exchange({profile:'intake-phase-control/1',action:'open',binding},true);
    if(!r.ok||r.phase?.profile!=='intake-phase-open/1'||r.phase.id!==binding.id)throw Error('EXTRACTION_PHASE_OPEN');
  }
  async closePhase(id:string){
    const r=await this.exchange({profile:'intake-phase-control/1',action:'close',phaseId:id},true);
    if(!r.ok||r.phase?.profile!=='intake-phase-closed/1'||r.phase.id!==id||r.phase.participant!==this.participant)throw Error('EXTRACTION_PHASE_UNCLOSED');
    return r.phase;
  }
  async call(command:ExtractionCommand){return this.exchange(command as unknown as Record<string,unknown>);}
  async observeLaunch(phaseId:string,subject:ExtractionSubject){
    const reply=await this.exchange({profile:'intake-extraction-observation/1',phaseId,subject},true);
    if(!reply.ok)throw Error('EXTRACTION_OBSERVATION_UNAVAILABLE');return reply.launch;
  }
  async stop(subject:ExtractionSubject){
    const r=await this.exchange({profile:'intake-extraction-stop/1',subject},true);
    if(!r.ok)throw Error('EXTRACTION_STOP_UNCONFIRMED');return r;
  }
}
