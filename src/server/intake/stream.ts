import type { IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { RECEPTION_BOUNDS } from './config.ts';
import { IntakeFailure, type ReceptionRequest } from './protocol.ts';
import { phase, projection, selected } from './reception.ts';
import type { ReceptionService, PreparedIntake } from './service.ts';
import {privatePhase} from './private_phase.ts';
import type {ObjectReply} from './ports.ts';

/** Closed diagnostic vocabulary; never forward a private body or free-form error. */
export function creationObservation(reply:ObjectReply):Record<string,unknown>{
  const raw=reply as ObjectReply&{termination?:Record<string,unknown>;dispatch?:unknown};
  const stop=raw.termination;
  const valid=stop?.profile==='intake-child-stop/1'&&stop.requestId===reply.id&&
    Number.isSafeInteger(stop.startedAtMs)&&Number.isSafeInteger(stop.closedAtMs)&&
    Number(stop.closedAtMs)>=Number(stop.startedAtMs)&&Number.isSafeInteger(stop.workerPid);
  const reason=stop?.reason;
  return {requestId:/^[a-f0-9-]{36}$/.test(reply.id)?reply.id:null,ok:reply.ok===true,
    outcome:['created','denied','failed'].includes(reply.outcome)?reply.outcome:'invalid',
    bytes:Number.isSafeInteger(reply.bytes)&&reply.bytes>=0?reply.bytes:null,
    dispatch:raw.dispatch==='not-started'?'not-started':'not-reported',
    termination:valid?{profile:'intake-child-stop/1',workerPid:stop!.workerPid,
      startedAtMs:stop!.startedAtMs,closedAtMs:stop!.closedAtMs,
      exitCode:Number.isInteger(stop!.exitCode)?stop!.exitCode:null,
      signal:typeof stop!.signal==='string'&&['SIGKILL','SIGTERM','SIGABRT','SIGSEGV'].includes(stop!.signal)?stop!.signal:stop!.signal===null?null:'other',
      reason:reason===null?null:typeof reason==='string'&&['deadline','output-limit','diagnostic-limit','input-failed','phase-closed','spawn-failed',
        'observation-failed','input-or-observation-failed','client-disconnected'].includes(reason)?reason:'other'}:
      {availability:stop===undefined?'missing':'invalid'}};
}

/** Wait without a database connection, transaction or admission lock. */
export function readable(request:IncomingMessage,deadline:number):Promise<boolean> {
  if(request.destroyed&&!request.complete)return Promise.reject(new IntakeFailure(400));
  if(request.readableLength>0)return Promise.resolve(true);
  if(request.readableEnded||request.complete)return Promise.resolve(false);
  return new Promise((resolve,reject)=>{
    const finish=(error:Error|null)=>{clearTimeout(timer);request.off('readable',ready);request.off('end',end);request.off('aborted',abort);request.off('error',abort);
      if(error)reject(error);else resolve(request.readableLength>0);};
    const ready=()=>finish(null),end=()=>finish(null),abort=()=>finish(new IntakeFailure(400));
    const timer=setTimeout(()=>finish(new IntakeFailure(400)),Math.max(1,Math.min(RECEPTION_BOUNDS.idleMs,deadline-Date.now())));
    request.once('readable',ready);request.once('end',end);request.once('aborted',abort);request.once('error',abort);
  });
}
export async function collectCommand(service:ReceptionService,request:ReceptionRequest,stream:IncomingMessage,token:string|null,onLoss:()=>void) {
  const chunks:Buffer[]=[];let size=0;const deadline=Date.now()+RECEPTION_BOUNDS.transferMs;
  while(size<request.contentLength) {
    if(Date.now()>=deadline||!await readable(stream,deadline))throw new IntakeFailure(400);
    const admitted=await service.metadata(request,token,onLoss);
    try {
      const count=Math.min(stream.readableLength,RECEPTION_BOUNDS.chunkBytes,request.contentLength-size);
      const chunk=stream.read(count) as Buffer|null;
      if(!chunk||chunk.length!==count||count===0)throw new IntakeFailure(400);
      size+=chunk.length;chunks.push(chunk);
    }finally{await admitted.close();}
  }
  if(size!==request.contentLength)throw new IntakeFailure(400);
  return Buffer.concat(chunks);
}
export async function uploadOriginal(service:ReceptionService,request:ReceptionRequest,stream:IncomingMessage,token:string|null,onLoss:()=>void):Promise<PreparedIntake> {
  const receptionId=request.parameters.id;
  if(service.activeReceptions.size>=RECEPTION_BOUNDS.concurrentUploads||service.activeReceptions.has(receptionId))throw new IntakeFailure(429);
  service.activeReceptions.add(receptionId);
  const deadline=Date.now()+RECEPTION_BOUNDS.transferMs;let consumed=0,created=false,ownedSession:string|null=null;const digest=createHash('sha256');
  let failedCreation:Record<string,unknown>|null=null,creationClosed=false;
  const reportCreation=(event:Record<string,unknown>)=>{
    try{service.hooks.storage?.(event);}catch{
      // Optional diagnostics cannot replace the effect outcome or its bookkeeping.
    }
  };
  const observeCreation=(result:ObjectReply,original:{id:string;generation:number},evidenceId:string)=>{
    const event={origin:'object-boundary',kind:'create-result',artifactId:original.id,generation:original.generation,
      evidenceId,atMs:Date.now(),...creationObservation(result)};
    if(!result.ok)failedCreation=event;
    reportCreation(event);
    if(result.ok&&result.outcome==='created')return null;
    if(!result.ok&&['denied','failed'].includes(result.outcome))return {creationFailure:result.outcome as 'denied'|'failed'};
    throw new IntakeFailure(503);
  };
  const rejectClosedCreation=(failure:{creationFailure:'denied'|'failed'},phaseId:string):never=>{
    // Only reached after privatePhase acknowledges and durably retires every participant.
    creationClosed=true;
    failedCreation={...failedCreation,phaseId};
    throw new IntakeFailure(failure.creationFailure==='denied'?409:503);
  };
  const admit=async()=>{
    const admission=await service.authority.open(request,token,['intake:reception:'+receptionId],onLoss);
    try {
      await service.authority.beforeMetadata(admission,request.route);
      const state=await selected(admission.db,receptionId,admission.session.account_id),{reception,attempt}=state;
      service.hooks.selection?.({origin:'reception-selection-boundary',receptionId:reception.id,principal:admission.session.account_id,
        artifactId:attempt.artifact_id,generation:attempt.generation,backendPid:admission.db.backendPid,atMs:Date.now()});
      if(String(attempt.generation)!==request.parameters.generation||reception.stopped||attempt.incarnation!==service.config.incarnation||
        !['reserved','receiving'].includes(attempt.state)||Number(attempt.expires_at)<=admission.now||attempt.actual_bytes!==consumed)throw new IntakeFailure(409);
      if(request.contentLength!==reception.declaration.bytes)throw new IntakeFailure(400);
      await service.authority.resolve(admission,request.route,undefined,reception,phase(admission,reception,attempt));
      ownedSession=admission.session.digest;
      return {admission,...state,original:{id:attempt.artifact_id,generation:attempt.generation,bytes:reception.declaration.bytes,sha256:reception.declaration.sha256}};
    }catch(error){await admission.db.close();throw error;}
  };
  try {
    while(consumed<request.contentLength) {
      if(Date.now()>=deadline||!await readable(stream,deadline))throw new IntakeFailure(400);
      const {admission,reception,attempt,original}=await admit();
      try {
        const event=await service.evidence(admission,request.route,'capture_admission',{receptionId,artifactId:original.id,generation:original.generation});
        const bounded=await privatePhase(service,admission,request,event.id,original,{objects:['create','append']},async ports=>{
          await service.hooks.barrier?.('before_capture',{route:request.route,receptionId,artifactId:original.id,generation:original.generation,evidenceId:event.id,backendPid:event.pid});
          await service.clock(admission,'original-capture',request.route);
          if(!created){const result=await ports.call({action:'create',original,incarnation:service.config.incarnation,evidenceId:event.id});
            const failure=observeCreation(result,original,event.id);if(failure)return failure;created=true;}
          const length=Math.min(RECEPTION_BOUNDS.chunkBytes,stream.readableLength,request.contentLength-consumed);
          const chunk=stream.read(length) as Buffer|null;
          if(!chunk||chunk.length!==length||length===0)throw new IntakeFailure(400);
          service.hooks.storage?.({origin:'object-boundary',kind:'capture',artifactId:original.id,generation:original.generation,bytes:chunk.length,
            offset:consumed,evidenceId:event.id,atMs:Date.now(),incarnation:service.config.incarnation});
          const append=await ports.call({action:'append',original,incarnation:service.config.incarnation,evidenceId:event.id,offset:consumed,data:chunk.toString('base64')});
          if(!append.ok||append.bytes!==chunk.length)throw new IntakeFailure(503);return chunk;
        });
        if('creationFailure' in bounded.value)rejectClosedCreation(bounded.value,bounded.id);
        const chunk=bounded.value as Buffer;
        await admission.db.query('SELECT $INTAKE.record_chunk($1,$2,$3,$4,$5)',[receptionId,attempt.generation,consumed,consumed+chunk.length,bounded.id]);
        await admission.db.commit();
        consumed+=chunk.length;digest.update(chunk);
      }finally{await admission.db.close();}
      await service.hooks.barrier?.('between_chunks',{route:request.route,receptionId,consumed});
    }
    const {admission,reception,attempt,original}=await admit();
    try {
      if(digest.digest('hex')!==original.sha256)throw new IntakeFailure(400);
      await service.authority.permitVerification(admission);
      const event=await service.evidence(admission,request.route,'read_admission',{receptionId,artifactId:original.id,generation:original.generation});
      const bounded=await privatePhase(service,admission,request,event.id,original,{objects:['create','read_stage','seal'],verifier:['verify']},async ports=>{
        await service.clock(admission,'minimum-form-read',request.route);
        if(!created){const result=await ports.call({action:'create',original,incarnation:service.config.incarnation,evidenceId:event.id});
          const failure=observeCreation(result,original,event.id);if(failure)return failure;}
        const raw=await ports.call({action:'read_stage',original,incarnation:service.config.incarnation,evidenceId:event.id});
        if(!raw.ok||typeof raw.data!=='string')throw new IntakeFailure(400);
        const verification=await ports.verify(original,reception.format,Buffer.from(raw.data,'base64'),event.id);
        if(!verification.ok)throw new IntakeFailure(verification.outcome==='limit'?413:415);
        if(verification.sha256!==original.sha256||verification.bytes!==original.bytes||verification.scope!=='minimum-form-only')throw new IntakeFailure(503);
        const sealed=await ports.call({action:'seal',original,incarnation:service.config.incarnation,evidenceId:event.id});
        if(!sealed.ok)throw new IntakeFailure(503);return verification;
      });
      if('creationFailure' in bounded.value)rejectClosedCreation(bounded.value,bounded.id);
      const verification=bounded.value;
      await service.clock(admission,'staged-object-commit',request.route);
      await admission.db.query('INSERT INTO $INTAKE.artifact VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [original.id,receptionId,original.generation,original.bytes,original.sha256,reception.format,service.config.namespace+':'+original.id+':'+original.generation,JSON.stringify(verification),await admission.db.now()]);
      await admission.db.query('SELECT $INTAKE.stage_attempt($1,$2,$3,$4)',[receptionId,original.generation,reception.revision,original.sha256]);
      reception.state='staged';reception.revision++;attempt.state='sealed';
      const operation=(await admission.db.query("SELECT id FROM $INTAKE.intention WHERE reception_id=$1 AND variant='reserve_reception'",[receptionId])).rows[0];
      return await service.prepared(admission,request,200,await projection(admission.db,reception,attempt,operation.id),operation.id,{receptionId,artifactId:original.id,generation:original.generation});
    }catch(error){await admission.db.close();throw error;}
  }catch(error){
    const observed=failedCreation as Record<string,unknown>|null;
    if(observed)reportCreation({...observed,kind:'create-closure',atMs:Date.now(),
      closure:creationClosed?'acknowledged-retired-current':'not-confirmed',recovery:creationClosed?'fence-new-generation':'unresolved'});
    if(ownedSession)await service.recordIncomplete(receptionId,Number(request.parameters.generation),ownedSession,
      observed?!creationClosed:!(error instanceof IntakeFailure)||error.status===503);
    throw error;
  }finally{service.activeReceptions.delete(receptionId);}
}
