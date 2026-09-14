import test from 'node:test';
import realFs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn as realSpawn} from 'node:child_process';
import {collectProcessOutput} from './reviewed/process-output.mjs';
import {tarMemberIdentity} from '../../../ci/intake_l03_observer.mjs';
import {counters,referenceCase,referenceFailure} from '../../../ci/intake_l03_reference.mjs';
const own=path.dirname(fileURLToPath(import.meta.url)),sourceRoot=path.resolve(own,'../../..');
const adapter=await realFs.readFile(path.join(sourceRoot,'ci/intake_l03_linux.mjs'),'utf8');
const runner=await realFs.readFile(path.join(sourceRoot,'ci/intake_t01_check.mjs'),'utf8');
const sha=b=>createHash('sha256').update(b).digest('hex');
// Derived from the preserved direct-review discriminator. Its kernel/process
// interfaces remain explicit synthetic fixtures; no Docker, Linux, root command
// or native allocation is executed here. No physical result is claimed.
// Function bodies are unchanged. Only ESM declarations are replaced with explicit
// environmental ports. The actual runner exec and collector are also retained.
const adapterBody=adapter.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const execBody=runner.slice(runner.indexOf('const referenceRecoveryLanes='),runner.indexOf('\nconst docker='));
assert(execBody.startsWith('const referenceRecoveryLanes=')&&execBody.trimEnd().endsWith('}'));
const probes=Object.fromEntries(await Promise.all(['probe.mjs','l03_gate.mjs'].map(async file=>[file,await realFs.readFile(path.join(sourceRoot,'tests/intake/t01',file))])));
const id='1'.repeat(64),nonce='2'.repeat(32),reference='system-ldl03'+nonce+'.slice',base='/sys/fs/cgroup/system.slice/'+reference,leaf='docker-'+id+'.scope',image='sha256:'+'4'.repeat(64);
const z='max 0\noom 0\noom_kill 0\noom_group_kill 0\n',oom='max 42\noom 1\noom_kill 1\noom_group_kill 0\n';
function tar(name,b){const h=Buffer.alloc(512);h.write(name);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h[156]=48;h.fill(32,148,156);const n=h.reduce((a,v)=>a+v,0);h.write(n.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([h,b,Buffer.alloc((512-b.length%512)%512),Buffer.alloc(1024)]);}
async function scenario(fault,{qualificationOnly=false}={}){
 const model={slice:false,container:false,running:false,scope:false,released:false,oom:false,closed:false};
 const trace=[],saved=[],writes=[],loggingFailures=[],commands=[];let attached,proofFailed=false,clock=Date.now(),recoveryWrites=0,preReconciliation;
 const injected=Object.fromEntries(['COMMAND_PROOF_WRITE_FAILED','ATTACHED_EXPORT_FAILED'].map(code=>[code,Object.assign(Error(code),{code})]));
 function fail(code){throw Object.assign(Error(code),{code});}
 function finish(p,code,signal=null){if(p.closed)return;p.closed=true;p.stdout.end();p.stderr.end();p.emit('close',code,signal);}
 function row(){return {Id:id,Name:'/ld-l03-'+nonce,Config:{Labels:{'l03.reference':(fault==='foreign-owner'||fault==='command-proof-foreign'&&loggingFailures.length)? '9'.repeat(32):nonce}},State:{Running:model.running,Pid:2345,ExitCode:model.oom?137:0,OOMKilled:false},RestartCount:0,Image:image,HostConfig:{CgroupParent:reference,Memory:536870912,MemorySwap:536870912,RestartPolicy:{Name:'no'}}};}
 function response(bin,args){
  trace.push({op:'command',bin,args});let a=args;if(bin==='docker'&&a[0]==='--host')a=a.slice(2);
  if(bin==='docker'){
   if(a[0]==='info')return JSON.stringify({CgroupDriver:'systemd',CgroupVersion:'2',KernelVersion:'synthetic-kernel',SecurityOptions:['name=seccomp']});
   if(a[0]==='context')return JSON.stringify([{Endpoints:{docker:{Host:'unix:///var/run/docker.sock'}}}]);
   if(a[0]==='create'){model.container=true;if(['partial-container','foreign-owner'].includes(fault))fail('CREATE_REPLY_LOST');return id;}
   if(a[0]==='inspect')return JSON.stringify([row()]);
   if(a[0]==='ps'){assert(a.includes('label=l03.reference='+nonce));return model.container?id:'';}
   if(a[0]==='rm'){assert.equal(a.at(-1),id);model.container=false;model.running=false;model.scope=false;if(attached)finish(attached,137);if(fault==='rm-reply-lost')fail('REMOVE_REPLY_LOST');return id;}
   if(a[0]==='kill'){model.running=false;model.scope=false;if(attached)finish(attached,137);return id;}
  }
  if(bin==='/usr/bin/systemctl'){
   if(a[0]==='list-units')return '';
   if(a[0]==='show'){
    if(fault==='read-after'&&model.released)fail('POSTMORTEM_READ_FAILED');
    return 'LoadState=loaded\nActiveState=active\nControlGroup=/system.slice/'+reference+'\nInvocationID='+'3'.repeat(32)+'\nDescription=L03 reference '+nonce+'\nStopWhenUnneeded=no\n';
   }
  }
  if(bin==='/usr/bin/sudo'){
   if(a.includes('/usr/bin/readlink')){
    assert.deepEqual(a,['-n','/usr/bin/timeout','--signal=KILL','5s','/usr/bin/readlink','--verbose','--','/proc/1/ns/cgroup']);
    return 'cgroup:[123]\n';
   }
   if(a.includes('StartTransientUnit')){model.slice=true;if(fault==='partial-slice')fail('SLICE_REPLY_LOST');return 'o /synthetic/job/1';}
   if(a.includes('stop')){assert(!model.scope);model.slice=false;return '';}
  }
  fail('UNMODELED_COMMAND');
 }
 function spawn(bin,args,options){
  if(qualificationOnly&&bin==='/usr/bin/sudo'&&args.includes('/usr/bin/readlink')){
   response(bin,args); // Enforce the exact privileged target and bounded command.
   const specimen={stdout:'cgroup:[123]\n',stderr:'',code:0};
   if(fault==='different')specimen.stdout='cgroup:[456]\n';
   if(fault==='permission-denied')Object.assign(specimen,{stdout:'',stderr:'readlink: /proc/1/ns/cgroup: Permission denied\n',code:1});
   if(fault==='command-failed')Object.assign(specimen,{stdout:'',stderr:'sudo: /usr/bin/timeout: command not found\n',code:127});
   if(fault==='missing')specimen.stdout='';
   if(fault==='malformed')specimen.stdout='cgroup:[123]\ncgroup:[123]\n';
   if(fault==='output-limit')specimen.stdout='x'.repeat(129);
   if(fault==='invalid-utf8')specimen.stdout=null;
   // Real pipes, exit status, collector, bounded executor and command records;
   // a synthetic child replaces sudo only at the OS-spawn boundary.
   const script='const s='+JSON.stringify(specimen)+';process.stdout.write(s.stdout===null?Buffer.from([255]):s.stdout);process.stderr.write(s.stderr);process.exitCode=s.code;';
   const child=realSpawn(process.execPath,['-e',script],options);
   trace.push({op:'namespace-child',pid:child.pid});return child;
  }
  const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.kill=signal=>{trace.push({op:'client-kill',signal});finish(p,null,signal);return true;};
  if(bin==='docker'&&args[2]==='start'){
   trace.push({op:'attach',bin,args});attached=p;model.running=true;model.scope=true;
   p.stdin.on('finish',()=>{model.released=true;trace.push({op:'release'});model.running=false;model.scope=false;model.oom=true;queueMicrotask(()=>finish(p,137));});
   queueMicrotask(()=>{if(fault!=='no-gate')p.stdout.write('L03_READY\n');if(fault==='unexpected-exit'){model.running=false;model.scope=false;finish(p,2);}});
  }else queueMicrotask(()=>{try{p.stdout.write(response(bin,args));finish(p,0);}catch(e){p.stderr.write(e.message);finish(p,1);}});
  return p;
 }
 async function save(name,value,options={}){
  writes.push({name,terminal:options.terminal===true});
  trace.push({op:'write',name});
  if(fault==='group-deadline'&&/^\d+\.json$/.test(name)&&model.running&&!proofFailed){proofFailed=true;clock+=70000;}
  const proofFault=['command-proof','command-proof-foreign','cleanup-proof','cleanup-reconcile','rm-reply-lost'].includes(fault);
  if(proofFault&&/^\d+\.json$/.test(name)&&model.running&&!proofFailed){proofFailed=true;throw injected.COMMAND_PROOF_WRITE_FAILED;}
  if(fault==='cleanup-proof'&&options.terminal&&/^\d+\.json$/.test(name))throw injected.COMMAND_PROOF_WRITE_FAILED;
  if(fault==='cleanup-reconcile'&&options.terminal&&/^\d+\.json$/.test(name)&&++recoveryWrites===1)clock+=21000;
  if(fault==='attached-export'&&name.endsWith('-attached-command.json'))throw injected.ATTACHED_EXPORT_FAILED;
  saved.push({name,value:structuredClone(value)});
 }
 const fs={
  async lstat(file){if(file===base&&!model.slice)fail('ENOENT');return {dev:29,ino:file===base?1001:1002,isDirectory:()=>true,isSymbolicLink:()=>false};},
  async readdir(file){return file===base&&model.scope?[{name:leaf,isDirectory:()=>true}]:[];},
  async readlink(file){
   trace.push({op:'readlink',file});
   if(file==='/proc/1/ns/cgroup'||fault==='self-denied')fail('EACCES');
   assert.equal(file,'/proc/self/ns/cgroup');return 'cgroup:[123]';
  },
  async readFile(file){const name=path.basename(file);assert(Object.hasOwn(probes,name));return probes[name];},
  async open(file){
   trace.push({op:'read',file});let v;
   if(file==='/proc/self/mountinfo')v='29 28 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
   else if(file==='/proc/2345/cgroup')v='0::/system.slice/'+reference+'/'+leaf+'\n';
   else if(file==='/proc/2345/stat')v='2345 (node) '+Array.from({length:20},(_,i)=>i===19?'900123':'0').join(' ');
   else if(file.endsWith('/cgroup.procs'))v=file.startsWith(base+'/'+leaf)&&model.running?'2345\n':'';
   else if(file.endsWith('/memory.events'))v=model.oom?oom:z;
   else if(file.endsWith('/memory.events.local'))v=z;
   else if(file.endsWith('/memory.max'))v=file.startsWith(base+'/'+leaf)?'536870912':'max';
   else if(file.endsWith('/memory.swap.max'))v='0';
   else if(file.endsWith('/cpu.max'))v='100000 100000';
   else if(file.endsWith('/pids.max'))v='64';
   else fail('UNMODELED_READ');
   return {async read(buffer){return {bytesRead:buffer.write(v)};},async close(){}};
  }
 };
 const makeExec=new Function('spawn','collectProcessOutput','save','path','root','loggingFailures','commands','redact','assert','Date',
  'let budgetEnd=Date.now()+60000,cleanupMode=false,seq=0;'+execBody+
  ';return {exec,openReferenceRecovery,registerReference,reconcileReferences,referenceResources,beginOuter:()=>{cleanupMode=true;budgetEnd=Date.now()+60000;}};');
 const runtime=makeExec(spawn,collectProcessOutput,save,path,sourceRoot,loggingFailures,commands,v=>v,assert,{now:()=>clock});
 const {exec,openReferenceRecovery,registerReference}=runtime;
 const captureClient=(bin,args)=>{trace.push({op:'copy-proof',bin,args});const file=args.at(-2).split('/').at(-1);return {done:Promise.resolve({code:0,reason:null,closed:true,stdout:tar(file,probes[file])})};};
 const fakeProcess={pid:6789,platform:'linux',env:{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted'}};
 const build=new Function('fs','path','os','randomUUID','createHash','spawn','assert','collectProcessOutput','captureClient','tarMemberIdentity','counters','referenceCase','process',adapterBody+';return linuxReferencePorts;');
 const create=build(fs,path,{release:()=> 'synthetic-kernel'},()=>nonce,createHash,spawn,assert,collectProcessOutput,captureClient,tarMemberIdentity,counters,referenceCase,fakeProcess);
 const ports=await create({image,flags:['--memory=512m','--memory-swap=512m','--cpus=1','--pids-limit=64'],sourceRoot,save,exec,openReferenceRecovery,registerReference},'memory');
 let result,error,caught;try{result=qualificationOnly?await ports.prepare():await referenceCase(ports,'memory');}catch(e){caught=e;error={message:e.message,code:e.code};}
 if(qualificationOnly)await ports.cleanup();
 const terminal=saved.find(r=>r.name==='L03-memory-result.json')?.value;
 preReconciliation={model:structuredClone(model),resources:structuredClone(runtime.referenceResources.map(e=>e.resource))};
 runtime.beginOuter();await runtime.reconcileReferences();
 if(fault==='attached-export')assert.equal(caught,injected.ATTACHED_EXPORT_FAILED,'Original export error identity');
 const facts=referenceFailure(caught)?.record;
 return {fault,model,result,error,terminal,facts,loggingFailures,commands,trace,writes,saved,preReconciliation,
   resources:runtime.referenceResources.map(e=>e.resource)};
}
for(const fault of ['equal','different','permission-denied','command-failed','missing','malformed','output-limit','invalid-utf8','self-denied'])test('L03 namespace qualification through actual executor: '+fault,async t=>{
 const r=await scenario(fault,{qualificationOnly:true});
 const record=r.saved.find(e=>e.value.executable==='sudo'&&e.value.args?.includes('/usr/bin/readlink'))?.value;
 assert.deepEqual(r.trace.filter(e=>e.op==='readlink').map(e=>e.file),['/proc/self/ns/cgroup']);
 assert.equal(r.model.container,false);assert.equal(r.model.slice,false);
 assert.equal(r.trace.some(e=>e.op==='release'||e.op==='attach'),false);
 if(fault==='equal'){
  assert.equal(r.error,undefined);assert.equal(r.resources.length,1);
  assert.equal(r.saved.find(e=>e.name==='L03-memory-host.json').value.sameNamespace,true);
  const observed=r.saved.find(e=>e.name==='L03-memory-namespace.json').value;
  assert.deepEqual(observed,{originatorPid:6789,originator:'cgroup:[123]',init:'cgroup:[123]',commandRecord:r.saved.find(e=>e.value===record).name});
 }else{
  assert(r.error);assert.equal(r.resources.length,0,'Invalid qualification cannot reserve or create a slice');
  assert.equal(r.saved.some(e=>e.name==='L03-memory-host.json'||e.name==='L03-memory-reservation.json'),false);
  assert.equal(r.trace.some(e=>e.op==='command'&&e.args.includes('StartTransientUnit')),false);
 }
 if(fault==='different'){
  assert.match(r.error.message,/EXCLUSIVE_REFERENCE_HOST_REQUIRED/);
  assert.equal(r.saved.find(e=>e.name==='L03-memory-namespace.json').value.init,'cgroup:[456]');
 }
 if(fault==='permission-denied'){assert.equal(record.code,1);assert.match(record.stderr,/Permission denied/);assert.match(r.error.message,/NAMESPACE_COMMAND_FAILED/);}
 if(fault==='command-failed'){assert.equal(record.code,127);assert.match(record.stderr,/command not found/);assert.match(r.error.message,/NAMESPACE_COMMAND_FAILED/);}
 if(fault==='missing')assert.match(r.error.message,/NAMESPACE_OUTPUT_MISSING/);
 if(fault==='malformed')assert.match(r.error.message,/NAMESPACE_OUTPUT_MALFORMED/);
 if(fault==='output-limit'){assert.equal(record.reason,'output_limit');assert.equal(record.stdoutRetainedBytes,128);}
 if(fault==='invalid-utf8'){assert.equal(record.reason,'invalid_output_utf8');assert.equal(record.stdoutEncodingError,true);}
 if(fault==='self-denied'){assert.equal(r.error.code,'EACCES');assert.equal(record,undefined);}
 else assert.equal(r.trace.filter(e=>e.op==='namespace-child').length,1);
 t.diagnostic(JSON.stringify({kind:'Real child transport with synthetic namespace output; no privileged or physical Linux execution',fault,error:r.error,record,
  namespace:r.saved.find(e=>e.name==='L03-memory-namespace.json')?.value,resources:r.resources.length}));
});
const cases=['none','partial-slice','partial-container','foreign-owner','no-gate','unexpected-exit','command-proof','group-deadline','cleanup-proof','cleanup-reconcile','command-proof-foreign','rm-reply-lost','attached-export','read-after'];
for(const fault of cases)test('L03-B01/B03 actual adapter and runner composition: '+fault,async t=>{
 const r=await scenario(fault);
 assert.equal(r.resources.length,1,'The exact reservation remains registered for final reconciliation');
 if(fault==='none'){
  assert.equal(r.result.verdict.acceptedAsOOM,true);
  assert.equal(r.terminal.cleanup.confirmed,true);
 }else assert(r.error);
 const foreign=['foreign-owner','command-proof-foreign'].includes(fault);
 if(foreign){
  assert(!r.trace.some(e=>e.op==='command'&&e.args.includes('rm')));
  assert.equal(r.model.container,true);
  // A stopped foreign container has no process in the empty owned slice.
  // A running foreign scope does: that slice must not be stopped.
  assert.equal(r.model.slice,fault==='command-proof-foreign');
  assert.equal(r.resources[0].reconciliation.confirmed,false);
 }else if(fault==='read-after'){
  assert.equal(r.terminal.cleanup.confirmed,false);
  assert.equal(r.model.container,false);
  assert.equal(r.model.slice,true,'Unknown reference is not stopped');
 }else{
  if(!['cleanup-reconcile','rm-reply-lost'].includes(fault))assert.equal(r.terminal.cleanup.confirmed,true,'Local cleanup must work before outer reconciliation');
  assert.equal((r.resources[0].reconciliation??r.terminal.cleanup).confirmed,true);
  assert.equal(r.model.container,false);assert.equal(r.model.slice,false);
 }
 if(['command-proof','cleanup-proof','cleanup-reconcile','command-proof-foreign','rm-reply-lost'].includes(fault)){
  assert.equal(r.error.message,'EVIDENCE_INCOMPLETE');
  assert.equal(r.loggingFailures[0].error,'COMMAND_PROOF_WRITE_FAILED');
  assert.equal(r.model.released,false);
 }
 if(fault==='group-deadline'){
  assert.equal(r.error.message,'GROUP_DEADLINE');
  assert.equal(r.terminal.cleanup.confirmed,true);
  assert.equal(r.model.released,false);
 }
 if(fault==='cleanup-reconcile'){
  assert.equal(r.terminal.cleanup.confirmed,false);
  assert(r.terminal.cleanup.errors.some(e=>e==='REFERENCE_RECOVERY_DEADLINE'));
  assert.equal(r.preReconciliation.model.container,true);
  assert.equal(r.preReconciliation.resources[0].created,true);
  assert.equal(r.resources[0].reconciliation.confirmed,true);
 }
 if(fault==='rm-reply-lost'){
  assert.equal(r.terminal.cleanup.confirmed,false,'A lost removal reply is not confirmation');
  assert.equal(r.preReconciliation.model.container,false);
  assert.equal(r.resources[0].reconciliation.confirmed,true);
 }
 if(fault==='cleanup-proof'){
  assert(r.loggingFailures.length>1);
  assert.equal(r.terminal.cleanup.confirmed,true);
 }
 if(fault==='attached-export'){
  assert.equal(r.error.message,'ATTACHED_EXPORT_FAILED');
  assert.deepEqual(r.terminal.after.events,{max:42,oom:1,oom_kill:1,oom_group_kill:0});
  assert.deepEqual({exit:r.terminal.outcome.exit,client:r.terminal.outcome.clientCode,closed:r.terminal.outcome.clientClosed},
   {exit:137,client:137,closed:true});
  assert.equal(r.terminal.verdict,undefined);
  assert.deepEqual(r.terminal.outcome,r.facts.outcome);
  const released=r.trace.findIndex(e=>e.op==='release');
  const lastRead=r.trace.findIndex((e,i)=>i>released&&e.op==='read'&&e.file===base+'/memory.events');
  const removed=r.trace.findIndex(e=>e.op==='command'&&e.args.includes('rm'));
  assert(lastRead>=0&&lastRead<removed,'Terminal counters are retained before container and reference disposal');
  const exported=r.trace.findIndex(e=>e.op==='write'&&e.name==='L03-memory-postmortem.json');
  assert(exported>lastRead&&exported<removed);
 }
 t.diagnostic(JSON.stringify({kind:'Synthetic adapter/executor composition, not physical execution',
  adapterSha256:sha(adapter),runnerSha256:sha(runner),adapterBodySha256:sha(adapterBody),execBodySha256:sha(execBody),...r}));
});

test('L03-B01: actual executor closes an expired recovery allowance without spawning and keeps ordinary guards',async()=>{
 let clock=1000,spawns=0;const commands=[],loggingFailures=[],written=[];
 const spawn=()=>{spawns++;const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>true;
  queueMicrotask(()=>{p.stdout.end('ok');p.stderr.end();p.emit('close',0,null);});return p;};
 const build=new Function('spawn','collectProcessOutput','save','path','root','loggingFailures','commands','redact','assert','Date',
  'let budgetEnd=2000,cleanupMode=false,seq=0;'+execBody+';return {exec,openReferenceRecovery};');
 const runtime=build(spawn,collectProcessOutput,async(name,value,options)=>written.push({name,value,options}),path,sourceRoot,loggingFailures,commands,v=>v,assert,{now:()=>clock});
 assert.equal((await runtime.exec('synthetic',[])).code,0);
 assert.equal(written[0].options.terminal,false);
 loggingFailures.push({file:'original',error:'ORIGINAL_WRITE_ERROR'});
 await assert.rejects(runtime.exec('synthetic',[]),/EVIDENCE_INCOMPLETE/);
 clock=3000;await assert.rejects(runtime.exec('synthetic',[]),/GROUP_DEADLINE/);
 const cleanup=runtime.openReferenceRecovery();
 assert.equal((await cleanup('synthetic',[])).code,0);
 assert.equal(written[1].options.terminal,true);
 assert.equal(written[1].value.lane,'reference-recovery');
 clock+=20000;await assert.rejects(cleanup('synthetic',[]),/REFERENCE_RECOVERY_DEADLINE/);
 assert.equal(spawns,2);
 assert.deepEqual(loggingFailures,[{file:'original',error:'ORIGINAL_WRITE_ERROR'}]);
 await assert.rejects(runtime.exec('synthetic',[],{recovery:{deadline:Infinity}}),/UNREGISTERED_RECOVERY_ALLOWANCE/);
});

test('L03-B01: actual save reserves bounded terminal space without enlarging the ordinary evidence allowance',async()=>{
 const body=runner.slice(runner.indexOf('async function save('),runner.indexOf('\nconst hash='));
 assert(body.startsWith('async function save('));
 const writes=[];
 const build=new Function('fs','path','output','Buffer',
  'let bytesWritten=2143289344,cleanupMode=false;'+body+';return {save,fill:()=>{bytesWritten=2147483648;}};');
 const runtime=build({writeFile:async(...args)=>writes.push(args)},path,'synthetic-terminal',Buffer);
 await assert.rejects(runtime.save('normal','x'),/EVIDENCE_LIMIT/);
 await runtime.save('cleanup','x',{terminal:true});
 await assert.rejects(runtime.save('normal-after','x'),/EVIDENCE_LIMIT/);
 runtime.fill();await assert.rejects(runtime.save('terminal-full','x',{terminal:true}),/EVIDENCE_LIMIT/);
 assert.equal(writes.length,1);assert.deepEqual(writes[0],[path.join('synthetic-terminal','cleanup'),'x',{flag:'wx'}]);
});

test('L03-B01: actual collector stops an expired recovery command without claiming command success',async()=>{
 const commands=[],loggingFailures=[],signals=[];
 const spawn=()=>{const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();
  p.kill=signal=>{signals.push(signal);p.stdout.end();p.stderr.end();p.emit('close',null,signal);return true;};return p;};
 const build=new Function('spawn','collectProcessOutput','save','path','root','loggingFailures','commands','redact','assert',
  'let budgetEnd=Date.now()+60000,cleanupMode=false,seq=0;'+execBody+';return openReferenceRecovery;');
 const open=build(spawn,collectProcessOutput,async()=>{},path,sourceRoot,loggingFailures,commands,v=>v,assert);
 const result=await open()('synthetic-hung-command',[],{timeout:5});
 assert.deepEqual({code:result.code,signal:result.signal,reason:result.reason,signals},
  {code:null,signal:'SIGKILL',reason:'worker_timeout',signals:['SIGKILL']});
 assert.equal(commands.length,1);assert.equal(commands[0].reason,'worker_timeout');
});

test('L03-B02: actual runner check carries the retained error record into the terminal case result',async()=>{
 const body=runner.slice(runner.indexOf('async function check('),runner.indexOf('\nasync function ownedResource('));
 assert(body.startsWith('async function check('));
 const cases=[];
 const check=new Function('cases','referenceFailure','redact','console',body+';return check;')(cases,referenceFailure,v=>v,{log:()=>{}});
 const primary=Error('ORIGINAL_EXECUTION_FAILURE'),secondary=Error('FINAL_EXPORT_FAILED');
 await check('L03','Preserve terminal observations',()=>referenceCase({
  prepare:async()=>{throw primary;},cleanup:async()=>({confirmed:true}),persist:async()=>{throw secondary;}
 },'memory'));
 assert.equal(cases.length,1);assert.equal(cases[0].status,'failed');
 assert.equal(cases[0].error,primary.message);
 assert.equal(cases[0].reference,referenceFailure(primary).record);
 assert.equal(cases[0].reference.cleanup.confirmed,true);
 assert.equal(cases[0].reference.errors[1].message,secondary.message);
});
