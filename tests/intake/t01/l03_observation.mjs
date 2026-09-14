import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureClient,projectEvent,projectState,tarMemberIdentity,parseLeafCounters,observationAssessment,observeL03,L03_CAPTURE} from '../../../ci/intake_l03_observer.mjs';

const target='a'.repeat(64),other='b'.repeat(64),image='sha256:'+'c'.repeat(64);
const hash=b=>createHash('sha256').update(b).digest('hex');
const result=stdout=>({code:0,signal:null,error:null,reason:null,closed:true,pendingBytes:0,encodingError:false,received:Buffer.byteLength(stdout),retained:Buffer.byteLength(stdout),stderrBytes:0,stdout:Buffer.from(stdout)});
const event=(action,id=target)=>JSON.stringify({Type:'container',Action:action,Actor:{ID:id,Attributes:{exitCode:'137',signal:'9',secret:'PRIVATE_SENTINEL'}},timeNano:'1789350874012345678'});
function archive(name,content){
  const bytes=Buffer.from(content),tar=Buffer.alloc(512+Math.ceil(bytes.length/512)*512+1024);
  tar.write(name,0);tar.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);tar.write('0',156);tar.fill(32,148,156);
  let sum=0;for(const b of tar.subarray(0,512))sum+=b;tar.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  bytes.copy(tar,512);return tar;
}
function harness({broken=false,streamReason='observer_stop',foreign=false,exportError=false}={}){
  let record,emit,finished=false;const calls=[],failures=[];
  const before={Id:target,Image:image,Created:'2026-09-14T00:00:00Z',Path:'node',Args:['/work/probe.mjs','memory'],
    State:{OOMKilled:false,ExitCode:0,Pid:17,Error:'PRIVATE_SENTINEL'},Config:{User:'1000:1000',Env:['SECRET=PRIVATE_SENTINEL']},HostConfig:{Memory:536870912,MemorySwap:536870912}};
  const run=async args=>{
    calls.push(args);
    if(broken)throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'ECONNREFUSED'});
    if(args[0]==='image')return result(JSON.stringify([{Id:image,Config:{Env:['PRIVATE_SENTINEL']},RootFS:{Layers:[]}}]));
    if(args[0]==='cp')return result(archive(args[1].includes('probe.mjs')?'probe.mjs':'docker-entrypoint.sh','synthetic'));
    return result(JSON.stringify([{...before,State:{...before.State,OOMKilled:finished,ExitCode:finished?137:0}}]));
  };
  return {calls,failures,get record(){return record;},
    options:{target,run,expectedProbeSha256:hash('synthetic'),leafReader:async()=>[{status:'unavailable',reason:'TEST_INTERFACE_UNAVAILABLE'}],
      openEvents:(args,onLine)=>{calls.push(args);emit=onLine;return {stop:()=>{finished=true;},done:Promise.resolve({...result(''),reason:streamReason})};},
      save:async(name,value)=>{assert.equal(name,'L03-observation.json');record=value;if(exportError)throw Error('PRIVATE_SENTINEL');},onFailure:e=>failures.push(e)},
    work:async observer=>{
      if(emit){emit(event('start'));emit(event('oom',foreign?other:target));emit(event('die'));}
      const primary={state:{OOMKilled:false,ExitCode:137},host:{}};
      observer.recordPrimary({code:137,signal:null,reason:undefined,milliseconds:259,commandRecord:'0033.json'},{State:primary.state});
      finished=true;return primary;
    }};
}

test('event projection binds the exact container, preserves nanoseconds and drops unrelated attributes',()=>{
  const value=projectEvent(event('oom').replace('"1789350874012345678"','1789350874012345678'),target);
  assert.deepEqual(value,{action:'oom',container:target,timeNano:'1789350874012345678',exitCode:'137',signal:'9'});
  assert.throws(()=>projectEvent(event('oom',other),target),/TARGET/);
  assert.throws(()=>projectEvent('{',target));
  assert.equal(JSON.stringify(projectState({OOMKilled:false,Error:'PRIVATE_SENTINEL'})), '{"OOMKilled":false}');
});
test('exit 137 is not an OOM classifier; missing, truncated and foreign evidence stay unknown',()=>{
  const base={events:{capture:{reason:'observer_stop',closed:true,pendingBytes:0,encodingError:false},invalid:0,records:['start','die'].map(action=>({action}))},primary:{state:{OOMKilled:false,ExitCode:137}}};
  assert.equal(observationAssessment(base).oomEvent,false);
  for(const reason of ['output_limit','observer_timeout',null])assert.equal(observationAssessment({...base,events:{...base.events,capture:{...base.events.capture,reason}}}).oomEvent,null);
  assert.equal(observationAssessment({...base,events:{...base.events,invalid:1}}).oomEvent,null);
  assert.equal(observationAssessment({}).oomEvent,null);
  assert.equal(observationAssessment({...base,events:{...base.events,records:[{action:'oom'}]}}).oomEvent,null);
  for(const changed of [{pendingBytes:1},{encodingError:true}])assert.equal(observationAssessment({...base,events:{...base.events,capture:{...base.events.capture,...changed}}}).oomEvent,null);
});
test('copied tar member identity uses actual bytes and rejects replacement, damaged header and extra members',()=>{
  const original=archive('probe.mjs','synthetic');
  assert.deepEqual(tarMemberIdentity(original,'probe.mjs'),{bytes:9,sha256:hash('synthetic')});
  assert.notEqual(tarMemberIdentity(archive('probe.mjs','different'),'probe.mjs').sha256,hash('synthetic'));
  const corrupt=Buffer.from(original);corrupt[0]^=1;assert.throws(()=>tarMemberIdentity(corrupt,'probe.mjs'),/CHECKSUM/);
  assert.throws(()=>tarMemberIdentity(archive('wrong','synthetic'),'probe.mjs'),/MEMBER/);
  const extra=Buffer.from(original);extra[1024]=1;assert.throws(()=>tarMemberIdentity(extra,'probe.mjs'),/EXTRA/);
});
test('leaf counters preserve scope and integers without inventing missing counters or kernel cause',()=>{
  assert.deepEqual(parseLeafCounters({'memory.events.local':'max 2\noom 1\noom_kill 1\n','memory.peak':'536870912\n'}),{'memory.events.local':{max:'2',oom:'1',oom_kill:'1'},'memory.peak':'536870912'});
  assert.deepEqual(parseLeafCounters({}),{});
  assert.throws(()=>parseLeafCounters({'memory.events':'oom_kill 1\noom_kill 2'}),/FORMAT/);
  assert.throws(()=>parseLeafCounters({'memory.peak':'unknown'}),/FORMAT/);
});
test('later true never replaces original false, and captured public data excludes fixture secrets',async()=>{
  const h=harness();const original=await observeL03(h.options,h.work);
  assert.equal(original.state.OOMKilled,false);assert.equal(h.record.primary.state.OOMKilled,false);
  assert.equal(h.record.later.state.OOMKilled,true);assert.equal(h.record.assessment.oomEvent,true);
  assert.equal(h.record.identity.probeMatchesSource,true);
  assert.ok(!JSON.stringify(h.record).includes('PRIVATE_SENTINEL'));
  const {integrity,...body}=h.record;assert.equal(integrity.sha256,hash(JSON.stringify(body)));
  const eventCall=h.calls.find(args=>args[0]==='events');assert.ok(eventCall.includes('container='+target));
});
test('the identical primary thrown error survives missing observer and failed export',async()=>{
  const h=harness({broken:true,exportError:true});const primary=Object.assign(Error('PRIMARY_ASSERTION'),{actual:false,expected:true});
  await assert.rejects(observeL03(h.options,async()=>{throw primary;}),error=>error===primary);
  assert.equal(h.failures.length,1);assert.equal(h.record.assessment.oomEvent,null);
  assert.ok(h.record.errors.length>0);
});
test('a foreign event cannot make a complete target OOM observation',async()=>{
  const h=harness({foreign:true});await observeL03(h.options,h.work);
  assert.equal(h.record.events.invalid,1);assert.equal(h.record.assessment.oomEvent,null);
  assert.ok(!JSON.stringify(h.record).includes(other));
});
test('a stopped or exhausted observer does not modify the successful primary result',async()=>{
  const h=harness({streamReason:'output_limit'});const r=await observeL03(h.options,h.work);
  assert.equal(r.state.ExitCode,137);assert.equal(h.record.assessment.oomEvent,null);
});
test('real diagnostic client output cap preserves incompleteness and terminates its own child',async()=>{
  const client=captureClient(process.execPath,['-e','process.stdout.write("x".repeat(1048576));setInterval(()=>{},1000)'],{bytes:64,timeoutMs:2000});
  const r=await client.done;assert.equal(r.reason,'output_limit');assert.equal(r.retained,64);assert.equal(r.closed,true);
});
test('real diagnostic client timeout is finite and is not a workload timeout',async()=>{
  const started=Date.now(),r=await captureClient(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100}).done;
  assert.equal(r.reason,'observer_timeout');assert.equal(r.closed,true);assert.ok(Date.now()-started<1500);
});
test('real event capture distinguishes an unterminated line and invalid retained UTF-8',async()=>{
  const events=[];let client;
  client=captureClient(process.execPath,['-e','process.stdout.write('+JSON.stringify(['start','oom','die'].map(action=>event(action)).join('\n')+'\n')+');setInterval(()=>{},1000)'],{
    onLine:line=>{events.push(projectEvent(line,target));if(events.at(-1).action==='die')client.stop('observer_stop');}});
  const complete=await client.done;
  assert.equal(observationAssessment({events:{capture:complete,records:events,invalid:0}}).oomEvent,true);
  const lines=[];
  const partial=await captureClient(process.execPath,['-e','process.stdout.write("{\\\"partial\\\":1}")'],{onLine:line=>lines.push(line)}).done;
  assert.deepEqual(lines,[]);assert.ok(partial.pendingBytes>0);assert.equal(partial.encodingError,false);
  const invalid=await captureClient(process.execPath,['-e','process.stdout.write(Buffer.from([255,10]))'],{onLine:line=>lines.push(line)}).done;
  assert.equal(invalid.encodingError,true);
});
test('unavailable diagnostic executable reports absence without exposing error text',async()=>{
  const r=await captureClient('nonexistent-l03-diagnostic-client',[]).done;
  assert.equal(r.error,'ENOENT');assert.equal(r.stdout.length,0);
});
test('actual runner preserves L03 probe/assertions and captures only memory after original state save',()=>{
  const source=fs.readFileSync(new URL('../../../ci/intake_t01_check.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("assert.equal(r.state.OOMKilled,true);assert.equal(r.state.ExitCode,137)"));
  assert.ok(source.includes("command[0]==='memory'?await observeL03"));
  assert.ok(source.indexOf("await save('state-'+seq")<source.indexOf('observer?.recordPrimary'));
  assert.ok(source.includes("'ci/intake_l03_observer.mjs'"));
  const probe=fs.readFileSync(new URL('./probe.mjs',import.meta.url),'utf8');
  assert.ok(probe.includes("else if(kind==='memory'){const chunks=[];while(true){const b=Buffer.alloc(16*1024*1024,1);chunks.push(b);}}"));
  assert.equal(L03_CAPTURE.laterMs,250);
});
test('actual probe function keeps first inspection/save order and leaves non-memory probes unobserved',async()=>{
  const source=fs.readFileSync(new URL('../../../ci/intake_t01_check.mjs',import.meta.url),'utf8');
  const actual=source.slice(source.indexOf('async function probe('),source.indexOf('async function originalCase('));
  assert.ok(actual.startsWith('async function probe('));
  const make=new Function('context',`const {prefix,seq,parserFlags,parserImage,container,docker,json,save,owned,sourceRoot,hash,fs,path,observeL03,loggingFailures,required}=context;let parserActive=false;return (${actual});`);
  for(const mode of ['memory','cpu']){
    const order=[],first={State:{OOMKilled:false,ExitCode:137},HostConfig:{Memory:536870912},Config:{User:'1000:1000'}};
    const probe=make({prefix:'fixed',seq:1,parserFlags:[],parserImage:image,owned:[{id:target}],sourceRoot:'source',path:{join:()=>''},hash:()=>hash('synthetic'),fs:{readFile:async()=>Buffer.from('synthetic')},loggingFailures:[],
      container:async()=>order.push('create'),json:r=>r,required:async()=>{throw Error('No stop expected');},
      docker:async args=>{order.push(args[0]);return args[0]==='inspect'?[first]:{code:137,reason:undefined};},
      save:async(name,value)=>{order.push('save');assert.deepEqual(value.state,first.State);},
      observeL03:async(options,work)=>{order.push('observer-before');assert.equal(options.target,target);const r=await work({recordPrimary:()=>order.push('primary')});order.push('observer-after');return r;}});
    const result=await probe([mode]);assert.equal(result.state,first.State);
    assert.deepEqual(order,mode==='memory'?['create','observer-before','start','inspect','save','primary','observer-after']:['create','start','inspect','save']);
  }
});

// Execute the actual runner function AND observer. Only their I/O dependencies
// are controlled; no replacement observer can hide prelaunch argument evaluation.
async function prelaunchControl(readError,primaryOutcome){
  const source=fs.readFileSync(new URL('../../../ci/intake_t01_check.mjs',import.meta.url),'utf8');
  const actual=source.slice(source.indexOf('async function probe('),source.indexOf('async function originalCase('));
  const make=new Function('context',`const {prefix,seq,parserFlags,parserImage,container,docker,json,save,owned,sourceRoot,hash,fs,path,observeL03,loggingFailures,required}=context;let parserActive=false;return (${actual});`);
  const h=harness(),order=[],loggingFailures=[];
  const retainedRoot=path.join('unique-run-17','source'),retainedProbe=path.join(retainedRoot,'tests/intake/t01/probe.mjs');
  const primaryError=Object.assign(Error('PRIMARY_WORKLOAD_FAILURE'),{code:'OWN_PRIMARY'});
  const diagnosticError=Object.assign(Error('PRIVATE_SENTINEL /private/unrelated-path'),{code:readError});
  const first={State:{OOMKilled:true,ExitCode:137},HostConfig:{Memory:536870912},Config:{User:'1000:1000'}};
  const primary={code:137,signal:null,reason:undefined,milliseconds:17,commandRecord:'original-start.json'};
  let observation,returned,caught;
  const probe=make({prefix:'fixed',seq:1,parserFlags:[],parserImage:image,owned:[{id:target}],sourceRoot:retainedRoot,path,hash,
    fs:{readFile:async file=>{assert.equal(file,retainedProbe,'Digest must use the exact run snapshot, not the current checkout');order.push('diagnostic-probe-read');if(readError)throw diagnosticError;return Buffer.from('synthetic');}},
    loggingFailures,container:async()=>order.push('create'),json:r=>r,required:async()=>{throw Error('No stop expected');},
    docker:async args=>{order.push(args[0]);if(args[0]==='start'){if(primaryOutcome==='throw')throw primaryError;return primary;}return [first];},
    save:async(name,value)=>{if(name==='L03-observation.json'){observation=value;order.push('diagnostic-save');}else{order.push('primary-save');assert.equal(value.state,first.State);}},
    observeL03:async(options,work)=>{order.push('observer-entered');return observeL03({...h.options,...options},work);}});
  try{returned=await probe(['memory']);}catch(error){caught=error;}
  return {order,loggingFailures,observation,returned,caught,primaryError,primary,first};
}
for(const readError of [null,'EACCES','EIO'])for(const primaryOutcome of ['return','throw'])
test('real runner '+(readError??'available')+' '+primaryOutcome+' preserves primary across diagnostic acquisition',async t=>{
  const actual=await prelaunchControl(readError,primaryOutcome);
  const {order,observation,returned,caught,primaryError,primary,first}=actual;
  const observed={launch:order.includes('start'),observer:order.includes('observer-entered'),
    preserved:primaryOutcome==='throw'?caught===primaryError:caught===undefined&&returned?.state===first.State,
    propagated:caught?.code??null};
  t.diagnostic(JSON.stringify({readError,primaryOutcome,order,...observed,expectedProbe:observation?.expectedProbe,errors:observation?.errors}));
  assert.deepEqual(observed,{launch:true,observer:true,preserved:true,propagated:primaryOutcome==='throw'?'OWN_PRIMARY':null});
  assert.deepEqual(order,primaryOutcome==='throw'?['create','observer-entered','diagnostic-probe-read','start','diagnostic-save']:
    ['create','observer-entered','diagnostic-probe-read','start','inspect','primary-save','diagnostic-save']);
  if(primaryOutcome==='return')assert.deepEqual(returned,{...primary,state:first.State,host:first.HostConfig});
  assert.deepEqual(observation.expectedProbe,readError?{status:'unavailable',sha256:null}:{status:'observed',sha256:hash('synthetic')});
  assert.equal(observation.identity.probeMatchesSource,readError?null:true);
  assert.deepEqual(observation.errors,readError?[{phase:'expected-probe',code:readError}]:[]);
  assert.deepEqual(actual.loggingFailures,[]);
  assert.ok(!JSON.stringify(observation).includes('PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(observation).includes('/private/unrelated-path'));
});

test('absent expected and actual probe identities stay unknown, while provided digest remains supported',async()=>{
  const positive=harness();await observeL03(positive.options,positive.work);
  assert.deepEqual(positive.record.expectedProbe,{status:'observed',sha256:hash('synthetic')});
  assert.equal(positive.record.identity.probeMatchesSource,true);
  const missing=harness(),run=missing.options.run;
  await observeL03({...missing.options,expectedProbeSha256:undefined,
    run:async args=>args[0]==='cp'?{...result(''),code:1}:run(args)},missing.work);
  assert.equal(missing.record.expectedProbe.status,'unavailable');
  assert.equal(missing.record.identity.probe,undefined);
  assert.equal(missing.record.identity.probeMatchesSource,null);
  assert.ok(missing.record.errors.some(error=>error.phase==='expected-probe'&&error.code==='EXPECTED_PROBE_IDENTITY_INVALID'));
});
