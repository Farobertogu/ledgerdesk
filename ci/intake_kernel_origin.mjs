import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {collectProcessOutput} from '../tests/intake/t01/reviewed/process-output.mjs';

export const KERNEL_BOUNDS=Object.freeze({callMs:2000,closeMs:250,receivedBytes:65536,projectionBytes:16384,calls:2,windowUs:15000000n,clockToleranceUs:100000n});
const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const need=(test,code)=>{if(!test)fail(code);};
const bootOK=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const idOK=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>typeof v==='string'&&/^\d{1,20}$/.test(v);
const nowUs=()=>BigInt(Date.now())*1000n;
let activeClient=false,unconfirmedClient=false;

// Reuse the byte collector. The extra listener limits total received stdout AND
// stderr, not merely the filtered projection. A pipe chunk may cross the cap;
// the exact received count and failed capture are retained, never called bounded success.
export async function boundedKernelClient(command,{spawnProcess=spawn,callMs=2000,closeMs=250,receivedBytes=65536}={}){
  need(callMs>0&&callMs<=2000&&closeMs>0&&closeMs<=250&&receivedBytes>0&&receivedBytes<=65536,'INVALID_BOUND');
  if(activeClient||unconfirmedClient)return {complete:false,reason:unconfirmedClient?'prior_close_unconfirmed':'client_busy',closed:false};
  activeClient=true;
  const started=performance.now(),cpu=process.cpuUsage(),rssBefore=process.resourceUsage().maxRSS;
  return new Promise(resolve=>{
    let child,collector,timer,closing,ended=false,closed=false,spawnError=null,received=0;
    const finish=(code,signal)=>{
      if(ended)return;ended=true;clearTimeout(timer);clearTimeout(closing);activeClient=false;
      let groupClosure=process.platform==='linux'?'unavailable':'single-fixture-child-only';
      if(process.platform==='linux'&&child?.pid){try{process.kill(-child.pid,0);groupClosure='still_present';closed=false;}catch(e){groupClosure=e.code==='ESRCH'?'absent':'unavailable';if(groupClosure!=='absent')closed=false;}}
      const output=collector?.finish()??{stdout:'',stderr:'',stdoutBytes:0,stderrBytes:0};
      const resource=/^L03_RESOURCE user=(\d+(?:\.\d+)?) system=(\d+(?:\.\d+)?) rss=(\d+)\r?\n?$/.exec(output.stderr);
      const reason=spawnError??(!closed?'close_unconfirmed':output.reason??(output.stderrEncodingError?'invalid_diagnostic_utf8':code!==0?'client_exit':!resource?'resource_or_access_diagnostic':null));
      if(!closed&&!spawnError)unconfirmedClient=true;
      const complete=reason===null&&closed&&received<=receivedBytes;
      resolve({complete,reason,closed,groupClosure,code,signal,received,stdoutBytes:output.stdoutBytes,stderrBytes:output.stderrBytes,
        stdoutEncodingError:output.stdoutEncodingError??false,stderrEncodingError:output.stderrEncodingError??false,
        milliseconds:performance.now()-started,readerCpuUs:process.cpuUsage(cpu),readerPeakRssKiB:{before:rssBefore,after:process.resourceUsage().maxRSS,scope:'whole reader-process high-water marks, not isolated delta'},
        journalResources:resource?{userSeconds:resource[1],systemSeconds:resource[2],peakRssKiB:resource[3],source:'GNU time child accounting; availability not assumed'}:null,
        text:complete?output.stdout:''});
    };
    const stop=()=>{
      if(closing||ended)return;
      // GNU time owns journalctl in this new process group. Killing only the
      // time wrapper could leave the reader alive. Windows synthetic children
      // have no descendants; no Windows journal calibration is supported.
      try{if(process.platform==='linux'&&child?.pid)process.kill(-child.pid,'SIGKILL');else child?.kill('SIGKILL');}catch{}
      closing=setTimeout(()=>finish(null,null),closeMs);
    };
    try{
      child=spawnProcess(command.executable,command.args,{windowsHide:true,detached:process.platform==='linux',stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',SYSTEMD_COLORS:'0'}});
      collector=collectProcessOutput(child.stdout,child.stderr,{outputBytes:receivedBytes,diagnosticBytes:4096,stop});
      const count=b=>{received+=b.length;if(received>receivedBytes)collector.terminate('received_limit');};
      child.stdout.on('data',count);child.stderr.on('data',count);
      child.on('error',()=>{spawnError='client_unavailable';closed=true;finish(null,null);});
      child.on('close',(code,signal)=>{closed=true;finish(code,signal);});
      timer=setTimeout(()=>collector.terminate('journal_timeout'),callMs);
    }catch{spawnError='client_unavailable';closed=true;finish(null,null);}
  });
}

async function boundedFile(file){const handle=await fs.open(file,'r');try{const b=Buffer.alloc(4097),r=await handle.read(b,0,b.length,0);need(r.bytesRead<=4096,'IDENTITY_FILE_LIMIT');return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,r.bytesRead));}finally{await handle.close();}}
function statIdentity(text,pid){const end=text.lastIndexOf(') ');need(end>0&&text.slice(0,text.indexOf(' '))===String(pid),'PID_MISMATCH');const tail=text.slice(end+2).trim().split(/\s+/);need(integer(tail[19])&&!['Z','X'].includes(tail[0]),'START_IDENTITY_UNAVAILABLE');return tail[19];}
export function bindIdentity(input,{target,pid,expectedStartTicks}={}){
  need(idOK(target)&&Number.isSafeInteger(pid)&&pid>0,'INVALID_TARGET');
  const a=statIdentity(input.before,pid),b=statIdentity(input.after,pid);need(a===b&&(!expectedStartTicks||a===expectedStartTicks),'PID_REUSED');
  const boot=input.boot.trim().replaceAll('-','');need(bootOK(boot),'BOOT_UNAVAILABLE');
  const rows=input.cgroup.trim().split('\n');need(rows.length===1&&rows[0].startsWith('0::/'),'CGROUP_UNSUPPORTED');
  const cgroup=rows[0].slice(3);need(cgroup.length<=1024&&!cgroup.split('/').includes('..')&&cgroup.split('/').some(s=>s===target||s==='docker-'+target+'.scope'),'CGROUP_TARGET_MISMATCH');
  const ns=/^NSpid:\s+([\d\s]+)$/m.exec(input.status);need(ns&&Number(ns[1].trim().split(/\s+/).at(-1))===1,'NOT_CONTAINER_INIT');
  const uptime=/^(\d+)\.(\d{2})\s/.exec(input.uptime);need(uptime,'MONOTONIC_UNAVAILABLE');
  need(integer(input.realtimeUs),'REALTIME_UNAVAILABLE');
  return {target,pid,startTicks:a,boot,cgroup,observedRealtimeUs:input.realtimeUs,observedMonotonicUs:String(BigInt(uptime[1])*1000000n+BigInt(uptime[2])*10000n),scope:'live inspected container-init binding; no arbitrary PID lookup'};
}
export async function readLiveIdentity(target,pid){
  need(process.platform==='linux','HOST_NOT_LINUX');need(idOK(target)&&Number.isSafeInteger(pid)&&pid>0,'INVALID_TARGET');
  const clockStart=nowUs();
  const before=await boundedFile('/proc/'+pid+'/stat'),boot=await boundedFile('/proc/sys/kernel/random/boot_id');
  const cgroup=await boundedFile('/proc/'+pid+'/cgroup'),status=await boundedFile('/proc/'+pid+'/status'),uptime=await boundedFile('/proc/uptime');
  const after=await boundedFile('/proc/'+pid+'/stat');
  const clockEnd=nowUs();need(clockEnd>=clockStart&&clockEnd-clockStart<=KERNEL_BOUNDS.clockToleranceUs,'IDENTITY_CLOCK_UNCERTAINTY');
  return bindIdentity({before,after,boot,cgroup,status,uptime,realtimeUs:String(clockEnd)},{target,pid});
}

const fields=['__CURSOR','__REALTIME_TIMESTAMP','__MONOTONIC_TIMESTAMP','_BOOT_ID','_TRANSPORT','MESSAGE'];
export function journalCommand(boot,{cursor,untilUs}={}){
  need(boot===null||bootOK(boot),'BOOT_UNAVAILABLE');
  const args=['--no-pager','--system','--dmesg','--boot='+(boot??'0'),'--output=json','--output-fields='+fields.join(',')];
  if(cursor!==undefined){need(typeof cursor==='string'&&/^[\x21-\x7e]{1,1024}$/.test(cursor),'CURSOR_UNAVAILABLE');need(integer(untilUs),'WINDOW_UNAVAILABLE');args.push('--after-cursor='+cursor,'--until=@'+(BigInt(untilUs)/1000000n)+'.'+(BigInt(untilUs)%1000000n).toString().padStart(6,'0'));}
  else args.push('--lines=1');
  // No sudo, journal writes, quiet mode, follow mode, --all or unrestricted dump.
  return {executable:'/usr/bin/time',args:['-f','L03_RESOURCE user=%U system=%S rss=%M','--','/usr/bin/journalctl',...args]};
}
function rows(text){
  need(Buffer.byteLength(text)<=65536,'RECEIVED_LIMIT');if(text==='')return [];
  need(text.endsWith('\n'),'TRUNCATED_RECORD');const lines=text.trimEnd().split('\n');need(lines.length<=256,'RECORD_LIMIT');
  return lines.map(line=>{
    need(Buffer.byteLength(line)<=8192,'RECORD_LIMIT');const v=JSON.parse(line);
    need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>fields.includes(k)),'JOURNAL_SCHEMA');
    for(const k of fields){need(typeof v[k]==='string','JOURNAL_SCHEMA');need((line.match(new RegExp('"'+k+'"\\s*:','g'))??[]).length===1,'DUPLICATE_FIELD');}
    need(bootOK(v._BOOT_ID)&&integer(v.__REALTIME_TIMESTAMP)&&integer(v.__MONOTONIC_TIMESTAMP),'JOURNAL_SCHEMA');
    need(/^[\x21-\x7e]{1,1024}$/.test(v.__CURSOR),'CURSOR_UNAVAILABLE');return v;
  });
}
export function cursorFrom(text,boot,clockUs){
  const r=rows(text);need(r.length===1,'NO_VISIBLE_KERNEL_JOURNAL');const v=r[0];
  need((boot===null||v._BOOT_ID===boot)&&v._TRANSPORT==='kernel'&&BigInt(v.__REALTIME_TIMESTAMP)<=BigInt(clockUs),'UNQUALIFIED_KERNEL_JOURNAL');
  return {cursor:v.__CURSOR,boot:v._BOOT_ID,realtimeUs:v.__REALTIME_TIMESTAMP,monotonicUs:v.__MONOTONIC_TIMESTAMP};
}
function context(message){
  const m=/^oom-kill:constraint=(CONSTRAINT_[A-Z_]+),nodemask=[^,\n]{1,128},cpuset=[^,\n]{1,1024},mems_allowed=[0-9a-fA-F,\-]{1,128},(?:oom_memcg=([^,\n]{1,1024})|(global_oom)),task_memcg=([^,\n]{1,1024}),task=[^,\n]{1,16},pid=(\d{1,10}),uid=\d{1,10}$/.exec(message);
  return m?{constraint:m[1],limiting:m[2]??null,global:!!m[3],task:m[4],pid:Number(m[5])}:null;
}
function victim(message){const m=/^(?:Memory cgroup out of memory|Out of memory): Killed process (\d{1,10}) \([^\n]{1,16}\) total-vm:\d+kB, anon-rss:\d+kB, file-rss:\d+kB, shmem-rss:\d+kB, UID:\d+ pgtables:\d+kB oom_score_adj:-?\d+$/.exec(message);return m?Number(m[1]):null;}
export function projectKernel(text,binding,window,cursor){
  need(binding&&idOK(binding.target)&&bootOK(binding.boot)&&integer(binding.startTicks),'IDENTITY_UNAVAILABLE');
  need(cursor.boot===binding.boot&&integer(window.fromUs)&&integer(window.toUs),'WINDOW_UNAVAILABLE');
  const from=BigInt(window.fromUs),to=BigInt(window.toUs);
  need(to>=from&&to-from<=KERNEL_BOUNDS.windowUs&&BigInt(binding.observedRealtimeUs)>=from&&BigInt(binding.observedRealtimeUs)<=to,'WINDOW_UNAVAILABLE');
  need(BigInt(cursor.realtimeUs)<=from,'CURSOR_AFTER_LAUNCH');
  const raw=rows(text),counts={foreignBoot:0,outsideWindow:0,foreignPid:0,foreignCgroup:0,unrelated:0,malformedOOM:0,rateLimited:0},items=[];
  let previousMono=BigInt(cursor.monotonicUs);const seen=new Set([cursor.cursor]);
  for(const r of raw){
    need(!seen.has(r.__CURSOR),'DUPLICATE_CURSOR');seen.add(r.__CURSOR);
    if(r._BOOT_ID!==binding.boot||r._TRANSPORT!=='kernel'){counts.foreignBoot++;items.push(null);continue;}
    const mono=BigInt(r.__MONOTONIC_TIMESTAMP);need(mono>=previousMono,'JOURNAL_ORDER');previousMono=mono;
    const real=BigInt(r.__REALTIME_TIMESTAMP);
    if(real<from||real>to||mono<BigInt(binding.observedMonotonicUs)){counts.outsideWindow++;items.push(null);continue;}
    const elapsedMono=mono-BigInt(binding.observedMonotonicUs),elapsedReal=real-BigInt(binding.observedRealtimeUs);
    const difference=elapsedMono-elapsedReal,tolerance=KERNEL_BOUNDS.clockToleranceUs;
    need(elapsedMono<=to-BigInt(binding.observedRealtimeUs)+tolerance&&difference<=tolerance&&difference>=-tolerance,'CLOCK_INCOHERENT');
    if(/(?:callbacks|messages) suppressed|ratelimit/i.test(r.MESSAGE)){counts.rateLimited++;items.push(null);continue;}
    const c=context(r.MESSAGE),v=victim(r.MESSAGE);
    if(!c&&v===null){if(/oom-kill:|Killed process/.test(r.MESSAGE))counts.malformedOOM++;else counts.unrelated++;items.push(null);continue;}
    const pid=c?.pid??v;
    if(pid!==binding.pid){counts.foreignPid++;items.push({foreign:true});continue;}
    if(c&&c.task!==binding.cgroup){counts.foreignCgroup++;items.push({foreign:true});continue;}
    items.push({c,v,mono,real});
  }
  const contexts=items.filter(i=>i?.c),victims=items.filter(i=>i?.v!==undefined&&i?.v!==null),pairs=[];
  for(let n=0;n<items.length-1;n++){
    const a=items[n],b=items[n+1];
    if(a?.c&&b?.v===binding.pid&&b.mono>=a.mono&&b.mono-a.mono<=100000n)pairs.push(a.c);
  }
  const matched=pairs.length===1&&contexts.length===1&&victims.length===1&&counts.malformedOOM===0&&counts.rateLimited===0;
  let origin=null;
  if(matched){const c=pairs[0];
    if(c.global&&c.constraint!=='CONSTRAINT_MEMCG')origin='global';
    else if(!c.global&&c.constraint==='CONSTRAINT_MEMCG'&&c.limiting===binding.cgroup)origin='target-leaf';
    else if(!c.global&&c.constraint==='CONSTRAINT_MEMCG'&&c.limiting?.startsWith('/')&&binding.cgroup.startsWith(c.limiting.replace(/\/$/,'')+'/'))origin='ancestor';
    // An unrecognised or unrelated limiting domain is not promoted to an origin.
  }
  return {status:matched&&origin?'matched':contexts.length||victims.length?'partial':'unknown',captureComplete:true,origin,
    target:binding.target,bindingSha256:digest(binding),taskMemcgSha256:digest(binding.cgroup),
    limitingMemcgSha256:matched&&pairs[0].limiting?digest(pairs[0].limiting):null,
    contextCount:contexts.length,victimCount:victims.length,pairs:pairs.length,rejected:counts,
    contextAbsent:contexts.length===0,ambiguous:contexts.length>1||victims.length>1||pairs.length>1,
    meaning:'No match is not proof of a non-OOM kill; adjacency and target association are required, not arbitrary pairing.'};
}

function publicClient(r){const {text,...safe}=r;return safe;}
export function createKernelCase({target,client=boundedKernelClient,bootReader=async()=>{need(process.platform==='linux','HOST_NOT_LINUX');return null;},clock=nowUs}={}){
  let position,binding,calls=[],begun=false,finished=false,fault=null;
  const attempt=async command=>{
    need(calls.length<2,'CALL_LIMIT');
    const remaining=KERNEL_BOUNDS.receivedBytes-calls.reduce((n,r)=>n+r.received,0);
    need(Number.isSafeInteger(remaining)&&remaining>0,'CASE_RECEIVED_LIMIT');
    const r=await client(command,{receivedBytes:remaining});calls.push(publicClient(r));
    need(Number.isSafeInteger(r.received)&&r.received>=0&&r.received<=remaining,'CASE_RECEIVED_LIMIT');
    need(r.complete&&r.closed,'JOURNAL_CAPTURE_UNAVAILABLE');return r;
  };
  return {
    attach(value){need(target===undefined&&!binding&&idOK(value),'TARGET_ALREADY_BOUND');target=value;},
    cancel(reason){finished=true;const result={profile:'l03-kernel-origin/1',status:'unavailable',captureComplete:false,reason,calls,noRawJournalRetained:true};need(Buffer.byteLength(JSON.stringify(result))<=16384,'PROJECTION_LIMIT');return result;},
    async begin(){if(begun)return {ready:!!position};begun=true;try{const boot=await bootReader();position=cursorFrom((await attempt(journalCommand(boot))).text,boot,String(clock()));}catch(e){fault=e.code??'CURSOR_UNAVAILABLE';}return {ready:!!position,reason:fault};},
    bind(value){try{need(value?.target===target&&value.boot===position?.boot,'BINDING_MISMATCH');binding=value;}catch(e){fault=e.code;binding=null;}},
    async finish(window){
      if(finished)return {status:'unavailable',reason:'ALREADY_FINISHED'};finished=true;
      let projection={status:'unavailable',captureComplete:false,reason:fault??'IDENTITY_UNAVAILABLE'};
      if(position&&binding)try{
        const r=await attempt(journalCommand(position.boot,{cursor:position.cursor,untilUs:window.toUs}));
        projection=projectKernel(r.text,binding,window,position);
      }catch(e){projection={status:'unavailable',captureComplete:false,reason:e.code??'PROJECTION_UNAVAILABLE'};}
      const result={profile:'l03-kernel-origin/1',...projection,calls,accountingScope:'Per-call GNU time accounting and whole-reader high-water marks; no assertion of timing neutrality',noRawJournalRetained:true};
      need(Buffer.byteLength(JSON.stringify(result))<=16384,'PROJECTION_LIMIT');return result;
    }
  };
}
