import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

/** A kill request is not completion. Only the child's close observation settles. */
export function supervisedOperation(mode,request,observe){
  if(!['objects','verifier'].includes(mode))throw Error('SUPERVISOR_MODE');
  const startedAtMs=Date.now(),maximum=1500000,deadlineMs=mode==='objects'?750:9500;
  const child=spawn(process.execPath,['--max-old-space-size=128',fileURLToPath(new URL('./operation_worker.mjs',import.meta.url)),mode],
    {stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',TZ:'UTC'},windowsHide:true});
  const output=[];let bytes=0,diagnosticBytes=0,reason=null,closed=false;
  const stop=why=>{if(closed)return;if(!reason)reason=why;child.kill('SIGKILL');};
  const subject={phaseId:request.phaseId??null,artifactId:request.original?.id??null,generation:request.original?.generation??null,action:request.action??'verify',evidenceId:request.evidenceId??null};
  let processRef=null;
  const observed=event=>{try{observe(event);return true;}catch{if(!reason)reason='observation-failed';stop(reason);return false;}};
  const timer=setTimeout(()=>stop('deadline'),deadlineMs);
  const completion=new Promise(resolve=>{
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maximum)stop('output-limit');else output.push(chunk);});
    child.stderr.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>65536)stop('diagnostic-limit');});
    child.stdin.on('error',()=>stop('input-failed'));
    child.once('error',()=>{reason='spawn-failed';});
    child.once('close',(exitCode,signal)=>{
      closed=true;clearTimeout(timer);
      const termination={profile:'intake-child-stop/1',requestId:request.id,workerPid:child.pid??null,
        startedAtMs,closedAtMs:Date.now(),exitCode,signal,reason};
      observed({origin:'private-supervisor',kind:'closed',...subject,...termination,processRef});
      termination.reason=reason;
      let reply={id:request.id,ok:false,outcome:'failed',bytes:0};
      if(!reason&&exitCode===0)try{
        const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output)));
        if(parsed.id===request.id&&typeof parsed.ok==='boolean')reply=parsed;
      }catch{ /* A malformed child reply cannot promote an object. */ }
      resolve({...reply,termination});
    });
  });
  // Attach lifecycle handlers before any fallible observation or input delivery.
  try{
    const stat=readFileSync('/proc/'+child.pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    if(!/^\d+$/.test(fields[19]??''))throw Error('WORKER_START_TICKS');
    processRef={pid:child.pid,startTicks:BigInt(fields[19]).toString(10),bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
    if(observed({origin:'private-supervisor',kind:'started',...subject,requestId:request.id,workerPid:child.pid,processRef,atMs:startedAtMs}))child.stdin.end(JSON.stringify(request));
  }catch{stop('input-or-observation-failed');}
  return{completion,stop};
}
