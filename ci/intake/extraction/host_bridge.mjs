import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {launchExtraction} from './launcher.mjs';
import {loseControllerAfterLaunch} from './controller_loss.mjs';
import {grantOriginalCopy} from './granted_original.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value??'');

/** Owns the existing Docker launcher; no daemon socket is mounted into an application or parser. */
export function extractionHostBridge({broker,image,runId,directory,docker}){
  const active=new Map(),handled=new Set();let failure=null,holdNext=false,failInputNext=false,loseControllerNext=false;
  const control=(action,channel)=>docker(['exec',broker,'node','--experimental-strip-types','/work/ci/intake/extraction/bridge_cli.mjs',action,...(channel?[channel]:[])]);
  async function execute(item,abort){
    const hold=holdNext,inputFault=failInputNext,controllerLoss=loseControllerNext;holdNext=false;failInputNext=false;loseControllerNext=false;
    const target=path.join(directory,item.channel);await fs.mkdir(target,{recursive:false,mode:0o700});
    await fs.writeFile(path.join(target,'request.json'),JSON.stringify(item,null,2),{flag:'wx'});
    const memoryBefore=process.memoryUsage().rss;let sampledPeakRss=memoryBefore,samples=0;
    const memoryTimer=setInterval(()=>{sampledPeakRss=Math.max(sampledPeakRss,process.memoryUsage().rss);samples++;},10);
    const events=[];let completion;
    try{
      if(item.image!==image||item.request.binding.channel_id!==item.channel)throw Error('EXTRACTION_BRIDGE_IMAGE_OR_CHANNEL');
      await docker(['cp',broker+':/output/queue/'+item.channel+'/original',path.join(target,'original')]);
      const originalPath=await grantOriginalCopy(target,item.request.binding.original);
      if(item.stopped)abort.abort();
      if(inputFault)await fs.writeFile(path.join(target,'injection.json'),JSON.stringify({boundary:'controller-stdin',fault:'disconnect-before-input'}),{flag:'wx'});
      const result=await(controllerLoss?loseControllerAfterLaunch:launchExtraction)({request:item.request,originalPath,image,runId,
        directory:target,signal:abort.signal,testInputFault:inputFault,testHoldInput:hold,
        observe:async event=>{
          events.push(event);await fs.writeFile(path.join(target,'event-'+String(events.length).padStart(3,'0')+'.json'),JSON.stringify(event,null,2),{flag:'wx'});
          if(event.kind==='running'){
            const launch={subject:item.subject,metadata:{channel_id:item.channel,container_id:event.id,image:event.image,pid:event.pid,started_at:event.started_at}};
            await fs.writeFile(path.join(target,'launch.json'),JSON.stringify(launch),{flag:'wx'});
            await docker(['cp',path.join(target,'launch.json'),broker+':/output/queue/'+item.channel+'/launch.pending.json']);
            await control('launched',item.channel);
          }
        }});
      const raw=result.retainedStdout,start=events.find(e=>e.kind==='running');
      const metadata={channel_id:item.channel,container_id:result.containerId,image,
        exit_code:result.termination.ExitCode,reason:result.output.reason??result.protocolError??(result.termination.ExitCode!==0?'process_exit':null),
        diagnostics:{stdoutEncodingError:result.output.stdoutEncodingError,stderrEncodingError:result.output.stderrEncodingError,
          stdoutReceivedBytes:result.output.stdoutBytes,stdoutRetainedBytes:result.output.stdoutRetainedBytes,
          stderrReceivedBytes:result.output.stderrBytes,stderrRetainedBytes:result.output.stderrRetainedBytes},
        raw:{id:item.channel,generation:item.subject.attempt_generation,bytes:raw.length,sha256:hash(raw)},
        started_at:result.termination.StartedAt,closed_at:result.termination.FinishedAt,pid:start?.pid??null,
        observations:events.filter(e=>['running','closed','cleaned'].includes(e.kind))};
      await fs.writeFile(path.join(target,'raw.bin'),raw,{flag:'wx'});
      await docker(['cp',path.join(target,'raw.bin'),broker+':/output/queue/'+item.channel+'/raw.pending']);
      completion={requestId:item.id,subject:item.subject,closed:true,failed:metadata.reason!==null,metadata};
    }catch(error){
      // A failed CREATE with no later close is uncertain, never a successful stop.
      const neverIssued=events.length===0&&error.message==='EXTRACTION_STOPPED_BEFORE_CREATE';
      const closed=neverIssued||events.some(e=>e.kind==='cleaned');
      completion={requestId:item.id,subject:item.subject,closed,failed:true,metadata:null,error:error.message};
    }finally{
      clearInterval(memoryTimer);const after=process.memoryUsage().rss;
      await fs.writeFile(path.join(target,'controller-memory.json'),JSON.stringify({pid:process.pid,platform:process.platform,
        beforeBytes:memoryBefore,afterBytes:after,sampledPeakBytes:Math.max(sampledPeakRss,after),samples,intervalMs:10,
        processHighWaterKiB:process.resourceUsage().maxRSS,
        scope:'Trusted host controller, including concurrent bounded harness control; sampled peak is not a physical memory cap and may miss inter-sample peaks.'}),{flag:'wx'});
    }
    await fs.writeFile(path.join(target,'completion.json'),JSON.stringify(completion,null,2),{flag:'wx'});
    await docker(['cp',path.join(target,'completion.json'),broker+':/output/queue/'+item.channel+'/completion.pending.json']);
    await control('publish',item.channel);
  }
  return{
    replaceClosedBroker(next){
      if(active.size||failure||holdNext||failInputNext||typeof next!=='string'||!/^ld-i03-t02-[a-f0-9]+-extraction-replaced$/.test(next))throw Error('EXTRACTION_BRIDGE_REPLACEMENT_STATE');
      broker=next;
    },
    isIdle(){return active.size===0&&!failure&&!holdNext&&!failInputNext&&!loseControllerNext;},
    loseNextController(){if(active.size||holdNext||failInputNext||loseControllerNext)throw Error('EXTRACTION_CONTROLLER_LOSS_STATE');loseControllerNext=true;},
    holdNextInput(){if(active.size||holdNext||failInputNext)throw Error('EXTRACTION_HOLD_STATE');holdNext=true;},
    failNextInput(){if(active.size||holdNext||failInputNext)throw Error('EXTRACTION_INPUT_FAULT_STATE');failInputNext=true;},
    async tick(){
      if(failure)throw failure;
      const pending=JSON.parse(await control('pending'));
      for(const item of pending){
        if(!uuid(item.channel)||!uuid(item.id))throw Error('EXTRACTION_BRIDGE_PENDING');
        if(active.has(item.channel)){if(item.stopped)active.get(item.channel).abort.abort();continue;}
        if(handled.has(item.channel))continue;
        if(active.size)continue;
        handled.add(item.channel);const abort=new AbortController();
        const task=execute(item,abort).catch(error=>{failure=error;}).finally(()=>active.delete(item.channel));
        active.set(item.channel,{abort,task});
      }
    },
    async close(){for(const row of active.values())row.abort.abort();await Promise.all([...active.values()].map(row=>row.task));if(failure)throw failure;},
  };
}
