import {fork} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AccessService} from '../../../src/server/access/service.ts';

function bounded(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
function processIdentity(pid){
  const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  if(!/^\d+$/.test(fields[19]??''))throw Error('APPLICATION_START_TICKS');
  return{pid,startTicks:BigInt(fields[19]).toString(10),bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
    namespacePid:readFileSync('/proc/'+pid+'/status','utf8').split('\n').find(line=>line.startsWith('NSpid:'))};
}
/** The observer survives application death; PostgreSQL remains owned by its parent. */
export async function startApplication({intakeHooks={},mailbox,...options}){
  const child=fork(fileURLToPath(new URL('./application_child.mjs',import.meta.url)),[],{
    execArgv:['--experimental-strip-types'],serialization:'advanced',stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  const identity=processIdentity(child.pid),observations=[{kind:'started',...identity,atMs:Date.now()}],flushes=new Map();
  let sequence=0,closed=false,startResolve,startReject,bytes=0,stderrTail='';const fallbackDiagnostics=[];
  const persist=()=>writeFileSync('/work/output/application-'+identity.pid+'-'+identity.startTicks+'.json',JSON.stringify(observations,null,2));
  const ready=new Promise((resolve,reject)=>{startResolve=resolve;startReject=reject;});
  const completion=new Promise(resolve=>child.once('close',(code,signal)=>{
    closed=true;observations.push({kind:'closed',...identity,code,signal,atMs:Date.now()});persist();
    for(const pending of flushes.values())pending.reject(Error('APPLICATION_CLOSED'));flushes.clear();
    startReject(Error('APPLICATION_CLOSED_BEFORE_READY'));resolve({code,signal,...identity});
  }));
  child.on('error',error=>startReject(error));
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)child.kill('SIGKILL');});
  child.stderr.on('data',chunk=>{
    stderrTail+=chunk.toString('utf8');let newline;
    while((newline=stderrTail.indexOf('\n'))>=0){
      const line=stderrTail.slice(0,newline);stderrTail=stderrTail.slice(newline+1);
      if(line.startsWith('INTAKE_OBSERVATION_FAILURE ')){
        const event=JSON.parse(line.slice('INTAKE_OBSERVATION_FAILURE '.length));
        fallbackDiagnostics.push({recipient:'parent process reading application stderr',event});
      }
    }
  });
  child.on('message',message=>{
    if(message.kind==='ready')startResolve();
    else if(message.kind==='failure')startReject(Error(message.code));
    else if(message.kind==='mailbox')mailbox?.send(message.value);
    else if(message.kind==='observation')intakeHooks[message.name]?.(message.event);
    else if(message.kind==='barrier')Promise.resolve().then(()=>intakeHooks.barrier?.(message.label,message.event)).then(
      ()=>{if(child.connected)child.send({kind:'release',id:message.id});},
      ()=>{if(child.connected)child.send({kind:'release',id:message.id,failed:true});});
    else if(message.kind==='flushed'){flushes.get(message.id)?.resolve();flushes.delete(message.id);}
  });
  persist();child.send({kind:'start',options});
  try{await bounded(ready,5000,'APPLICATION_NOT_READY');}catch(error){child.kill('SIGKILL');await completion;throw error;}
  return{
    processRef:identity,
    fallbackDiagnostics,
    async failureReceiver(mode){
      const id=++sequence;const waiting=new Promise((resolve,reject)=>flushes.set(id,{resolve,reject}));
      child.send({kind:'failure-receiver',id,mode});await bounded(waiting,1000,'FAILURE_RECEIVER_UNCONFIRMED');
    },
    service:{digest:value=>AccessService.prototype.digest.call({config:options.config},value)},
    async flushObservations(){
      if(closed)return;const id=++sequence;
      const waiting=new Promise((resolve,reject)=>flushes.set(id,{resolve,reject}));child.send({kind:'flush',id});
      await bounded(waiting,1000,'APPLICATION_OBSERVATIONS_UNCONFIRMED');
    },
    async crash(){if(!closed){observations.push({kind:'kill-requested',...identity,atMs:Date.now()});child.kill('SIGKILL');}return bounded(completion,3000,'APPLICATION_NOT_TERMINATED');},
    async close(){
      if(closed)return;
      child.send({kind:'close'});
      try{const result=await bounded(completion,5000,'APPLICATION_CLOSE_UNCONFIRMED');
        if(result.code!==0||result.signal!==null)throw Error('APPLICATION_CLOSE_FAILED');}
      catch(error){child.kill('SIGKILL');await bounded(completion,3000,'APPLICATION_NOT_TERMINATED');throw error;}
    },
  };
}
