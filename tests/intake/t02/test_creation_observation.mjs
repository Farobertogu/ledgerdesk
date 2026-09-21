import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {creationObservation,uploadOriginal} from '../../../src/server/intake/stream.ts';
import {publicEvidence} from '../../../ci/intake_t02_artifacts.mjs';
const id='11111111-1111-4111-8111-111111111111';
test('creation result keeps structured termination but drops private bodies and unbounded diagnostics',()=>{
  const marker='PRIVATE_TEST_COOKIE_BODY_PATH';
  const result={id,ok:false,outcome:'failed',bytes:0,data:marker,error:marker,
    termination:{profile:'intake-child-stop/1',requestId:id,workerPid:23,startedAtMs:10,closedAtMs:12,exitCode:1,signal:null,reason:'deadline',stderr:marker}};
  const observed=creationObservation(result);
  assert.deepEqual(observed,{requestId:id,ok:false,outcome:'failed',bytes:0,dispatch:'not-reported',termination:{profile:'intake-child-stop/1',
    workerPid:23,startedAtMs:10,closedAtMs:12,exitCode:1,signal:null,reason:'deadline'}});
  assert.deepEqual(publicEvidence(observed),observed);assert.ok(!JSON.stringify(observed).includes(marker));
  for(const reason of ['input-failed','spawn-failed','observation-failed','input-or-observation-failed','diagnostic-limit'])
    assert.equal(creationObservation({...result,termination:{...result.termination,reason}}).termination.reason,reason);
  assert.equal(creationObservation({...result,termination:{...result.termination,reason:marker}}).termination.reason,'other');
});
test('missing, mismatched and malformed termination cannot claim a closed worker',()=>{
  const result={id,ok:false,outcome:'denied',bytes:0,dispatch:'not-started'};
  assert.deepEqual(creationObservation(result).termination,{availability:'missing'});
  for(const termination of [{}, {profile:'intake-child-stop/1',requestId:id,workerPid:1,startedAtMs:12,closedAtMs:10},
    {profile:'intake-child-stop/1',requestId:'another',workerPid:1,startedAtMs:10,closedAtMs:12}])
    assert.deepEqual(creationObservation({...result,termination}).termination,{availability:'invalid'});
});

test('creation diagnostic catalogue accepts only primitive members or explicit null',()=>{
  const project=(signal,reason)=>{
    const observed=creationObservation({id,ok:false,outcome:'failed',bytes:0,
      termination:{profile:'intake-child-stop/1',requestId:id,workerPid:1,startedAtMs:10,closedAtMs:20,exitCode:1,signal,reason}});
    const published=publicEvidence(observed);
    return {observed:{signal:observed.termination.signal,reason:observed.termination.reason},
      published:{signal:published.termination.signal,reason:published.termination.reason}};
  };
  for(const signal of ['SIGKILL','SIGTERM','SIGABRT','SIGSEGV',null])
    for(const reason of ['deadline','output-limit','diagnostic-limit','input-failed','phase-closed','spawn-failed',
      'observation-failed','input-or-observation-failed','client-disconnected',null])
      assert.deepEqual(project(signal,reason),{observed:{signal,reason},published:{signal,reason}});
  const coercionTrap={toString(){throw Error('DIAGNOSTIC_COERCION_MUST_NOT_RUN');}};
  const lookalikes=[['SIGKILL'],[['deadline']],new String('SIGKILL'),new String('deadline'),
    {toString:()=>'SIGKILL'},{toString:()=>'deadline'},coercionTrap,{},[],true,42,1n,undefined,Symbol('deadline'),()=> 'deadline'];
  for(const value of lookalikes)
    assert.deepEqual(project(value,value),{observed:{signal:'other',reason:'other'},published:{signal:'other',reason:'other'}},
      'diagnostic catalogue must reject nonprimitive lookalikes without coercion');
  assert.deepEqual(project('UNKNOWN','UNKNOWN'),{observed:{signal:'other',reason:'other'},published:{signal:'other',reason:'other'}});
});

// Actual uploadOriginal/privatePhase control flow with explicit authority, SQL,
// request and participant doubles. This is not a durable SQL or browser proof.
async function diagnosticUpload({empty,unclosed=false,observer='none',outcome='failed',failAt=null}){
  const bytes=Buffer.from(empty?'':'x'),queries=[],actions=[],events=[],bookkeeping=[],closed=[];
  const fault=new Error('AUTHORITATIVE_'+failAt),nextAction=new Error('EXPECTED_POST_CREATE_ACTION');
  const reject=point=>{if(failAt===point)throw fault;};
  const reception={id,principal:'account',state:'reserved',revision:1,generation:1,stopped:false,load_reference:{intention:{}},
    declaration:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
  const attempt={generation:1,artifact_id:'22222222-2222-4222-8222-222222222222',incarnation:'test-incarnation',
    state:'reserved',expires_at:Date.now()+60000,actual_bytes:0};
  let captures=0,verifications=0,prepared=0;
  const db={healthy:true,backendPid:123,query:async sql=>{
    queries.push(sql);
    if(sql.startsWith('SELECT * FROM $INTAKE.reception'))return {rows:[reception]};
    if(sql.startsWith('SELECT * FROM $INTAKE.attempt'))return {rows:[attempt]};
    if(sql.startsWith('SELECT intake_control.finish_phase')){reject('retirement');return {rows:[{epoch:2}]};}
    if(sql.startsWith('SELECT intake_control.begin_phase')||sql.startsWith('SELECT intake_control.assert_fence_epoch'))return {rows:[]};
    throw Error('UNEXPECTED_QUERY');
  },commit:async()=>{},begin:async()=>{},close:async()=>{reject('admission-close');}};
  const port=name=>({openPhase:async()=>{},closePhase:async phase=>{
    closed.push(name);if(unclosed&&name==='objects')throw Error('UNCONFIRMED_CLOSE');
    return {profile:'intake-phase-closed/1',id:phase,participant:name};
  },call:async command=>{
    actions.push(command.action);reject('participant');
    if(command.action!=='create')throw nextAction;
    return {id,ok:outcome==='created',outcome,bytes:0};
  },verify:async()=>{verifications++;throw Error('UNEXPECTED_VERIFY');}});
  const service={activeReceptions:new Set(),config:{namespace:'intake_trial',incarnation:'test-incarnation',controlSource:'source'},
    hooks:{storage:event=>{
      events.push(event);
      if(observer==='both'&&['create-result','create-closure'].includes(event.kind)||observer===event.kind)
        throw Error('DIAGNOSTIC_WRITE_FAILURE');
    },barrier:async label=>{if(label==='private_phase_committed')reject('barrier');}},
    authority:{open:async()=>({db,session:{account_id:'account',digest:'owned-session'},now:Date.now(),deadline:Date.now()+60000}),
      beforeMetadata:async()=>{},resolve:async()=>{reject('authority');},permitVerification:async()=>{}},
    objects:port('objects'),verifier:port('verifier'),clock:async(admission,label)=>{if(label==='private-phase-continuation')reject('continuation');},
    evidence:async()=>({id:'evidence',pid:123}),prepared:async()=>{prepared++;throw Error('UNEXPECTED_PREPARED');},
    recordIncomplete:async(...args)=>{bookkeeping.push({id:args[0],generation:args[1],session:args[2],unresolved:args[3]});reject('bookkeeping');}};
  const request={route:'upload_original',parameters:{id,generation:'1'},contentLength:bytes.length};
  const stream={readableLength:bytes.length,complete:true,destroyed:false,read:()=>{captures++;throw nextAction;}};
  let error;try{await uploadOriginal(service,request,stream,null,()=>{});}catch(caught){error=caught;}
  return {error,fault,nextAction,bookkeeping,queries,actions,events,closed,captures,verifications,prepared,active:service.activeReceptions.size};
}

for(const empty of [false,true])for(const unclosed of [false,true])for(const outcome of ['failed','denied'])
  for(const observer of ['none','create-result','create-closure','both'])
    test(`creation diagnostic isolation: ${empty?'empty':'nonempty'}, ${unclosed?'unconfirmed':'confirmed'}, ${outcome}, observer ${observer}`,async()=>{
      const observed=await diagnosticUpload({empty,unclosed,outcome,observer});
      const status=unclosed||outcome==='failed'?503:409;
      assert.deepEqual({bookkeeping:observed.bookkeeping,error:observed.error?.message,status:observed.error?.status,
        actions:observed.actions,captures:observed.captures,verifications:observed.verifications,prepared:observed.prepared,
        active:observed.active,retired:observed.queries.some(q=>q.includes('finish_phase')),closed:observed.closed,
        closure:observed.events.find(e=>e.kind==='create-closure')?.closure},
      {bookkeeping:[{id,generation:1,session:'owned-session',unresolved:unclosed}],error:'INTAKE_'+status,status,
        actions:['create'],captures:0,verifications:0,prepared:0,active:0,retired:!unclosed,
        closed:empty?['objects','verifier']:['objects'],closure:unclosed?'not-confirmed':'acknowledged-retired-current'},
      'diagnostic failure must preserve bookkeeping, original failure and phase certainty');
    });

for(const empty of [false,true]){
  test(`successful ${empty?'empty':'nonempty'} create reaches its next action despite a failing result observer`,async()=>{
    const observed=await diagnosticUpload({empty,outcome:'created',observer:'create-result'});
    assert.equal(observed.error,observed.nextAction,'only the deliberate downstream sentinel may stop the upload');
    assert.deepEqual({actions:observed.actions,captures:observed.captures,active:observed.active,
      closure:observed.events.some(e=>e.kind==='create-closure')},
    {actions:empty?['create','read_stage']:['create'],captures:empty?0:1,active:0,closure:false});
  });
  for(const failAt of ['authority','barrier','participant','retirement','continuation','bookkeeping','admission-close'])
    test(`diagnostic isolation does not swallow ${failAt} in the ${empty?'empty':'nonempty'} branch`,async()=>{
      const observed=await diagnosticUpload({empty,failAt,observer:'both'});
      assert.equal(observed.error,observed.fault,'the authoritative or cleanup failure must still propagate');
      assert.deepEqual({count:observed.bookkeeping.length,unresolved:observed.bookkeeping[0]?.unresolved,
        active:observed.active,captures:observed.captures,verifications:observed.verifications,prepared:observed.prepared},
      {count:failAt==='authority'?0:1,unresolved:failAt==='authority'?undefined:!['bookkeeping','admission-close'].includes(failAt),
        active:0,captures:0,verifications:0,prepared:0});
    });
}
