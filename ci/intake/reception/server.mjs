import { createServer } from 'node:net';
import { appendFileSync, chmodSync, chownSync, existsSync } from 'node:fs';
import { supervisedOperation } from './operation_supervisor.mjs';
import { PrivatePhaseJournal } from './private_phase.mjs';

const mode=process.argv[2],socket=process.argv[3];
if(process.platform!=='linux'||process.getuid()===0||!['objects','verifier'].includes(mode)||
  !/^\/run\/intake-t02\/(?:objects|verifier)\/channel\.sock$/.test(socket??''))throw Error('PRIVATE_SERVICE_CONFIGURATION');
if(existsSync(socket))throw Error('EXISTING_PRIVATE_SOCKET');
const observer=event=>appendFileSync('/output/events.ndjson',JSON.stringify(event)+'\n');
const controlDirectory='/output/phase-control';
const journal=existsSync(controlDirectory)?PrivatePhaseJournal.reopen(controlDirectory,mode):new PrivatePhaseJournal(controlDirectory,mode);
let connections=0;
const server=createServer({allowHalfOpen:true},connection=>{
  if(connections>=8){connection.destroy();return;}connections++;
  let size=0,ended=false,operation=null;const chunks=[];
  const timer=setTimeout(()=>connection.destroy(),12000);
  connection.on('data',chunk=>{size+=chunk.length;if(size>1500000)connection.destroy();else chunks.push(chunk);});
  connection.on('error',()=>{});
  connection.once('close',()=>{
    clearTimeout(timer);connections--;
    if(operation)operation.stop('client-disconnected');
  });
  connection.once('end',async()=>{
    if(ended)return;ended=true;
    let request;
    try {
      request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(!/^[a-f0-9-]{36}$/.test(request?.id??''))throw Error('INVALID_PRIVATE_ID');
      let reply;
      if(request.profile==='intake-phase-control/1'){
        const phase=request.action==='open'?journal.open(request.binding):request.action==='close'?await journal.close(request.phaseId):null;
        if(!phase)throw Error('INVALID_PHASE_CONTROL');
        observer({origin:'private-phase',kind:request.action,phaseId:phase.id,participant:mode,requestId:request.id,atMs:Date.now()});
        reply={id:request.id,ok:true,phase};
      }else{
        reply=await journal.execute(request.phaseId,request,()=>{
          operation=supervisedOperation(mode,request,observer);return operation;
        });
      }
      if(!connection.destroyed)connection.end(JSON.stringify(reply));
    }catch(error){
      observer({origin:'private-service',kind:'failure',code:/^[A-Z0-9_]{1,40}$/.test(error.code??'')?error.code:null,
        reason:/^[A-Z0-9_]{1,64}$/.test(error.message??'')?error.message:'PRIVATE_OPERATION_FAILED',atMs:Date.now()});
      const notStarted=!operation&&!journal.active.has(request?.phaseId);
      connection.end(JSON.stringify({id:request?.id??null,ok:false,outcome:notStarted?'denied':'failed',
        ...(notStarted?{dispatch:'not-started'}:{}),bytes:0}));
    }
  });
});
server.listen(socket,()=>{chownSync(socket,process.getuid(),20202);chmodSync(socket,0o660);console.log(JSON.stringify({ready:true,mode,uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()}));});
