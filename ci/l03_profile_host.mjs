import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {collectProcessOutput} from '../tests/intake/t01/reviewed/process-output.mjs';
import {observeL03} from './intake_l03_observer.mjs';
import {compare,loadOriginal,sha,BUDGET,privilegedCommand,fixedHostDiagnostic} from './l03_profile_comparison.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const fault=code=>{throw Object.assign(Error(code),{code});};
async function bounded(file,limit=65536){const h=await fs.open(file,'r');try{const b=Buffer.alloc(limit+1),r=await h.read(b,0,b.length,0);if(r.bytesRead>limit)fault('FILE_LIMIT');return b.subarray(0,r.bytesRead);}finally{await h.close();}}
async function binary(file){const h=await fs.open(file,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;try{while(true){const r=await h.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;total+=r.bytesRead;if(total>256*1024*1024)fault('BINARY_LIMIT');hash.update(buffer.subarray(0,r.bytesRead));}return{path:file,bytes:total,sha256:hash.digest('hex')};}finally{await h.close();}}
export async function linuxPorts(){
 assert.equal(process.platform,'linux','Only the reviewed hosted Linux job can execute');
 assert.equal(process.env.LEDGERDESK_L03_PROFILE_COMPARISON,'1');assert.equal(process.env.DOCKER_HOST??'','');assert.equal(process.env.DOCKER_CONTEXT??'','');
 const runId=process.env.GITHUB_RUN_ID;assert(/^\d+$/.test(runId??''),'RUN_ID');
 const prefix='ld-l03-'+runId,output=path.join(root,'test-results/l03-profile-comparison',runId),privateDir=path.join(process.env.RUNNER_TEMP,prefix);
 await fs.mkdir(output,{recursive:true});await fs.mkdir(privateDir,{recursive:false,mode:0o700});
 const lease=await fs.open(path.join(privateDir,'active'),'wx');await lease.writeFile(prefix);await lease.close();
 let sequence=0,totalBytes=0,observation,owned=[],imageId,imageTag,original,installedSha,beforeInstallSha,profileIdentity,baselineInfo;
 let caseDeadline=Infinity,hostPoisoned=false;
 const commands=[];let budgetEnd=Date.now()+BUDGET.totalMs;
 async function record(name,value){assert(/^[A-Za-z0-9-]+$/.test(name),'EVIDENCE_NAME');const text=JSON.stringify(value,null,2)+'\n';totalBytes+=Buffer.byteLength(text);assert(totalBytes<=32*1024*1024,'EVIDENCE_LIMIT');await fs.writeFile(path.join(output,name+'.json'),text,{flag:'wx'});}
 async function exec(bin,args,{timeout=5000,limit=65536,diagnostic=4096}={}){
  if(hostPoisoned)fault('PRIOR_HOST_CHILD_UNCONFIRMED');if(Date.now()>Math.min(budgetEnd,caseDeadline))fault('HOST_DEADLINE');const started=Date.now();timeout=Math.min(timeout,Math.max(1,Math.min(budgetEnd,caseDeadline)-started));
  const result=await new Promise(resolve=>{
   const child=spawn(bin,args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DOCKER_HOST:'',DOCKER_CONTEXT:''}});
   let closing,done=false;const finish=(code,signal,error)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(closing);let groupGone=false;try{process.kill(-child.pid,0);}catch(e){groupGone=e.code==='ESRCH';}resolve({code,signal,error,closed:groupGone,...collector.finish(),milliseconds:Date.now()-started});};
   const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}closing=setTimeout(()=>finish(null,null,'CLOSE_UNCONFIRMED'),250);};
   const collector=collectProcessOutput(child.stdout,child.stderr,{outputBytes:limit,diagnosticBytes:diagnostic,stop});
   let received=0;const count=b=>{received+=b.length;if(received>limit+diagnostic)collector.terminate('combined_output_limit');};child.stdout.on('data',count);child.stderr.on('data',count);
   const timer=setTimeout(()=>collector.terminate('worker_timeout'),timeout);child.on('error',()=>finish(null,null,'COMMAND_UNAVAILABLE'));child.on('close',(code,signal)=>finish(code,signal));
  });
  const name='command-'+String(++sequence).padStart(4,'0');commands.push({name,bin:path.basename(bin),argsSha256:sha(JSON.stringify(args)),code:result.code,reason:result.reason??null,error:result.error??null,closed:result.closed,stdoutBytes:result.stdoutBytes,stderrBytes:result.stderrBytes,milliseconds:result.milliseconds});
  const failureDiagnostic=fixedHostDiagnostic(bin,args,result);if(failureDiagnostic)commands.at(-1).diagnostic=failureDiagnostic;
  await record(name,commands.at(-1));if(!result.closed||result.error){hostPoisoned=true;throw Object.assign(Error('HOST_CHILD_UNCONFIRMED'),{code:'HOST_CHILD_UNCONFIRMED',commandRecord:name});}return {...result,commandRecord:name};
 }
 const required=async(bin,args,options)=>{const r=await exec(bin,args,options);if(r.code!==0||r.reason)throw Object.assign(Error('HOST_COMMAND_FAILED'),{code:'HOST_COMMAND_FAILED',commandRecord:r.commandRecord});return r.stdout.trim();};
 const privileged=async(tool,args,seconds)=>{const command=privilegedCommand(tool,args,seconds);return required(command.bin,command.args,{timeout:command.timeout});};
 const docker=(args,options)=>exec('/usr/bin/docker',['--host','unix:///var/run/docker.sock',...args],options);
 const requireDocker=async(args,options)=>{const r=await docker(args,options);if(r.code!==0||r.reason)throw Object.assign(Error('DOCKER_COMMAND_FAILED'),{code:'DOCKER_COMMAND_FAILED',commandRecord:r.commandRecord});return r.stdout.trim();};
 const json=r=>{assert.equal(r.code,0);assert.equal(r.reason,undefined);return JSON.parse(r.stdout);};
 const containers=async()=>{const s=await requireDocker(['ps','-a','--no-trunc','--format','{{.ID}}']);return s?s.split('\n'):[];};
 const daemonInfo=async()=>JSON.parse(await requireDocker(['info','--format','{{json .}}']));
 const infoProjection=info=>({driver:info.CgroupDriver,cgroupVersion:info.CgroupVersion,server:info.ServerVersion,kernel:info.KernelVersion,containerd:info.ContainerdCommit?.ID,runc:info.RuncCommit?.ID});
 async function guardConfig(){const parent=await fs.realpath('/etc/docker');assert.equal(parent,'/etc/docker');try{const s=await fs.lstat('/etc/docker/daemon.json');assert(s.isFile()&&!s.isSymbolicLink(),'CONFIG_NOT_REGULAR');}catch(e){if(e.code!=='ENOENT')throw e;}}
 async function inventory(){
  const socket=await fs.realpath('/var/run/docker.sock'),stat=await fs.lstat(socket);assert(stat.isSocket());
  const info=await daemonInfo(),existing=await containers();baselineInfo=infoProjection(info);
  const context=JSON.parse(await required('/usr/bin/docker',['context','inspect']));assert.equal(context.length,1);assert.equal(context[0].Endpoints?.docker?.Host,'unix:///var/run/docker.sock','NONLOCAL_DEFAULT_CONTEXT');
  const vm=await required('/usr/bin/systemd-detect-virt',['--vm']);
  const checkout=await required('git',['rev-parse','HEAD']);
  const event=JSON.parse((await bounded(process.env.GITHUB_EVENT_PATH,1048576)).toString());
  assert(/^[a-f0-9]{40}$/.test(event.after??''),'EVENT_HEAD_REQUIRED');
  const parent=await required('git',['rev-parse',event.after+'^']);
  return {platform:process.platform,provider:process.env.RUNNER_ENVIRONMENT,imageOS:process.env.ImageOS,imageVersion:process.env.ImageVersion,event:process.env.GITHUB_EVENT_NAME,action:event.action,number:event.number,before:event.before,after:event.after,headSha:event.pull_request?.head?.sha,parent,headRepository:event.pull_request?.head?.repo?.full_name,attempt:process.env.GITHUB_RUN_ATTEMPT,repository:process.env.GITHUB_REPOSITORY,branch:process.env.GITHUB_HEAD_REF,workflow:process.env.GITHUB_WORKFLOW,commit:process.env.GITHUB_SHA,checkout,vm,socket,socketType:'socket',rootless:info.SecurityOptions?.some(v=>v.includes('rootless'))??true,containers:existing,...infoProjection(info)};
 }
 async function snapshot(){
  await guardConfig();const daemonPid=await required('/usr/bin/systemctl',['show','docker','--property=MainPID','--value']);assert(/^\d+$/.test(daemonPid)&&Number(daemonPid)>0);
  const argv=(await bounded('/proc/'+daemonPid+'/cmdline')).toString().split('\0').filter(Boolean);
  let bytes=null;try{bytes=await bounded('/etc/docker/daemon.json');}catch(e){if(e.code!=='ENOENT')throw e;}
  const text=bytes===null?null:new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  original={text,argv,driver:(await daemonInfo()).CgroupDriver,bytesSha:bytes===null?null:sha(bytes)};
  if(bytes!==null){await privileged('cp',['--preserve=all','--','/etc/docker/daemon.json',path.join(privateDir,'original.json')]);}
  await record('config-original',{exists:bytes!==null,sha256:original.bytesSha,argvSha256:sha(JSON.stringify(argv)),privateBackupNotUploaded:true});
  return original;
 }
 async function prepare(){
  const originalSource=(await bounded(path.join(root,'ci/intake_t01_check.mjs'),100000)).toString();loadOriginal(originalSource,{});
  const sources=[];for(const f of ['ci/intake_t01_check.mjs','ci/intake_l03_observer.mjs','ci/intake_kernel_origin.mjs','ci/l03_profile_hierarchy.mjs','ci/l03_profile_comparison.mjs','ci/l03_profile_host.mjs','ci/intake/T01.Dockerfile','tests/intake/t01/probe.mjs','tests/intake/t01/reviewed/process-output.mjs']){const b=await bounded(path.join(root,f),200000);sources.push({path:f,bytes:b.length,sha256:sha(b)});}
  await record('sources',sources);
  const binaries=[];for(const f of ['/usr/bin/dockerd','/usr/bin/containerd','/usr/bin/runc',process.execPath])binaries.push(await binary(await fs.realpath(f)));profileIdentity=binaries;await record('binaries-before',binaries);
  imageTag='ledgerdesk-l03:'+prefix;assert.equal(await requireDocker(['image','ls','--filter','reference='+imageTag,'--format','{{.ID}}']),'','IMAGE_ALREADY_EXISTS');await requireDocker(['build','--target','parser','--label','intake.run='+prefix,'-f','ci/intake/T01.Dockerfile','-t',imageTag,'.'],{timeout:120000,limit:1048576});
  imageId=await requireDocker(['image','inspect',imageTag,'--format','{{.Id}}']);assert(/^sha256:[a-f0-9]{64}$/.test(imageId));
  const image=JSON.parse(await requireDocker(['image','inspect',imageId]));assert.equal(image[0].Config.Labels['intake.run'],prefix);await record('image',{id:imageId,tag:imageTag,configSha256:sha(JSON.stringify(image[0].Config)),layers:image[0].RootFS.Layers});
 }
 async function validate(text){await fs.writeFile(path.join(privateDir,'candidate.json'),text,{mode:0o600});await privileged('dockerd',['--validate','--config-file='+path.join(privateDir,'candidate.json')]);}
 async function install(text){await guardConfig();const existing=await bounded('/etc/docker/daemon.json').catch(e=>{if(e.code==='ENOENT')return null;throw e;});assert.equal(existing===null?null:sha(existing),installedSha??original.bytesSha,'CONFIG_CHANGED_EXTERNALLY');beforeInstallSha=existing===null?null:sha(existing);installedSha=sha(text);await privileged('install',['-m','0644','-o','0','-g','0','--',path.join(privateDir,'candidate.json'),'/etc/docker/daemon.json']);}
 async function restart(){await privileged('systemctl',['restart','docker'],15);}
 async function ready(driver){for(let i=0;i<10;i++){const r=await docker(['info','--format','{{json .}}'],{timeout:1500});if(r.code===0&&!r.reason){const value=infoProjection(JSON.parse(r.stdout));assert.deepEqual({...value,driver:baselineInfo.driver},baselineInfo,'RUNTIME_PROFILE_DRIFT');assert.equal(value.driver,driver);assert.equal(value.cgroupVersion,'2');assert.deepEqual(await containers(),[]);return value;}await new Promise(resolve=>setTimeout(resolve,250));}fault('READINESS_FAILED');}
 async function cleanupCase(){
  caseDeadline=Infinity;
  for(const resource of owned){if(resource.removed)continue;const v=json(await docker(['inspect',resource.id]))[0];assert.equal(v.Id,resource.id);assert.equal(v.Config.Labels['intake.run'],prefix,'OWNERSHIP_MISMATCH');await requireDocker(['rm','-f',resource.id]);resource.removed=true;}
 }
 async function run(entry){
  caseDeadline=Date.now()+BUDGET.caseMs;observation=null;const name=prefix+'-'+entry.id;let launched=0,ownedKill;
  const container=async(_name,args)=>{assert.deepEqual(await containers(),[]);const id=await requireDocker(['create','--name',name,'--label','intake.run='+prefix,...args]);owned.push({id});const v=json(await docker(['inspect',id]))[0];assert.equal(v.Image,imageId);assert.equal(v.Config.User,'1000:1000');assert.deepEqual([v.HostConfig.Memory,v.HostConfig.MemorySwap,v.HostConfig.NanoCpus,v.HostConfig.PidsLimit,v.HostConfig.ReadonlyRootfs,v.HostConfig.NetworkMode],[536870912,536870912,1000000000,64,true,'none']);return name;};
  const probeDocker=async(args,options)=>{if(args[0]==='start'){assert.equal(++launched,1,'DUPLICATE_CASE_START');args=[...args.slice(0,-1),name];}else if(['inspect','stop'].includes(args[0]))args=[...args.slice(0,-1),name];return docker(args,options);};
  const save=async(n,value)=>record(entry.id+'-'+n.replaceAll('.','-'),value);
  const observed=(options,work)=>observeL03({...options,save:async(_n,value)=>{observation=value;await record(entry.id+'-observation',value);}},work);
  const loaded=loadOriginal((await bounded(path.join(root,'ci/intake_t01_check.mjs'),100000)).toString(),{prefix,parserImage:imageId,container,docker:probeDocker,json,save,owned,sourceRoot:root,hash:sha,fs,path,observeL03:observed,loggingFailures:[],required:async args=>{const r=await probeDocker(args);assert.equal(r.code,0);assert.equal(r.reason,undefined);return r.stdout;}});
  let result;
  if(entry.kind==='memory')result=await loaded.probe(['memory']);
  else{
   const command=entry.kind==='external'?['node','--max-old-space-size=128','-e','setInterval(()=>{},1000)']:['node','--max-old-space-size=128','/work/probe.mjs','cpu'];
   await container(name,[...loaded.flags,'--network','none',imageId,...command]);
   result=await observed({target:owned.at(-1).id,expectedProbeSha256:async()=>sha(await bounded(path.join(root,'tests/intake/t01/probe.mjs')))},async observer=>{
    const running=probeDocker(['start','-a',name],{timeout:10000,limit:8388608,diagnostic:8192}).then(value=>({value}),error=>({error}));
    let result;
    try{if(entry.kind==='external'){await new Promise(resolve=>setTimeout(resolve,500));const id=owned.at(-1).id,v=json(await docker(['inspect',id]))[0];assert.equal(v.Config.Labels['intake.run'],prefix);assert.equal(v.State.Running,true);const kill=await docker(['kill','--signal=KILL',id]);assert.equal(kill.code,0);ownedKill={id,signal:'KILL',commandRecord:kill.commandRecord};}}
    finally{const settled=await running;if(settled.error)throw settled.error;const r=settled.value;if(r.reason)await requireDocker(['stop','-t','1',name]);const state=json(await docker(['inspect',name]))[0];observer.recordPrimary(r,state);result={...r,state:state.State};}
    return result;
   });
  }
  let passed=false,assertion;
  try{await loaded.assertMemory(result);passed=true;}catch(e){assertion={code:e.code,actual:e.actual,expected:e.expected};}
  const memoryAccepted=passed;
  if(entry.kind!=='memory')passed=!memoryAccepted&&result.state.OOMKilled===false&&result.state.Running===false&&(entry.kind==='external'?!!ownedKill&&result.state.ExitCode===137&&!result.reason:result.reason==='worker_timeout');
  const measurement=observation?.hierarchy?.status==='observed'&&!!observation.later&&observation.identity?.image===imageId&&observation.identity?.probeMatchesSource===true;
  return {...entry,passed,memoryAccepted,assertion,state:result.state,primaryReason:result.reason??null,launches:launched,ownedKill,measurement,kernel:observation?.kernelOrigin??null};
 }
 async function restore(snapshot){budgetEnd=Date.now()+BUDGET.restoreMs;await guardConfig();const current=await bounded('/etc/docker/daemon.json').catch(e=>{if(e.code==='ENOENT')return null;throw e;});const currentSha=current===null?null:sha(current);assert([installedSha,beforeInstallSha].includes(currentSha),'CONFIG_CHANGED_EXTERNALLY');if(currentSha===snapshot.bytesSha)return;if(snapshot.text===null)await privileged('rm',['--','/etc/docker/daemon.json']);else await privileged('cp',['--preserve=all','--',path.join(privateDir,'original.json'),'/etc/docker/daemon.json']);}
 async function verifyRestored(snapshot){const b=await bounded('/etc/docker/daemon.json').catch(e=>{if(e.code==='ENOENT')return null;throw e;});assert.equal(b===null?null:sha(b),snapshot.bytesSha);const after=[];for(const v of profileIdentity)after.push(await binary(v.path));assert.deepEqual(after,profileIdentity,'BINARY_CHANGED');await record('binaries-after',after);}
 async function releaseImage(){
  if(imageTag){const found=await requireDocker(['image','ls','--filter','reference='+imageTag,'--format','{{.ID}}']);if(found){const v=json(await docker(['image','inspect',imageTag]))[0];if(imageId)assert.equal(v.Id,imageId);assert.equal(v.Config.Labels['intake.run'],prefix);await requireDocker(['image','rm',imageTag]);}}
  await fs.unlink(path.join(privateDir,'active'));await record('release',{ownedContainers:owned,privateBackupNotPublished:true,hostDisposal:'Expected from provider lifecycle; not observed by this process'});
 }
 const finalize=async()=>{await fs.unlink(path.join(privateDir,'active')).catch(e=>{if(e.code!=='ENOENT')throw e;});};
 return {inventory,snapshot,prepare,containers,validate,install,restart,ready,record,run,cleanupCase,restore,verifyRestored,releaseImage,finalize};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.deepEqual(process.argv.slice(2),['--execute']);const result=await compare(await linuxPorts());
 // A completed comparison may contain preserved failed original assertions.
 // It is not a green substitute for ordinary CI and cannot authorize adoption.
 console.log(JSON.stringify({status:result.status,cases:result.rows.length,restoration:result.restoration}));
 process.exitCode=result.status==='no_discrimination'?0:1;
}
