import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import next from 'next';
import { chromium } from '@playwright/test';
import { runtimeEnvironment } from './runtime_environment.mjs';
import { authorizedReadingMigration } from '../../ci/access_material_schema.mjs';
import { PasswordVerifier } from '../../src/server/access/password.ts';
import { startAccessTerminal } from '../../src/server/access/terminal.ts';
import { startReadingTerminal } from '../../src/server/reading/terminal.ts';
import { PgReadingStore } from '../../src/server/reading/postgres/store.ts';
import { seedTrial, trialEnv, original, policy, treatment } from '../reading/T04_seed.mjs';
import { observeBrowser } from '../reading/browser_diagnostics.mjs';
import { compareTiming, TIMING_PROTOCOL } from '../reading/timing_comparison.mjs';
import { InvitationAuthority } from '../../src/server/access/invitation_authority.ts';

const uiOrigin = 'https://ui.inc02.test:8443';
const apiOrigin = 'https://api.inc02.test:9443';
const materialPath = (id) => '/api/v1/material/' + encodeURIComponent(id) + '/versions/v1';
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function eventually(check, message, milliseconds=4000) {
  const until=Date.now()+milliseconds;
  while (Date.now()<until) { if (await check()) return; await pause(10); }
  throw Error(message);
}

test('T04 authenticated material, scoped census and actual handoff', {timeout:240000}, async t => {
  const env=await runtimeEnvironment();
  let terminal, oldTerminal, oldAdmin, reader, browser, app, uiServer, mutantRoot;
  const gates=new Set(), readingHooks={}, messages=[];
  const hooks={failure:e=>console.error('READING_TRIAL_FAILURE',e.message,e.code??'')};
  t.afterEach(async()=>{
    for(const release of gates) release();gates.clear();delete readingHooks.afterCommit;delete readingHooks.afterLastClock;
    await env.admin.query('ROLLBACK');
    // A discriminating failure must not poison the next scenario's authority or generation.
    await env.admin.query("UPDATE access_trial.permission_definition SET requires_investiture=false WHERE id='read_material'; UPDATE access_trial.investiture SET active=false; UPDATE access_trial.investiture_resolution SET active=false");
    await env.control.query('SELECT material_trial.set_control($1,true,$2)',[reading.generation,treatment]);
  });
  t.after(async()=>{
    for(const release of gates) release();
    try {
      await browser?.close();uiServer?.closeAllConnections();
      if(uiServer) await new Promise(r=>uiServer.close(r));await app?.close();
      await terminal?.close();await oldTerminal?.close();await reader?.end();await oldAdmin?.end();
    } finally {
      await env.close();
      if(mutantRoot){assert.ok(mutantRoot.startsWith('/work/output/reading-mutant-'));rmSync(mutantRoot,{recursive:true,force:true});}
    }
  });
  const password='Synthetic reading password';
  const passwords=new PasswordVerifier();await passwords.initialize();
  const masterId=randomUUID();
  await env.admin.query('INSERT INTO access_trial.account(id,email,person_ref,office,verifier) VALUES($1,$2,$3,$4,$5)',
    [masterId,'master@example.test','synthetic-custodian','master',await passwords.create(password)]);
  const config={profile:'access-runtime/1',synthetic:true,transport:{profile:'session/1',uiOrigin,terminalOrigin:apiOrigin},
    security:{profile:'access-trial/1',sessionSeconds:1800,proofSeconds:300,invitationSeconds:86400,proofAttempts:5,loginAttempts:5,
      attemptWindowSeconds:300,bodyBytes:16384,resendSeconds:1,resendLimit:3,retryLimit:2},
    connectionString:env.runtimeConfig.connectionString,expectedPort:55432,digestKey:randomBytes(32).toString('hex')};
  const mailbox={async send(m){messages.push(m);}};
  terminal=await startAccessTerminal({config,tls:env.tls,mailbox,hooks});
  function request(route,{method='GET',body,client,origin=uiOrigin,headers={}}={}) {
    return new Promise((resolve,reject)=>{
      const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
      const req=https.request({host:'127.0.0.1',port:9443,servername:'api.inc02.test',ca:env.ca,path:route,method,
        headers:{Host:'api.inc02.test:9443',Origin:origin,...(client?{cookie:client.cookie}:{}),
          ...(bytes?{'content-type':'application/json','content-length':bytes.length}:{}),...headers}},res=>{
        const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>{
          const raw=Buffer.concat(parts).toString();resolve({status:res.statusCode,body:raw?JSON.parse(raw):null,headers:res.headers});
        });res.on('error',reject);
      });req.setTimeout(12000,()=>req.destroy(Error('Bounded HTTPS request timed out')));req.on('error',reject);req.end(bytes);
    });
  }
  const access=(route,options)=>request('/api/access/v1'+route,options);
  const post=(route,body,client)=>access(route,{method:'POST',body,client,headers:{'x-ledgerdesk-csrf':client.csrf,'x-ledgerdesk-intent':randomUUID()}});
  async function reception(){const r=await access('/reception');assert.equal(r.status,200);return{cookie:r.headers['set-cookie'][0].split(';')[0],csrf:r.body.csrf_token};}
  async function login(email){const f=await reception(),r=await post('/sessions',{email,password},f);assert.equal(r.status,200,JSON.stringify(r.body));return{cookie:r.headers['set-cookie'][0].split(';')[0],csrf:r.body.csrf_token};}
  const master=await login('master@example.test'),until=Date.now()+3600000;
  await env.admin.query(`INSERT INTO access_trial.permission_definition VALUES
    ('invite','Invite','application',1,true,false),('read_material','Read material','application',1,true,false),
    ('read_people','Read scoped people','application',1,true,false);
    INSERT INTO access_trial.scope_definition VALUES('organisation',NULL,'Organisation','synthetic-reading-trial',1,true),
    ('inc02-material','organisation','Material scope','synthetic-reading-trial',1,true),('unrelated',NULL,'Unrelated','different-purpose',1,true);`);
  await env.admin.query("INSERT INTO access_trial.support_definition VALUES('domain','domain',NULL,'Domain adoption','synthetic-adoption',$1,true,1)",[until]);
  for(const [permission,faculty] of [['invite','exercise'],['read_material','grant'],['read_people','grant']])
    await env.admin.query('INSERT INTO access_trial.grant_record VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,false,1)',
      [randomUUID(),masterId,permission,faculty,'organisation','domain','synthetic-root-grant',until]);
  async function admitPerson(email,permissions=['read_material','read_people']) {
    const issued=await post('/invitations',{email,family:'application',expires_at:Date.now()+360000,
      grants:permissions.map(permission_id=>({permission_id,exercise_or_grant:'exercise',scope_ref:'inc02-material',support_ref:'domain'}))},master);
    assert.equal(issued.status,200,JSON.stringify(issued.body));
    const inv=issued.body,f=await reception();
    assert.equal((await post(`/invitations/${inv.invitation_id}/challenges`,{},f)).status,200);
    const m=messages.at(-1),proof=await post(`/invitation-proofs/${m.challenge_id}/verify`,{code:m.code},f);
    assert.equal(proof.status,200);
    const accepted=await post(`/invitations/${inv.invitation_id}/accept`,{expected_revision:inv.revision,proof_id:proof.body.proof_id},f);
    assert.equal(accepted.status,200,JSON.stringify(accepted.body));
    assert.equal((await post('/account/initial-credential',{password},f)).status,200);
    const row=(await env.admin.query('SELECT id,person_ref FROM access_trial.account WHERE email=$1',[email])).rows[0];
    return {...row,email,client:await login(email)};
  }
  const alice=await admitPerson('alice@example.test'),bob=await admitPerson('bob@example.test');
  await env.admin.query('INSERT INTO access_trial.person_determination VALUES($1,$2,$3)',['alice-second@example.test',alice.person_ref,'synthetic-person-link']);
  const aliceSecond=await admitPerson('alice-second@example.test');
  const snapshot=async()=>{
    const result={};for(const table of ['account','session','acceptance','grant_record','invitation_intent','person_account','evidence'])
      result[table]=(await env.admin.query(`SELECT * FROM access_trial.${table} ORDER BY 1`)).rows;
    return result;
  };
  const before=await snapshot();
  await terminal.close();terminal=null;
  await env.admin.query(authorizedReadingMigration());
  const readerPassword=randomBytes(24).toString('hex');
  await env.admin.query(`ALTER ROLE inc02_reader LOGIN PASSWORD '${readerPassword}'`);
  const reading={connectionString:`postgresql://inc02_reader:${readerPassword}@127.0.0.1:55432/inc02_synthetic`,expectedPort:55432,
    generation:'authenticated-reading-generation-one',cursorSeconds:120,cursorLimit:50,pageSize:1};
  reader=new Client({connectionString:reading.connectionString});await reader.connect();
  await env.admin.query('INSERT INTO material_trial.control VALUES(true,$1,1,true,true,true,true,true,true)',[reading.generation]);
  for(const surface of ['material-list','material-exact','people'])
    await env.admin.query('INSERT INTO material_trial.surface VALUES($1,$2,$3,$4,true,true,true,1)',
      [surface,surface==='people'?'read_people':'read_material','inc02-material','synthetic-reading-trial']);
  for(const [id,name,scope] of [[alice.id,'Alex Reader','inc02-material'],[bob.id,'Blair Reader','inc02-material'],[masterId,'Unrelated private name','unrelated']])
    await env.admin.query('INSERT INTO material_trial.census_entry VALUES($1,$2,$3,$4,1)',[id,scope,name,'synthetic-nominal-source']);
  await env.admin.query('CREATE DATABASE inc01_synthetic');
  oldAdmin=new Client({host:env.admin.connectionParameters.host,port:55432,user:'trial_bootstrap',database:'inc01_synthetic'});await oldAdmin.connect();
  await oldAdmin.query(readFileSync(new URL('../../src/server/reading/postgres/001_trial.sql',import.meta.url),'utf8'));
  const oldPassword=randomBytes(24).toString('hex');await oldAdmin.query(`ALTER ROLE inc01_reader LOGIN PASSWORD '${oldPassword}'`);
  await seedTrial(oldAdmin);
  // The source seed has exact multilingual/opaque text. The two paths differ only in trusted context.
  const sourceRows=(await oldAdmin.query('SELECT m.*,p.hierarchy FROM reading_trial.material m JOIN reading_trial.policy p USING(deployment_id,scope_id,unit_key,version_key)')).rows;
  function contextual(hierarchy){
    const copy=structuredClone(hierarchy);
    copy.unit=copy.unit.flatMap(row=>[alice,bob].map(a=>{
      const r=structuredClone(row),binding={...r.binding,deploymentId:'inc02-synthetic',scopeId:'inc02-material',subjectId:a.id,
        surface:r.binding.action==='list'?'material-list':'material-exact',generation:reading.generation};
      r.binding=binding;r.grant.binding=binding;return r;
    }));return copy;
  }
  const materialPolicy=new Map();
  for(const row of sourceRows){
    const p=contextual(row.hierarchy);materialPolicy.set(JSON.parse(row.unit_key),p);
    await env.admin.query('INSERT INTO material_trial.material VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['inc02-synthetic','inc02-material',row.unit_key,row.version_key,JSON.stringify(row.original_value),row.original_language,
        JSON.stringify(row.metadata),JSON.stringify(row.fragments),JSON.stringify(row.requirements)]);
    await env.admin.query('INSERT INTO material_trial.policy VALUES($1,$2,$3,$4,$5)',
      ['inc02-synthetic','inc02-material',row.unit_key,row.version_key,JSON.stringify(p)]);
  }
  // Keep an indispensable condition in storage but remove permission to reveal it.
  for(const [admin,schema,context] of [[oldAdmin,'reading_trial','inc01'],[env.admin,'material_trial','inc02']]){
    const p=context==='inc01'?policy('EXCERPT'):contextual(policy('EXCERPT'));
    p.unit.forEach(r=>r.grant.fragmentIds=['rule']);
    await admin.query(`INSERT INTO ${schema}.material SELECT deployment_id,scope_id,'"broken"',version_key,original_value,original_language,
      metadata,fragments,requirements FROM ${schema}.material WHERE unit_key='"excerpt"'`);
    await admin.query(`INSERT INTO ${schema}.policy VALUES($1,$2,'"broken"','"v1"',$3)`,
      [context+'-synthetic',context+'-material',JSON.stringify(p)]);
  }
  oldTerminal=await startReadingTerminal({env:trialEnv,createStore:onLoss=>new PgReadingStore({
    connectionString:`postgresql://inc01_reader:${oldPassword}@127.0.0.1:55432/inc01_synthetic`,expectedPort:55432},onLoss)});
  let start=startAccessTerminal;
  const mutation=process.env.ACCESS_RUNTIME_MUTATION;
  if(mutation && mutation!=='early-failure'){
    const changes={
      'drop-cursor-session':['authenticated_reading.ts','row.session_digest === sessionDigest &&','true &&'],
      'drop-reading-authority':['authenticated_reading.ts',"const maximum = scope?.purpose_ref === surface.purpose_ref", "const maximum = true ? 'CONTENT' : scope?.purpose_ref === surface.purpose_ref"],
      'drop-reading-evidence':['authenticated_reading.ts',"'INSERT INTO material_trial.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'",
        "'SELECT $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::json,$7::text,$8::json,$9::int,$10::bigint'"],
      'drop-reading-admission':['postgres/store.ts',"await this.client.query(\n      exclusive", "await this.client.query(\n      this.role === 'inc02_reader' ? 'SELECT 1' : exclusive"],
      'drop-reading-generation':['reading_control.ts','c.generation !== expected','false'],
    };
    assert.ok(changes[mutation],'Named mutation');mutantRoot='/work/output/reading-mutant-'+randomUUID();cpSync('/work/src',mutantRoot+'/src',{recursive:true});
    const [file,from,to]=changes[mutation],target=mutantRoot+'/src/server/access/'+file,source=readFileSync(target,'utf8');
    assert.equal(source.split(from).length-1,1);writeFileSync(target,source.replace(from,to));
    start=(await import(pathToFileURL(mutantRoot+'/src/server/access/terminal.ts').href)).startAccessTerminal;
  }
  terminal=await start({config,tls:env.tls,mailbox,hooks,reading,readingHooks});
  if(mutation==='early-failure') throw Error('Injected early failure');
  const read=(id,client=alice.client)=>request(materialPath(id),{client});
  const replace=(id,p)=>env.control.query('SELECT material_trial.replace_policy($1,$2,$3)',[JSON.stringify(id),'"v1"',JSON.stringify(p)]);
  function heldRead(surface='material-exact'){
    let arrive,release;const reached=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);
    const timeout=setTimeout(release,5000),finish=()=>{clearTimeout(timeout);release();};gates.add(finish);
    readingHooks.afterCommit=async event=>{if(event.surface===surface){arrive(event);await gate;}};
    return {reached:Promise.race([reached,pause(6000).then(()=>{throw Error('Material gate not reached');})]),release:finish};
  }
  async function declarationFixture() {
    await env.admin.query("UPDATE access_trial.permission_definition SET requires_investiture=true WHERE id='read_material'");
    const d={...env.root,holderPersonRef:alice.person_ref,purposeRef:'synthetic-reading-trial',maximumGradeRef:'CONTENT'};
    await env.admin.query(`INSERT INTO access_trial.investiture VALUES('reading-office',$1,'read_material','inc02-material',$2,$3,true,1)
      ON CONFLICT(id) DO UPDATE SET declaration=excluded.declaration,expires_at=excluded.expires_at,active=true,revision=1`,[alice.person_ref,d,until]);
  }
  await t.test('R01 populated migration preserves identity, acceptance, intent and prior evidence',async()=>{
    assert.deepEqual(await snapshot(),before);
    assert.equal((await access('/session',{client:alice.client})).status,200);
    const columns=async(admin,schema,table)=>(await admin.query(`SELECT column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,[schema,table])).rows;
    for(const table of ['material','policy']) assert.deepEqual(await columns(env.admin,'material_trial',table),await columns(oldAdmin,'reading_trial',table));
  });
  await t.test('R02 reader and identity privileges are limited in both directions',async()=>{
    for(const sql of ['SELECT verifier FROM access_trial.account','SELECT csrf FROM access_trial.session','UPDATE access_trial.grant_record SET withdrawn=true',
      'UPDATE material_trial.policy SET hierarchy=hierarchy','DELETE FROM material_trial.evidence','SET ROLE inc02_owner','SET ROLE inc02_runtime','SELECT * FROM retained_legacy.private_data'])
      await assert.rejects(reader.query(sql),e=>e.code==='42501');
    for(const sql of ['SELECT * FROM material_trial.material','INSERT INTO material_trial.evidence SELECT * FROM material_trial.evidence','SET ROLE inc02_reader'])
      await assert.rejects(env.runtime.query(sql),e=>e.code==='42501');
    await env.admin.query('SET ROLE retained_legacy');try{await assert.rejects(env.admin.query('SELECT * FROM material_trial.material'),e=>e.code==='42501');}finally{await env.admin.query('RESET ROLE');}
    assert.equal((await env.admin.query("SELECT has_database_privilege('retained_legacy','inc02_synthetic','CONNECT') AS permitted")).rows[0].permitted,false);
  });
  await t.test('R03 both real transports match independent positive and negative projection oracles',async()=>{
    const oldList=await fetch(oldTerminal.url+'/api/v1/material'),newList=await request('/api/v1/material',{client:alice.client});
    assert.deepEqual({status:newList.status,body:newList.body},{status:oldList.status,body:await oldList.json()});
    assert.deepEqual({references:newList.body.items.map(i=>i.reference.unit_id),signal:newList.body.existence_signal},
      {references:['broken','content','excerpt','reference'],signal:true});
    for(const [id,status,kind] of [['content',200,'CONTENT'],['excerpt',200,'EXCERPT'],['reference',200,'REFERENCE'],['hidden',404,null],['absent',404,null],['broken',200,'REFERENCE']]){
      const old=await fetch(oldTerminal.url+materialPath(id)),previous=await old.json(),current=await read(id);
      assert.deepEqual({status:current.status,body:current.body},{status:old.status,body:previous},id);
      assert.equal(current.status,status,id);
      if(kind) assert.equal(current.body.projection.kind,kind,id);
      if(id==='content') assert.equal(current.body.projection.original_text,original);
      if(id==='excerpt') assert.deepEqual(current.body.projection.fragments.map(f=>({fragment_id:f.fragment_id,text:f.text})),
        [{fragment_id:'rule',text:'Regla.'},{fragment_id:'exception',text:'Excepto los domingos.'}]);
      if(id==='broken') assert.equal(JSON.stringify(current.body).includes('Regla.'),false);
      assert.match(current.headers['cache-control'],/no-store/);
      assert.equal(current.headers['access-control-allow-credentials'],'true');
      assert.equal(old.headers.get('access-control-allow-credentials'),null);
    }
  });
  await t.test('R04 master/grant faculty is not reading authority and denial preserves session',async()=>{
    assert.equal((await read('content',master)).status,404);
    assert.equal((await access('/session',{client:master})).status,200);
    assert.equal((await read('content',null)).status,403);
    assert.equal((await read('content')).status,200);
  });
  await t.test('R05 population is scoped before pagination; names are nominal, not email aliases',async()=>{
    const a=await access('/people',{client:alice.client});assert.equal(a.status,200);
    assert.equal(a.body.people.length,1);assert.ok(a.body.next_cursor);assert.ok(a.body.revision>0);
    const b=await access('/people?cursor='+a.body.next_cursor,{client:alice.client});assert.equal(b.status,200);assert.equal(b.body.next_cursor,'');
    assert.deepEqual([...a.body.people,...b.body.people].map(x=>x.display_name).sort(),['Alex Reader','Blair Reader']);
    assert.equal(JSON.stringify([a.body,b.body]).includes('example.test'),false);
    assert.equal(JSON.stringify([a.body,b.body]).includes('Unrelated'),false);
  });
  await t.test('R06 cursor tampering, foreign principal and another session of the same account are neutral',async()=>{
    const cursor=(await access('/people',{client:alice.client})).body.next_cursor;
    const another=await login(alice.email);
    const denied=[];
    for(const [value,client] of [[cursor.slice(0,-1)+'!',alice.client],[cursor,bob.client],[cursor,another]]){
      const r=await access('/people?cursor='+encodeURIComponent(value),{client});denied.push({status:r.status,body:r.body});
    }
    assert.equal(denied[0].status,404);assert.deepEqual(denied[1],denied[0]);assert.deepEqual(denied[2],denied[0]);
    assert.equal((await access('/people?cursor='+cursor,{client:alice.client})).status,200);
  });
  await t.test('R07 cursor expires and rejects a changed authorized population',async()=>{
    let cursor=(await access('/people',{client:alice.client})).body.next_cursor;
    await env.admin.query('UPDATE material_trial.census_cursor SET expires_at=created_at+1');await pause(2);
    assert.equal((await access('/people?cursor='+cursor,{client:alice.client})).status,404);
    cursor=(await access('/people',{client:alice.client})).body.next_cursor;
    await env.admin.query('UPDATE material_trial.census_entry SET revision=revision+1 WHERE account_id=$1',[bob.id]);
    assert.equal((await access('/people?cursor='+cursor,{client:alice.client})).status,404);
  });
  await t.test('R08 capability truth and surface state are distinct from authentication',async()=>{
    const before=(await access('/capabilities',{client:alice.client})).body;
    assert.ok(JSON.stringify(before).includes('material-list'));
    await env.control.query("SELECT material_trial.set_surface('material-exact',false,true)");
    assert.equal((await read('content')).status,404);assert.equal((await access('/session',{client:alice.client})).status,200);
    await env.control.query("SELECT material_trial.set_surface('material-exact',true,false)");assert.equal((await read('content')).status,503);
    await env.control.query("SELECT material_trial.set_surface('material-exact',true,true)");assert.equal((await read('content')).status,200);
  });
  await t.test('R09 request, Origin and legacy-cookie negatives fail before material evidence',async()=>{
    const count=async()=>(await env.admin.query('SELECT count(*)::int AS n FROM material_trial.evidence')).rows[0].n;
    const before=await count();assert.equal((await request(materialPath('content'),{client:alice.client,origin:'https://other.inc02.test:8443'})).status,403);
    assert.equal(await count(),before);
    assert.equal((await request(materialPath('content'),{client:{cookie:'legacy_identity=master'}})).status,403);
    for(const method of ['HEAD','POST','DELETE']) assert.equal((await request(materialPath('content'),{method,client:alice.client})).status,400);
    assert.equal((await request('/api/v1/material/content/versiones/v1',{client:alice.client})).status,400);
  });
  await t.test('R10 declared investiture is operational, not accredited, with bounded grade and purpose',async()=>{
    await env.admin.query("UPDATE access_trial.permission_definition SET requires_investiture=true WHERE id='read_material'");
    assert.equal((await read('content')).status,404);
    const declaration={...env.root,holderPersonRef:alice.person_ref,purposeRef:'synthetic-reading-trial',maximumGradeRef:'REFERENCE'};
    await env.admin.query('INSERT INTO access_trial.investiture VALUES($1,$2,$3,$4,$5,$6,true,1)',
      ['reading-office',alice.person_ref,'read_material','inc02-material',declaration,until]);
    assert.equal((await read('content')).body.projection.kind,'REFERENCE');
    const facts=(await env.admin.query("SELECT authority_facts FROM material_trial.evidence WHERE actor_ref=$1 ORDER BY recorded_at DESC LIMIT 1",[alice.id])).rows[0]?.authority_facts;
    assert.equal(facts?.declarations?.[0]?.accreditation,'not_externally_accredited');
    declaration.purposeRef='other-purpose';await env.admin.query("UPDATE access_trial.investiture SET declaration=$1 WHERE id='reading-office'",[declaration]);
    assert.equal((await read('content')).status,404);
    declaration.purposeRef='synthetic-reading-trial';declaration.maximumGradeRef='CONTENT';
    await env.admin.query("UPDATE access_trial.investiture SET declaration=$1 WHERE id='reading-office'",[declaration]);
    assert.equal((await read('content')).body.projection.kind,'CONTENT');
  });
  await t.test('R11 conflicting declarations require an explicit local resolution',async()=>{
    await declarationFixture();
    await env.admin.query(`INSERT INTO access_trial.investiture SELECT 'reading-office-conflict',person_ref,permission_id,scope_ref,
      jsonb_set(declaration,'{maximumGradeRef}','"REFERENCE"'),expires_at,true,1 FROM access_trial.investiture WHERE id='reading-office'`);
    assert.equal((await read('content')).status,404);
    await env.admin.query("INSERT INTO access_trial.investiture_resolution VALUES('local-resolution','inc02-material','read_material','reading-office','synthetic-resolution',true,1)");
    assert.equal((await read('content')).body.projection.kind,'CONTENT');
    await env.admin.query("UPDATE access_trial.investiture_resolution SET active=false");
    assert.equal((await read('content')).status,404);
    await env.admin.query("UPDATE access_trial.investiture SET active=false WHERE id='reading-office-conflict'");
  });
  await t.test('R12 event-based revalidation and explicit ending alter current authority',async()=>{
    await declarationFixture();
    await env.admin.query("UPDATE access_trial.investiture SET declaration=jsonb_set(declaration,'{termination}', $1) WHERE id='reading-office'",
      [JSON.stringify({kind:'revalidate',eventRef:'mandate-review'})]);
    assert.equal((await read('content')).status,404);
    await env.admin.query("INSERT INTO access_trial.revalidation_event VALUES('mandate-review',$1,true,1)",[until]);
    assert.equal((await read('content')).status,200);
    await env.control.query("SELECT access_trial.set_revalidation('mandate-review',$1,false)",[until]);assert.equal((await read('content')).status,404);
    await env.control.query("SELECT access_trial.set_revalidation('mandate-review',$1,true)",[until]);assert.equal((await read('content')).status,200);
    await env.control.query("SELECT access_trial.end_investiture('reading-office')");assert.equal((await read('content')).status,404);
    await env.admin.query("UPDATE access_trial.permission_definition SET requires_investiture=false WHERE id='read_material'");
  });
  await t.test('R13 authenticated handoff commits exact evidence before bytes with idle SQL',async()=>{
    const gate=heldRead();let received=false;const pending=read('content').then(r=>{received=true;return r;});
    try{
      const event=await gate.reached;
      const evidence=(await env.admin.query('SELECT result,object_ref FROM material_trial.evidence WHERE id=$1',[event.evidenceId])).rows[0];
      const sql=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows[0];
      const n=(await env.admin.query('SELECT count(*)::int AS n FROM material_trial.observation WHERE evidence_id=$1',[event.evidenceId])).rows[0].n;
      assert.deepEqual({evidence,sql,received,observations:n},{evidence:{result:200,object_ref:{unit_id:'content',version_id:'v1'}},sql:{state:'idle',xact_start:null},received:false,observations:0});
      gate.release();assert.equal((await pending).status,200);
      await eventually(async()=>(await env.admin.query("SELECT 1 FROM material_trial.observation WHERE evidence_id=$1 AND outcome='handed_off'",[event.evidenceId])).rowCount===1,'Handoff observation missing');
    } finally {gate.release();await pending;}
  });
  await t.test('R14 actual writer waits in 20202 until material handoff; inverse order denies',async()=>{
    const gate=heldRead(),pending=read('content');let writer;
    try{
      await gate.reached;
      writer=env.control.query("SELECT access_trial.set_support('domain',false,'Synthetic invalidation')");
      await eventually(async()=>(await env.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=20202 AND NOT granted",[env.control.processID])).rowCount===1,'Writer not waiting on reading admission');
      gate.release();assert.equal((await pending).status,200);await writer;delete readingHooks.afterCommit;
      assert.equal((await read('content')).status,404);
    } finally {gate.release();await pending;await writer;await env.control.query("SELECT access_trial.set_support('domain',true,'Synthetic restoration')");}
  });
  await t.test('R15 policy invalidation uses the same admission, not the old 10404 domain',async()=>{
    const gate=heldRead(),pending=read('content');let writer;
    try{await gate.reached;writer=replace('content',contextual(policy('NONE')));
      await eventually(async()=>(await env.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND classid=20202 AND NOT granted",[env.control.processID])).rowCount===1,'Policy writer not coordinated');
      gate.release();assert.equal((await pending).status,200);await writer;delete readingHooks.afterCommit;assert.equal((await read('content')).status,404);
    }finally{gate.release();await pending;await writer;await replace('content',materialPolicy.get('content'));}
  });
  await t.test('R16 treatment flags and restored generation cannot make themselves ready',async()=>{
    for(const flag of Object.keys(treatment)){
      await env.control.query('SELECT material_trial.set_control($1,true,$2)',[reading.generation,{...treatment,[flag]:false}]);
      assert.equal((await read('content')).status,503,flag);
      assert.equal((await access('/session',{client:alice.client})).status,200,'Material treatment does not disable identity preparation');
      const caps=(await access('/capabilities',{client:alice.client})).body.capabilities;
      assert.equal(caps.find(c=>c.capability_id==='material-list').executable,'no');
    }
    await env.control.query('SELECT material_trial.set_control($1,true,$2)',['unreconciled-restored-generation',treatment]);
    assert.equal((await read('content')).status,503);
    await env.control.query('SELECT material_trial.set_control($1,true,$2)',[reading.generation,treatment]);
    assert.equal((await read('content')).status,200);
  });
  await t.test('R17 writer-free expiry is observed at the last check, without claiming atomic clock/transport',async()=>{
    const deadline=Date.now()+700,p=contextual(policy('CONTENT',deadline));await replace('content',p);
    const gate=heldRead(),pending=read('content');
    try{await gate.reached;await pause(Math.max(0,deadline-Date.now()+20));gate.release();assert.equal((await pending).status,503);}
    finally{gate.release();await pending;await replace('content',materialPolicy.get('content'));}
  });
  await t.test('R18 actual browser receives no material before durable evidence and resumes exact text',async()=>{
    app=next({dev:false,dir:path.resolve('tests/access/runtime-ui'),hostname:'ui.inc02.test',port:8443});await app.prepare();
    let leakedCookies=0;const handle=app.getRequestHandler();uiServer=https.createServer(env.tls,(req,res)=>{
      if(req.headers.cookie?.includes('__Host-ledgerdesk')) leakedCookies++;return handle(req,res);
    });await new Promise(r=>uiServer.listen(8443,'127.0.0.1',r));
    browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP *.inc02.test 127.0.0.1','--no-proxy-server']});
    const context=await browser.newContext({viewport:{width:1100,height:850}}),page=await context.newPage();
    const diagnostics=observeBrowser(page,'/work/output/browser-diagnostics');
    await diagnostics.run('R18',async()=>{
      await page.goto(uiOrigin);await page.getByLabel('Email address',{exact:true}).fill(alice.email);await page.getByLabel('Password',{exact:true}).fill(password);
      await page.locator('form').getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Session active',exact:true}).waitFor();
      const [initialResponse]=await Promise.all([
        page.waitForResponse(r=>new URL(r.url()).pathname==='/access/material' && r.request().resourceType()==='document'),
        page.getByRole('link',{name:'Open material library'}).click(),
      ]);
      const initialHtml=await initialResponse.text();
      for(const forbidden of [original,alice.id,alice.email,config.digestKey,'__Host-ledgerdesk-session','csrf_token'])
        assert.equal(initialHtml.includes(forbidden),false,'No private material or identity in the initial HTML');
      await page.getByRole('button',{name:/Synthetic content/}).waitFor();
      let materialResponses=0;page.on('response',r=>{if(new URL(r.url()).pathname===materialPath('content'))materialResponses++;});
      const gate=heldRead();
      try{
        await page.getByRole('button',{name:/Synthetic content/}).click();const event=await gate.reached;
        const observed=(await env.admin.query(`SELECT e.result,(SELECT count(*)::int FROM material_trial.observation o WHERE o.evidence_id=e.id) AS n,
          a.state,a.xact_start FROM material_trial.evidence e CROSS JOIN pg_stat_activity a WHERE e.id=$1 AND a.pid=$2`,[event.evidenceId,event.backendPid])).rows[0];
        assert.deepEqual({observed,materialResponses,dom:await page.getByText('Exact original:',{exact:false}).count()},
          {observed:{result:200,n:0,state:'idle',xact_start:null},materialResponses:0,dom:0});
        gate.release();await page.getByTestId('original').waitFor();
        assert.equal(await page.getByTestId('original').textContent(),original);
        assert.equal(await page.locator('script').filter({hasText:'inert()'}).count(),0);
        await page.screenshot({path:'/work/output/authorized-reading-desktop.png',fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
        await page.screenshot({path:'/work/output/authorized-reading-narrow.png',fullPage:true});
        assert.equal(leakedCookies,0);
        await eventually(async()=>(await env.admin.query('SELECT 1 FROM material_trial.observation WHERE evidence_id=$1',[event.evidenceId])).rowCount===1,'Browser handoff unobserved');
      }finally{gate.release();}
    });await context.close();
  });
  await t.test('R19 same-person/different-account quorum fixture cannot manufacture independence',async()=>{
    const authority=new InvitationAuthority({client:env.admin},Date.now());await authority.load();
    assert.equal(authority.independentActors([alice.id,aliceSecond.id],'read_material','inc02-material'),false);
    assert.equal(authority.independentActors([alice.id,bob.id],'read_material','inc02-material'),true);
    assert.equal(authority.independentActors([alice.id,masterId],'read_material','inc02-material'),false);
  });
  await t.test('R20 evidence failure aborts both preparation and deferred commit before content',async()=>{
    const count=async()=>(await env.admin.query('SELECT count(*)::int AS n FROM material_trial.evidence')).rows[0].n;
    const before=await count();
    await env.admin.query('REVOKE INSERT ON material_trial.evidence FROM inc02_reader');
    try{assert.deepEqual({status:(await read('content')).status,count:await count()},{status:503,count:before});}
    finally{await env.admin.query('GRANT INSERT ON material_trial.evidence TO inc02_reader');}
    await env.admin.query(`CREATE FUNCTION material_trial.fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected evidence commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON material_trial.evidence DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION material_trial.fail_commit()`);
    try{assert.deepEqual({status:(await read('content')).status,count:await count()},{status:503,count:before});}
    finally{await env.admin.query('DROP TRIGGER fail_commit ON material_trial.evidence; DROP FUNCTION material_trial.fail_commit()');}
    assert.equal((await read('content')).status,200);
  });
  await t.test('R21 a real session revocation is ordered against authenticated material',async()=>{
    const client=await login(bob.email),gate=heldRead(),pending=read('content',client);let logout;
    try{await gate.reached;logout=post('/sessions/logout',{},client);
      await eventually(async()=>(await env.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=20202 AND NOT granted")).rowCount>0,'Logout did not wait for handoff');
      gate.release();assert.equal((await pending).status,200);assert.equal((await logout).status,200);delete readingHooks.afterCommit;
      assert.equal((await read('content',client)).status,403);assert.equal((await read('content')).status,200);
    }finally{gate.release();await pending;await logout;}
  });
  await t.test('R22 withdrawal through the admitted grant route removes reading without logout',async()=>{
    const grant=(await env.admin.query("SELECT id,revision FROM access_trial.grant_record WHERE account_id=$1 AND permission_id='read_material'",[bob.id])).rows[0];
    assert.equal((await read('content',bob.client)).status,200);
    assert.equal((await post('/grants/'+grant.id+'/withdraw',{expected_revision:grant.revision,reason:'Synthetic withdrawal'},master)).status,200);
    assert.equal((await read('content',bob.client)).status,404);assert.equal((await access('/session',{client:bob.client})).status,200);
  });
  await t.test('R23 absent and NONE have identical public envelopes and measured temporal parity',async()=>{
    const a=await read('absent'),b=await read('hidden');assert.deepEqual(a,b);
    const groups={absent:[],none:[]},ids={absent:'absent',none:'hidden'};
    for(let i=0;i<TIMING_PROTOCOL.rounds+TIMING_PROTOCOL.warmupRounds;i++)
      for(const key of (i%2?['none','absent']:['absent','none'])){
        const at=performance.now();const r=await read(ids[key]);const elapsed=performance.now()-at;
        assert.equal(r.status,404);if(i>=TIMING_PROTOCOL.warmupRounds)groups[key].push(elapsed);
      }
    const result=compareTiming(groups),control=compareTiming({baseline:groups.absent,shifted:groups.absent.map(x=>x+100)});
    writeFileSync('/work/output/reading-timing.json',JSON.stringify({result,control},null,2));
    assert.equal(control.signalDetected,true);assert.equal(result.signalDetected,false,JSON.stringify(result));
  });
  await t.test('R24 clock/transport suspension records the unaccredited temporal boundary',async()=>{
    const deadline=Date.now()+700;await replace('content',contextual(policy('CONTENT',deadline)));
    let observed;
    readingHooks.afterLastClock=expiry=>{
      assert.equal(expiry,deadline,'The suspension uses the deliberately short policy deadline, never a session lifetime');
      observed=expiry;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(1000,Math.max(1,expiry-Date.now()+30)));
    };
    try{
      const response=await read('content');assert.equal(observed,deadline);
      const materialReceivedAfterDeadline=Date.now()>=deadline && response.body.projection?.original_text===original;
      const observation={experiment:'writer-free-expiry-after-clock',status:response.status,materialReceivedAfterDeadline,fullTemporalConformity:false};
      writeFileSync('/work/output/temporal-boundary.json',JSON.stringify(observation,null,2));t.diagnostic(JSON.stringify(observation));
      assert.ok([200,503].includes(response.status));delete readingHooks.afterLastClock;
      assert.equal((await read('content')).status,404);
    }finally{delete readingHooks.afterLastClock;await replace('content',materialPolicy.get('content'));}
  });
  await t.test('R26 loss of the admitted SQL connection prevents the prepared material handoff',async()=>{
    const gate=heldRead(),pending=read('content').catch(()=>null);
    try{
      const event=await gate.reached;
      assert.equal((await env.admin.query('SELECT result FROM material_trial.evidence WHERE id=$1',[event.evidenceId])).rows[0]?.result,200);
      await env.admin.query('SELECT pg_terminate_backend($1)',[event.backendPid]);
      await eventually(async()=>(await env.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rowCount===0,'Serving SQL connection did not end');
      gate.release();const result=await pending;
      assert.ok(result===null || result.status===503);
      assert.equal((await env.admin.query('SELECT 1 FROM material_trial.observation WHERE evidence_id=$1',[event.evidenceId])).rowCount,0);
    }finally{gate.release();await pending;}
  });
  await t.test('R25 missing external startup context does not fall back to credential-free reading',async()=>{
    await terminal.close();terminal=await start({config,tls:env.tls,mailbox,hooks});
    assert.equal((await read('content')).status,503);assert.equal((await access('/session',{client:alice.client})).status,503);
  });
});
