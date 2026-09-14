import {appendFileSync} from 'node:fs';
import {objectStore} from './object_store.mjs';

const mode=process.argv[2];
if(process.platform!=='linux'||process.getuid()!==1000||!['objects','verifier'].includes(mode))throw Error('OPERATION_WORKER_IDENTITY');
const chunks=[];let size=0;
for await(const chunk of process.stdin){size+=chunk.length;if(size>1500000)throw Error('OPERATION_INPUT_LIMIT');chunks.push(chunk);}
let request,reply;
try{
  request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  if(mode==='objects'&&request.profile==='intake-object/1'&&['intake_trial','intake_restore'].includes(request.namespace)){
    const observe=event=>appendFileSync('/output/events.ndjson',JSON.stringify({...event,requestId:request.id,workerPid:process.pid})+'\n');
    reply=objectStore(request.namespace==='intake_trial'?'/objects':'/restored',observe)(request);
  }else if(mode==='verifier'&&request.profile==='intake-form/1'&&typeof request.data==='string'&&request.data.length<=1398104){
    const bytes=Buffer.from(request.data,'base64');
    if(bytes.toString('base64')!==request.data||bytes.length!==request.original?.bytes)throw Error('INVALID_FORM_INPUT');
    const {minimumForm}=await import('./minimum_form.mjs');
    reply={id:request.id,...await minimumForm(bytes,request.format)};
    if(reply.sha256!==request.original.sha256)reply={...reply,ok:false,outcome:'invalid'};
  }else throw Error('INVALID_PRIVATE_PROFILE');
}catch{
  reply={id:request?.id??null,ok:false,outcome:'failed',bytes:0};
}
// The supervisor waits for this process AND its pipes to close before replying.
process.stdout.write(JSON.stringify(reply),()=>process.exit(0));
