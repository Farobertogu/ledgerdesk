// Fault-harness controller process, never a worker or operational entry point.
import {launchExtraction} from './launcher.mjs';
if(!process.send)throw Error('CONTROLLER_LOSS_IPC_REQUIRED');
process.once('message',async message=>{
  try{
    if(message?.kind!=='launch')throw Error('CONTROLLER_LOSS_COMMAND');
    process.send({kind:'controller-started',pid:process.pid,startedAtMs:Date.now()});
    await launchExtraction({...message.options,observe:async event=>{
      process.send({kind:'observation',event});
      // The parent observes the actual running container, then kills this real
      // controller before it can send the input or record a final observation.
      if(event.kind==='running')await new Promise(()=>{});
    }});
    process.send({kind:'unexpected-completion'});process.exitCode=1;
  }catch(error){process.send({kind:'failure',message:error.message});process.exitCode=1;}
});
