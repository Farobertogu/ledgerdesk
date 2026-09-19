import fs from 'node:fs';
import {createServer} from 'node:net';
import {PrivatePhaseJournal} from '../reception/private_phase.mjs';
import {WORKER_REQUEST_V3,EXTRACTION_BOUNDS,decodeExtractionPrivate} from '../../../src/contracts/intake_extraction.ts';
import {extractionOperation} from './supervisor.mjs';
import {uuid,hash,json,subjectMatches} from './storage.mjs';
import {extractionControlRequest} from './control_scope.mjs';
import {extractionDataRequest} from './data_scope.mjs';

const participant=process.argv[2],socket='/run/intake-t03/'+participant+'/channel.sock';
if(process.platform!=='linux'||process.getuid()!==1000||!['extraction','outputs'].includes(participant)||fs.existsSync(socket))throw Error('EXTRACTION_SERVER_IDENTITY');
for(const child of ['queue','bundles'])if(!fs.existsSync('/output/'+child))fs.mkdirSync('/output/'+child,{mode:0o700});
const journalDirectory='/output/phase-control';
const journal=fs.existsSync(journalDirectory)?PrivatePhaseJournal.reopen(journalDirectory,participant):new PrivatePhaseJournal(journalDirectory,participant);
const observe=event=>fs.appendFileSync('/output/events.ndjson',JSON.stringify({participant,atMs:Date.now(),...event})+'\n');
let count=0;
const server=createServer({allowHalfOpen:true},connection=>{
  if(count>=8){connection.destroy();return;}count++;
  const chunks=[];let size=0,operation;
  const timer=setTimeout(()=>connection.destroy(),95000);
  connection.on('data',chunk=>{size+=chunk.length;if(size>EXTRACTION_BOUNDS.privateBytes)connection.destroy();else chunks.push(chunk);});
  connection.on('error',()=>{});connection.once('close',()=>{clearTimeout(timer);count--;operation?.stop('client-disconnected');});
  connection.once('end',async()=>{
    let request;
    try{
      request=decodeExtractionPrivate(Buffer.concat(chunks));chunks.length=0;
      if(!uuid(request.id))throw Error('EXTRACTION_PRIVATE_ID');
      let reply;
      if(request.profile==='intake-phase-control/1'){
        const phase=request.action==='open'?journal.open(request.binding):request.action==='close'?await journal.close(request.phaseId):null;
        if(!phase)throw Error('EXTRACTION_PHASE_CONTROL');reply={id:request.id,ok:true,phase};
      }else if(request.profile==='intake-extraction-observation/1'&&participant==='extraction'){
        if(!extractionControlRequest(request,'observation'))throw Error('EXTRACTION_OBSERVATION_SCOPE');
        const row=journal.rows[request.phaseId];
        if(journal.poisoned||!row||row.state!=='open'||!subjectMatches(request.subject,JSON.parse(row.binding).subject))throw Error('EXTRACTION_OBSERVATION_SUBJECT');
        const file='/output/queue/'+request.subject.channel_id+'/launch.json';
        const launch=fs.existsSync(file)?json(file):null;
        if(launch&&!subjectMatches(request.subject,launch.subject))throw Error('EXTRACTION_OBSERVATION_ASSOCIATION');
        reply={id:request.id,ok:true,launch:launch?.metadata??null};
      }else if(request.profile==='intake-extraction-stop/1'&&participant==='extraction'){
        if(!extractionControlRequest(request,'stop'))throw Error('EXTRACTION_STOP_SCOPE');
        const target=request.subject;
        if(!target||!uuid(target.channel_id))throw Error('EXTRACTION_STOP_TARGET');
        const existing=json('/output/queue/'+target.channel_id+'/request.json');
        if(!subjectMatches(target,existing.subject))throw Error('EXTRACTION_STOP_TARGET');
        const stop='/output/queue/'+target.channel_id+'/stop';if(!fs.existsSync(stop))fs.writeFileSync(stop,'stop',{flag:'wx'});
        observe({kind:'stop-request',subject:target});
        const completionPath='/output/queue/'+target.channel_id+'/completion.json';
        const completion=fs.existsSync(completionPath)?json(completionPath):null;
        if(completion&&(!subjectMatches(target,completion.subject)||completion.requestId!==existing.id))throw Error('EXTRACTION_STOP_ASSOCIATION');
        // Metadata of the exact controlled predecessor, never its output body.
        reply={id:request.id,ok:true,pending:!completion?.closed,
          completion:completion?.closed?{subject:completion.subject,metadata:completion.metadata}:null};
      }else if(request.profile==='intake-extraction-private/1'){
        if(!extractionDataRequest(request,participant))throw Error('EXTRACTION_PRIVATE_SCOPE');
        if(request.action==='run'){
          const ordered=v=>v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
          if(participant!=='extraction'||!WORKER_REQUEST_V3(request.request)||
            request.request.binding.channel_id!==request.subject?.channel_id||request.request.binding.job.id!==request.subject.job_id||
            request.request.binding.attempt_generation!==request.subject.attempt_generation||
            hash(Buffer.from(JSON.stringify(ordered(request.request.binding))))!==request.subject.binding_sha256)throw Error('EXTRACTION_RUN_BINDING');
        }
        reply=await journal.execute(request.phaseId,request,()=>{
          if(request.action==='run'){
            if(fs.readdirSync('/output/queue').length>=64)throw Error('EXTRACTION_QUEUE_LIMIT');
            fs.mkdirSync('/output/queue/'+request.subject.channel_id,{mode:0o700});
          }
          operation=extractionOperation(participant,request,observe);return operation;
        });
      }else throw Error('EXTRACTION_PRIVATE_PROFILE');
      connection.end(JSON.stringify(reply));
    }catch(error){observe({kind:'refused',phaseId:uuid(request?.phaseId)?request.phaseId:uuid(request?.binding?.id)?request.binding.id:null,
      code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'PRIVATE_FAILURE'});
      connection.end(JSON.stringify({id:request?.id??null,ok:false}));}
  });
});
server.listen(socket,()=>{fs.chownSync(socket,1000,20202);fs.chmodSync(socket,0o660);console.log(JSON.stringify({ready:true,participant}));});
