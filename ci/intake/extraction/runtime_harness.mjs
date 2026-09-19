import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {extractionHostBridge} from './host_bridge.mjs';

/** Extends the isolated receipt harness with two fixed private participants. */
export async function extractionHarness({directory,prefix,docker,resources,container,bounded,save,originalParticipant}) {
  const entrySource=await fs.readFile(path.join(directory,'source/workers/intake/extraction/entry.mjs'));
  const entrySha256=createHash('sha256').update(entrySource).digest('hex');
  const images={};
  for(const target of ['extraction','extraction_private']){
    const name='ledgerdesk-intake-t03:'+prefix+'-'+target;
    await docker(['build','-f',path.join(directory,'source/ci/intake/T03.Dockerfile'),'--target',target,
      '--label','intake.t02.run='+prefix,'-t',name,path.join(directory,'source')],{timeout:240000});
    const built=JSON.parse(await docker(['image','inspect',name]))[0];
    resources.push({type:'image',name,id:built.Id});images[target]=built.Id;
  }
  const sourceProbe=await container('extraction-source-check',[...bounded,'--entrypoint','node',images.extraction,'-e',
    "const f=require('fs'),c=require('crypto');process.stdout.write(JSON.stringify({node:process.version,sha256:c.createHash('sha256').update(f.readFileSync('/app/workers/intake/extraction/entry.mjs')).digest('hex')}));"]);
  const observedSource=JSON.parse(await docker(['start','-a',sourceProbe.name]));
  if(observedSource.node!=='v22.16.0'||observedSource.sha256!==entrySha256)throw Error('EXTRACTION_IMAGE_SOURCE_IDENTITY');
  await save('worker-source-identity.json',{image:images.extraction,sourceSha256:entrySha256,observed:observedSource,
    meaning:'Fixed-path source inspection in the built image; no original, credentials, application network or worker invocation.'});
  const volumes={};
  for(const key of ['extraction-ipc','outputs-ipc','extraction-data','outputs-data']){
    const name=prefix+'-'+key;await docker(['volume','create','--label','intake.t02.run='+prefix,name]);
    volumes[key]=name;resources.push({type:'volume',name,id:name});
  }
  const mount=(key,target)=>['--mount',`type=volume,source=${volumes[key]},target=${target}`];
  const init=await container('extraction-init',['--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN',
    '--security-opt','no-new-privileges',...Object.keys(volumes).flatMap((key,i)=>mount(key,'/owned-'+i)),
    '--entrypoint','node',images.extraction_private,'-e',
    "const fs=require('fs');for(let i=0;i<4;i++){fs.chmodSync('/owned-'+i,i<2?0o750:0o700);fs.chownSync('/owned-'+i,1000,i<2?20202:1000)}"]);
  await docker(['start','-a',init.name]);
  const participants=[];
  // Trusted framed storage has concurrent server/relay allocations and retained
  // page cache. Its budget is not the unchanged 512 MiB analyzer cgroup.
  const privateBounded=bounded.map((value,index)=>['--memory','--memory-swap'].includes(bounded[index-1])?'1g':value);
  for(const name of ['extraction','outputs']){
    const item=await container(name,[...privateBounded,...mount(name+'-ipc','/run/intake-t03/'+name),...mount(name+'-data','/output'),
      images.extraction_private,name,'/run/intake-t03/'+name+'/channel.sock']);
    participants.push(item);await docker(['start',item.name]);
    let ready=false;
    for(let i=0;i<20;i++){
      if((await docker(['logs',item.name])).includes('"ready":true')){ready=true;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!ready)throw Error('EXTRACTION_PARTICIPANT_NOT_READY');
    const actual=JSON.parse(await docker(['inspect',item.name]));
    if(actual[0].HostConfig.Memory!==1073741824||actual[0].HostConfig.MemorySwap!==1073741824||
      actual[0].HostConfig.NetworkMode!=='none'||!actual[0].HostConfig.ReadonlyRootfs)throw Error('EXTRACTION_PRIVATE_EFFECTIVE_LIMITS');
    await save(item.name+'-inspect.json',actual);
  }
  const bridgeDirectory=path.join(directory,'worker-bridge');await fs.mkdir(bridgeDirectory);
  const bridge=extractionHostBridge({broker:participants[0].name,image:images.extraction,runId:prefix.toLowerCase(),directory:bridgeDirectory,docker});
  const exports=participants.map((item,i)=>[item,'/output/.',i===0?'extraction-private':'extraction-outputs']);
  return {bridge,image:images.extraction,
    async replaceClosed(participant,{unresolved=false}={}){
      if(!['extraction','outputs'].includes(participant)||!bridge.isIdle())throw Error('EXTRACTION_REPLACE_SCOPE');
      if(unresolved&&participant!=='outputs')throw Error('EXTRACTION_UNRESOLVED_REPLACE_SCOPE');
      const index=participant==='extraction'?0:1,old=participants[index];
      const before=JSON.parse(await docker(['inspect',old.id]))[0];
      if(before.Id!==old.id||before.Config.Labels?.['intake.t02.run']!==prefix||!before.State.Running||
        before.HostConfig.RestartPolicy.Name!=='no')throw Error('EXTRACTION_REPLACE_OWNER');
      const journal=JSON.parse(await docker(['exec',old.name,'node','-e',
        "process.stdout.write(require('fs').readFileSync('/output/phase-control/phases.json'))"]));
      const hasOpen=Object.values(journal.rows).some(row=>row.state!=='closed');
      if(hasOpen!==unresolved)throw Error('EXTRACTION_REPLACE_OPEN_PHASE');
      await docker(['kill','--signal','KILL',old.id]);
      const ended=JSON.parse(await docker(['inspect',old.id]))[0];
      if(ended.Id!==old.id||ended.State.Running||ended.State.Pid!==0||ended.State.Restarting||ended.State.Status!=='exited')
        throw Error('EXTRACTION_REPLACE_CLOSURE');
      await save('replacement-'+participant+'-old.json',{before,ended});
      await docker(['rm',old.id]);old.removed=true;
      const next=await container(participant+'-replaced',[...privateBounded,...mount(participant+'-ipc','/run/intake-t03/'+participant),
        ...mount(participant+'-data','/output'),images.extraction_private,participant,'/run/intake-t03/'+participant+'/channel.sock']);
      participants[index]=next;exports[index][0]=next;
      const helper=await container(participant+'-restart-control',[...privateBounded,...mount(participant+'-ipc','/run/intake-t03/'+participant),
        ...mount(participant+'-data','/output'),'--entrypoint','node',images.extraction_private,'--experimental-strip-types',
        '/work/ci/intake/extraction/'+(unresolved?'restart_unresolved.mjs':'restart_closed.mjs'),JSON.stringify({participant,oldContainerId:old.id})]);
      const retained=JSON.parse(await docker(['start','-a',helper.name]));
      if(!retained.ok||JSON.stringify(retained.rows)!==JSON.stringify(journal.rows))throw Error('EXTRACTION_REPLACE_JOURNAL');
      await docker(['start',next.name]);let ready=false;
      for(let i=0;i<20;i++){
        if((await docker(['logs',next.name])).includes('"ready":true')){ready=true;break;}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!ready)throw Error('EXTRACTION_REPLACE_NOT_READY');
      const current=JSON.parse(await docker(['inspect',next.id]))[0];
      if(current.Image!==before.Image||current.Id===old.id||current.HostConfig.NetworkMode!=='none'||
        current.HostConfig.Memory!==1073741824||current.HostConfig.MemorySwap!==1073741824||!current.HostConfig.ReadonlyRootfs)
        throw Error('EXTRACTION_REPLACE_CONTROLS');
      await save('replacement-'+participant+'-new.json',current);
      if(participant==='extraction')bridge.replaceClosedBroker(next.name);
      return {ok:true,participant,oldContainerId:old.id,newContainerId:next.id,ended:ended.State,retained};
    },
    async storageFault(action,body){
      if(!['arm','inspect'].includes(action)||Object.keys(body).join(',')!=='channel'||!/^[a-f0-9-]{36}$/.test(body.channel??''))throw Error('EXTRACTION_STORAGE_FAULT_SCOPE');
      const result=await docker(['exec',participants[1].name,'node','--experimental-strip-types',
        '/work/ci/intake/extraction/storage_fault.mjs',action,JSON.stringify(body)]);
      return JSON.parse(result);
    },
    async restoreArchive(action,body){
      if(!['backup','restore','inspect'].includes(action))throw Error('EXTRACTION_RESTORE_ACTION_SCOPE');
      return JSON.parse(await docker(['exec',participants[1].name,'node','--experimental-strip-types','--max-old-space-size=256',
        '/work/ci/intake/extraction/restore_archive.mjs',action,JSON.stringify(body)]));
    },
    async faultOutput(body){
      return JSON.parse(await docker(['exec',participants[1].name,'node','--experimental-strip-types','/work/ci/intake/extraction/output_fault.mjs',JSON.stringify(body)]));
    },
    async replayCompletion(body){
      if(!bridge.isIdle())throw Error('EXTRACTION_REPLAY_ACTIVE_WORKER');
      return JSON.parse(await docker(['exec',participants[0].name,'node','--experimental-strip-types',
        '/work/ci/intake/extraction/replay_completion_probe.mjs',JSON.stringify(body)]));
    },
    async observe(participant){
      if(!['objects','extraction','outputs'].includes(participant))throw Error('EXTRACTION_OBSERVER_SCOPE');
      const item=participant==='objects'?originalParticipant:participants[participant==='extraction'?0:1];
      return JSON.parse(await docker(['exec',item.name,'node','-e',
        "const fs=require('fs');const p='/output/events.ndjson';const s=fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';if(s.length>1048576)throw Error('EVENT_LIMIT');process.stdout.write(JSON.stringify(s.trim()?s.trim().split('\\n').map(JSON.parse):[]))"]));
    },
    runtimeArgs:[...mount('extraction-ipc','/run/intake-t03/extraction'),...mount('outputs-ipc','/run/intake-t03/outputs'),
      '--env','LEDGERDESK_INTAKE_EXTRACTION=1','--env','LEDGERDESK_EXTRACTION_IMAGE='+images.extraction,
      '--env','LEDGERDESK_EXTRACTION_SOURCE_SHA256='+entrySha256],
    exports};
}
