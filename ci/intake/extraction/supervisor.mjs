import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collectProcessOutput} from './collector.mjs';
import {EXTRACTION_BOUNDS,decodeExtractionPrivate} from '../../../src/contracts/intake_extraction.ts';

function resourceObservation(){
  const read=name=>fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();
  try{return{currentBytes:Number(read('memory.current')),peakBytes:Number(read('memory.peak')),maximum:read('memory.max'),
    events:Object.fromEntries(read('memory.events').split('\n').map(line=>{const [name,count]=line.split(' ');return[name,Number(count)];}))};}
  catch(error){return{unavailable:error.code??'unknown'};}
}

/** The relay child may close before the parser: that is not a closed run. */
export function extractionOperation(mode,request,observe){
  const startedAtMs=Date.now(),resourcesBefore=resourceObservation();let reason=null,closed=false;
  const child=spawn(process.execPath,['--experimental-strip-types','--max-old-space-size=256',fileURLToPath(new URL('./operation_worker.mjs',import.meta.url)),mode],
    {stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',TZ:'UTC'},windowsHide:true});
  const stop=why=>{if(closed)return;reason??=why;
    if(mode==='extraction'&&request.action==='run'){
      const file='/output/queue/'+request.subject.channel_id+'/stop';
      if(!fs.existsSync(file))fs.writeFileSync(file,'stop',{flag:'wx',mode:0o600});
    }else child.kill('SIGKILL');
  };
  const collector=collectProcessOutput(child.stdout,child.stderr,{outputBytes:EXTRACTION_BOUNDS.privateBytes,diagnosticBytes:8192,stop:()=>stop('output-limit')});
  const timer=setTimeout(()=>{stop('deadline');child.kill('SIGKILL');},85000);
  const completion=new Promise(resolve=>{
    child.stdin.on('error',()=>stop('input-failed'));child.once('error',()=>{reason='spawn-failed';});
    child.once('close',(exitCode,signal)=>{
      closed=true;clearTimeout(timer);const output=collector.finish();
      let reply={id:request.id,ok:false};
      if(!output.reason&&exitCode===0)try{const value=decodeExtractionPrivate(collector.retainedStdout());if(value.id===request.id&&typeof value.ok==='boolean')reply=value;}catch{}
      const parserConfirmed=mode!=='extraction'||request.action!=='run'||reply.parserClosed===true;
      const failureCode=exitCode!==0?/Error: (EXTRACTION_[A-Z_]+)(?:\r?\n|$)/.exec(output.stderr)?.[1]??'EXTRACTION_PRIVATE_FAILURE':null;
      const termination={profile:'intake-child-stop/1',requestId:request.id,workerPid:child.pid,
        startedAtMs,closedAtMs:Date.now(),exitCode,signal,reason:reason??output.reason??null};
      try{observe({kind:'private-worker-closed',phaseId:request.phaseId,subject:request.subject,parserConfirmed,termination,failureCode,
        resources:{before:resourcesBefore,after:resourceObservation(),meaning:'Whole private-participant cgroup; peak is cumulative since container start, not a universal or per-child bound.'}});}
      catch{reply={id:request.id,ok:false};}
      resolve({...reply,...(parserConfirmed?{termination}:{})});
    });
  });
  child.stdin.end(JSON.stringify(request));return{completion,stop};
}
