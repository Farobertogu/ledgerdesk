import {ExtractionService} from '../../../src/server/intake/extraction.ts';

// Test-owned process boundary. Configuration arrives over inherited IPC and is
// never persisted. This does not add a public or application dispatch endpoint.
if(process.platform!=='linux'||!process.send||process.env.LEDGERDESK_INTAKE_CONTAINER!=='1')throw Error('EXTRACTION_CHILD_ENVIRONMENT');
let service,active=false,pauseAt=null;
process.on('disconnect',()=>process.exit(1));
process.on('message',async message=>{
  try{
    if(message.kind==='start'&&!service){
      service=new ExtractionService(message.config,{barrier:async(label,event)=>{
        if(label!==pauseAt)return;
        process.send({kind:'paused',label,event});
        // The test kills this actual process at the observed implementation
        // point. No exception/finally substitutes for abrupt process death.
        await new Promise(()=>{});
      }});
      process.send({kind:'ready'});return;
    }
    if(message.kind!=='invoke'||!service||active||!['dispatch','accept'].includes(message.operation)||
      !/^[a-f0-9-]{36}$/.test(message.jobId))throw Error('EXTRACTION_CHILD_COMMAND');
    active=true;pauseAt=message.pauseAt??null;
    const result=await service[message.operation](message.jobId);
    process.send({kind:'result',result});active=false;
  }catch(error){
    active=false;process.send({kind:'failure',code:/^[A-Z0-9_]{1,64}$/.test(error.message??'')?error.message:'EXTRACTION_CHILD_FAILED'});
  }
});
