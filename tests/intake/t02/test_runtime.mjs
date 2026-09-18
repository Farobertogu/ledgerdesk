import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { journeyEnvironment,password,recipientEmail,uiOrigin } from '../../access/journey_environment.mjs';
import { startApplication } from './application_process.mjs';
import { Client } from 'pg';
import { catalog,configuration,limits,treatment,permissionIds,installControl } from './fixtures.mjs';
import {recoveryCases,administration} from './recovery_cases.mjs';
import {streamCases} from './stream_cases.mjs';
import {fenceSqlCases} from './fence_sql_cases.mjs';
import {clientEndpoint} from './request_observer.mjs';
import {phaseLineageCapture} from './phase_lineage_capture.mjs';
import {browserRoundTrip} from './browser_round_trip.mjs';
import {runtimeBoundaries} from './runtime_boundaries.mjs';
import {temporalCases} from './temporal_cases.mjs';
import {integrityCases} from './integrity_cases.mjs';
import {completionCases} from './completion_cases.mjs';
import {finiteLimitsCases} from './finite_limits_cases.mjs';
import {privilegeCases} from './privilege_cases.mjs';
import {transactionCases} from './transaction_cases.mjs';
import {deliveryOrderCases} from './delivery_order_cases.mjs';
import {observationFailureCases} from './observation_failure_cases.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const runtimePermissionIds=process.env.LEDGERDESK_INTAKE_EXTRACTION==='1'?[...permissionIds,'intake_processing','intake_extraction_read']:permissionIds;
// The separate extraction temporal group has fourteen real worker/effect cases
// and seven declared five-second expiry windows; older groups keep their bound.
test('T02 real identity, grant, durable reception and protected original', {timeout:process.env.LEDGERDESK_EXTRACTION_CASES==='temporal'?300000:180000}, async t=>{
  console.log('INTAKE_RUNTIME_IDENTITY '+JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()}));
  const env=await journeyEnvironment({facultiesTransform:faculties=>[...faculties,...runtimePermissionIds.map(permission_id=>({
    permission_id,exercise_or_grant:'grant',scope_ref:'organisation',support_ref:'domain',permission_revision:1,scope_revision:1,support_revision:1,expires_at:Date.now()+3500000}))]});
  let terminal;const messages=[],storage=[],comparisons=[],barriers=[],transfers=[],privilegeProbes=[],incomplete=[],admissions=[],diagnostics=[];
  let barrierAction=async()=>{};
  const requestEvents=[],clientCalls=[],incumbentComparisons=[],evidenceInserts=[],selections=[],privateDispatches=[],clientOrdinals=new WeakMap();
  t.after(async()=>{try{await terminal?.close();}finally{
    await env.close();console.log('INTAKE_T02_RUNTIME_CLEANED');
    const ended=await administration('complete',{scope:'runtime-cleanup'});
    assert.equal(ended.ok,true);
  }});
  for(const permission of runtimePermissionIds)await env.admin.query('INSERT INTO access_trial.permission_definition VALUES($1,$2,$3,1,true,false)',[permission,permission,'application']);
  const before=(await env.admin.query('SELECT * FROM material_trial.material')).rows;
  await env.admin.query(readFileSync(new URL('../../../src/server/intake/postgres/001_reception.sql',import.meta.url),'utf8'));
  await env.admin.query(readFileSync(new URL('../../../src/server/intake/postgres/002_data.sql',import.meta.url),'utf8'));
  const runtimePassword=randomBytes(24).toString('hex'),readerPassword=randomBytes(24).toString('hex');
  await env.admin.query(`ALTER ROLE inc03_intake_runtime LOGIN PASSWORD '${runtimePassword}'; ALTER ROLE inc03_intake_reader LOGIN PASSWORD '${readerPassword}'`);
  await installControl(env,{omitOperations:process.env.LEDGERDESK_INTAKE_COMPLETION==='missing-catalog'?['cancel_reception']:[]});
  await env.admin.query(readFileSync(new URL('../../../src/server/intake/postgres/003_private_fence.sql',import.meta.url),'utf8'));
  const intake={profile:'intake-runtime/1',synthetic:true,enabled:true,connectionString:`postgresql://inc03_intake_runtime:${runtimePassword}@127.0.0.1:55432/inc02_synthetic`,
    readerConnectionString:`postgresql://inc03_intake_reader:${readerPassword}@127.0.0.1:55432/inc02_synthetic`,expectedPort:55432,
    deployment:'inc02-synthetic',namespace:'intake_trial',controlSource:'live-control',incarnation:'intake-runtime-1',generation:1,
    catalog,configuration,limits,brokerSocket:'/run/intake-t02/objects/channel.sock',verifierSocket:'/run/intake-t02/verifier/channel.sock',digestKeyVersion:1,
    ...(process.env.LEDGERDESK_INTAKE_EXTRACTION==='1'?{extraction:'intake-execution/1'}:{})};
  const hooks={storage:event=>storage.push(event),comparison:event=>comparisons.push(event),
    request:event=>requestEvents.push(event),incumbentComparison:event=>incumbentComparisons.push(event),
    evidence:event=>evidenceInserts.push(event),
    selection:event=>selections.push(event),
    privateDispatch:event=>privateDispatches.push(event),
    incomplete:event=>incomplete.push(event),
    admission:event=>admissions.push(event),
    barrier:async(label,event)=>{barriers.push({label,...event,atMs:Date.now()});await barrierAction(label,event);},
    failure:event=>{diagnostics.push(event);console.log('INTAKE_DIAGNOSTIC '+JSON.stringify(event));}};
  terminal=await startApplication({config:env.config,reading:env.reading,tls:env.tls,mailbox:{send:async message=>messages.push(message)},intake,intakeHooks:hooks});
  function request(path,{body,client,key,bytes,headers={},label=null}={}) {
    const payload=bytes??(body===undefined?undefined:Buffer.from(JSON.stringify(body)));
    const started=performance.now();
    const observed={label,path,route:path,method:payload===undefined?'GET':'POST',socket:null,atMs:null,response:null,receivedBytes:0};
    clientCalls.push(observed);
    return new Promise((resolve,reject)=>{
      const call=https.request({host:'127.0.0.1',port:9443,servername:'api.inc02.test',ca:env.ca,path,method:payload===undefined?'GET':'POST',
        headers:{host:'api.inc02.test:9443',origin:uiOrigin,...(client?{cookie:client.cookie}:{}),
          ...(payload===undefined?{}:{'content-type':bytes?'application/octet-stream':'application/json','content-length':String(payload.length),'x-ledgerdesk-csrf':client?.csrf,
            ...(key?{'x-ledgerdesk-intent':key}:{})}),...headers}},reply=>{
        const chunks=[];reply.on('data',chunk=>{chunks.push(chunk);observed.receivedBytes+=chunk.length;});reply.on('error',reject);reply.on('end',async()=>{
          const elapsedMs=performance.now()-started;
          try{await terminal.flushObservations();}catch(error){reject(error);return;}
          const raw=Buffer.concat(chunks),isJson=String(reply.headers['content-type']).includes('json');
          observed.atMs=Date.now();observed.response={status:reply.statusCode,headers:reply.headers,bytes:raw};
          transfers.push({origin:'https-client',path,status:reply.statusCode,bytes:raw.length,sha256:hash(raw),atMs:Date.now()});
          resolve({status:reply.statusCode,headers:reply.headers,bytes:raw,body:isJson&&raw.length?JSON.parse(raw.toString('utf8')):null,elapsedMs});});
      });call.on('socket',socket=>{const capture=()=>{observed.socket=clientEndpoint(socket,clientOrdinals);};
        if(socket.connecting)socket.once('secureConnect',capture);else capture();});
      call.setTimeout(15000,()=>call.destroy(Error('T02 bounded HTTPS timeout')));call.once('error',reject);
      if(label&&payload)observed.sent={observedAtMs:Date.now(),bytes:Buffer.from(payload),ended:false};
      call.end(payload);if(observed.sent)observed.sent.ended=true;
    });
  }
  const get=(path,client)=>request('/api/access/v1'+path,{client});
  const post=(path,body,client,key=randomUUID())=>request('/api/access/v1'+path,{body,client,key});
  const flow=async()=>{const result=await get('/reception');assert.equal(result.status,200);return {cookie:result.headers['set-cookie'][0].split(';')[0],csrf:result.body.csrf_token};};
  const login=async(email)=>{const f=await flow(),r=await post('/sessions',{email,password},f);assert.equal(r.status,200,JSON.stringify(r.body));return{cookie:r.headers['set-cookie'][0].split(';')[0],csrf:r.body.csrf_token};};
  const activation=await flow();assert.equal((await post('/activation/challenges',{email:'master@example.test'},activation)).status,200);
  const proof=messages.at(-1);assert.equal((await post('/activation/complete',{challenge_id:proof.challenge_id,code:proof.code,password},activation)).status,200);
  const master=await login('master@example.test');
  const issued=await post('/invitations',{email:recipientEmail,family:'application',expires_at:Date.now()+300000,
    grants:runtimePermissionIds.map(permission_id=>({permission_id,exercise_or_grant:'exercise',scope_ref:'organisation',support_ref:'domain'}))},master);
  assert.equal(issued.status,200,JSON.stringify(issued.body));
  const receiving=await flow();assert.equal((await post(`/invitations/${issued.body.invitation_id}/challenges`,{},receiving)).status,200);
  const challenge=messages.at(-1),verified=await post(`/invitation-proofs/${challenge.challenge_id}/verify`,{code:challenge.code},receiving);
  assert.equal(verified.status,200,JSON.stringify(verified.body));
  assert.equal((await post(`/invitations/${issued.body.invitation_id}/accept`,{expected_revision:issued.body.revision,proof_id:verified.body.proof_id},receiving)).status,200);
  assert.equal((await post('/account/initial-credential',{password},receiving)).status,200);
  const client=await login(recipientEmail);
  await t.test('identity and permissions originate in the existing accepted invitation',async()=>{
    const grants=(await env.admin.query(`SELECT g.*,a.invitation_id FROM access_trial.grant_record g
      JOIN access_trial.acceptance a ON a.id=g.acceptance_id WHERE a.invitation_id=$1`,[issued.body.invitation_id])).rows;
    assert.equal(grants.length,runtimePermissionIds.length);assert.ok(grants.every(g=>g.faculty==='exercise'&&g.acceptance_id));
    assert.deepEqual((await env.admin.query('SELECT * FROM material_trial.material')).rows,before);
  });
  if(process.env.LEDGERDESK_INTAKE_BROWSER==='1'){
    await browserRoundTrip(t,{env,terminal,setBarrier:action=>{barrierAction=action;}});return;
  }
  if(process.env.LEDGERDESK_INTAKE_EXTRACTION==='1'){
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='associations'){
      const {extractionAssociationCases}=await import('../extraction/runtime_associations.mjs');
      await extractionAssociationCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='lineage'){
      const {extractionLineageCases}=await import('../extraction/runtime_lineage.mjs');
      await extractionLineageCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='browser-disconnect'){
      const {extractionBrowserDisconnectCases}=await import('../extraction/runtime_browser_disconnect.mjs');
      await extractionBrowserDisconnectCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='extraction-privileges'){
      const {extractionPrivilegeCases}=await import('../extraction/runtime_privileges.mjs');
      await extractionPrivilegeCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='compatibility'){
      const {extractionCompatibilityCases}=await import('../extraction/runtime_compatibility.mjs');
      await extractionCompatibilityCases(t,{env,intake,client,request,setBarrier:action=>{barrierAction=action;}});return;
    }
    if(['authority-original','authority-result','authority-effect'].includes(process.env.LEDGERDESK_EXTRACTION_CASES)){
      const {extractionAuthorityMatrix}=await import('../extraction/runtime_authority_matrix.mjs');
      await extractionAuthorityMatrix(t,{env,intake,client,request,boundary:process.env.LEDGERDESK_EXTRACTION_CASES.slice('authority-'.length)});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='format-negatives'){
      const {extractionFormatNegativeCases}=await import('../extraction/runtime_format_negatives.mjs');
      await extractionFormatNegativeCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='resources'){
      const {extractionResourceCases}=await import('../extraction/runtime_resources.mjs');
      await extractionResourceCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='containment'){
      const {extractionContainmentCases}=await import('../extraction/runtime_containment.mjs');
      await extractionContainmentCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='controller-loss'){
      const {extractionControllerLossCases}=await import('../extraction/runtime_controller_loss.mjs');
      await extractionControllerLossCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='private-loss'){
      const {extractionPrivateLossCases}=await import('../extraction/runtime_private_loss.mjs');
      await extractionPrivateLossCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='capacity'){
      const {extractionCapacityCases}=await import('../extraction/runtime_capacity.mjs');
      await extractionCapacityCases(t,{env,intake,client,request,admissions});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='semantics'){
      const {extractionSemanticCases}=await import('../extraction/runtime_semantics.mjs');
      await extractionSemanticCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='mixed'){
      const {extractionMixedCases}=await import('../extraction/runtime_mixed.mjs');
      await extractionMixedCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='storage-recovery'){
      const {extractionStorageRecoveryCases}=await import('../extraction/runtime_storage_recovery.mjs');
      await extractionStorageRecoveryCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='restore'){
      const {extractionRestoreCases}=await import('../extraction/runtime_restore.mjs');
      await extractionRestoreCases(t,{env,intake,client,request,post,master,flow,messages,
        digestSession:value=>terminal.service.digest(value),restart:async next=>{
          await terminal.close();terminal=await startApplication({config:env.config,reading:env.reading,tls:env.tls,
            mailbox:{send:async message=>messages.push(message)},intake:next,intakeHooks:hooks});
        }});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='retry'){
      const {extractionRetryGroup}=await import('../extraction/runtime_retry.mjs');
      await extractionRetryGroup(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='restart'){
      const {extractionRestartCases}=await import('../extraction/runtime_restart.mjs');
      await extractionRestartCases(t,{env,intake,client,request,application:{crash:()=>terminal.crash(),restart:async next=>{
        await terminal.close();terminal=await startApplication({config:env.config,reading:env.reading,tls:env.tls,
          mailbox:{send:async message=>messages.push(message)},intake:next,intakeHooks:hooks});return terminal.processRef;
      }}});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='budgets'){
      const {extractionBudgetCases}=await import('../extraction/runtime_budgets.mjs');
      await extractionBudgetCases(t,{env,intake,client,request});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='fencing'){
      const {extractionFencingCases}=await import('../extraction/runtime_fencing.mjs');
      await extractionFencingCases(t,{env,intake,client,request,clientCalls,setBarrier:action=>{barrierAction=action;}});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='temporal'){
      const {extractionTemporalCases}=await import('../extraction/runtime_temporal.mjs');
      await extractionTemporalCases(t,{env,intake,client,request,requestEvents,clientCalls,setBarrier:action=>{barrierAction=action;}});return;
    }
    if(process.env.LEDGERDESK_EXTRACTION_CASES==='formats'){
      const {extractionFormatCases}=await import('../extraction/runtime_formats.mjs');
      await extractionFormatCases(t,{env,intake,client,request,terminal});return;
    }
    const {extractionRuntimeCases}=await import('../extraction/runtime_cases.mjs');
    await extractionRuntimeCases(t,{env,intake,client,request,post,master,login});return;
  }
  if(process.env.LEDGERDESK_INTAKE_COMPLETION){
    await completionCases(t,{env,client,master,request,post,flow,messages,login,storage,selections});return;
  }
  if(process.env.LEDGERDESK_INTAKE_FINITE){
    await finiteLimitsCases(t,{env,intake,client,request,storage,restart:async next=>{
      const previous=terminal.processRef;await terminal.close();terminal=await startApplication({config:env.config,reading:env.reading,tls:env.tls,
        mailbox:{send:async message=>messages.push(message)},intake:next,intakeHooks:hooks});return{previous,current:terminal.processRef};
    }});return;
  }
  if(process.env.LEDGERDESK_INTAKE_PRIVILEGES==='1'){
    await privilegeCases(t,{env,intake,client,request,setBarrier:action=>{barrierAction=action;}});return;
  }
  if(process.env.LEDGERDESK_INTAKE_TRANSACTION==='1'){
    await transactionCases(t,{env,client,request,setBarrier:action=>{barrierAction=action;}});return;
  }
  if(process.env.LEDGERDESK_INTAKE_DELIVERY_ORDER==='1'){
    await deliveryOrderCases(t,{env,client,request,requestEvents,clientCalls,setBarrier:action=>{barrierAction=action;}});
    await observationFailureCases(t,{env,client,request,requestEvents,clientCalls,diagnostics,admissions,
      failureReceiver:mode=>terminal.failureReceiver(mode),fallbackDiagnostics:terminal.fallbackDiagnostics,
      flush:()=>terminal.flushObservations(),setBarrier:action=>{barrierAction=action;}});return;
  }
  if(process.env.LEDGERDESK_INTAKE_BOUNDARIES==='1'){
    await runtimeBoundaries(t,{env,client,request,requestEvents,storage,barriers});return;
  }
  if(process.env.LEDGERDESK_INTAKE_TEMPORAL==='1'){
    await temporalCases(t,{env,client,request,requestEvents,storage,barriers,setBarrier:action=>{barrierAction=action;}});return;
  }
  if(process.env.LEDGERDESK_INTAKE_INTEGRITY==='1'){
    await integrityCases(t,{env,intake,client,request,storage,getProcess:()=>terminal.processRef,restart:async next=>{
      const previous=terminal.processRef;await terminal.close();terminal=await startApplication({config:env.config,reading:env.reading,tls:env.tls,
        mailbox:{send:async message=>messages.push(message)},intake:next,intakeHooks:hooks});return{previous,current:terminal.processRef};
    }});return;
  }
  let reserved,staged,received;const original=readFileSync(new URL('../t01/fixtures/bom.txt',import.meta.url));
  const declaration={profile:'intake/1',original:{name:'bom.txt',bytes:17,sha256:'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9',declared_media_type:'text/plain'},
    format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  const reserveKey=randomUUID();
  await t.test('profiles separate reception from unimplemented processing',async()=>{
    const result=await request('/api/intake/profiles',{client});assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.profiles.length,4);assert.ok(result.body.profiles.every(p=>p.reception_available&&!p.processing_available));
  });
  await t.test('reservation creates neither receipt nor job',async()=>{
    const result=await request('/api/intake/receptions',{body:declaration,client,key:reserveKey});assert.equal(result.status,202,JSON.stringify(result.body));reserved=result.body;
    assert.deepEqual((await env.admin.query('SELECT (SELECT count(*)::int FROM intake_trial.receipt) AS receipts,(SELECT count(*)::int FROM intake_trial.work) AS jobs')).rows[0],{receipts:0,jobs:0});
  });
  if(process.env.LEDGERDESK_INTAKE_PHASE_LINEAGE==='1'){
    await phaseLineageCapture(t,{env,intake,client,request,requestEvents,clientCalls,admissions,comparisons,incumbentComparisons,evidenceInserts,selections,privateDispatches,
      setBarrier:action=>{barrierAction=action;}});return;
  }
  await t.test('binary continuation stages exact bytes with evidence before capture',async()=>{
    const result=await request(`/api/intake/receptions/${reserved.reception_id}/attempts/1/original`,{bytes:original,client});
    assert.equal(result.status,200,JSON.stringify(result.body));staged=result.body;
    assert.deepEqual({state:staged.state,effect:staged.effect,work:staged.work},{state:'staged',effect:null,work:null});
    assert.equal(storage.filter(e=>e.kind==='capture').reduce((n,e)=>n+e.bytes,0),17);
    for(const event of storage){const evidence=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows[0];assert.ok(evidence);assert.ok(Number(evidence.recorded_at)<=event.atMs);}
  });
  let finalizeKey=randomUUID(),finalizeBody;
  if(process.env.LEDGERDESK_INTAKE_CANONICAL){
    const {realCanonicalCase}=await import('./real_canonical_case.mjs');
    try{await realCanonicalCase(t,{env,intake,client,request,requestEvents,clientCalls,admissions,comparisons,incumbentComparisons,evidenceInserts,selections,
      setBarrier:action=>{barrierAction=action;},variant:process.env.LEDGERDESK_INTAKE_CANONICAL});}
    finally{writeFileSync('/work/output/observer-raw.json',JSON.stringify({requestEvents,admissions,barriers,comparisons,incumbentComparisons,evidenceInserts,selections},null,2));}
    return;
  }
  await t.test('finalization produces one receipt and a distinct unstarted job',async()=>{
    finalizeBody={profile:'intake/1',expected_revision:staged.revision,original:staged.original,format_profile:'text-utf8/1'};
    const result=await request(`/api/intake/receptions/${reserved.reception_id}/finalize`,{body:finalizeBody,client,key:finalizeKey});
    assert.equal(result.status,200,JSON.stringify(result.body));received=result.body;
    const rows=(await env.admin.query('SELECT r.*,w.id AS job_id,w.dispatchable,w.state AS work_state FROM intake_trial.receipt r JOIN intake_trial.work w ON w.receipt_id=r.id')).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].work_state,'not_started');assert.equal(rows[0].dispatchable,false);
    assert.notEqual(rows[0].person_ref,rows[0].executor_ref);assert.notEqual(rows[0].job_id,rows[0].operation_id);
  });
  await t.test('original travels as exact protected bytes, not a public URL',async()=>{
    const result=await request(`/api/intake/receptions/${reserved.reception_id}/original`,{client});
    assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.bytes,original);
    assert.equal(result.headers['content-type'],'application/octet-stream');assert.equal(result.headers['content-length'],'17');
    assert.equal(result.headers['cache-control'],'private, no-store');assert.equal(result.headers.etag,undefined);
    writeFileSync('/work/output/original-bom.bin',result.bytes);
  });
  if(process.env.LEDGERDESK_INTAKE_OBSERVER==='1'){
    const {realObservationCase}=await import('./real_observation_case.mjs');
    try{await realObservationCase(t,{env,intake,client,request,requestEvents,clientCalls,admissions,barriers,evidenceInserts,selections,
      setBarrier:action=>{barrierAction=action;}});}
    finally{writeFileSync('/work/output/observer-raw.json',JSON.stringify({requestEvents,admissions,barriers,comparisons,incumbentComparisons,evidenceInserts,selections},null,2));}
    return;
  }
  await t.test('same finalization key and another key reconcile without another receipt',async()=>{
    for(const key of [finalizeKey,randomUUID()]) {
      const result=await request(`/api/intake/receptions/${reserved.reception_id}/finalize`,{body:finalizeBody,client,key});
      assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body.effect,received.effect);
    }
    assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.receipt')).rows[0].n,1);
  });
  await t.test('current SQL identities cannot rewrite history, authority or transition columns',async()=>{
    for(const connectionString of [intake.connectionString,intake.readerConnectionString]) {
      const connection=new Client({connectionString});await connection.connect();
      try {
        const role=(await connection.query('SELECT current_user AS role')).rows[0].role;
        assert.match(role,/^inc03_intake_(runtime|reader)$/);
        const positive=(await connection.query('SELECT id FROM intake_trial.receipt')).rowCount;assert.equal(positive,1);
        const cases=[
          ['receipt-rewrite',"UPDATE intake_trial.receipt SET person_ref='wrong'"],
          ['artifact-delete','DELETE FROM intake_trial.artifact'],
          ['evidence-delete','DELETE FROM intake_trial.evidence'],
          ['authority-write','UPDATE access_trial.grant_record SET withdrawn=true'],
          ['session-write','UPDATE access_trial.session SET revoked=true'],
          ['control-write','UPDATE intake_control.live SET enabled=false'],
          ['reception-direct-write',"UPDATE intake_trial.reception SET state='received'"],
          ['attempt-direct-write',"UPDATE intake_trial.attempt SET state='sealed'"],
          ['legacy-read','SELECT * FROM retained_legacy.private_data'],
        ];
        for(const [action,sql] of cases) {
          let code=null;try{await connection.query(sql);}catch(error){code=error.code;}
          privilegeProbes.push({origin:'sql-client',role,action,sqlState:code,positiveRows:positive});
          assert.equal(code,'42501',role+':'+action);
        }
        if(role.endsWith('_reader'))await assert.rejects(()=>connection.query('SELECT intake_trial.stop_reception($1,1,1)',[reserved.reception_id]),error=>error.code==='42501');
      }finally{await connection.end();}
    }
    assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.receipt')).rows[0].n,1);
  });
  await t.test('concurrent compatible intentions share the principal across two sessions',async()=>{
    const another=await login(recipientEmail),key=randomUUID();
    const [a,b]=await Promise.all([client,another].map(c=>request('/api/intake/receptions',{body:declaration,client:c,key})));
    assert.deepEqual([a.status,b.status].sort(),[200,202]);
    assert.equal(a.body.operation_id,b.body.operation_id);assert.equal(a.body.reception_id,b.body.reception_id);
    assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.intention WHERE client_key=$1',[key])).rows[0].n,1);
    const changed=await request('/api/intake/receptions',{body:{...declaration,original:{...declaration.original,name:'another.txt'}},client,key});
    assert.equal(changed.status,409);assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.intention WHERE client_key=$1',[key])).rows[0].n,1);
  });
  await t.test('denied binary admission consumes no application bytes and does not stage',async()=>{
    const before=storage.length;
    const denied=await request(`/api/intake/receptions/${reserved.reception_id}/attempts/1/original`,{bytes:original,client,headers:{origin:'https://foreign.test'}});
    assert.deepEqual({status:denied.status,captures:storage.length-before},{status:403,captures:0});
    const unauthenticated=await request('/api/intake/profiles');assert.equal(unauthenticated.status,403);
    assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.receipt')).rows[0].n,1);
  });
  await t.test('invalid framing and unimplemented routes remain closed',async()=>{
    const bad=await request('/api/intake/receptions',{body:declaration,client,key:randomUUID(),headers:{'content-encoding':'gzip'}});assert.equal(bad.status,400);
    for(const path of ['/api/intake/extractions/not-available','/api/intake/preparations/not-available','/api/intake/receptions?hidden=1'])
      assert.equal((await request(path,{client})).status,400);
  });
  await t.test('wrong actual digest cannot produce a receipt even if the declaration is valid',async()=>{
    const r=await request('/api/intake/receptions',{body:declaration,client,key:randomUUID()});assert.equal(r.status,202);
    const wrong=Buffer.from(original);wrong[wrong.length-1]^=1;
    const reference={original:declaration.original,actualBytes:wrong.length,actualSha256:hash(wrong),actualHex:wrong.toString('hex'),
      expected:{status:400,receipts:0,appendedBytes:17,formatEntries:0},fixedAtMs:Date.now()};
    assert.notEqual(reference.actualSha256,reference.original.sha256);
    writeFileSync('/work/output/digest-order-reference.json',JSON.stringify(reference,null,2),{flag:'wx'});
    const sent=await request(`/api/intake/receptions/${r.body.reception_id}/attempts/1/original`,{bytes:wrong,client});
    const events=(await administration('observe-events',{})).events.filter(e=>e.origin==='object-boundary');
    const target=events.filter(e=>e.artifactId===r.body.original.id),positive=events.filter(e=>e.artifactId===reserved.original.id);
    const verifier=(await administration('observe-events',{participant:'verifier'})).events;
    const targetVerifier=verifier.filter(e=>e.artifactId===r.body.original.id&&e.kind==='started'&&e.action==='verify');
    const positiveVerifier=verifier.filter(e=>e.artifactId===reserved.original.id&&e.kind==='started'&&e.action==='verify');
    const observed={status:sent.status,receipts:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.receipt WHERE reception_id=$1',[r.body.reception_id])).rows[0].n,
      appendedBytes:target.filter(e=>e.kind==='append').reduce((n,e)=>n+e.bytes,0),formatEntries:targetVerifier.length};
    // Broker integrity reads are diagnostic, not forbidden format processing.
    // Removing a redundant early digest check may leave the contract protected.
    const readEvents=target.filter(e=>['open','read'].includes(e.kind)).length;
    writeFileSync('/work/output/digest-order.json',JSON.stringify({observed,readEvents,target,positive,targetVerifier,positiveVerifier},null,2),{flag:'wx'});
    assert.ok(positive.some(e=>e.kind==='open')&&positive.some(e=>e.kind==='read'&&e.bytes===17),'The legitimate path must actually read its stored original');
    assert.ok(positiveVerifier.length>0,'The legitimate original must reach the actual format verifier');
    assert.deepEqual(observed,reference.expected);
  });
  await t.test('resume fences an unused generation and preserves one logical reception',async()=>{
    const r=await request('/api/intake/receptions',{body:declaration,client,key:randomUUID()});assert.equal(r.status,202);
    const advanced=await request(`/api/intake/receptions/${r.body.reception_id}/resume`,{body:{profile:'intake/1',expected_revision:r.body.revision,
      expected_generation:1,cause:'interrupted',original:r.body.original},client,key:randomUUID()});
    assert.equal(advanced.status,202,JSON.stringify(advanced.body));assert.equal(advanced.body.original.generation,2);
    const before=storage.length;
    const late=await request(`/api/intake/receptions/${r.body.reception_id}/attempts/1/original`,{bytes:original,client});
    assert.deepEqual({status:late.status,captures:storage.length-before},{status:409,captures:0});
    const staged2=await request(`/api/intake/receptions/${r.body.reception_id}/attempts/2/original`,{bytes:original,client});
    assert.equal(staged2.status,200,JSON.stringify(staged2.body));
    const done=await request(`/api/intake/receptions/${r.body.reception_id}/finalize`,{body:{profile:'intake/1',expected_revision:staged2.body.revision,
      original:staged2.body.original,format_profile:'text-utf8/1'},client,key:randomUUID()});
    assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.original.generation,2);
    const row=(await env.admin.query('SELECT generation,load_reference FROM intake_trial.receipt WHERE reception_id=$1',[r.body.reception_id])).rows[0];
    assert.equal(row.generation,2);assert.equal(row.load_reference.original.id,done.body.original.id);
  });
  await t.test('cancel fences the attempt and cannot manufacture a receipt',async()=>{
    const r=await request('/api/intake/receptions',{body:declaration,client,key:randomUUID()});assert.equal(r.status,202);
    const stopped=await request(`/api/intake/receptions/${r.body.reception_id}/cancel`,{body:{profile:'intake/1',expected_revision:r.body.revision},client,key:randomUUID()});
    assert.equal(stopped.status,200,JSON.stringify(stopped.body));assert.equal(stopped.body.state,'stopped');
    const before=storage.length,sent=await request(`/api/intake/receptions/${r.body.reception_id}/attempts/1/original`,{bytes:original,client});
    assert.deepEqual({status:sent.status,captures:storage.length-before,receipts:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.receipt WHERE reception_id=$1',[r.body.reception_id])).rows[0].n},
      {status:409,captures:0,receipts:0});
  });
  await t.test('governed JSON and original share durable evidence and idle SQL before handoff',async()=>{
    const observations=[];
    barrierAction=async(label,event)=>{
      if(label!=='before_handoff')return;
      const evidence=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows[0];
      const backend=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows[0];
      observations.push({route:event.route,evidence:!!evidence,status:evidence?.status,state:backend.state,transaction:backend.xact_start,
        transport:(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.transport WHERE evidence_id=$1',[event.evidenceId])).rows[0].n});
    };
    try {
      for(const path of ['/api/intake/profiles',`/api/intake/receptions/${reserved.reception_id}`,`/api/intake/receptions/${reserved.reception_id}/original`])
        assert.equal((await request(path,{client})).status,200);
    }finally{barrierAction=async()=>{};}
    assert.deepEqual(observations.map(({route,...rest})=>rest),Array.from({length:3},()=>({evidence:true,status:200,state:'idle',transaction:null,transport:0})));
    assert.deepEqual(observations.map(x=>x.route),['profiles','reception','original']);
  });
  if(process.env.LEDGERDESK_INTAKE_FENCE_SQL==='1'){
    await fenceSqlCases(t,{env,intake,accessService:terminal.service,client,receptionId:reserved.reception_id,request,declaration,
      probeLogin:async()=>post('/sessions',{email:recipientEmail,password},await flow())});
    return;
  }
  await streamCases(t,{env,intake,client,request,storage,barriers,admissions,freshSession:()=>login(recipientEmail),digestSession:value=>terminal.service.digest(value),
    retained:{receptionId:reserved.reception_id,bytes:original},setBarrier:action=>{barrierAction=action;},application:{
    crash:()=>terminal.crash(),restart:async next=>{
      await terminal.close();terminal=await startApplication({config:env.config,reading:env.reading,tls:env.tls,
        mailbox:{send:async message=>messages.push(message)},intake:next,intakeHooks:hooks});
    }}});
  if(process.env.LEDGERDESK_INTAKE_FENCING_PROBE==='1'||process.env.LEDGERDESK_INTAKE_FENCE_LOSS||process.env.LEDGERDESK_INTAKE_FENCE_ACK||process.env.LEDGERDESK_INTAKE_FENCE_COMMIT||process.env.LEDGERDESK_INTAKE_FENCE_CONTINUATION||process.env.LEDGERDESK_INTAKE_FENCE_IPC||process.env.LEDGERDESK_INTAKE_FENCE_RESTORE){
    writeFileSync('/work/output/runtime-observations.json',JSON.stringify({storage,comparisons,barriers,transfers,privilegeProbes,incomplete,admissions},null,2));
    return;
  }
  await t.test('F01 every completed private phase retains its exact evidence and terminal participant set',async()=>{
    const phases=(await env.admin.query(`SELECT p.*,c.observation,c.kind AS completion_kind FROM intake_control.private_phase p
      LEFT JOIN intake_control.phase_completion c ON c.phase_id=p.id ORDER BY p.started_at`)).rows;
    const head=(await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0];
    assert.ok(phases.length>10);assert.equal(head.active_phase,null);
    for(const p of phases){
      assert.equal(p.completion_kind,'participants_closed');
      assert.deepEqual(Object.keys(p.observation).sort(),Object.keys(p.participant_plan).sort());
      const e=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[p.evidence_id])).rows[0];
      assert.deepEqual([e.reception_id,e.artifact_id,e.generation,e.backend_pid],[p.reception_id,p.artifact_id,p.generation,p.backend_pid]);
      for(const [participant,ack]of Object.entries(p.observation))assert.deepEqual(ack,{profile:'intake-phase-closed/1',id:p.id,participant});
    }
    writeFileSync('/work/output/completed-private-phases.json',JSON.stringify({head,phases},null,2));
  });
  await t.test('known effect survives withdrawn load faculty while current query remains',async()=>{
    const grant=(await env.admin.query("SELECT * FROM access_trial.grant_record WHERE permission_id='intake_load' AND faculty='exercise'")).rows[0];
    assert.equal((await post(`/grants/${grant.id}/withdraw`,{expected_revision:grant.revision,reason:'Synthetic current authority control'},master)).status,200);
    const result=await request(`/api/intake/receptions/${reserved.reception_id}/finalize`,{body:finalizeBody,client,key:finalizeKey});
    assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body.effect,received.effect);
    assert.equal((await request('/api/intake/receptions',{body:declaration,client,key:randomUUID()})).status,404);
  });
  await recoveryCases(t,{env,intake,client,master,received,original,request,post,flow,messages,
    digestSession:value=>terminal.service.digest(value),restart:async next=>{
      await terminal.close();terminal=await startApplication({config:env.config,reading:env.reading,tls:env.tls,
        mailbox:{send:async message=>messages.push(message)},intake:next,intakeHooks:hooks});
    }});
  writeFileSync('/work/output/runtime-observations.json',JSON.stringify({storage,comparisons,barriers,transfers,privilegeProbes,incomplete,admissions},null,2));
});
