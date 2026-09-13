import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {PrivatePhaseJournal} from '/work/private_phase.mjs';
import {supervisedOperation} from '/work/operation_supervisor.mjs';

const folder='/output/phase-prototype-'+randomUUID();fs.mkdirSync(folder,{mode:0o700});
const observations=[];
const make=(options={})=>new PrivatePhaseJournal(folder+'/'+randomUUID(),'objects',options);
const fixture=()=>({id:randomUUID(),incarnation:'runtime-prototype-1',namespace:'intake_trial',
  original:{id:randomUUID(),generation:1,bytes:197,sha256:'a'.repeat(64)},evidenceId:randomUUID(),participant:'objects',actions:['append']});
const command=phase=>({id:randomUUID(),incarnation:phase.incarnation,namespace:phase.namespace,original:phase.original,evidenceId:phase.evidenceId,action:'append'});
function worker(request){
  const startedAtMs=Date.now(),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});
  const completion=new Promise(resolve=>child.once('close',(exitCode,signal)=>resolve({id:request.id,termination:{profile:'intake-child-stop/1',
    requestId:request.id,workerPid:child.pid,startedAtMs,closedAtMs:Date.now(),exitCode,signal}})));
  return{completion,stop:()=>child.kill('SIGKILL')};
}
test.after(()=>fs.writeFileSync(folder+'/observations.json',JSON.stringify({profile:'private-phase-prototype/1',observations},null,2),{flag:'wx'}));
test('a real worker closes before the persisted terminal acknowledgement',async()=>{
  const journal=make(),phase=fixture(),request=command(phase);journal.open(phase);
  const operation=worker(request),pending=journal.execute(phase.id,request,()=>operation);
  try{
    const acknowledgement=await journal.close(phase.id),result=await pending,atMs=Date.now();
    const persisted=JSON.parse(fs.readFileSync(journal.file));
    assert.deepEqual({state:persisted.rows[phase.id].state,signal:result.termination.signal,id:acknowledgement.id},
      {state:'closed',signal:'SIGKILL',id:phase.id});
    assert.ok(result.termination.closedAtMs<=atMs);observations.push({case:'actual-worker-close',acknowledgement,result,atMs});
  }finally{operation.stop();await operation.completion;}
});
test('CLOSE before OPEN is durable across a fresh journal instance',async()=>{
  const journal=make(),phase=fixture();await journal.close(phase.id);
  const reopened=PrivatePhaseJournal.reopen(journal.directory,'objects');
  assert.throws(()=>reopened.open(phase),/PHASE_CLOSED/);
  let calls=0;await assert.rejects(()=>reopened.execute(phase.id,command(phase),()=>{calls++;}),/PHASE_CLOSED/);assert.equal(calls,0);
  assert.equal((await reopened.close(phase.id)).id,phase.id);
  const positive=fixture();assert.equal(reopened.open(positive).id,positive.id);await reopened.close(positive.id);
});
test('reopening an unfinished journal does not infer that old workers stopped',async()=>{
  const journal=make(),phase=fixture();journal.open(phase);
  const reopened=PrivatePhaseJournal.reopen(journal.directory,'objects');
  assert.throws(()=>reopened.open(phase),/PHASE_RECOVERY_REQUIRED/);
  assert.throws(()=>reopened.open(fixture()),/PHASE_RECOVERY_REQUIRED/);
  await assert.rejects(()=>reopened.close(phase.id),/PHASE_RECOVERY_REQUIRED/);
  assert.equal(JSON.parse(fs.readFileSync(reopened.file)).rows[phase.id].state,'open');
  await journal.close(phase.id);
});
test('each command pins the original, generation, evidence, action and incarnation',async()=>{
  const journal=make(),phase=fixture();journal.open(phase);let calls=0;
  for(const delta of [{original:{...phase.original,id:randomUUID()}},{original:{...phase.original,generation:2}},
    {original:{...phase.original,sha256:'b'.repeat(64)}},{evidenceId:randomUUID()},{action:'read'},
    {incarnation:'runtime-prototype-2'},{namespace:'intake_restore'}]){
    await assert.rejects(()=>journal.execute(phase.id,{...command(phase),...delta},()=>{calls++;}),/PHASE_COMMAND_BINDING/);
  }
  assert.equal(calls,0);assert.equal(journal.open(phase).id,phase.id);
  assert.throws(()=>journal.open({...phase,evidenceId:randomUUID()}),/PHASE_BINDING_CONFLICT/);await journal.close(phase.id);
});
test('a lost completion cannot clear a closing phase after the bounded wait',async()=>{
  const journal=make({closeMs:20}),phase=fixture(),request=command(phase);journal.open(phase);let stopped=0;
  // A deliberately unresolved controlled double tests timeout classification, not process termination.
  journal.execute(phase.id,request,()=>({completion:new Promise(()=>{}),stop:()=>stopped++}));
  await assert.rejects(()=>journal.close(phase.id),/PHASE_QUIESCENCE_UNCONFIRMED/);
  assert.deepEqual({stopped,state:JSON.parse(fs.readFileSync(journal.file)).rows[phase.id].state},{stopped:1,state:'closing'});
  assert.throws(()=>journal.open(phase),/PHASE_CLOSED/);
});
test('the journal bound refuses new work rather than evicting old tombstones',async()=>{
  const journal=make({maximumEntries:1}),phase=fixture();await journal.close(phase.id);
  assert.throws(()=>journal.open(fixture()),/PHASE_JOURNAL_LIMIT/);
  assert.throws(()=>journal.open(phase),/PHASE_CLOSED/);
});
test('an uncertain worker start cannot be classified as an empty phase',async()=>{
  const journal=make({closeMs:20}),phase=fixture(),request=command(phase);journal.open(phase);
  await assert.rejects(()=>journal.execute(phase.id,request,()=>{throw Error('INJECTED_START_FAILURE');}),/INJECTED_START_FAILURE/);
  await assert.rejects(()=>journal.close(phase.id),/PHASE_QUIESCENCE_UNCONFIRMED/);
  assert.equal(JSON.parse(fs.readFileSync(journal.file)).rows[phase.id].state,'closing');
});
test('corrupt retained control is not rebuilt from an empty replacement',()=>{
  const journal=make();fs.writeFileSync(journal.file,'{broken');
  assert.throws(()=>PrivatePhaseJournal.reopen(journal.directory,'objects'));
  assert.throws(()=>new PrivatePhaseJournal(journal.directory,'objects'),{code:'EEXIST'});
});
test('a failing start observer still owns and terminates its actual child',async()=>{
  const phase=fixture(),request=command(phase);let starts=0;
  const operation=supervisedOperation('objects',request,event=>{if(event.kind==='started'){starts++;throw Error('INJECTED_OBSERVATION_FAILURE');}});
  const result=await operation.completion;
  assert.deepEqual({starts,ok:result.ok,reason:result.termination.reason,signal:result.termination.signal},
    {starts:1,ok:false,reason:'observation-failed',signal:'SIGKILL'});
  assert.throws(()=>fs.statSync('/proc/'+result.termination.workerPid),{code:'ENOENT'});
  observations.push({case:'observer-failure-child-closed',result});
});
