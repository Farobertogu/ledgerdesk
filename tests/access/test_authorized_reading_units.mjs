import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materialDefinition, authorizedReadingMigration } from '../../ci/access_material_schema.mjs';
import { authenticatedReadingConfig } from '../../src/server/access/reading_config.ts';
import { declarationDeadline, independentPeople, resolveDeclarations } from '../../src/server/access/authority_rules.ts';
import { InvitationAuthority } from '../../src/server/access/invitation_authority.ts';
import { Reader } from '../../src/components/reading/reader.ts';
import { accessSourceViolations } from '../../ci/access_boundary_check.mjs';
import ts from 'typescript';
const transport={profile:'session/1',uiOrigin:'https://ui.inc02.test:8443',terminalOrigin:'https://api.inc02.test:9443'};
const config={connectionString:'postgresql://inc02_reader:synthetic@127.0.0.1:55432/inc02_synthetic',expectedPort:55432,
  generation:'synthetic-unit-generation',cursorSeconds:120,cursorLimit:50,pageSize:10};
test('material definition is derived without importing control roles, functions or old admission',()=>{
  const source=readFileSync(new URL('../../src/server/reading/postgres/001_trial.sql',import.meta.url),'utf8'),block=materialDefinition(source);
  assert.equal((block.match(/CREATE TABLE/g)??[]).length,2);assert.doesNotMatch(block,/10404|CREATE ROLE|CREATE FUNCTION|reading_trial\./);
  assert.match(block,/CHECK.*inc02-synthetic/);assert.match(authorizedReadingMigration(),/pg_advisory_xact_lock\(20202,1\)/);
  assert.throws(()=>materialDefinition(source.replace('CREATE TABLE reading_trial.material (','CREATE TABLE wrong (')));
  assert.throws(()=>materialDefinition(source.replace('CREATE TABLE reading_trial.policy (','CREATE ROLE unexpected; CREATE TABLE reading_trial.policy (')));
});
test('reader connection and finite census configuration cannot reuse identity or legacy credentials',()=>{
  assert.deepEqual(authenticatedReadingConfig(config),config);
  for(const delta of [{connectionString:config.connectionString.replace('inc02_reader','inc02_runtime')},{connectionString:config.connectionString.replace('inc02_synthetic','inc01_synthetic')},
    {connectionString:config.connectionString+'?sslmode=disable'},{generation:''},{pageSize:0},{pageSize:101},{cursorSeconds:301},{cursorLimit:101},{expectedPort:5432},{extra:true}])
    assert.throws(()=>authenticatedReadingConfig({...config,...delta}));
});
test('event revalidation needs exactly one current operational declaration',()=>{
  const d={termination:{kind:'revalidate',eventRef:'review'}};
  assert.equal(declarationDeadline(d,[]),null);assert.equal(declarationDeadline(d,[{id:'review',satisfied:false,current_until:20}]),null);
  assert.equal(declarationDeadline(d,[{id:'review',satisfied:true,current_until:20}]),20);
  assert.equal(declarationDeadline(d,[{id:'review',satisfied:true,current_until:20},{id:'review',satisfied:true,current_until:30}]),null);
  assert.equal(declarationDeadline({termination:{kind:'expires',at:1.5}},[]),null);
});
test('compatible overlap survives, conflicting overlap never selects the latest declaration',()=>{
  const a={id:'a',declaration:{purposeRef:'read',maximumGradeRef:'CONTENT'}},b={...a,id:'b'},c={id:'c',declaration:{purposeRef:'read',maximumGradeRef:'REFERENCE'}};
  const resolution={active:true,scope_ref:'s',permission_id:'p',selected_id:'a'};
  assert.deepEqual(resolveDeclarations([a,b],[],'p','s'),[a,b]);assert.deepEqual(resolveDeclarations([a,c],[],'p','s'),[]);
  assert.deepEqual(resolveDeclarations([a,c],[resolution],'p','s'),[a]);
  assert.deepEqual(resolveDeclarations([a,c],[{...resolution,scope_ref:'other'}],'p','s'),[]);
  assert.deepEqual(resolveDeclarations([a,c],[resolution,{...resolution,selected_id:'c'}],'p','s'),[]);
});
test('independence is by currently authorized person, never the number of accounts',()=>{
  const a=new InvitationAuthority({},10);
  a.accounts=[{id:'a',person_ref:'same',restricted:false},{id:'b',person_ref:'same',restricted:false},{id:'c',person_ref:'other',restricted:false}];
  a.permissions=[{id:'read',active:true,requires_investiture:false}];a.scopes=[{id:'s',active:true,parent_id:null}];
  a.supports=[{id:'support',kind:'domain',active:true,expires_at:100}];
  a.grants=a.accounts.map(x=>({id:x.id,account_id:x.id,permission_id:'read',faculty:'exercise',scope_ref:'s',support_ref:'support',expires_at:100,withdrawn:false}));
  assert.equal(a.independentActors(['a','b'],'read','s'),false);assert.equal(a.independentActors(['a','c'],'read','s'),true);
  a.accounts[2].restricted=true;assert.equal(a.independentActors(['a','c'],'read','s'),false);
  assert.equal(independentPeople(['a',null]),false);assert.equal(independentPeople(['a']),false);
});
test('viewer profiles preserve opposite credential assertions without fallback',async()=>{
  for(const [profile,origin,expected] of [[undefined,'http://127.0.0.1:4321','omit'],[transport,transport.terminalOrigin,'include']]){
    let observed;const reader=new Reader(async(url,init)=>{observed={url,...init};return Response.json({contract:'reading/1',items:[],existence_signal:false},{headers:{'cache-control':'private, no-store'}});},origin,profile);
    await reader.reload();assert.equal(reader.snapshot().phase,'ready');assert.equal(observed.credentials,expected);
    assert.equal(observed.cache,'no-store');assert.equal(observed.redirect,'error');reader.pause();
  }
  assert.throws(()=>new Reader(undefined,transport.terminalOrigin));
  assert.throws(()=>new Reader(undefined,'http://127.0.0.1:4321',transport));
  assert.throws(()=>new Reader(undefined,transport.terminalOrigin,{...transport,profile:'reading/1'}));
});
test('only named reading bridges cross the access boundary',()=>{
  assert.deepEqual(accessSourceViolations('src/server/access/authenticated_reading.ts',"import x from '../reading/policy.ts'"),[]);
  assert.deepEqual(accessSourceViolations('src/components/reading/reader.ts',"import x from '../../contracts/access_transport.ts'"),[]);
  for(const [file,source] of [
    ['src/server/access/authenticated_reading.ts',"import x from '../reading/postgres/store.ts'"],
    ['src/server/access/authority_rules.ts',"import x from '../reading/policy.ts'"],
    ['src/components/reading/reader.ts',"import x from '../../server/access/service.ts'"],
    ['src/server/reading/policy.ts',"import x from '../access/invitation_authority.ts'"],
    ['src/components/access/AuthenticatedMaterial.tsx',"import x from '../../server/access/authenticated_reading.ts'"],
    ['src/app/(legacy)/portal/page.tsx',"import x from '@/server/access/authenticated_reading'"],
  ]) assert.ok(accessSourceViolations(file,source).length>0,file);
});
test('session reader credential mutation is caught independently of the old omission profile',async()=>{
  const url=new URL('../../src/components/reading/reader.ts',import.meta.url),source=readFileSync(url,'utf8');
  const from="{ ...sessionRequest('GET'), signal }";
  assert.equal(source.split(from).length-1,1);
  async function check(text){
    const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
      .replace(/from (['"])(\.[^'"]+)\1/g,(_,quote,specifier)=>`from ${quote}${new URL(specifier,url).href}${quote}`);
    const m=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
    let credentials;const r=new m.Reader(async(_url,init)=>{credentials=init.credentials;return Response.json({contract:'reading/1',items:[],existence_signal:false},{headers:{'cache-control':'no-store'}});},transport.terminalOrigin,transport);
    await r.reload();assert.equal(r.snapshot().phase,'ready');assert.equal(credentials,'include');r.pause();
  }
  await check(source);
  await assert.rejects(check(source.replace(from,"{ ...sessionRequest('GET'), credentials: 'omit', signal }")),{code:'ERR_ASSERTION'});
});
