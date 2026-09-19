import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {L03_REFERENCE,validateArmed,validateTermination,referenceCase} from '../../../ci/intake_l03_reference.mjs';
import {nativeProbeLaunch,observeT03Setup} from '../../../ci/intake_l03_linux.mjs';
import {extractionArguments,memoryFlags,memoryContext,runMemoryQualification,memoryFailure,
  projectMemoryProof,requireMemoryProof} from '../../../ci/intake/extraction/memory_qualification.mjs';
import {extractionPublicSummary,exportExtractionEvidence} from '../../../ci/intake_extraction_artifacts.mjs';

// Literal model observations, not a physical Linux or OOM result. Expected
// commands, identities and counters are not obtained from the producer helpers.
const image='sha256:'+'4'.repeat(64),zero=()=>({max:0,oom:0,oom_kill:0,oom_group_kill:0});
const nodeArgs=mode=>['--experimental-strip-types','--permission','--allow-fs-read=/app/workers/intake/extraction',
 '--allow-fs-read=/app/src/contracts','--allow-fs-read=/input/original','--allow-fs-read=/work/l03_gate.mjs',
 '--allow-fs-read=/work/probe.mjs','--max-old-space-size=128','/work/l03_gate.mjs',mode==='memory'?'memory':'cpu'];
const modes=['memory','external','watchdog'];
function specimen(mode='memory'){
 const n=modes.indexOf(mode)+1,nonce=String(n).repeat(32),id=String(n+4).repeat(64),reference='system-ldl03'+nonce+'.slice';
 const before={name:reference,path:'/system.slice/'+reference,identity:'29:1001',invocation:'a'.repeat(32),active:'active',
  memoryMax:'max',processes:[],children:[],events:zero(),localEvents:zero()};
 const child={name:'docker-'+id+'.scope',identity:'29:1002',memoryMax:'536870912',swapMax:'0',cpuMax:'100000 100000',pidsMax:'64',
  processes:[2345,2346],children:[],events:zero(),localEvents:zero()};
 const membership=before.path+'/'+child.name;
 const participants=[{pid:2345,ppid:111,startTicks:'9001',membership,argv:['/sbin/docker-init','--','node',...nodeArgs(mode)]},
  {pid:2346,ppid:2345,startTicks:'9002',membership,argv:['node',...nodeArgs(mode)]}];
 const destinations=['/input/original','/work/l03_gate.mjs','/work/probe.mjs'];
 return {profile:L03_REFERENCE,executionProfile:'t03-init-probe/1',mode,image,reference,before,
  armed:{...structuredClone(before),children:[child]},after:{...structuredClone(before),events:mode==='memory'?{max:42,oom:1,oom_kill:1,oom_group_kill:0}:zero()},
  host:{platform:'linux',actions:'true',environment:'github-hosted',driver:'systemd',version:'2',sameNamespace:true,sameKernel:true,
   rootless:false,localEvents:false,socket:'unix:///var/run/docker.sock',contextSocket:'unix:///var/run/docker.sock',hostOverride:null},
  container:{id,pid:2345,membership,startTicks:'9001',parent:reference,memory:536870912,memorySwap:536870912,restartCount:0,restartPolicy:'no',image},
  probeMatchesSource:true,t03:{participants,confirmedParticipants:structuredClone(participants),
   files:destinations.map((destination,i)=>({destination,expected:{bytes:37+i,sha256:String(i+6).repeat(64)},observed:{bytes:37+i,sha256:String(i+6).repeat(64)}})),
   mounts:destinations.map(destination=>({destination,type:'bind',readOnly:true,matchesSource:true})),
   configuration:{init:true,user:'1000:1000',readOnly:true,network:'none',capDrop:['ALL'],securityOpt:['no-new-privileges'],nanoCpus:1000000000,pidsLimit:64,
    nofile:{soft:128,hard:128},entrypoint:['node'],cmd:nodeArgs(mode),tmpfs:{'/work':'rw,noexec,nosuid,size=67108864,uid=1000,gid=1000','/tmp':'rw,noexec,nosuid,size=8388608,uid=1000,gid=1000'}},
   effective:{uid:1000,gid:1000,node:'v22.16.0',seccomp:'2',cap:'0000000000000000',nnp:'1',memory:'536870912',swap:'0',cpu:'100000 100000',pids:'64',nofileSoft:128,nofileHard:128}},
  outcome:{id,running:false,restartCount:0,exit:137,clientCode:137,clientClosed:true,reason:mode==='watchdog'?'worker_timeout':null,
   encodingError:false,intervention:mode==='memory'?null:mode,dockerOOMKilled:mode==='memory'},
  cleanup:{confirmed:true,removed:[id,reference],errors:[]}};
}
const proof=()=>({profile:'t03-memory-proof/1',required:true,image,records:modes.map(specimen)});
const sources=()=>specimen().t03.files.map((file,i)=>({path:'/synthetic/fixed-'+i,destination:file.destination,...file.expected}));

test('M01: one literal T03 topology and the unchanged three-way termination oracle',()=>{
 for(const mode of modes){const record=specimen(mode);assert.equal(validateArmed(record),true);
  assert.equal(validateTermination(record,mode).acceptedAsOOM,mode==='memory');
  if(mode!=='memory')assert.throws(()=>validateTermination(record,'memory'));
 }
 const record=specimen();delete record.executionProfile;assert.throws(()=>validateArmed(record),/FOREIGN_REFERENCE_PROCESS/);
 record.armed.children[0].processes=[2345];assert.equal(validateArmed(record),true,'The old singleton is unchanged');
});
const negatives=[
 ['extra-process',r=>r.armed.children[0].processes.push(2347),'FOREIGN_REFERENCE_PROCESS'],
 ['wrong-parent',r=>{r.t03.participants[1].ppid=99;r.t03.confirmedParticipants[1].ppid=99;},'T03_NODE_PARENT'],
 ['changed-start',r=>r.t03.confirmedParticipants[1].startTicks='9003','T03_PROCESS_CHANGED'],
 ['same-process',r=>{r.t03.participants[1].pid=2345;r.t03.confirmedParticipants[1].pid=2345;},'T03_NODE_PID'],
 ['missing-init',r=>r.t03.configuration.init=false,'T03_CONFIGURATION'],
 ['wrong-command',r=>{r.t03.participants[1].argv[1]='--expose-gc';r.t03.confirmedParticipants=structuredClone(r.t03.participants);},'T03_NODE_COMMAND'],
 ['wrong-image',r=>r.container.image='sha256:'+'9'.repeat(64),'CONTAINER_IMAGE'],
 ['wrong-mount',r=>r.t03.mounts[1].matchesSource=false,'T03_MOUNTS'],
 ['changed-fixture',r=>r.t03.files[1].observed.sha256='f'.repeat(64),'T03_ACTUAL_FILE_BYTES'],
 ['missing-file',r=>r.t03.files.pop(),'T03_FILES'],
 ['wrong-memory',r=>r.armed.children[0].memoryMax='1073741824','EFFECTIVE_MEMORY_LIMIT'],
 ['weak-controls',r=>r.t03.effective.nnp='0','T03_EFFECTIVE_CONTROLS'],
 ['heap-only',r=>{r.outcome.exit=134;r.outcome.clientCode=134;r.after.events=zero();},'TERMINAL_EXIT'],
 ['timeout-not-oom',r=>r.outcome.reason='worker_timeout','SUPERVISOR_INTERVENTION'],
 ['missing-pressure',r=>r.after.events.oom=0,'CASE_LIMIT_NOT_REACHED'],
 ['unknown-profile',r=>r.executionProfile='t03-any-process/1','EXECUTION_PROFILE'],
];
test('M02: independent directed topology, fixture and termination negatives',()=>{
 for(const [name,mutate,code]of negatives){const record=specimen();mutate(record);assert.throws(()=>validateTermination(record,'memory'),new RegExp(code),name);}
});
test('M03: fixed launch replaces the entry point and retains init, bounds and trusted mounts',()=>{
 const flags=memoryFlags(sources()),args=nativeProbeLaunch({image,flags,executionProfile:'t03-init-probe/1'},'memory');
 assert.deepEqual(args.slice(args.indexOf('--entrypoint')),['--entrypoint','node',image,...nodeArgs('memory')]);
 for(const flag of ['--init','--read-only','--memory=512m','--memory-swap=512m','--pids-limit=64','--cpus=1'])assert.ok(args.includes(flag),flag);
 assert.deepEqual(flags.filter(value=>value.startsWith('type=bind')),sources().map(s=>`type=bind,src=${s.path},dst=${s.destination},readonly`));
 assert.deepEqual(nativeProbeLaunch({image,flags:['--memory=512m']},'external'),['--memory=512m','--network=none',image,'node','--max-old-space-size=128','/work/l03_gate.mjs','cpu']);
 assert.throws(()=>nativeProbeLaunch({image,flags:[],executionProfile:'unknown'},'memory'),/EXECUTION_PROFILE/);
});
async function actualObservation(fault){
 const record=specimen(),trace=[],src=sources(),c=record.t03.configuration;
 const row={Id:record.container.id,State:{Pid:2345},Config:{User:c.user,Entrypoint:c.entrypoint,Cmd:c.cmd},
  HostConfig:{Init:c.init,ReadonlyRootfs:c.readOnly,NetworkMode:c.network,CapDrop:c.capDrop,SecurityOpt:c.securityOpt,NanoCpus:c.nanoCpus,
   PidsLimit:c.pidsLimit,Ulimits:[{Name:'nofile',Soft:128,Hard:128}],Tmpfs:c.tmpfs},
  Mounts:src.map(s=>({Source:s.path,Destination:s.destination,Type:'bind',RW:false}))};
 if(fault==='mount')row.Mounts[1].Source='/wrong/intact-probe';
 let helperActive=false,stats=0;
 const result=await observeT03Setup({row,sources:src,
  command:async args=>{
   trace.push('helper');helperActive=true;assert.deepEqual(args.slice(0,6),['exec','--user','1000:1000',row.Id,'node','-e']);
   assert.ok(args[6].includes("['/input/original','/work/l03_gate.mjs','/work/probe.mjs']"));
   const files=record.t03.files.map(f=>({destination:f.destination,...f.observed}));if(fault==='bytes')files[1].sha256='f'.repeat(64);
   helperActive=false;return JSON.stringify({files,effective:record.t03.effective});},
  readText:async file=>{
   trace.push(file);const pid=Number(file.split('/')[2]),p=record.t03.participants.find(p=>p.pid===pid);assert.ok(p,'Only identified PIDs');
   if(file.endsWith('/cmdline'))return p.argv.join('\0')+'\0';if(file.endsWith('/cgroup'))return '0::'+p.membership;
   assert.ok(file.endsWith('/stat'));const f=Array(20).fill('0');f[0]='S';f[1]=String(p.ppid);f[19]=p.startTicks;
   if(fault==='replacement'&&++stats>2)f[19]='9900';return pid+' (node) '+f.join(' ');},
  snapshot:async()=>{trace.push('snapshot');assert.equal(helperActive,false);return structuredClone(record.armed);}});
 assert.equal(validateArmed({...record,...result}),true);return trace;
}
test('M04: actual observation binds bytes and process identities after the helper has exited',async()=>{
 const trace=await actualObservation();assert.equal(trace[0],'helper');assert.equal(trace[1],'snapshot');
 for(const [fault,error]of [['mount','T03_MOUNTS'],['bytes','T03_ACTUAL_FILE_BYTES'],['replacement','T03_PROCESS_CHANGED']])
  await assert.rejects(actualObservation(fault),new RegExp(error));
});

function syntheticExecution({fault}={}){
 return async context=>{
  for(const mode of modes){
   const s=specimen(mode),nonce=s.reference.slice('system-ldl03'.length,-'.slice'.length);
   const resource={nonce,reference:s.reference,name:'ld-l03-'+nonce,id:s.container.id};
   context.registerReference(resource,async()=>({confirmed:true,removed:[resource.id,resource.reference],errors:[]}));
   await referenceCase({
    prepare:async()=>({reference:s.reference,image,executionProfile:s.executionProfile,host:s.host,before:s.before}),
    arm:async()=>({armed:s.armed,container:s.container,probeMatchesSource:true,t03:s.t03}),
    execute:async()=>{if(fault==='primary')throw Object.assign(Error('PRIMARY_EXECUTION'),{code:'PRIMARY'});return s.outcome;},
    readAfter:async()=>s.after,
    recoverTerminal:async observe=>{observe({after:s.after});return [];},
    cleanup:async()=>{const value=fault==='cleanup'?{confirmed:false,removed:[],errors:['LOST_REMOVAL_REPLY']}:s.cleanup;resource.cleanup=value;return value;},
    persist:(phase,value)=>context.save('L03-'+mode+'-'+phase+'.json',value,{terminal:phase==='result'||phase==='postmortem'})
   },mode);
  }
 };
}
async function bridge(fault){
 const saved=new Map(),original=Error('ORIGINAL_EXPORT_FAILURE');let error,result;
 try{result=await runMemoryQualification({image,sourceRoot:'/synthetic',save:async(name,value)=>{
   if(fault==='export'&&name==='L03-memory-result.json')throw original;
   if(fault==='final-export'&&name==='memory-proof.json')throw original;
   if(fault==='primary'&&name==='L03-memory-postmortem.json')throw Error('SECONDARY_EXPORT');
   saved.set(name,structuredClone(value));},recordCommand:async()=>{throw Error('No real commands in directed ports');}},
  {run: fault==='missing'?async()=>{}:syntheticExecution({fault}),sourceReader:async()=>sources()});}catch(e){error=e;}
 return {saved,error,result,original};
}
test('M05: real bridge and reference composition requires all three results and exact resource closure',async()=>{
 const r=await bridge();assert.equal(r.error,undefined);assert.equal(r.result.qualified,true);
 assert.deepEqual(r.result.records.map(r=>r.verdict.acceptedAsOOM),[true,false,false]);
 assert.equal(r.saved.get('memory-status.json').resources.length,3);assert.ok(r.saved.has('memory-proof.json'));
 for(const fault of ['missing','export','final-export','cleanup','primary']){
  const failed=await bridge(fault);assert.ok(failed.error,fault);assert.equal(memoryFailure(failed.error).status.qualified,false,fault);
  if(fault==='export'||fault==='final-export')assert.equal(failed.error,failed.original);
  if(fault==='final-export')assert.equal(failed.saved.get('memory-status.json').qualified,false,'Proof-write failure cannot leave a qualified terminal status');
  if(fault==='missing')assert.match(failed.error.message,/MEMORY_CONTROL_SET/);
  if(fault==='cleanup')assert.equal(memoryFailure(failed.error).status.resources[0].reconciliation.confirmed,true,'Reconciliation cannot erase the original failure');
  if(fault==='primary'){assert.equal(failed.error.code,'PRIMARY');assert.equal(memoryFailure(failed.error).status.reference.errors[1].message,'SECONDARY_EXPORT');}
 }
});
function childLaunch({hang=false}={}){
 const signals=[];let calls=0;
 return {signals,get calls(){return calls;},launch(){calls++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  child.kill=signal=>{signals.push(signal);child.stdout.end();child.stderr.end();child.emit('close',null,signal);};
  if(!hang)queueMicrotask(()=>{child.stdout.end('ok');child.stderr.end();child.emit('close',0,null);});return child;}};
}
test('M06: actual bounded executor keeps evidence failure primary and recovery finite',async()=>{
 let clock=1000;const launched=childLaunch();let failExport=false;
 const context=memoryContext({image,sourceRoot:'/synthetic',save:async()=>{},launch:launched.launch,now:()=>clock,
  recordCommand:async()=>{if(failExport)throw Error('WRITE_FAILED');return '001-command.json';}});
 assert.equal((await context.exec('synthetic',[])).code,0);failExport=true;
 assert.equal((await context.exec('synthetic',[])).code,0);await assert.rejects(context.exec('synthetic',[]),/EVIDENCE_INCOMPLETE/);
 const recover=context.openReferenceRecovery();assert.equal((await recover('synthetic',[])).code,0);
 clock+=20001;await assert.rejects(recover('synthetic',[]),/REFERENCE_RECOVERY_DEADLINE/);
 await assert.rejects(context.exec('synthetic',[],{recovery:{deadline:Infinity}}),/UNREGISTERED_RECOVERY_ALLOWANCE/);
 assert.equal(launched.calls,3);
 const hung=childLaunch({hang:true}),other=memoryContext({image,sourceRoot:'/synthetic',save:async()=>{},recordCommand:async()=> '002-command.json',launch:hung.launch});
 const observed=await other.openReferenceRecovery()('synthetic',[],{timeout:5});
 assert.deepEqual({code:observed.code,reason:observed.reason,signals:hung.signals},{code:null,reason:'worker_timeout',signals:['SIGKILL']});
});
test('M07: command mode is explicit and removing the required proof cannot pass',()=>{
 assert.deepEqual(extractionArguments(['--group','worker','--qualified-memory']),{group:'worker',required:true});
 assert.deepEqual(extractionArguments(['--group','worker']),{group:'worker',required:false});
 for(const args of [[],['--group','schema','--qualified-memory'],['--group','worker','--ignore'],['--qualified-memory','--group','worker'],['--group','worker','--qualified-memory','--qualified-memory']])assert.throws(()=>extractionArguments(args));
 assert.equal(requireMemoryProof(true,image,proof()).qualified,true);
 assert.throws(()=>requireMemoryProof(true,image,undefined),/MEMORY_PROOF_IMAGE/);
 assert.deepEqual(requireMemoryProof(false,image,undefined),{required:false,qualified:false});
 const missing=proof();missing.records.pop();assert.throws(()=>requireMemoryProof(true,image,missing),/MEMORY_CONTROL_SET/);
});
test('M08: closed proof replays the independent oracle and cannot publish an injected secret',()=>{
 const raw=proof(),secret='PRIVATE_COOKIE_PATH_BODY_7891';
 raw.cookie=secret;raw.records[0].host.secret=secret;raw.records[0].t03.participants[0].body=secret;
 raw.records[0].t03.confirmedParticipants[0].body=secret;raw.records[0].before.secret=secret;raw.records[0].outcome.secret=secret;
 const safe=projectMemoryProof(raw);assert.equal(JSON.stringify(safe).includes(secret),false);
 for(const row of safe.records)assert.deepEqual(validateTermination(row,row.mode),row.verdict);
 const corrupt=proof();corrupt.records[0].before.identity=secret;corrupt.records[0].armed.identity=secret;corrupt.records[0].after.identity=secret;
 assert.throws(()=>projectMemoryProof(corrupt),/MEMORY_PUBLIC_STRING/);
 const unknown=proof();unknown.records[0].t03.configuration.secret=secret;assert.throws(()=>projectMemoryProof(unknown),/T03_CONFIGURATION/);
 const reused=proof();reused.records[1]=structuredClone(reused.records[0]);reused.records[1].mode='external';assert.throws(()=>projectMemoryProof(reused),/MEMORY_REFERENCE_REUSE/);
});
test('M09: actual exporter retains replayable proof; missing required proof stays visibly unqualified',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'t03-memory-export-'));
 const runId='intake-extraction-2026-09-19t00-00-00-000z-1234abcd';
 try{
  const input=path.join(dir,'input'),run=path.join(input,runId);await fs.mkdir(run,{recursive:true});
  const manifest={runId,group:'worker',outcome:'passed',commands:[],resources:[],memory:{required:true,qualified:true,image,proofFile:'memory-proof.json'}};
  await fs.writeFile(path.join(run,'manifest.json'),JSON.stringify(manifest));await fs.writeFile(path.join(run,'memory-proof.json'),JSON.stringify(proof()));
  const output=path.join(dir,'positive');assert.equal(await exportExtractionEvidence(input,output),true);
  const summary=JSON.parse(await fs.readFile(path.join(output,runId+'.json'))),record=JSON.parse(await fs.readFile(path.join(output,runId+'-memory.json')));
  assert.equal(summary.memory.qualified,true);assert.deepEqual(record,projectMemoryProof(proof()));
  await fs.unlink(path.join(run,'memory-proof.json'));
  const negative=path.join(dir,'missing');assert.equal(await exportExtractionEvidence(input,negative),false);
  const failed=JSON.parse(await fs.readFile(path.join(negative,runId+'.json')));assert.equal(failed.completed,false);assert.equal(failed.memory.qualified,false);
  assert.deepEqual(extractionPublicSummary({...manifest,memory:{required:false,qualified:false}},'a'.repeat(64)).memory,{required:false,qualified:false});
 }finally{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('t03-memory-export-'));await fs.rm(dir,{recursive:true});}
});

test('M10: actual worker and final-result connection discriminate missing invocation and missing proof',async()=>{
 const source=await fs.readFile(new URL('../../../ci/intake_extraction_check.mjs',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function worker()'),source.indexOf('\nasync function composition()'));
 const gate=source.slice(source.indexOf('  requireMemoryProof(qualifiedMemory,'),source.indexOf("  outcome = 'passed';")+"  outcome = 'passed';".length);
 assert.ok(body.startsWith('async function worker()')&&gate.includes('requireMemoryProof'),'Actual worker and terminal gate selected');
 const start=body.indexOf('memoryProof=await module.runMemoryQualification('),end=body.indexOf('      memory={required:true',start);
 assert.ok(start>0&&end>start);
 const withoutInvocation=body.slice(0,start)+'memoryProof=undefined;\n'+body.slice(end);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 async function exercise(worker,terminal,{lostResult=false}={}){
  const trace=[];
  const run=new AsyncFunction('source','command','path','directory','runId','resources','save','pathToFileURL','load','requireMemoryProof','trace',
   'let qualifiedMemory=true,memoryImage,memoryProof,memory,outcome="failed";'+worker.replaceAll('await import(','await load(')+
   ';await worker();'+terminal+';return {outcome,memory,memoryProof,trace};');
  const load=async file=>file.includes('fixed_entry_driver')?{fixedEntryCases:async options=>{trace.push(['positive',options.image]);return [{useful:true}];}}:
   {runMemoryQualification:async options=>{trace.push(['memory',options.image]);const result=await runMemoryQualification(options,{run:syntheticExecution(),sourceReader:async()=>sources()});return lostResult?undefined:result;},memoryFailure};
  return run(async()=>{},async args=>args[0]==='image'?JSON.stringify([{Id:image}]):'',path,'/synthetic','synthetic-run',[],async()=>{},p=>p,load,requireMemoryProof,trace);
 }
 const positive=await exercise(body,gate);assert.equal(positive.outcome,'passed');assert.equal(positive.memoryProof.qualified,true);assert.deepEqual(positive.trace,[['positive',image],['memory',image]]);
 await assert.rejects(exercise(body,gate,{lostResult:true}),/MEMORY_PROOF_IMAGE/);
 await assert.rejects(exercise(withoutInvocation,gate),/MEMORY_PROOF_IMAGE/,'Directed removal of actual bridge invocation');
 const unsafe=await exercise(body,"outcome='passed';",{lostResult:true});
 assert.throws(()=>assert.equal(unsafe.memoryProof?.qualified,true,'Required proof must exist'),/Required proof must exist/,
  'Removing the actual final gate admits the observed lost result and fails the independent requirement');
});
