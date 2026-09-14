import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createKernelCase,readLiveIdentity} from './intake_kernel_origin.mjs';
import {readHierarchy} from './l03_profile_hierarchy.mjs';

// Diagnostics only. No observer result authorizes or changes an L03 assertion.
export const L03_CAPTURE = Object.freeze({commandMs:2000, closeMs:250, eventMs:15000,
  laterMs:250, streamBytes:262144, eventBytes:65536, leafSamples:4});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const idOK = id => /^[a-f0-9]{64}$/.test(id);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const now = () => new Date().toISOString();
const safeCode = value => typeof value==='string' && /^[A-Z0-9_]{1,40}$/.test(value) ? value : 'OBSERVER_ERROR';

// Only the owned client is killed. stdout is retained internally until projected;
// stderr, arbitrary labels, environment, host paths and container logs are not exported.
export function captureClient(bin,args,{timeoutMs=L03_CAPTURE.commandMs,bytes=L03_CAPTURE.streamBytes,onLine}={}) {
  let child,resolveDone,closed=false,timer,closing,reason=null,stdout=Buffer.alloc(0),stderrBytes=0,received=0,pending='';
  const startedAt=now(),done=new Promise(resolve=>{resolveDone=resolve;});
  const finish=(code,signal,error=null)=>{
    if(closed)return;closed=true;clearTimeout(timer);clearTimeout(closing);
    let encodingError=false;try{new TextDecoder('utf-8',{fatal:true}).decode(stdout);}catch{encodingError=true;}
    resolveDone({startedAt,finishedAt:now(),code,signal,error,reason,received,retained:stdout.length,
      stderrBytes,pendingBytes:Buffer.byteLength(pending),encodingError,
      closed:error==='CLIENT_CLOSE_UNCONFIRMED'?false:child?.exitCode!==null||child?.signalCode!==null||error!==null,stdout});
  };
  const stop=why=>{
    if(closed||reason)return;reason=why;
    try{child?.kill('SIGKILL');}catch{}
    closing=setTimeout(()=>finish(null,null,'CLIENT_CLOSE_UNCONFIRMED'),L03_CAPTURE.closeMs);
  };
  try {
    child=spawn(bin,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{
      received+=chunk.length;
      const kept=chunk.subarray(0,Math.max(0,bytes-stdout.length));stdout=Buffer.concat([stdout,kept]);
      if(onLine){pending+=kept.toString('utf8');let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{onLine(line);}catch{stop('invalid_observation');}}}
      if(received>bytes)stop('output_limit');
    });
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>8192)stop('diagnostic_limit');});
    child.on('error',error=>finish(null,null,safeCode(error.code)));
    child.on('close',(code,signal)=>finish(code,signal));
    timer=setTimeout(()=>stop('observer_timeout'),timeoutMs);
  }catch(error){finish(null,null,safeCode(error.code));}
  return {done,stop};
}
const command = args => captureClient('docker',args).done;
const meta = r => ({startedAt:r.startedAt,finishedAt:r.finishedAt,code:r.code,signal:r.signal,
  error:r.error,reason:r.reason,received:r.received,retained:r.retained,stderrBytes:r.stderrBytes,
  pendingBytes:r.pendingBytes,encodingError:r.encodingError,closed:r.closed});
const decoded = r => {
  if(r.code!==0||r.reason||r.error)throw Error('COMMAND_INCOMPLETE');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.stdout));
};
export function projectState(value) {
  return Object.fromEntries(['Status','Running','Paused','Restarting','OOMKilled','Dead','Pid','ExitCode','StartedAt','FinishedAt']
    .filter(key=>Object.hasOwn(value??{},key)).map(key=>[key,value[key]]));
}
export function projectEvent(line,target) {
  // Preserve nanoseconds exactly instead of first converting them through Number.
  const value=JSON.parse(line.replace(/("timeNano"\s*:\s*)(\d+)/g,'$1"$2"'));
  if(value.Type!=='container'||value.Actor?.ID!==target)throw Error('EVENT_TARGET_MISMATCH');
  if(!['create','attach','start','oom','die','kill','stop','destroy'].includes(value.Action))return null;
  if(!/^\d{1,25}$/.test(String(value.timeNano)))throw Error('EVENT_TIME_INVALID');
  const record={action:value.Action,container:target,timeNano:String(value.timeNano)};
  for(const key of ['exitCode','signal'])if(/^\d{1,10}$/.test(String(value.Actor.Attributes?.[key])))record[key]=String(value.Actor.Attributes[key]);
  return record;
}

// A stopped-container copy does not execute code in the memory cgroup. Accept
// one ordinary tar member, with a checked header; never extract paths to disk.
export function tarMemberIdentity(bytes,basename) {
  if(bytes.length<1024||bytes.length%512)throw Error('TAR_INCOMPLETE');
  const header=bytes.subarray(0,512),string=(start,length)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
  let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];
  if(parseInt(string(148,8),8)!==sum)throw Error('TAR_CHECKSUM');
  const size=parseInt(string(124,12),8);
  if(!Number.isSafeInteger(size)||size<0||size>131072||!['0',''].includes(string(156,1))||path.posix.basename(string(0,100))!==basename)throw Error('TAR_MEMBER');
  const end=512+Math.ceil(size/512)*512;
  if(end+512>bytes.length||bytes.subarray(end).some(byte=>byte!==0))throw Error('TAR_EXTRA_OR_MISSING');
  const content=bytes.subarray(512,512+size);
  return {bytes:size,sha256:sha(content)};
}

export function parseLeafCounters(files) {
  const result={};
  for(const name of ['memory.events','memory.events.local']){
    if(files[name]===undefined)continue;
    const rows={};for(const line of files[name].trim().split('\n')){
      const [key,value,...extra]=line.trim().split(/\s+/);
      if(extra.length||!['low','high','max','oom','oom_kill','oom_group_kill'].includes(key)||!/^\d{1,30}$/.test(value)||Object.hasOwn(rows,key))throw Error('COUNTER_FORMAT');
      rows[key]=value;
    }result[name]=rows;
  }
  if(files['memory.peak']!==undefined){const peak=files['memory.peak'].trim();if(!/^\d{1,30}$/.test(peak))throw Error('PEAK_FORMAT');result['memory.peak']=peak;}
  return result;
}
async function boundedFile(file){
  const handle=await fs.open(file,'r');try{const bytes=Buffer.alloc(4097),r=await handle.read(bytes,0,4097,0);if(r.bytesRead>4096)throw Error('FILE_LIMIT');return bytes.subarray(0,r.bytesRead).toString('utf8');}finally{await handle.close();}
}
async function readLeaf(target,pid){
  if(process.platform!=='linux')return {status:'unavailable',reason:'HOST_NOT_LINUX'};
  if(!Number.isSafeInteger(pid)||pid<=0)return {status:'unavailable',reason:'NO_LIVE_PID'};
  try{
    const membership=await boundedFile('/proc/'+pid+'/cgroup');
    const relative=membership.split('\n').find(line=>line.startsWith('0::'))?.slice(3);
    if(!relative||!relative.includes(target)||relative.split('/').includes('..'))return {status:'unavailable',reason:'LOCAL_CGROUP_NOT_BOUND_TO_CONTAINER'};
    const base=await fs.realpath('/sys/fs/cgroup'),leaf=await fs.realpath(path.join(base,relative));
    if(!leaf.startsWith(base+path.sep)||!leaf.includes(target))return {status:'unavailable',reason:'CGROUP_PATH_OUTSIDE_TARGET'};
    const files={},missing=[];for(const name of ['memory.events','memory.events.local','memory.peak']){
      try{files[name]=await boundedFile(path.join(leaf,name));}catch{missing.push(name);}
    }
    return {status:missing.length?'partial':'observed',scope:'identified target leaf; ancestors and host pressure not sampled',
      pathSha256:sha(relative),pid,at:now(),counters:parseLeafCounters(files),missing};
  }catch(error){return {status:'unavailable',reason:safeCode(error.code)};}
}
async function leafSamples(target,pid){
  if(process.platform!=='linux')return [{status:'unavailable',reason:'HOST_NOT_LINUX'}];
  // Bound even a stalled filesystem read in a separate, unprivileged host client.
  const r=await captureClient(process.execPath,[fileURLToPath(import.meta.url),'--leaf',target,String(pid)],{timeoutMs:1000,bytes:16384}).done;
  try{return decoded(r);}catch{return [{status:'unavailable',reason:'LEAF_CAPTURE_INCOMPLETE',capture:meta(r)}];}
}

export function observationAssessment(record){
  const stream=record.events?.capture,events=record.events?.records??[];
  const complete=!!stream&&stream.reason==='observer_stop'&&stream.closed&&!stream.error&&
    stream.pendingBytes===0&&stream.encodingError===false&&
    record.events.invalid===0&&events.some(e=>e.action==='start')&&events.some(e=>e.action==='die');
  return {eventsComplete:complete,oomEvent:complete?events.some(e=>e.action==='oom'):null,
    killEvent:complete?events.some(e=>e.action==='kill'):null,
    initialOOMKilled:record.primary?.state?.OOMKilled??null,laterOOMKilled:record.later?.state?.OOMKilled??null,
    meaning:'Observed Docker events, not proof of the originating kernel limit or repair. Missing events are unknown when capture is incomplete.'};
}

export async function observeL03({target,save,expectedProbeSha256,onFailure=()=>{},run=command,
  openEvents,
  leafReader=leafSamples,
  kernelFactory=process.env.LEDGERDESK_L03_KERNEL_ORIGIN==='1'?createKernelCase:null},work){
  const record={profile:'l03-observation/1',target,startedAt:now(),budget:L03_CAPTURE,
    calls:[],errors:[],events:{records:[],invalid:0},leaf:[],primary:null,
    missing:['ancestor counters','host pressure','kernel kill origin','executable binary hash']};
  let stream,leafTask,leafStarted=false,kernel;
  const attempt=async(label,fn)=>{try{return await fn();}catch(error){record.errors.push({phase:label,code:safeCode(error.code??error.message)});return undefined;}};
  const call=async(label,args)=>{const r=await run(args);record.calls.push({phase:label,...meta(r)});return r;};
  const inspect=async label=>{const raw=decoded(await call(label,['inspect',target]))[0];if(raw?.Id!==target)throw Error('CONTAINER_ID_MISMATCH');return raw;};
  function onLine(line){
    try{
      const event=projectEvent(line,target);if(event)record.events.records.push(event);
      if(event?.action==='start'&&!leafStarted){leafStarted=true;
        leafTask=attempt('leaf',async()=>{
          const running=await inspect('leaf-pid');
          const read=await leafReader(target,running.State?.Pid);
          record.leaf=Array.isArray(read)?read:read.samples;
          if(kernel&&read.identity){kernel.bind(read.identity);}
          if(read.hierarchy)record.hierarchy=read.hierarchy;
        });
      }
    }catch{record.events.invalid++;}
  }
  // The runner supplies a deferred read of this run's retained source, not the
  // current checkout. Only diagnostic acquisition is caught here; work is not.
  record.expectedProbe={status:'unavailable',sha256:null};
  await attempt('expected-probe',async()=>{
    const value=typeof expectedProbeSha256==='function'?await expectedProbeSha256():expectedProbeSha256;
    if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('EXPECTED_PROBE_IDENTITY_INVALID');
    record.expectedProbe={status:'observed',sha256:value};
  });
  await attempt('before',async()=>{
    if(!idOK(target))throw Error('INVALID_CONTAINER_ID');
    const before=await inspect('before');
    if(!/^sha256:[a-f0-9]{64}$/.test(before.Image))throw Error('INVALID_IMAGE_ID');
    const image=decoded(await call('image',['image','inspect',before.Image]))[0];
    if(image?.Id!==before.Image)throw Error('IMAGE_ID_MISMATCH');
    record.identity={container:target,image:before.Image,created:before.Created,
      state:projectState(before.State),commandSha256:sha(JSON.stringify({path:before.Path,args:before.Args})),
      imageConfigSha256:sha(JSON.stringify(image.Config)),layers:image.RootFS?.Layers,
      user:before.Config?.User,limits:Object.fromEntries(['Memory','MemorySwap','NanoCpus','PidsLimit','ReadonlyRootfs','NetworkMode','CapDrop','SecurityOpt','Ulimits','Tmpfs']
        .map(key=>[key,before.HostConfig?.[key]]))};
    for(const [label,file]of [['probe','/work/probe.mjs'],['entrypoint','/usr/local/bin/docker-entrypoint.sh']])await attempt(label,async()=>{
      const result=await call(label,['cp',target+':'+file,'-']);
      if(result.code!==0||result.reason||result.error)throw Error('COPY_INCOMPLETE');
      record.identity[label]=tarMemberIdentity(result.stdout,path.posix.basename(file));
    });
    record.identity.probeMatchesSource=record.expectedProbe.status==='observed'&&record.identity.probe
      ?record.identity.probe.sha256===record.expectedProbe.sha256:null;
    if(kernelFactory)await attempt('kernel-before',async()=>{kernel=kernelFactory({target});await kernel.begin();});
    const since=String(Math.floor(Date.now()/1000));record.events.since=since;
    const eventArgs=['events','--since',since,'--filter','type=container','--filter','container='+target,'--format','{{json .}}'];
    stream=openEvents?openEvents(eventArgs,onLine):captureClient('docker',eventArgs,{timeoutMs:L03_CAPTURE.eventMs,bytes:L03_CAPTURE.eventBytes,onLine});
    await sleep(100);record.events.launchAllowedAt=now();
  });
  // Primary return/throw is never replaced by an observer problem, including export.
  try{return await work({recordPrimary:(result,state)=>{
    record.primary={at:now(),state:projectState(state.State),code:result.code,signal:result.signal,
      reason:result.reason??null,milliseconds:result.milliseconds,commandRecord:result.commandRecord};
  }});}finally{
    await attempt('after',async()=>{
      await sleep(L03_CAPTURE.laterMs);
      const later=await inspect('later');record.later={at:now(),state:projectState(later.State)};
    });
    if(stream)await attempt('events-close',async()=>{stream.stop('observer_stop');const result=await stream.done;record.events.capture=meta(result);});
    if(leafTask)await leafTask;
    if(kernel)await attempt('kernel-after',async()=>{
      if(!record.later){record.kernelOrigin=kernel.cancel('REQUIRED_LATER_INSPECTION_MISSING');return;}
      const from=Date.parse(record.primary?.state?.StartedAt);
      record.kernelOrigin=await kernel.finish({fromUs:Number.isFinite(from)?String(BigInt(from)*1000n):'invalid',toUs:String(BigInt(Date.parse(record.later.at))*1000n)});
    });
    if(!record.leaf.length)record.leaf.push({status:'unavailable',reason:'NO_OBSERVED_LIVE_TARGET'});
    record.assessment=observationAssessment(record);record.finishedAt=now();
    record.integrity={sha256:sha(JSON.stringify(record)),meaning:'Digest of this record before the integrity field; not source authentication.'};
    try{await save('L03-observation.json',record);}catch(error){try{onFailure({phase:'L03-observer-export',code:safeCode(error.code)});}catch{}}
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='--leaf'||!idOK(process.argv[3])||!/^\d{1,10}$/.test(process.argv[4]??''))throw Error('Invalid leaf observation target');
  let identity,hierarchy;
  if(process.env.LEDGERDESK_L03_KERNEL_ORIGIN==='1'){
    try{identity=await readLiveIdentity(process.argv[3],Number(process.argv[4]));}catch{}
    if(process.env.LEDGERDESK_L03_PROFILE_COMPARISON==='1')try{hierarchy=await readHierarchy(identity);}catch{hierarchy={status:'unavailable',reason:'REQUIRED_HIERARCHY_UNAVAILABLE'};}
  }
  const samples=[];for(let i=0;i<L03_CAPTURE.leafSamples;i++){
    const sample=await readLeaf(process.argv[3],Number(process.argv[4]));samples.push(sample);
    if(sample.status==='unavailable')break;
    if(i+1<L03_CAPTURE.leafSamples)await sleep(50);
  }
  process.stdout.write(JSON.stringify(process.env.LEDGERDESK_L03_KERNEL_ORIGIN==='1'?{samples,identity,hierarchy}:samples));
}
