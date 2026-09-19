import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';

function bounded(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
function identity(pid){
  const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  if(!/^\d+$/.test(fields[19]??''))throw Error('EXTRACTION_PROCESS_START_TICKS');
  return{pid,startTicks:fields[19],bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
}
/** The parent owns closure observations; a PID or a timeout alone is not closure. */
export async function startExtractionProcess(config){
  const child=fork(fileURLToPath(new URL('./service_child.mjs',import.meta.url)),[],{
    execArgv:['--experimental-strip-types'],serialization:'advanced',stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  const processRef=identity(child.pid),events=[{kind:'started',...processRef,atMs:Date.now()}];
  const file='/work/output/extraction-process-'+processRef.pid+'-'+processRef.startTicks+'.json';
  const persist=()=>writeFileSync(file,JSON.stringify(events,null,2));
  let closed=false,bytes=0,readyResolve,readyReject,pending;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const completion=new Promise(resolve=>child.once('close',(code,signal)=>{
    closed=true;const observed={kind:'closed',...processRef,code,signal,atMs:Date.now()};events.push(observed);persist();
    readyReject(Error('EXTRACTION_CHILD_CLOSED'));pending?.reject(Error('EXTRACTION_CHILD_CLOSED'));pending=null;resolve(observed);
  }));
  child.once('error',error=>{readyReject(error);pending?.reject(error);});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)child.kill('SIGKILL');});
  child.on('message',message=>{
    if(message.kind==='ready'){readyResolve();return;}
    if(message.kind==='failure'){pending?.reject(Error(message.code));pending=null;return;}
    if(['paused','result'].includes(message.kind)){
      if(message.kind==='paused')events.push({kind:'paused',label:message.label,event:message.event,atMs:Date.now()});
      else events.push({kind:'returned',atMs:Date.now()});
      persist();pending?.resolve(message);pending=null;
    }
  });
  async function terminate(){
    if(!closed){events.push({kind:'kill-requested',...processRef,atMs:Date.now()});persist();child.kill('SIGKILL');}
    return bounded(completion,5000,'EXTRACTION_CHILD_TERMINATION_UNCONFIRMED');
  }
  persist();child.send({kind:'start',config});
  try{await bounded(ready,5000,'EXTRACTION_CHILD_NOT_READY');}catch(error){await terminate();throw error;}
  return{processRef,terminate,
    async invoke(operation,jobId,pauseAt=null){
      if(closed||pending)throw Error('EXTRACTION_CHILD_STATE');
      const reply=new Promise((resolve,reject)=>{pending={resolve,reject};});
      child.send({kind:'invoke',operation,jobId,pauseAt});
      try{return await bounded(reply,60000,'EXTRACTION_CHILD_OPERATION_TIMEOUT');}
      catch(error){await terminate();throw error;}
    },
  };
}
