import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import {dockerCommand} from './launcher.mjs';

/** Kills an owned real launcher process; cleanup observations are not a worker reply. */
export async function loseControllerAfterLaunch({request,originalPath,image,runId,observe,directory}){
  const child=fork(fileURLToPath(new URL('./controller_loss_child.mjs',import.meta.url)),[],{
    execArgv:['--experimental-strip-types'],stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  const events=[{kind:'controller-spawned',pid:child.pid,atMs:Date.now()}];
  let live,bytes=0,settled=false,resolveRunning,rejectRunning;
  const running=new Promise((resolve,reject)=>{resolveRunning=resolve;rejectRunning=reject;});
  const completion=new Promise(resolve=>child.once('close',(code,signal)=>{
    const event={kind:'controller-closed',pid:child.pid,code,signal,atMs:Date.now()};events.push(event);resolve(event);
    if(!live)rejectRunning(Error('CONTROLLER_LOSS_EARLY_EXIT'));
  }));
  child.once('error',rejectRunning);
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)child.kill('SIGKILL');});
  child.on('message',message=>{
    if(message.kind==='controller-started'){events.push(message);return;}
    if(message.kind==='observation'){
      events.push(message.event);
      if(message.event.kind==='running'){live=message.event;resolveRunning(live);}
      return;
    }
    rejectRunning(Error('CONTROLLER_LOSS_PRECONDITION'));
  });
  const inspect=async id=>JSON.parse((await dockerCommand(['inspect',id])).stdout)[0];
  const owned=value=>{
    if(value.Id!==live.id||value.Image!==image||value.Config.Labels?.['intake.t03.run']!==runId||
      value.Name!=='/intake-t03-'+request.binding.channel_id)throw Error('CONTROLLER_LOSS_OWNERSHIP');
  };
  let timer,observed;
  try{
    child.send({kind:'launch',options:{request,originalPath,image,runId}});
    timer=setTimeout(()=>rejectRunning(Error('CONTROLLER_LOSS_LAUNCH_TIMEOUT')),30000);
    await running;clearTimeout(timer);
    const before=await inspect(live.id);owned(before);
    if(!before.State.Running||before.State.Pid!==live.pid||before.State.StartedAt!==live.started_at)throw Error('CONTROLLER_LOSS_NOT_RUNNING');
    events.push({kind:'worker-before-controller-loss',id:before.Id,state:before.State});
    child.kill('SIGKILL');
    let closureTimer;
    try{observed=await Promise.race([completion,new Promise((_,reject)=>{closureTimer=setTimeout(()=>reject(Error('CONTROLLER_LOSS_CLOSE_UNKNOWN')),5000);})]);}
    finally{clearTimeout(closureTimer);}
    if(observed.signal!=='SIGKILL')throw Error('CONTROLLER_LOSS_SIGNAL');
    // The durable launch fact comes from the actual assigned process above, not
    // from a fabricated completion. No termination result is sent to the service.
    await observe(live);
    await observe({kind:'host-controller-lost',pid:child.pid,channel_id:request.binding.channel_id,containerId:live.id});
    settled=true;
  }finally{
    clearTimeout(timer);
    if(!observed){child.kill('SIGKILL');await completion;}
    if(live){
      let actual=await inspect(live.id);owned(actual);
      events.push({kind:'worker-after-controller-loss',id:actual.Id,state:actual.State});
      if(actual.State.Running)await dockerCommand(['kill','--signal','KILL',actual.Id]);
      actual=await inspect(live.id);owned(actual);
      if(actual.State.Running||actual.State.Pid!==0||actual.State.Restarting)throw Error('CONTROLLER_LOSS_WORKER_NOT_CLOSED');
      events.push({kind:'owned-worker-cleanup-observed',id:actual.Id,state:actual.State});
      await dockerCommand(['rm',actual.Id]);events.push({kind:'owned-worker-removed',id:actual.Id});
    }
    await fs.writeFile(path.join(directory,'controller-loss.json'),JSON.stringify({settled,events,
      meaning:'Actual host controller killed after real worker launch. Subsequent owner cleanup is not a recovered producer result or an acknowledged service stop.'},null,2),{flag:'wx'});
  }
  throw Error('EXTRACTION_HOST_CONTROLLER_LOST');
}
