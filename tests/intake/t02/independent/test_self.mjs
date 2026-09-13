import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCase as assertActualCase, OBSERVATION_PROFILE, supportedCases, supportedVariants, unsupportedVariants } from './index.mjs';
import { upgradeIllustration, illustrateBoundaries, eventR3 } from './illustrative_revision3.mjs';
import { canonicalReference } from './canonical.mjs';
import { registerRevision3Tests } from './test_revision3.mjs';
import { registerPreservedProbes } from './test_preserved_probes.mjs';
import { registerAddendumTests } from './test_addendum.mjs';
import { registerVariantTests } from './test_variants.mjs';
import { registerCorrectionR3 } from './test_correction_r3.mjs';
import { registerCorrectionR4 } from './test_correction_r4.mjs';
import { registerPhaseLineageTests } from './test_phase_lineage.mjs';
import { registerCorrectionR6 } from './test_correction_r6.mjs';

// All records below are illustrative module inputs, never service observations.
const root=process.env.T02_SELF_RUN_ROOT??fileURLToPath(new URL('./.self-evidence/',import.meta.url));
mkdirSync(root,{recursive:true});
const run=mkdtempSync(path.join(root,'illustrative-'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const clone=x=>structuredClone(x);
function assertCase(caseId,variant,o,locations) {
  if(o&&o.profile==='intake-observation/1'&&Object.getOwnPropertyDescriptor(o,'source')?.get===undefined)upgradeIllustration(o,locations);
  return assertActualCase(caseId,variant,o,locations);
}
const bom=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');
const bomHash='8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9';
const H='a'.repeat(64), J='b'.repeat(64), epoch=1800000000000;
const at=x=>epoch+x;
let serial=0;
function put(root,name,bytes) { const p=path.join(root,name);mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,bytes,{flag:'wx'});return p; }
function json(root,name,data) { return put(root,name,Buffer.from(JSON.stringify(data,null,2))); }
function counts(ops=1,receipts=0,jobs=0) {return {receptions:ops,receipts,jobs,extractions:0,candidates:0,publications:0};}
function operation(id='operation-1',principal='person-1',artifactId='original-1',generation=1) {return {id,principal,clientKey:'intention-1',variant:'load',canonicalProfile:'canon_m09_1',generation,revision:1,state:'pending',artifactId,originSessionId:'session-1'};}
function receipt() {return {id:'receipt-1',operationId:'operation-1',artifactId:'original-1',generation:1,bytes:17,sha256:bomHash,effectId:'receipt-effect-1',personId:'person-1'};}
function job() {return {id:'job-1',receiptId:'receipt-1',originalId:'original-1',generation:1,state:'pending',dispatchable:false};}
function snapshot(complete=false) {return {origin:'sql-observer',atMs:at(complete?50:0),database:'inc02_synthetic',schema:'intake_trial',operations:[operation()],receipts:complete?[receipt()]:[],jobs:complete?[job()]:[],counts:counts(1,complete?1:0,complete?1:0)};}
function event(kind,time=5,bytes=17,extra={}) {return {origin:'object-boundary',kind,artifactId:'original-1',generation:1,bytes,offset:0,evidenceId:kind==='open'||kind==='read'?'e-read':'e-capture',atMs:at(time),incarnation:'incarnation-1',...extra};}
function evidence(phase,id,time,extra={}) {return {origin:'sql-observer',id,phase,operationId:'operation-1',artifactId:'original-1',generation:1,principal:'person-1',status:200,atMs:at(time),backendPid:41,transactionOpen:false,...extra};}
function response(label='subject',status=200,body={result:'received'},time=16) {const bytes=Buffer.from(JSON.stringify(body));return {origin:'https-client',label,route:'/api/intake/receptions/operation-1',status,headers:{'content-type':'application/json','cache-control':'no-store'},body,bodyFile:null,bytes:bytes.length,sha256:sha(bytes),atMs:at(time)};}
function lost(label='subject') {return {...response(label,null,null),headers:{},body:null,bytes:0,sha256:null};}
function gate(action='read',gate='load',time=3) {return {origin:'current-control',label:`${action}-${gate}`,sourceId:'live-control',sourceSchema:'intake_control',revision:2,atMs:at(time),available:action!=='unavailable',gate,action,objectId:'original-1'};}
function barrier(label,time=13,release=14,writer=null) {return {origin:'test-controller',label,reachedAtMs:at(time),releasedAtMs:at(release),writerCommittedAtMs:writer===null?null:at(writer),clientBytesAtPause:0,backendPid:41,transactionOpen:false};}
function terminal(route='/api/intake/receptions/operation-1/original',time=15,bytes=17) {return {origin:'terminal-boundary',route,operationId:'operation-1',evidenceId:'e-delivery',kind:'handoff',bytes,atMs:at(time)};}
function retained(o) {o.before=snapshot(true);o.before.atMs=at(0);o.after=clone(o.before);o.after.atMs=at(50);}
function noEffect(o) {o.after=snapshot(false);o.after.atMs=at(50);o.storage=[];o.evidence=[];o.transport=[];}
function binary(o,locations,label='subject') {put(locations.evidenceRoot,`${label}.bin`,bom);return {...response(label),route:'/api/intake/receptions/operation-1/original',headers:{'content-type':'application/octet-stream','cache-control':'no-store'},body:null,bodyFile:`${label}.bin`,bytes:17,sha256:bomHash};}
function r2(o) {o.interfaceRevision=2;for(const s of[o.before,o.after])for(const r of s.receipts)r.executorRef='executor-1';for(const e of o.evidence)if(e.phase==='effect'){e.personRef=e.principal;e.executorRef='executor-1';}}
function base(caseId,variant) {
  const dir=path.join(run,`${++serial}-${caseId}-${variant}`),locations={fixtureRoot:path.join(dir,'fixtures'),evidenceRoot:path.join(dir,'capture')};
  mkdirSync(locations.fixtureRoot,{recursive:true});mkdirSync(locations.evidenceRoot);
  put(locations.fixtureRoot,'bom.txt',bom);
  const o={profile:'intake-observation/1',caseId,variant,runId:`illustrative-${serial}`,source:{base:'364ec1f458e396f36fcfe9b19e33da59c0e7728a',manifestSha256:H,imageId:`sha256:${J}`},input:{fixture:'bom.txt',artifactId:'original-1',generation:1,principal:'person-1',operationId:'operation-1'},before:snapshot(),after:snapshot(true),responses:[],storage:[event('capture',5),event('append',6),event('seal',7),event('open',8,0),event('read',9)],control:[],evidence:[evidence('capture_admission','e-capture',4),evidence('read_admission','e-read',7),evidence('effect','e-effect',10),evidence('delivery','e-delivery',12)],transport:[],barriers:[],temporal:null};
  o.responses=[binary(o,locations)];
  return {o,locations};
}
function requestReference(o,locations,variant) {
  r2(o);o.invocations=[];o.comparisons=[];
  const reference={executorRef:'executor-1',invocations:[]};
  const total=o.caseId==='IC05'?1:2;
  for(let i=0;i<total;i++) {
    const label=`call-${i}`,other=variant==='other-principal'&&i===1,changed=variant==='incompatible'&&i===1;
    const principal=other?'person-2':'person-1',op=other?'operation-2':'operation-1';
    const target={receptionId:changed?'reception-other':other?'operation-2':'operation-1',artifactId:changed?'original-other':other?'original-2':'original-1',generation:1,expectedRevision:1};
    const body={profile:'intake/1',expected_revision:1,original:{id:target.artifactId,generation:1,bytes:17,sha256:bomHash},format_profile:'text-utf8/1'};
    const wire=Buffer.from(JSON.stringify(body));
    const canonical=Buffer.from(JSON.stringify({profile:'canon_m09_1',contract:'intake/1',variant:'finalize_reception',path:{template:'/api/intake/receptions/:id/finalize',parameters:{id:target.receptionId}},query:{},body}));
    // This literal is deliberately independent of canonicalReference and its sorting implementation.
    const canonicalBytes=Buffer.from(`{"body":{"expected_revision":1,"format_profile":"text-utf8/1","original":{"bytes":17,"generation":1,"id":"${target.artifactId}","sha256":"${bomHash}"},"profile":"intake/1"},"contract":"intake/1","path":{"parameters":{"id":"${target.receptionId}"},"template":"/api/intake/receptions/:id/finalize"},"profile":"canon_m09_1","query":{},"variant":"finalize_reception"}`);
    put(locations.fixtureRoot,`requests/${label}-wire.json`,wire);put(locations.fixtureRoot,`requests/${label}-canonical.json`,canonical);
    const common={label,principal,clientKey:'intention-1',act:'CARGAR_MATERIAL',variant:'finalize_reception',target,canonicalProfile:'canon_m09_1',keyVersion:1};
    reference.invocations.push({...common,wireFile:`requests/${label}-wire.json`,canonicalFile:`requests/${label}-canonical.json`});
    o.invocations.push({origin:'https-client-and-sql-observer',...common,wireBodySha256:sha(wire),canonicalPayloadSha256:sha(canonicalBytes),operationId:op,storedPayloadDigest:H,responseLabel:label});
    o.comparisons.push({origin:'canonical-comparison-boundary',label,operationId:op,principal,act:common.act,variant:common.variant,clientKey:common.clientKey,canonicalProfile:common.canonicalProfile,keyVersion:1,comparedCanonicalSha256:sha(canonicalBytes),storedPayloadDigest:H,outcome:i===0?'new':changed?'incompatible':other?'new':'compatible',atMs:at(12+i)});
    o.responses.push(response(label,changed||variant==='invalid-linkage'?409:200,{receiptId:other?'receipt-2':'receipt-1'}));
  }
  if(variant==='other-principal') {
    o.after.operations.push(operation('operation-2','person-2','original-2'));
    o.after.receipts.push({...receipt(),id:'receipt-2',operationId:'operation-2',artifactId:'original-2',personId:'person-2',effectId:'receipt-effect-2',executorRef:'executor-1'});
    o.after.jobs.push({...job(),id:'job-2',receiptId:'receipt-2',originalId:'original-2'});o.after.counts=counts(2,2,2);
  }
  json(locations.fixtureRoot,`references/${o.caseId}/${o.variant}.json`,reference);
}
function preservation(namespace='access_trial') {return {origin:'independent-sql-observer',label:`kept-${namespace}`,namespace,objectRef:'existing-row',before:{bytes:17,sha256:H,rowCount:1},after:{bytes:17,sha256:H,rowCount:1}};}
function restoreReference(o,locations,variant) {
  retained(o);r2(o);o.preservedData=[preservation(),preservation('intake_control')];
  const member={name:'original.bin',bytes:17,sha256:bomHash};
  const good=Buffer.from('{"backup":"backup-1","member":"original.bin"}');
  const arriving=variant==='forged-manifest'?Buffer.from('{"backup":"forged","member":"original.bin"}'):good;
  put(locations.evidenceRoot,'restore/manifest.json',arriving);put(locations.evidenceRoot,'restore/original.bin',bom);
  const anchor={origin:'independent-sql-observer',sourceId:'live-control',namespace:'intake_control',relation:'backup_anchor',id:'backup-1',createdAtMs:at(2),manifestSha256:sha(good),members:[member]};
  o.restoration={origin:'restore-controller-and-sql-observer',backupId:'backup-1',cutAtMs:at(1),cutObservation:{namespace:'intake_trial',transactionSnapshot:'snapshot-1',receiptIds:['receipt-1']},restoredNamespaces:['intake_restore'],excludedNamespaces:['access_trial','intake_control'],archiveMembers:[member],archiveManifest:{file:'restore/manifest.json',bytes:arriving.length,sha256:sha(arriving)},retainedAnchor:anchor,retainedAnchorAfter:clone(anchor),currentSource:{origin:'independent-sql-observer',id:'live-control',namespace:'intake_control',available:variant!=='control-unavailable'},withdrawal:null,admission:{origin:'restore-controller',startedAtMs:at(5),finishedAtMs:at(6),status:variant==='control-unavailable'?'unavailable':variant==='forged-manifest'?'rejected':'admitted',sqlState:null},namespaceBefore:{origin:'independent-sql-observer',rows:[]},namespaceAfter:{origin:'independent-sql-observer',rows:variant==='restore'||variant==='post-backup-withdrawal'?[{schema:'intake_restore',incarnation:'restore-1'}]:[]}};
  json(locations.fixtureRoot,`references/IC12/${variant}.json`,{backupId:'backup-1',currentSourceId:'live-control',manifestSha256:sha(good),members:[member]});
  o.storage=variant==='restore'?[event('restore_write',7),event('open',8,0),event('read',9)]:[];
  if(variant!=='restore')o.responses=[response('subject',variant==='control-unavailable'?503:variant==='forged-manifest'?409:403,{error:'unavailable'})];
  if(variant==='control-unavailable')o.control=[gate('unavailable','current-source',5)];
  if(variant==='post-backup-withdrawal') {
    o.restoration.withdrawal={origin:'independent-sql-observer',permissionId:'permission-1',grantId:'grant-1',committedAtMs:at(3),revisionBefore:1,revisionAfter:2,withdrawnBefore:false,withdrawnAfter:true};o.control=[gate('withdraw','read',3)];
  }
}
function privileges(o,locations,variant) {
  r2(o);o.preservedData=[preservation()];o.privilegeProbes=[];o.roleInventory=[];
  const rows=[
    {label:'intake-read',role:'intake-reader',source:'intake_trial',target:'intake_trial',object:'original-1',allow:true},
    {label:'legacy-read',role:'legacy-reader',source:'legacy',target:'legacy',object:'legacy-1',allow:true},
    {label:'intake-denied-legacy',role:'intake-reader',source:'intake_trial',target:'legacy',object:'legacy-1',allow:false,positive:'intake-read'},
    {label:'legacy-denied-intake',role:'legacy-reader',source:'legacy',target:'intake_trial',object:'original-1',allow:false,positive:'legacy-read'},
  ];
  const refs=[];
  for(const row of rows) {
    const action=variant==='overwrite'&&!row.allow?'overwrite':'read';
    const ref={label:row.label,processRole:row.role,effectiveRole:row.role,sourceNamespace:row.source,targetNamespace:row.target,objectRef:row.object,action,permitted:row.allow,positiveLabel:row.positive??null};refs.push(ref);
    o.privilegeProbes.push({origin:'sql-client',label:row.label,processRole:row.role,effectiveRole:row.role,sourceNamespace:row.source,targetNamespace:row.target,objectRef:row.object,action,startedAtMs:at(1),finishedAtMs:at(2),status:row.allow?'succeeded':'denied',sqlState:row.allow?null:'42501',errno:null,observedRows:row.allow?1:0,observedBytes:0,beforeSha256:H,afterSha256:H,positiveLabel:row.positive??null});
  }
  for(const role of ['intake-reader','legacy-reader'])o.roleInventory.push({origin:'sql-observer',role,superuser:false,createDatabase:false,createRole:false,bypassRls:false,replication:false,memberships:[],grants:[{schema:role==='legacy-reader'?'legacy':'intake_trial',object:'source',privilege:'SELECT'}]});
  json(locations.fixtureRoot,`references/IC17/${variant}.json`,{probes:refs,preservedNamespaces:['access_trial']});
}
function profiles(o,locations,variant) {
  r2(o);
  if(variant==='safe-output') {
    const log=Buffer.from('Illustrative module fixture. No service was started.\n');put(locations.evidenceRoot,'logs/normal.log',log);
    o.diagnosticFiles=[{origin:'evidence-collector',path:'logs/normal.log',bytes:log.length,sha256:sha(log),kind:'stdout'}];
    json(locations.fixtureRoot,'references/IC18/safe-output.json',{diagnosticPaths:['logs/normal.log'],protectedMarkers:['SYNTHETIC_PRIVATE_NAME_72']});return;
  }
  o.profileControls=[true,false].map((revealable,i)=>({origin:'independent-sql-observer',observedAtMs:at(2),format:'text-utf8/1',configuration:`config-${i}`,scope:'scope-1',purpose:'purpose-1',revealable,receptionEnabled:true,processingImplemented:false}));
  const body={profiles:[{format:'text-utf8/1',configuration:'config-0',reception:true,processing:false}]};
  o.responses=[response('subject',200,body)];
  const requiredRoutes=[['GET','/profiles'],['POST','/receptions'],['POST','/receptions/operation-1/attempts/1/original'],['POST','/receptions/operation-1/finalize'],['POST','/operations/lookup'],['POST','/receptions/operation-1/resume'],['POST','/receptions/operation-1/cancel'],['GET','/receptions/operation-1'],['GET','/receptions/operation-1/original']].map(([method,p])=>({method,path:`/api/intake${p}`,implemented:true}));
  requiredRoutes.push({method:'POST',path:'/api/intake/process',implemented:false});
  o.routeInventory={origin:'actual-dispatch-probe',probes:requiredRoutes.map(x=>({method:x.method,path:x.path,status:x.implemented?200:404,bodySha256:H})),workerPorts:[]};
  json(locations.fixtureRoot,'references/IC18/profiles.json',{controlRows:o.profileControls,responseBody:body,requiredRoutes});
}
function temporal(o,locations,variant,kind='original',point='handoff',violate=true) {
  retained(o);o.storage=[];o.evidence=[];o.transport=[];
  const route=kind==='original'?'/api/intake/receptions/operation-1/original':kind==='profiles'?'/api/intake/profiles':'/api/intake/operations/operation-1';
  const p=kind==='original'?binary(o,locations,'positive'):response('positive',200,{result:'known'});
  p.route=route;p.atMs=at(5);
  const expired=response('expired',403,{error:'unavailable'},40);expired.route=route;
  const denied=variant==='already-expired'||variant==='writer-free-expiry'&&!violate;
  const s=denied?response('subject',403,{error:'unavailable'},26):kind==='original'?o.responses[0]:response('subject',200,{result:'known'},26);
  s.route=route;s.atMs=at(variant==='before-deadline'?16:26);
  o.responses=[p,expired,s];
  if(!denied){
    // These fixed positive/expiry-crossing examples prepare 200 before the
    // final clock at +10. The later handoff retains that exact preparation.
    o.evidence=[evidence('delivery','e-delivery',9,{status:200})];
    o.transport=[terminal(route,variant==='before-deadline'?15:25,s.bytes)];
  }
  o.temporal={origin:'test-controller',route,point,deadlineMs:at(20),lastEvaluationMs:at(variant==='already-expired'?21:10),resumedMs:at(variant==='before-deadline'?14:24),writerParticipated:false,observedEffects:0,observedBytes:denied?0:s.bytes,conformity:variant==='writer-free-expiry'&&violate?'violated':'satisfied_in_observation'};
  if(variant==='writer-free-expiry')o.barriers=[barrier('after_last_clock',11,24)];
  if(point==='receipt_commit') {
    o.before=snapshot();o.after=snapshot(!denied);o.after.atMs=at(50);o.transport=[];o.temporal.observedBytes=0;o.temporal.observedEffects=denied?0:1;
    if(!denied)o.evidence=[evidence('effect','effect-at-point',variant==='before-deadline'?15:25)];
  }
}
function specimen(caseId,variant) {
  const {o,locations}=base(caseId,variant);
  switch(caseId) {
    case 'IC01':break;
    case 'IC02':
      if(variant==='at-limit') {
        const data=Buffer.alloc(1048576,0x78);put(locations.fixtureRoot,'at-byte-limit.txt',data);put(locations.evidenceRoot,'limit.bin',data);o.input.fixture='at-byte-limit.txt';
        o.after.receipts[0].bytes=data.length;o.after.receipts[0].sha256=sha(data);o.responses[0].bodyFile='limit.bin';o.responses[0].bytes=data.length;o.responses[0].sha256=sha(data);o.storage.forEach(x=>{if(x.bytes>0)x.bytes=data.length;});
      } else {
        noEffect(o);o.responses=[response('subject',variant==='over-limit'?413:409,{error:'integrity'})];
        o.input.fixture=variant==='over-limit'?'over-byte-limit.txt':'baseline.xlsx';
        const input=variant==='over-limit'?Buffer.alloc(1048577,0x78):readFileSync(new URL('../../t01/fixtures/baseline.xlsx',import.meta.url));put(locations.fixtureRoot,o.input.fixture,input);
      } break;
    case 'IC03':if(variant!=='admitted'){noEffect(o);o.responses=[response('subject',403)];o.control=[gate('read',variant==='wrong-origin'?'origin':'load')];}break;
    case 'IC04':requestReference(o,locations,variant);break;
    case 'IC05':if(variant==='invalid-linkage'){noEffect(o);o.responses=[response('subject',409)];}requestReference(o,locations,variant);break;
    case 'IC06':noEffect(o);o.storage=[event('capture',5,10),event('append',6,10)];o.responses=[lost()];o.barriers=[barrier('between_chunks')];break;
    case 'IC07':noEffect(o);o.storage=[event('seal',7)];o.responses=[lost()];o.barriers=[barrier('before_receipt_commit')];break;
    case 'IC08':
      o.storage=[];
      if(variant==='lost-response'){o.responses=[lost(),response('lookup')];o.barriers=[barrier('after_receipt_commit')];}
      else {retained(o);o.responses=[response('subject',variant==='query-denied'?403:variant==='uncertain'?503:200)];if(variant==='query-without-load')o.control=[gate('withdraw','load'),gate('read','query')];if(variant==='uncertain')o.control=[gate('unavailable','query')];}break;
    case 'IC09':retained(o);o.input.generation=2;for(const s of[o.before,o.after]){s.operations[0].generation=2;s.receipts[0].generation=2;s.jobs[0].generation=2;}o.storage=[event('failed_write',7,0,{generation:1})];o.responses=[response('subject',409)];break;
    case 'IC10':
      if(variant==='cancel-first'){noEffect(o);o.responses=[response('subject',409),response('cancel')];}
      else {retained(o);o.responses=[response(),response('cancel')];}break;
    case 'IC11':retained(o);if(variant!=='intact'){o.storage=variant==='missing'?[event('failed_open',7,0)]:[];o.responses=[response('subject',variant==='missing'?404:200)];}break;
    case 'IC12':restoreReference(o,locations,variant);break;
    case 'IC13':noEffect(o);o.responses=[response('subject',403)];o.control=[gate('withdraw','load',14)];o.barriers=[barrier(variant==='before-capture'?'before_capture':variant==='between-chunks'?'between_chunks':'before_original_read',13,15,14)];if(variant==='between-chunks')o.storage=[event('append',5,10)];break;
    case 'IC14':
      if(variant!=='whole'){retained(o);o.storage=[];o.responses=[response('subject',variant==='fragment-only'?404:200)];if(variant==='fragment-only')o.responses.push(response('fragment',200,{text:'permitted fragment'}));if(variant==='hidden-absent')o.responses=[response('hidden',404,{error:'unavailable'}),response('absent',404,{error:'unavailable'}),response('positive')];}break;
    case 'IC15':
      retained(o);o.barriers=[barrier('before_handoff')];o.transport=[terminal()];
      if(variant==='evidence-failure'){o.storage=[];o.transport=[];o.responses=[response('subject',503)];o.barriers=[barrier('before_original_read')];}
      else if(variant==='writer-first'){o.transport=[];o.responses=[response('subject',403)];o.control=[gate('withdraw','read',14)];o.barriers=[barrier('before_handoff',13,15,14)];}
      else if(variant==='handoff-first')o.control=[gate('withdraw','read',17)];break;
    case 'IC16':temporal(o,locations,variant);break;
    case 'IC17':privileges(o,locations,variant);break;
    case 'IC18':
      if(variant==='siblings'){retained(o);o.input.operationId='pending-2';o.input.artifactId='pending-original';for(const s of[o.before,o.after]){s.operations.push(operation('pending-2','person-1','pending-original'));s.counts.receptions=2;}o.responses=[lost(),response('positive')];o.barriers=[barrier('between_chunks')];o.storage=[];}
      else profiles(o,locations,variant);break;
  }
  upgradeIllustration(o,locations);
  return {o,locations};
}

const mutations={
  IC01:[x=>{x.o.after.receipts[0].sha256=J;x.o.after.attempts[0].actualSha256=J;},'effects.exact-receipt-identity'],
  IC02:[x=>{x.o.responses[0].status=x.o.variant==='at-limit'?403:200;},'outcome'],
  IC03:[x=>{if(x.o.variant==='admitted')x.o.evidence=x.o.evidence.filter(e=>e.id!=='e-capture');else x.o.storage.push(event('capture'));},'admitted'],
  IC04:[x=>{x.o.comparisons[0].comparedCanonicalSha256=J;},'actual-canonical-comparison'],
  IC05:[x=>{if(x.o.variant==='receipt')x.o.after.receipts[0].executorRef='wrong-executor';else x.o.responses[0].status=200;},'identity'],
  IC06:[x=>{x.o.storage[1].bytes=11;},'partial.exact-prefix-length'],
  IC07:[x=>{x.o.storage=[];},'orphan.actual-complete-seal'],
  IC08:[x=>{x.o.storage.push(event('read'));},'access'],
  IC09:[x=>{x.o.storage.push(event('append',8,17,{generation:1}));},'generation.no-stale-write'],
  IC10:[x=>{x.o.responses.find(r=>r.label==='cancel').status=403;},'cancel.actual-stop-response'],
  IC11:[x=>{if(x.o.variant==='intact')x.o.responses[0].status=403;else x.o.storage.push(event('read'));},'original'],
  IC12:[x=>{x.o.restoration.retainedAnchorAfter.manifestSha256=J;},'restoration.anchor-not-replaced'],
  IC13:[x=>{x.o.storage.push(event('capture',16));},'denial.outcome-and-effects-and-access'],
  IC14:[x=>{if(x.o.variant==='whole')x.o.responses[0].status=403;else if(x.o.variant==='hidden-absent')x.o.responses[0].headers.etag='hidden';else x.o.storage.push(event('read'));},'view'],
  IC15:[x=>{if(x.o.variant==='evidence-failure')x.o.storage.push(event('read'));else x.o.barriers[0].transactionOpen=true;},'handoff'],
  IC16:[x=>{x.o.temporal.conformity=x.o.temporal.conformity==='violated'?'satisfied_in_observation':'violated';},'temporal.truthful-classification'],
  IC17:[x=>{x.o.privilegeProbes[2].status='succeeded';x.o.privilegeProbes[2].observedRows=1;},'privileges.denial-and-no-effect'],
  IC18:[x=>{if(x.o.variant==='profiles')x.o.responses[0].body.profiles=[];else if(x.o.variant==='safe-output')x.o.diagnosticFiles=[];else x.o.responses[0]=response();},'profiles'],
};
function targetRule(caseId,variant) {
  const specific={
    IC02:{'at-limit':'receipt.outcome-and-effects','over-limit':'denial.outcome-and-effects-and-access'},
    IC03:{admitted:'access.prior-evidence-required','denied-capture':'denial.outcome-and-effects-and-access','wrong-origin':'denial.outcome-and-effects-and-access'},
    IC05:{receipt:'executor.persisted-identity-and-lineage','invalid-linkage':'denial.outcome-and-effects-and-access'},
    IC08:{'lost-response':'lookup.zero-original-access','query-without-load':'lookup.zero-original-access','query-denied':'denial.outcome-and-effects-and-access',uncertain:'denial.outcome-and-effects-and-access'},
    IC11:{intact:'original.exact-bytes-and-outcome',missing:'availability.no-substitute-body','query-only':'availability.record-does-not-open-original'},
    IC14:{whole:'original.exact-bytes-and-outcome','record-only':'view.record-zero-body-access','fragment-only':'denial.outcome-and-effects-and-access','hidden-absent':'view.hidden-absent-full-tuple'},
    IC15:{'prior-evidence':'handoff.client-empty-sql-idle','evidence-failure':'denial.outcome-and-effects-and-access','writer-first':'handoff.writer-first-empty-idle','handoff-first':'handoff.client-empty-sql-idle'},
    IC18:{profiles:'profiles.exact-independent-projection',siblings:'siblings.separate-visible-outcomes','safe-output':'diagnostics.nonempty-evidence'},
  };
  return specific[caseId]?.[variant]??mutations[caseId][1];
}

test('Public exports and unsupported variants are explicit',()=>{
  assert.equal(OBSERVATION_PROFILE,'intake-observation/1');assert.equal(supportedCases.length,18);
  assert.ok(Object.isFrozen(supportedVariants));
  for(const key of Object.keys(unsupportedVariants)){const [id,v]=key.split('/');assert.throws(()=>assertCase(id,v,{},{}),/coverage.unsupported-case-or-variant/);}
  assert.throws(()=>assertCase('IC99','missing',{},{}),/coverage.unsupported/);
  assert.throws(()=>assertCase(Symbol('invalid'),'round-trip',{},{}),assert.AssertionError);
});

for(const [caseId,variants] of Object.entries(supportedVariants)) for(const variant of variants) {
  if(['framing','digest-mismatch','resumed','corrupt','restart'].includes(variant))continue;
  test(`${caseId}/${variant}: accepts illustrative evidence and rejects a defended observation change`,()=>{
    const x=specimen(caseId,variant),result=assertCase(caseId,variant,x.o,x.locations);
    assert.ok(Number.isSafeInteger(result.assertions)&&result.assertions>0);
    json(x.locations.evidenceRoot,'illustrative-observation.json',x.o);json(x.locations.evidenceRoot,'assertion-result.json',result);
    const bad={o:clone(x.o),locations:x.locations};mutations[caseId][0](bad);
    for(const list of [bad.o.storage,bad.o.evidence,bad.o.transport])for(const e of list)if(!Object.hasOwn(e,'callId'))Object.assign(e,eventR3(e,bad.o.input.subject.receptionId,bad.o.input.subject.callId));
    const rule=targetRule(caseId,variant);let caught;
    assert.throws(()=>assertCase(caseId,variant,bad.o,bad.locations),error=>{caught=error;return error instanceof assert.AssertionError&&error.message.includes(rule);});
    json(x.locations.evidenceRoot,'illustrative-negative.json',bad.o);
    json(x.locations.evidenceRoot,'negative-result.json',{expectedRule:rule,observedRule:caught.message,errorName:caught.name});
  });
}

test('Missing fields, false zeros and wrong types never count as evidence',()=>{
  for(const change of [o=>delete o.after.counts.jobs,o=>o.after.counts.jobs='1',o=>o.after.jobs=[],o=>o.input.generation=0,o=>o.evidence[0].origin='service-claim']) {
    const x=specimen('IC01','round-trip');change(x.o);assert.throws(()=>assertCase('IC01','round-trip',x.o,x.locations),assert.AssertionError);
  }
});
test('Captured bytes, not two declared hashes, are compared to the fixed original',()=>{
  const x=specimen('IC01','round-trip');const bad=Buffer.from(bom);bad[bad.length-1]^=1;put(x.locations.evidenceRoot,'changed.bin',bad);
  x.o.responses[0].bodyFile='changed.bin';x.o.responses[0].sha256=sha(bad);
  assert.throws(()=>assertCase('IC01','round-trip',x.o,x.locations),/original.exact-bytes-and-outcome/);
});
test('A changed original cannot redefine its own independent reference',()=>{
  const x=specimen('IC01','round-trip');writeFileSync(path.join(x.locations.fixtureRoot,'bom.txt'),Buffer.from('other-original'));
  assert.throws(()=>assertCase('IC01','round-trip',x.o,x.locations),/fixed-original.independent-reference/);
});
test('Paths, file absence, aliases and executable observation properties fail closed',()=>{
  for(const name of ['../outside','C:/outside','/outside','dir/../subject.bin','subject.bin:stream','\\\\server\\share','missing.bin']) {
    const x=specimen('IC01','round-trip');x.o.responses[0].bodyFile=name;assert.throws(()=>assertCase('IC01','round-trip',x.o,x.locations),assert.AssertionError);
  }
  const x=specimen('IC01','round-trip');const alias=path.join(path.dirname(x.locations.evidenceRoot),'capture-alias');
  symlinkSync(x.locations.fixtureRoot,alias,'junction');x.locations.evidenceRoot=alias;
  assert.throws(()=>assertCase('IC01','round-trip',x.o,x.locations),/locations.disjoint-roots/);
  const y=specimen('IC01','round-trip');Object.defineProperty(y.o,'source',{enumerable:true,get(){throw new Error('Getter must never run');}});
  assert.throws(()=>assertCase('IC01','round-trip',y.o,y.locations),/json.data-property/);
});
test('Current controls cannot be restored, withdrawn too early or silently unavailable',()=>{
  for(const [variant,mutate,rule] of [
    ['restore',o=>o.restoration.restoredNamespaces.push('intake_control'),'current-source-not-restored'],
    ['post-backup-withdrawal',o=>o.restoration.withdrawal.committedAtMs=at(0),'withdrawal-after-backup'],
    ['control-unavailable',o=>o.control=[],'control.unavailable'],
    ['forged-manifest',o=>o.restoration.admission.status='admitted','forgery-against-separate-anchor'],
  ]){const x=specimen('IC12',variant);mutate(x.o);assert.throws(()=>assertCase('IC12',variant,x.o,x.locations),new RegExp(rule));}
});
test('An ordinary captured log containing a canary fails even with a correct new hash',()=>{
  const x=specimen('IC18','safe-output'),bytes=Buffer.from('T02_PRIVATE_PAYLOAD_CANARY_7c18');writeFileSync(path.join(x.locations.evidenceRoot,'logs/normal.log'),bytes);
  x.o.diagnosticFiles[0]={...x.o.diagnosticFiles[0],bytes:bytes.length,sha256:sha(bytes)};
  assert.throws(()=>assertCase('IC18','safe-output',x.o,x.locations),/diagnostics.no-protected-markers/);
});
test('A newly captured normal log cannot be omitted from the diagnostic inventory',()=>{
  const x=specimen('IC18','safe-output');put(x.locations.evidenceRoot,'logs/unlisted.log',Buffer.from('T02_PRIVATE_PAYLOAD_CANARY_7c18'));
  assert.throws(()=>assertCase('IC18','safe-output',x.o,x.locations),/diagnostics.complete-captured-log-directory/);
});
test('Temporal JSON/original/receipt measurements preserve violation versus conformity',()=>{
  for(const kind of ['original','query','profiles'])for(const variant of ['before-deadline','already-expired','writer-free-expiry']) {
    const x=base('IC16',variant);temporal(x.o,x.locations,variant,kind);const result=assertCase('IC16',variant,x.o,x.locations);
    assert.equal(result.temporalViolation,variant==='writer-free-expiry');
  }
  for(const variant of ['before-deadline','already-expired','writer-free-expiry']){
    const x=base('IC16',variant);temporal(x.o,x.locations,variant,'query','receipt_commit');assertCase('IC16',variant,x.o,x.locations);
  }
  const x=base('IC16','writer-free-expiry');temporal(x.o,x.locations,'writer-free-expiry','query','handoff',false);
  assert.equal(assertCase('IC16','writer-free-expiry',x.o,x.locations).temporalViolation,false);
  x.o.responses=x.o.responses.filter(r=>r.label!=='expired');assert.throws(()=>assertCase('IC16','writer-free-expiry',x.o,x.locations),/request-boundaries.complete-responses/);
});
test('Observed counts, origin labels and not_measurable cannot manufacture temporal success',()=>{
  for(const [change,rule] of [
    [o=>o.temporal.observedBytes=0,'counters-corroborated'],
    [o=>o.temporal.conformity='not_measurable','measurement-evidence-not-optional'],
    [o=>o.responses.find(r=>r.label==='positive').status=403,'valid-positive-and-expired-controls'],
    [o=>o.transport[0].kind='observation_failed','no-unknown-transfer-outcome'],
  ]){const x=specimen('IC16','writer-free-expiry');change(x.o);assert.throws(()=>assertCase('IC16','writer-free-expiry',x.o,x.locations),new RegExp(rule));}
});
test('Independent canonical references preserve scalar strings, null and code-point key order',()=>{
  const input=Buffer.from('{"𐀀":0,"":1,"a":"Café","missing":null}');
  assert.equal(canonicalReference(input).toString(),'{"a":"Café","missing":null,"":1,"𐀀":0}');
  for(const raw of ['{"x":1,"x":2}','{"x":1.0}','{"x":1e2}','{"x":"\\ud800"}','{"x":9007199254740992}'])assert.throws(()=>canonicalReference(Buffer.from(raw)),assert.AssertionError);
  assert.throws(()=>canonicalReference(Buffer.from([0x22,0xc0,0xaf,0x22])),/canonical.reference-utf8/);
  assert.notEqual(canonicalReference(Buffer.from('{"x":null}')).toString(),canonicalReference(Buffer.from('{}')).toString());
});
test('A coherent replacement of both reported anchors still conflicts with the independent reference',()=>{
  const x=specimen('IC12','forged-manifest');
  x.o.restoration.retainedAnchor.manifestSha256=x.o.restoration.archiveManifest.sha256;
  x.o.restoration.retainedAnchorAfter=clone(x.o.restoration.retainedAnchor);
  assert.throws(()=>assertCase('IC12','forged-manifest',x.o,x.locations),/restoration.independent-retained-reference/);
});
test('A duplicate durable receipt and job fail with internally consistent row counts',()=>{
  const x=specimen('IC01','round-trip');
  assertCase('IC01','round-trip',x.o,x.locations);
  x.o.after.receipts.push({...x.o.after.receipts[0],id:'receipt-duplicate',effectId:'receipt-effect-duplicate'});
  x.o.after.jobs.push({...job(),id:'job-duplicate',receiptId:'receipt-duplicate'});
  x.o.after.counts.receipts=2;x.o.after.counts.jobs=2;
  assert.throws(()=>assertCase('IC01','round-trip',x.o,x.locations),/after.receipts.unique-receptionId/);
});
test('Re-labelling a forbidden read as an unrelated artifact cannot hide it from the access vector',()=>{
  const x=specimen('IC08','query-denied');x.o.storage.push(eventR3(event('read',7,17,{artifactId:'unrelated-secret'})));
  assert.throws(()=>assertCase('IC08','query-denied',x.o,x.locations),/denial.outcome-and-effects-and-access/);
});
test('JSON handoff has its own ordering evidence and cannot inherit the original response record',()=>{
  for(const variant of ['prior-evidence','handoff-first']) {
    const x=specimen('IC15',variant);x.o.storage=[];const r=response();x.o.responses=[r];x.o.transport=[eventR3(terminal(r.route,15,r.bytes))];
    illustrateBoundaries(x.o,x.locations);
    assertCase('IC15',variant,x.o,x.locations);
    x.o.transport[0].evidenceId='not-the-observed-delivery';
    assert.throws(()=>assertCase('IC15',variant,x.o,x.locations),/handoff.durable-evidence-required/);
  }
});
test('Evidence queried after a body access cannot substitute for prior access evidence',()=>{
  const x=specimen('IC15','prior-evidence');x.o.evidence.find(e=>e.id==='e-read').atMs=at(11);
  assert.throws(()=>assertCase('IC15','prior-evidence',x.o,x.locations),/access.evidence-before-access/);
});
test('An OS identity probe distinguishes a permission denial from a missing-path error',()=>{
  const x=specimen('IC17','isolation');
  const refPath=path.join(x.locations.fixtureRoot,'references/IC17/isolation.json');const refs=JSON.parse(readFileSync(refPath));
  for(let i=0;i<x.o.privilegeProbes.length;i++){
    const p=x.o.privilegeProbes[i];p.origin='os-process';p.effectiveRole={uid:i%2?1002:1001,gid:1001,groups:[1001]};
    p.sqlState=null;p.errno=p.status==='denied'?'EACCES':null;p.observedBytes=p.observedRows?17:0;p.observedRows=0;
    refs.probes[i].effectiveRole=clone(p.effectiveRole);
  }
  writeFileSync(refPath,JSON.stringify(refs));assertCase('IC17','isolation',x.o,x.locations);
  x.o.privilegeProbes[2].errno='ENOENT';assert.throws(()=>assertCase('IC17','isolation',x.o,x.locations),/privileges.denial-and-no-effect/);
});
test('The assertion count changes with actual additional evidence checks',()=>{
  const x=specimen('IC01','round-trip');const first=assertCase('IC01','round-trip',x.o,x.locations);
  x.o.evidence.push(eventR3(evidence('query','extra-legitimate-query',11)));const second=assertCase('IC01','round-trip',x.o,x.locations);
  assert.ok(second.assertions>first.assertions);
});
test('Canonical target changes cannot be excused by a matching wire payload hash',()=>{
  const x=specimen('IC04','incompatible');x.o.comparisons[1].comparedCanonicalSha256=x.o.invocations[0].canonicalPayloadSha256;
  assert.throws(()=>assertCase('IC04','incompatible',x.o,x.locations),/invocations.actual-canonical-comparison/);
});
test('Missing extended evidence cannot fall back to an earlier observation revision',()=>{
  for(const [caseId,variant,field]of [['IC04','compatible','comparisons'],['IC05','receipt','invocations'],['IC12','restore','restoration'],['IC17','isolation','privilegeProbes'],['IC18','safe-output','diagnosticFiles']]){
    const x=specimen(caseId,variant);delete x.o[field];assert.throws(()=>assertCase(caseId,variant,x.o,x.locations),assert.AssertionError);
  }
});
test('Every preserved positive format compares its real source bytes without extracting or normalizing',()=>{
  for(const name of ['text.txt','bom.txt','inert.md','table.csv','bom.csv','unicode-records.csv','short.txt','baseline.xlsx','cache-discrepant.xlsx','cache-missing.xlsx','cache-zero.xlsx']){
    const x=base('IC01','round-trip'),bytes=readFileSync(new URL(`../../t01/fixtures/${name}`,import.meta.url));
    if(name!=='bom.txt')put(x.locations.fixtureRoot,name,bytes);put(x.locations.evidenceRoot,'format.bin',bytes);
    x.o.input.fixture=name;x.o.after.receipts[0].bytes=bytes.length;x.o.after.receipts[0].sha256=sha(bytes);
    x.o.responses[0].bodyFile='format.bin';x.o.responses[0].bytes=bytes.length;x.o.responses[0].sha256=sha(bytes);
    for(const e of x.o.storage)if(e.bytes>0)e.bytes=bytes.length;
    const result=assertCase('IC01','round-trip',x.o,x.locations);json(x.locations.evidenceRoot,'format-result.json',{fixture:name,...result});
  }
});

registerRevision3Tests({specimen,json,event:(o,kind,extra={})=>eventR3(event(kind,7,17,extra),o.input.subject.receptionId,o.input.subject.callId)});
registerPreservedProbes(root);
registerAddendumTests({specimen,json,event:(o,kind,extra={})=>eventR3(event(kind,7,17,extra),o.input.subject.receptionId,o.input.subject.callId)});
registerVariantTests({specimen,json,put,response,lost,event,evidence,terminal,binary,retained,noEffect,epoch});
registerCorrectionR3(root);
registerCorrectionR4(root,{specimen,json});
registerPhaseLineageTests(root);
registerCorrectionR6(root);
