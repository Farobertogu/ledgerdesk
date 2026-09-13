import {randomUUID} from 'node:crypto';
import type {OriginalReference} from '../../contracts/intake_reception.ts';
import type {Admission} from './authority.ts';
import type {ReceptionRequest} from './protocol.ts';
import {IntakeFailure} from './protocol.ts';
import type {ReceptionService} from './service.ts';
import type {ObjectCommand,PrivateParticipant} from './ports.ts';

/** Current registry survives SQL loss; terminal acknowledgments retire only this phase. */
export async function privatePhase<T>(service:ReceptionService,admission:Admission,request:ReceptionRequest,evidenceId:string,
  original:OriginalReference,plan:Record<string,string[]>,work:(ports:{call:ReceptionService['objects']['call'];verify:ReceptionService['verifier']['verify']})=>Promise<T>){
  const id=randomUUID(),db=admission.db,config=service.config;
  const participants=Object.keys(plan).map(name=>({name,port:(name==='objects'?service.objects:service.verifier) as PrivateParticipant}));
  await db.query('SELECT intake_control.begin_phase($1,$2,$3,$4,$5,$6,$7)',
    [id,config.namespace,evidenceId,config.controlSource,config.incarnation,JSON.stringify(plan),admission.deadline]);
  await db.commit(); // A lost commit reply never dispatches OPEN or application input.
  let result:T|undefined,failure:unknown;
  try{
    await service.hooks.barrier?.('private_phase_committed',{route:request.route,phaseId:id,evidenceId,backendPid:db.backendPid});
    for(const {name,port}of participants){
      await service.clock(admission,'private-phase-open',request.route);
      await port.openPhase({id,incarnation:config.incarnation,namespace:config.namespace,original,evidenceId,
        participant:name as 'objects'|'verifier',actions:plan[name]});
    }
    result=await work({
      call:async(command:ObjectCommand)=>{await service.clock(admission,'private-object-dispatch',request.route);
        return service.objects.call({...command,phaseId:id},command.action==='seal'?requestId=>service.hooks.privateDispatch?.({
          origin:'private-phase-dispatch-boundary',phaseId:id,evidenceId,requestId,action:'seal',original:command.original,
          incarnation:command.incarnation,atMs:Date.now()}):undefined);},
      verify:async(original,format,bytes,evidenceId)=>{await service.clock(admission,'private-verifier-dispatch',request.route);
        return service.verifier.verify(original,format,bytes,evidenceId,{id,incarnation:config.incarnation});},
    });
  }catch(error){failure=error;}
  const acknowledgments:Record<string,unknown>={};
  let closureFailure:unknown;
  for(const {name,port}of participants)try{acknowledgments[name]=await port.closePhase(id);}catch(error){closureFailure=error;}
  if(closureFailure||!db.healthy)throw new IntakeFailure(503);
  const retired=await db.query('SELECT intake_control.finish_phase($1,$2,$3,$4,$5) AS epoch',
    [id,config.controlSource,config.incarnation,evidenceId,JSON.stringify(acknowledgments)]);
  if(!retired.rows[0]?.epoch)throw new IntakeFailure(503);
  await service.hooks.barrier?.('private_phase_closed',{route:request.route,phaseId:id,evidenceId,backendPid:db.backendPid});
  if(failure)throw failure;
  // Reacquire a current effect snapshot and fence the source epoch. No IPC follows
  // while this short transaction holds the head row.
  await db.begin([]);
  await db.query('SELECT intake_control.assert_fence_epoch($1)',[retired.rows[0].epoch]);
  await service.clock(admission,'private-phase-continuation',request.route);
  return{value:result as T,id};
}
