import {startAccessTerminal} from '../../../src/server/access/terminal.ts';
import {observedContext,observeRequests} from './request_observer.mjs';

if(process.platform!=='linux'||!process.send||process.env.LEDGERDESK_INTAKE_CONTAINER!=='1')throw Error('APPLICATION_CHILD_ENVIRONMENT');
let terminal,hooks,configuredFailure,started=false,stopping=false,sequence=0;const waits=new Map();
const send=value=>process.send?.(value);
process.on('disconnect',()=>{if(!stopping)process.exit(1);});
process.on('message',async message=>{
  try{
    if(message.kind==='start'&&!started){
      started=true;
      hooks=Object.fromEntries(['storage','comparison','incumbentComparison','evidence','selection','privateDispatch','incomplete','admission','failure'].map(name=>[name,event=>send({kind:'observation',name,event:observedContext(event)})]));
      configuredFailure=hooks.failure;
      hooks.barrier=(label,event)=>new Promise((resolve,reject)=>{
        const id=++sequence;waits.set(id,{resolve,reject});send({kind:'barrier',id,label,event:observedContext(event)});
      });
      if(process.env.LEDGERDESK_INTAKE_TEMPORAL==='1'||['temporal','fencing'].includes(process.env.LEDGERDESK_EXTRACTION_CASES))hooks.afterLastClock=event=>hooks.barrier('after_last_clock',event);
      terminal=await startAccessTerminal({...message.options,intakeHooks:hooks,mailbox:{send:async value=>send({kind:'mailbox',value})}});
      observeRequests(terminal.server,event=>send({kind:'observation',name:'request',event}));
      send({kind:'ready',pid:process.pid});
    }else if(message.kind==='release'){
      const wait=waits.get(message.id);waits.delete(message.id);
      if(message.failed)wait?.reject(Error('CONTROLLED_BARRIER_FAILED'));else wait?.resolve();
    }else if(message.kind==='failure-receiver'){
      if(!terminal||!['configured','absent','throws'].includes(message.mode))throw Error('FAILURE_RECEIVER_SCOPE');
      if(message.mode==='absent')delete hooks.failure;
      else hooks.failure=message.mode==='configured'?configuredFailure:()=>{throw Error('synthetic-receiver-secret');};
      send({kind:'flushed',id:message.id});
    }else if(message.kind==='flush')send({kind:'flushed',id:message.id});
    else if(message.kind==='close'){
      stopping=true;
      for(const wait of waits.values())wait.reject(Error('APPLICATION_CLOSING'));waits.clear();
      await terminal?.close();send({kind:'stopped'});process.disconnect();
    }
  }catch(error){
    // Never serialize launch credentials, certificates, request bodies or SQL errors.
    send({kind:'failure',code:/^[A-Z0-9_]{1,64}$/.test(error.message??'')?error.message:'APPLICATION_CHILD_FAILED'});
    if(!terminal)process.exit(1);
  }
});
