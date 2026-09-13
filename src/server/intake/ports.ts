import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { OriginalReference, ReceptionFormat } from '../../contracts/intake_reception.ts';

export type ObjectCommand = {
  action: 'create' | 'append' | 'seal' | 'read' | 'read_stage' | 'fence';
  original: OriginalReference; incarnation: string; evidenceId: string;
  offset?: number; data?: string; phaseId?: string;
};
export type PrivatePhaseBinding={id:string;incarnation:string;namespace:'intake_trial'|'intake_restore';original:OriginalReference;
  evidenceId:string;participant:'objects'|'verifier';actions:string[]};
export interface PrivateParticipant{
  openPhase(binding:PrivatePhaseBinding):Promise<void>;
  closePhase(id:string):Promise<{profile:'intake-phase-closed/1';id:string;participant:string}>;
}
export type ObjectReply = { id: string; ok: boolean; outcome: 'created'|'appended'|'sealed'|'read'|'fenced'|'missing'|'corrupt'|'denied'|'failed'; bytes: number; sha256?: string; data?: string };
export type VerificationReply = { id: string; ok: boolean; format: ReceptionFormat; bytes: number; sha256: string;
  scope: 'minimum-form-only'; outcome: 'recognized'|'invalid'|'limit'|'failed' };
export interface OriginalPort extends PrivateParticipant {
  call(command: ObjectCommand, observeDispatch?: (requestId:string)=>void): Promise<ObjectReply>;
}
export interface VerificationPort extends PrivateParticipant {
  verify(original: OriginalReference, format: ReceptionFormat, bytes: Buffer, evidenceId: string,phase?:{id:string;incarnation:string}): Promise<VerificationReply>;
}
/** Private fixed socket protocol. No browser-supplied path, host or unbounded body. */
export class PrivateIntakePort implements OriginalPort, VerificationPort {
  readonly socket: string;
  readonly maximumReply: number;
  readonly timeoutMs: number;
  readonly namespace: 'intake_trial'|'intake_restore';
  private unavailable = false;
  constructor(socket: string, maximumReply = 1500000, timeoutMs = 1000, namespace:'intake_trial'|'intake_restore'='intake_trial') {
    if (!/^\/run\/intake-t02\/(?:objects|verifier)\/channel\.sock$/.test(socket)) throw Error('PRIVATE_INTAKE_SOCKET');
    if(!['intake_trial','intake_restore'].includes(namespace))throw Error('PRIVATE_INTAKE_NAMESPACE');
    this.socket=socket; this.maximumReply=maximumReply; this.timeoutMs=timeoutMs;this.namespace=namespace;
  }
  private exchange(body: Record<string, unknown>,control=false,observeDispatch?: (requestId:string)=>void): Promise<any> {
    if (this.unavailable&&!control) return Promise.reject(Error('INTAKE_PORT_UNRECONCILED'));
    const id = randomUUID(), message = Buffer.from(JSON.stringify({ id, ...body }) + '\n');
    if (message.length > 1500000) return Promise.reject(Error('INTAKE_PORT_REQUEST_LIMIT'));
    return new Promise((resolve,reject) => {
      const connection=createConnection({path:this.socket});
      let done=false, received=0; const chunks:Buffer[]=[];
      const finish=(error:Error|null,reply?:unknown)=>{
        if(done)return;done=true;clearTimeout(timer);connection.destroy();
        if(error){this.unavailable=true;reject(error);}else resolve(reply);
      };
      const timer=setTimeout(()=>finish(Error('INTAKE_PORT_UNCERTAIN')),control?1500:this.timeoutMs);
      connection.once('connect',()=>{try{observeDispatch?.(id);connection.end(message);}catch{finish(Error('INTAKE_DISPATCH_OBSERVATION_FAILED'));}});
      connection.on('data',(data:Buffer)=>{received+=data.length;if(received>this.maximumReply)finish(Error('INTAKE_PORT_REPLY_LIMIT'));else chunks.push(data);});
      connection.once('error',()=>finish(Error('INTAKE_PORT_UNAVAILABLE')));
      connection.once('end',()=>{
        try { const reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
          if(reply.id!==id||typeof reply.ok!=='boolean')throw Error('INTAKE_PORT_REPLY');
          const rejected=reply.ok===false&&reply.outcome==='denied'&&reply.dispatch==='not-started'&&reply.bytes===0;
          if(!control&&!rejected&&(reply.termination?.profile!=='intake-child-stop/1'||
            reply.termination.requestId!==id||!Number.isSafeInteger(reply.termination.closedAtMs)||
            reply.termination.closedAtMs<reply.termination.startedAtMs))throw Error('INTAKE_PORT_REPLY');finish(null,reply);
        }catch{finish(Error('INTAKE_PORT_REPLY'));}
      });
      connection.once('close',()=>{if(!done)finish(Error('INTAKE_PORT_INTERRUPTED'));});
    });
  }
  async openPhase(binding:PrivatePhaseBinding){
    const reply=await this.exchange({profile:'intake-phase-control/1',action:'open',binding},true);
    if(!reply.ok||reply.phase?.profile!=='intake-phase-open/1'||reply.phase.id!==binding.id)throw Error('INTAKE_PHASE_OPEN');
  }
  async closePhase(id:string){
    const reply=await this.exchange({profile:'intake-phase-control/1',action:'close',phaseId:id},true);
    const participant=this.socket.includes('/objects/')?'objects':'verifier';
    if(!reply.ok||reply.phase?.profile!=='intake-phase-closed/1'||reply.phase.id!==id||reply.phase.participant!==participant)throw Error('INTAKE_PHASE_UNCLOSED');
    return reply.phase;
  }
  async call(command: ObjectCommand,observeDispatch?: (requestId:string)=>void): Promise<ObjectReply> {
    return this.exchange({profile:'intake-object/1',namespace:this.namespace,...command},false,observeDispatch);
  }
  async verify(original:OriginalReference,format:ReceptionFormat,bytes:Buffer,evidenceId:string,phase?:{id:string;incarnation:string}):Promise<VerificationReply>{
    return this.exchange({profile:'intake-form/1',action:'verify',namespace:this.namespace,original,format,data:bytes.toString('base64'),evidenceId,
      phaseId:phase?.id,incarnation:phase?.incarnation});
  }
}
