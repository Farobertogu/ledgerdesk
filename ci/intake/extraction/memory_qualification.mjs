import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {collectProcessOutput} from '../../../tests/intake/t01/reviewed/process-output.mjs';
import {checkNativeMemory,qualifyReferenceHost} from '../../intake_l03_linux.mjs';
import {L03_REFERENCE,T03_EXECUTION_PROFILE,validateTermination,referenceFailure} from '../../intake_l03_reference.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const modes=['memory','external','watchdog'];
const failures=new WeakMap();
export const memoryFailure=error=>failures.get(error);
export function extractionArguments(args){
  assert.ok(args.length===2||args.length===3,'EXTRACTION_ARGUMENTS');
  assert.equal(args[0],'--group','EXTRACTION_ARGUMENTS');
  const group=args[1],required=args.length===3;
  assert.ok(['units','schema','worker','composition'].includes(group),'EXTRACTION_EXPLICIT_GROUP');
  if(required){assert.equal(args[2],'--qualified-memory','EXTRACTION_ARGUMENTS');assert.equal(group,'worker','EXTRACTION_MEMORY_GROUP');}
  return {group,required};
}

export async function memorySources(sourceRoot){
  const root=await fs.realpath(sourceRoot),files=[];
  for(const [relative,destination]of [['tests/intake/t01/fixtures/short.txt','/input/original'],
    ['tests/intake/t01/l03_gate.mjs','/work/l03_gate.mjs'],['tests/intake/t01/probe.mjs','/work/probe.mjs']]){
    const file=path.join(root,relative),stat=await fs.lstat(file),actual=await fs.realpath(file);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&actual===file&&stat.size>0&&stat.size<=131072,'MEMORY_SOURCE_FILE');
    assert.ok(!/[,\r\n]/.test(actual),'MEMORY_SOURCE_PATH');
    const bytes=await fs.readFile(file);files.push({path:actual,destination,bytes:bytes.length,sha256:hash(bytes)});
  }
  return files;
}
export function memoryFlags(sources){
  assert.deepEqual(sources.map(s=>s.destination),['/input/original','/work/l03_gate.mjs','/work/probe.mjs'],'MEMORY_SOURCE_SELECTION');
  return ['--init','--user','1000:1000','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--memory=512m','--memory-swap=512m','--cpus=1','--pids-limit=64','--ulimit','nofile=128:128',
    '--tmpfs','/work:rw,noexec,nosuid,size=67108864,uid=1000,gid=1000',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=8388608,uid=1000,gid=1000',
    ...sources.flatMap(s=>['--mount',`type=bind,src=${s.path},dst=${s.destination},readonly`])];
}

// Test ports replace process launch, time and storage, never the acceptance oracle.
export function memoryContext({image,sourceRoot,save,recordCommand,launch=spawn,now=Date.now}){
  const commands=[],loggingFailures=[],resources=[],records=new Map(),lanes=new WeakSet();
  let ordinaryEnd=now()+20*60*1000,cleanupEnd,bytes=0;
  function reserve(value,terminal){
    const size=Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
    assert.ok(bytes+size<=(terminal?2147483648:2143289344),'MEMORY_EVIDENCE_LIMIT');
    bytes+=size;
  }
  async function retain(name,value,{terminal=false}={}){
    reserve(value,terminal);
    try{await save(name,value);}
    catch(error){loggingFailures.push({file:name,error:error.message});throw error;}
    const match=/^L03-(memory|external|watchdog)-result\.json$/.exec(name);
    if(match){assert.ok(!records.has(match[1]),'MEMORY_DUPLICATE_RESULT');records.set(match[1],structuredClone(value));}
  }
  async function exec(bin,args,{timeout=6000,limit=65536,diagnostic=8192,input,recovery}={}){
    if(recovery){assert.ok(lanes.has(recovery),'UNREGISTERED_RECOVERY_ALLOWANCE');timeout=Math.min(timeout,recovery.deadline-now());assert.ok(timeout>0,'REFERENCE_RECOVERY_DEADLINE');}
    else {assert.ok(now()<ordinaryEnd,'GROUP_DEADLINE');assert.equal(loggingFailures.length,0,'EVIDENCE_INCOMPLETE');timeout=Math.min(timeout,ordinaryEnd-now());}
    const result=await new Promise((resolve,reject)=>{
      const child=launch(bin,args,{windowsHide:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
      let closeTimer,spawnError;
      const collector=collectProcessOutput(child.stdout,child.stderr,{outputBytes:limit,diagnosticBytes:diagnostic,
        stop:()=>{closeTimer=setTimeout(()=>reject(Error('MEMORY_COMMAND_CLOSE_TIMEOUT')),1000);child.kill('SIGKILL');}});
      const timer=setTimeout(()=>collector.terminate('worker_timeout'),timeout);
      child.on('error',error=>{spawnError=error;});
      child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(closeTimer);if(spawnError)reject(spawnError);else resolve({code,signal,...collector.finish()});});
      if(input!==undefined){child.stdin.on('error',()=>collector.terminate('input_failure'));child.stdin.end(input);}
    });
    let commandRecord;
    try{const observation={program:bin,args,...result,lane:recovery?'reference-recovery':'ordinary'};
      reserve(observation,!!recovery);commandRecord=await recordCommand(observation);}
    catch(error){loggingFailures.push({phase:'command-export',error:error.message});}
    commands.push({commandRecord,code:result.code,reason:result.reason});
    return {...result,commandRecord};
  }
  const openReferenceRecovery=()=>{const lane={deadline:Math.min(now()+20000,cleanupEnd??Infinity)};lanes.add(lane);return(bin,args,options)=>exec(bin,args,{...options,recovery:lane});};
  const registerReference=(resource,reconcile)=>{
    assert.match(resource.nonce,/^[a-f0-9]{32}$/);
    assert.equal(resource.reference,'system-ldl03'+resource.nonce+'.slice');assert.equal(resource.name,'ld-l03-'+resource.nonce);
    assert.ok(!resources.some(r=>r.resource.reference===resource.reference),'MEMORY_RESOURCE_DUPLICATE');resources.push({resource,reconcile});
  };
  async function reconcile(){
    cleanupEnd=now()+60000;
    for(const entry of resources)if(!entry.resource.cleanup?.confirmed){
      try{assert.ok(now()<cleanupEnd,'REFERENCE_CLEANUP_DEADLINE');entry.resource.reconciliation=await entry.reconcile();}
      catch(error){entry.resource.reconciliation={confirmed:false,errors:[error.message]};}
    }
    return resources.map(entry=>structuredClone(entry.resource));
  }
  return {image,sourceRoot,save:retain,exec,openReferenceRecovery,registerReference,reconcile,records,loggingFailures,commands};
}

const fields=(value,names)=>Object.fromEntries(names.map(name=>[name,value?.[name]]));
const integer=value=>{assert.ok(Number.isSafeInteger(value)&&value>=0,'MEMORY_PUBLIC_INTEGER');return value;};
const matched=(value,pattern)=>{assert.equal(typeof value,'string','MEMORY_PUBLIC_STRING');assert.match(value,pattern,'MEMORY_PUBLIC_STRING');return value;};
const sha=value=>matched(value,/^[a-f0-9]{64}$/);
const eventKeys=['max','oom','oom_kill','oom_group_kill'];
const events=value=>Object.fromEntries(eventKeys.map(key=>[key,integer(value?.[key])]));
function publicSnapshot(value,reference,child=false){
  const row={name:matched(value.name,child?/^docker-[a-f0-9]{64}\.scope$/:/^system-ldl03[a-f0-9]{32}\.slice$/),
    identity:matched(value.identity,/^[0-9]+:[0-9]+$/),processes:value.processes.map(integer),events:events(value.events),localEvents:events(value.localEvents),
    memoryMax:matched(value.memoryMax,/^(max|[0-9]+)$/),children:value.children.map(row=>publicSnapshot(row,reference,true))};
  if(child){Object.assign(row,{swapMax:matched(value.swapMax,/^[0-9]+$/),cpuMax:matched(value.cpuMax,/^[0-9]+ [0-9]+$/),pidsMax:matched(value.pidsMax,/^[0-9]+$/)});}
  else Object.assign(row,{path:matched(value.path,/^\/system\.slice\/system-ldl03[a-f0-9]{32}\.slice$/),invocation:matched(value.invocation,/^[a-f0-9]{32}$/),active:'active'});
  return row;
}
export function projectMemoryProof(value){
  assert.equal(value?.profile,'t03-memory-proof/1','MEMORY_PROOF_PROFILE');assert.equal(value.required,true,'MEMORY_NOT_REQUIRED');
  assert.match(value.image,/^sha256:[a-f0-9]{64}$/,'MEMORY_IMAGE');
  assert.ok(Array.isArray(value.records)&&value.records.length===3&&value.records.every(record=>record&&typeof record==='object'),'MEMORY_CONTROL_SET');
  assert.deepEqual(value.records?.map(record=>record.mode),modes,'MEMORY_CONTROL_SET');
  assert.equal(new Set(value.records.map(record=>record.reference)).size,3,'MEMORY_REFERENCE_REUSE');
  const records=value.records.map(record=>{
    assert.equal(record.executionProfile,T03_EXECUTION_PROFILE,'EXECUTION_PROFILE');assert.equal(record.image,value.image,'MEMORY_IMAGE');
    qualifyReferenceHost(record.host);
    const verdict=validateTermination(record,record.mode);
    if(record.mode!=='memory')assert.throws(()=>validateTermination(record,'memory'));
    assert.equal(record.failure,undefined,'MEMORY_CASE_FAILURE');assert.equal(record.cleanup?.confirmed,true,'MEMORY_CLEANUP_UNCONFIRMED');
    assert.deepEqual(record.cleanup.errors,[],'MEMORY_CLEANUP_ERRORS');
    assert.deepEqual([...record.cleanup.removed].sort(),[record.container.id,record.reference].sort(),'MEMORY_CLEANUP_IDENTITIES');
    const participant=entry=>({pid:entry.pid,ppid:entry.ppid,startTicks:entry.startTicks,membership:entry.membership,argv:[...entry.argv]});
    const t=record.t03;
    const output={profile:L03_REFERENCE,mode:record.mode,executionProfile:T03_EXECUTION_PROFILE,reference:record.reference,image:value.image,
      host:fields(record.host,['platform','actions','environment','driver','version','sameNamespace','sameKernel','rootless','localEvents','socket','contextSocket','hostOverride']),
      before:publicSnapshot(record.before,record.reference),armed:publicSnapshot(record.armed,record.reference),after:publicSnapshot(record.after,record.reference),
      container:fields(record.container,['id','pid','membership','startTicks','parent','memory','memorySwap','restartCount','restartPolicy','image']),probeMatchesSource:true,
      t03:{participants:t.participants.map(participant),confirmedParticipants:t.confirmedParticipants.map(participant),
        configuration:structuredClone(t.configuration),effective:structuredClone(t.effective),mounts:t.mounts.map(m=>fields(m,['destination','type','readOnly','matchesSource'])),
        files:t.files.map(file=>({destination:file.destination,expected:{bytes:file.expected.bytes,sha256:sha(file.expected.sha256)},observed:{bytes:file.observed.bytes,sha256:sha(file.observed.sha256)}}))},
      outcome:fields(record.outcome,['id','running','restartCount','exit','dockerOOMKilled','clientCode','clientClosed','reason','encodingError','intervention']),
      cleanup:{confirmed:true,removed:[...record.cleanup.removed],errors:[]}};
    assert.equal(typeof output.outcome.dockerOOMKilled,'boolean','MEMORY_DOCKER_FLAG');
    // Validate exact closed configuration before copying it; no unknown member survives.
    const replay=validateTermination(output,record.mode);
    assert.deepEqual(replay,{...verdict,memoryEvents:events(verdict.memoryEvents)},'MEMORY_PUBLIC_REPLAY');
    output.verdict=replay;return output;
  });
  return {profile:'t03-memory-proof/1',required:true,image:value.image,qualified:true,records};
}
export function requireMemoryProof(required,image,proof){
  if(!required){assert.equal(proof,undefined,'MEMORY_UNREQUESTED_PROOF');return {required:false,qualified:false};}
  assert.equal(proof?.image,image,'MEMORY_PROOF_IMAGE');return projectMemoryProof(proof);
}

export async function runMemoryQualification(options,{run=checkNativeMemory,sourceReader=memorySources}={}){
  const context=memoryContext(options);let primary,proof,resources;
  const secondary=[];
  try{
    const sources=await sourceReader(options.sourceRoot);
    await context.save('memory-source-identities.json',sources.map(source=>fields(source,['destination','bytes','sha256'])));
    await run({...context,executionProfile:T03_EXECUTION_PROFILE,probeSources:sources,flags:memoryFlags(sources)});
    assert.equal(context.loggingFailures.length,0,'MEMORY_EVIDENCE_INCOMPLETE');
    proof=requireMemoryProof(true,options.image,{profile:'t03-memory-proof/1',required:true,image:options.image,records:modes.map(mode=>context.records.get(mode))});
  }catch(error){primary=error;}
  finally{
    try{
      resources=await context.reconcile();assert.ok(resources.every(r=>(r.reconciliation??r.cleanup)?.confirmed===true),'MEMORY_FINAL_CLEANUP');
      if(!primary){
        assert.deepEqual(resources.map(r=>({reference:r.reference,id:r.id})),proof.records.map(r=>({reference:r.reference,id:r.container.id})),'MEMORY_RESOURCE_SET');
        assert.equal(context.loggingFailures.length,0,'MEMORY_EVIDENCE_INCOMPLETE');
      }
    }
    catch(error){if(!primary)primary=error;else secondary.push(error);}
    if(!primary)try{await context.save('memory-proof.json',proof,{terminal:true});}
    catch(error){primary=error;}
    const status={required:true,image:options.image,qualified:!primary&&!!proof,resources,
      loggingFailures:context.loggingFailures,...(primary?{failure:{message:primary.message},reference:referenceFailure(primary)?.record}:{})};
    try{await context.save('memory-status.json',status,{terminal:true});}
    catch(error){if(!primary)primary=error;else secondary.push(error);}
    if(primary){status.qualified=false;failures.set(primary,{status,secondary});}
  }
  if(primary)throw primary;return proof;
}
