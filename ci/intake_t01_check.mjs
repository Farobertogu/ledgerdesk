import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {collectProcessOutput} from '../tests/intake/t01/reviewed/process-output.mjs';
import {summarizeNodeTests} from './intake_test_summary.mjs';
import {observeL03} from './intake_l03_observer.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const group=arg('--group');
if(!['contracts','storage','recovery','isolation','limits','lifecycle','lifecycle-child'].includes(group))throw Error('Select an explicit experiment group');
const runId=process.argv.includes('--run-id')?arg('--run-id'):new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,90}$/.test(runId))throw Error('Unsafe run id');
const prefix='ld-i03-t01-'+randomUUID().slice(0,8);
const output=path.join(root,'test-results/intake-t01',runId);
const sourceRoot=path.join(output,'source');
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.mkdir(output,{recursive:false});
const lockPath=path.join(path.dirname(output),'.active-run');
const phase=group==='lifecycle-child'?arg('--phase'):undefined;
const phases=['normal','before-initialization','after-resource-creation','after-input-staging','during-export','during-assertion','assertion-export'];
let parentDirectory,nestedClaim;
if(group==='lifecycle-child'){
 const parentRun=arg('--parent-run'),nonce=arg('--lease');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,90}$/.test(parentRun)||!/^[-a-f0-9]{36}$/.test(nonce)||!phases.includes(phase))throw Error('Invalid lifecycle lease');
 parentDirectory=path.join(path.dirname(output),parentRun);
 const lease=JSON.parse(await fs.readFile(path.join(parentDirectory,'lease-'+nonce+'.json'),'utf8'));
 if(lease.runId!==runId||lease.phase!==phase||lease.nonce!==nonce||await fs.readFile(lockPath,'utf8')!==lease.owner)throw Error('Inactive lifecycle parent');
 nestedClaim=path.join(parentDirectory,'nested-active');
 await fs.writeFile(nestedClaim,prefix,{flag:'wx'});
}else await fs.writeFile(lockPath,prefix,{flag:'wx'});
let bytesWritten=0,cleanupMode=false;const loggingFailures=[];
async function save(name,value){const data=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';const size=Buffer.byteLength(data);if(bytesWritten+size>(cleanupMode?2147483648:2143289344))throw Error('EVIDENCE_LIMIT');await fs.writeFile(path.join(output,name),data,{flag:'wx'});bytesWritten+=size;}
const hash=b=>createHash('sha256').update(b).digest('hex');
const redact=value=>value.replaceAll(root,'[repository]/').replaceAll(root.replaceAll('\\','/'),'[repository]/')
 .replace(/synthetic-(admin|runtime|observer)/g,'[synthetic-credential]');
let seq=0;const cases=[],owned=[],commands=[],phaseMarks=[],reconciledResources=[];
let budgetEnd=Date.now()+20*60*1000;
async function exec(bin,args,{timeout=60000,limit=8388608,diagnostic=65536,input}={}){
 if(Date.now()>budgetEnd)throw Error('GROUP_DEADLINE');
 if(loggingFailures.length&&!cleanupMode)throw Error('EVIDENCE_INCOMPLETE');
 const started=Date.now();
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd:root,windowsHide:true,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
  if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
  const collector=collectProcessOutput(child.stdout,child.stderr,{outputBytes:limit,diagnosticBytes:diagnostic,stop:()=>child.kill()});
  const timer=setTimeout(()=>collector.terminate('worker_timeout'),timeout);
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,...collector.finish(),milliseconds:Date.now()-started});});
 });
 const safe=args.map(a=>/PASSWORD=/.test(a)?a.split('=')[0]+'=[redacted]':a);
 const name=String(++seq).padStart(4,'0')+'.json';
 try{await save(name,{executable:path.basename(bin),args:safe.map(redact),...result,stdout:redact(result.stdout),stderr:redact(result.stderr)});}
 catch(e){loggingFailures.push({file:name,error:e.message});}
 commands.push({file:name,code:result.code,reason:result.reason});
 return {...result,commandRecord:name};
}
const docker=(args,options)=>exec('docker',args,options);
const json=r=>{assert.equal(r.code,0,r.stderr||r.stdout);assert.equal(r.reason,undefined);return JSON.parse(r.stdout);};
async function required(args,options){const r=await docker(args,options);assert.equal(r.code,0,r.stderr||r.stdout);assert.equal(r.reason,undefined);return r.stdout.trim();}
async function check(id,description,fn){const start=Date.now();try{const observed=await fn();cases.push({id,description,status:'passed',milliseconds:Date.now()-start,observed});console.log('PASS '+id);}catch(e){cases.push({id,description,status:'failed',milliseconds:Date.now()-start,error:redact(e.message),errorCode:e.code,actual:e.actual,expected:e.expected});console.log('FAIL '+id+' '+redact(e.message).slice(0,180));}}
async function ownedResource(type,name,args){
 assert.ok(name.startsWith(prefix+'-'));const id=await required([type,'create','--label','intake.run='+prefix,...args,name]);
 owned.push({type,name,id});return name;
}
async function container(name,args){
 assert.ok(name.startsWith(prefix+'-'));
 const id=await required(['create','--name',name,'--label','intake.run='+prefix,...args]);
 owned.push({type:'container',name,id});return name;
}
async function remove(resource,expectedOwner=prefix){
 const inspected=json(await docker([resource.type,'inspect',resource.name]))[0];
 const label=['container','image'].includes(resource.type)?inspected.Config.Labels?.['intake.run']:inspected.Labels?.['intake.run'];
 assert.equal(label,expectedOwner,'Cleanup ownership mismatch');
 assert.equal(inspected.Id??inspected.Name,resource.type==='volume'?resource.name:resource.id);
 await required([resource.type,'rm',...(resource.type==='container'?['-f']:[]),resource.name]);resource.removed=true;
}
async function reconcileOwned(){
 for(const type of ['container','volume','network','image']){
  const args=[type,'ls',...(type==='container'?['-a']:[]),...(type==='volume'?[]:['--no-trunc']),'--filter','label=intake.run='+prefix,'--format',type==='volume'?'{{.Name}}':'{{.ID}}'];
  const identifiers=[...new Set((await required(args)).split('\n').map(s=>s.trim()).filter(Boolean))];
  for(const identifier of identifiers){
   const inspected=json(await docker([type,'inspect',identifier]))[0];
   const labels=['container','image'].includes(type)?inspected.Config.Labels:inspected.Labels;
   assert.equal(labels?.['intake.run'],prefix,'Actual resource has another owner');
   const id=inspected.Id??inspected.Name;
   if(owned.some(r=>r.type===type&&r.id===id))continue;
   const name=type==='container'?inspected.Name.replace(/^\//,''):type==='image'?inspected.RepoTags?.find(t=>t.startsWith('ledgerdesk-intake-t01:'+prefix+'-')):inspected.Name;
   assert.ok(name&&(type==='image'?name.startsWith('ledgerdesk-intake-t01:'+prefix+'-'):name.startsWith(prefix+'-')),'Unregistered resource is outside this run namespace');
   const resource={type,id,name,recoveredByLabelAndIdentity:true};owned.push(resource);reconciledResources.push({...resource});
  }
 }
}
async function markPhase(point,observation={}){
 const entry={point,...observation,pid:process.pid,node:process.version};phaseMarks.push(entry);
 await save('phase-'+phaseMarks.length+'.json',entry);
}
async function exportFault(){
 await markPhase('during-export',{previousAssertionPassed:cases.some(c=>c.status==='passed')});
 const name='controlled-export.json';await fs.mkdir(path.join(output,name));
 try{await save(name,{evidence:'must reach the actual export write'});throw Error('EXPORT_FAULT_NOT_REACHED');}
 catch(e){loggingFailures.push({file:name,error:redact(e.message),code:e.code,phase:'during-export'});throw e;}
}
async function lifecycleChild(){
 const inject=point=>{if(phase===point){const e=Error('Injected lifecycle fault at '+point);e.code='INJECTED_PHASE';throw e;}};
 await check('LC','Real lifecycle phase '+phase,async()=>{
  await markPhase('before-initialization',{owned:owned.length});inject('before-initialization');
  const lease=JSON.parse(await fs.readFile(path.join(parentDirectory,'lease-'+arg('--lease')+'.json'),'utf8'));
  const image=json(await docker(['image','inspect',lease.controlImage]))[0];
  assert.equal(image.Id,lease.controlImage);assert.equal(image.Config.Labels?.['intake.run'],lease.owner);controlImage=image.Id;
  const name=prefix+'-unregistered-volume';
  const id=await required(['volume','create','--label','intake.run='+prefix,name]);
  // Reach the actual creation boundary before insertion into the in-memory list.
  await markPhase('after-resource-creation',{type:'volume',name,id,registered:false});inject('after-resource-creation');
  owned.push({type:'volume',name,id});
  const child=await container(prefix+'-stage',['--network','none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=256m','--memory-swap=256m','--cpus=1','--pids-limit=64','--tmpfs=/tmp:rw,size=8388608,mode=1777',controlImage]);
  await required(['start',child]);
  const reference=Buffer.from('Synthetic staged input — exact\r\n');
  const staged=JSON.parse(await required(['exec',child,'node','-e',"const f=require('fs');const b=Buffer.from('"+reference.toString('base64')+"','base64');f.writeFileSync('/tmp/input',b,{flag:'wx'});console.log(JSON.stringify({pid:process.pid,node:process.version,base64:f.readFileSync('/tmp/input').toString('base64')}))"]));
  assert.equal(staged.base64,reference.toString('base64'));assert.equal(staged.node,'v22.16.0');
  await markPhase('after-input-staging',{container:child,staged,sha256:hash(reference)});inject('after-input-staging');
  await markPhase('during-assertion',{assertion:'LC expected staged length'});
  assert.equal(reference.length,phase==='during-assertion'||phase==='assertion-export'?reference.length+1:reference.length,'Injected LC assertion after real staging');
  return{staged:true,referenceSha256:hash(reference)};
 });
 if(phase==='during-export')await check('LC-EXPORT','Actual export write fails after a successful assertion',exportFault);
 if(phase==='assertion-export')try{await exportFault();}catch{/* Preserve the assertion as primary and the export error separately. */}
}
async function observeLifecycle(){
 const observations=[];
 for(const selected of phases){
  const nonce=randomUUID(),childRun=runId+'-'+selected;
  assert.ok(childRun.length<=91);await save('lease-'+nonce+'.json',{owner:prefix,runId:childRun,phase:selected,nonce,controlImage});
  assert.equal(await fs.readFile(lockPath,'utf8'),prefix);
  const started=Date.now();
  const r=await exec(process.execPath,['ci/intake_t01_check.mjs','--group','lifecycle-child','--run-id',childRun,'--phase',selected,'--parent-run',runId,'--lease',nonce],{timeout:60000});
  const childDirectory=path.join(path.dirname(output),childRun);
  const resultBytes=await fs.readFile(path.join(childDirectory,'results.json'));const result=JSON.parse(resultBytes);
  const baseline=JSON.parse(await fs.readFile(path.join(childDirectory,'baseline.json'),'utf8'));
  assert.equal(await fs.readFile(lockPath,'utf8'),prefix,'Child must not release its parent global lock');
  assert.equal(await fs.stat(path.join(output,'nested-active')).then(()=>true,()=>false),false);
  const actual=[];
  for(const type of ['container','volume','network','image']){const found=await required([type,'ls',...(type==='container'?['-a']:[]),'--filter','label=intake.run='+baseline.resourcesPrefix,'--format',type==='volume'?'{{.Name}}':'{{.ID}}']);if(found)actual.push({type,found});}
  assert.deepEqual({residues:result.cleanup.residues,actual},{residues:[],actual:[]});
  assert.equal(r.reason,undefined);assert.ok(Date.now()-started<60000);
  if(selected==='normal')assert.deepEqual({code:r.code,failed:result.failed,blocked:result.blocked,complete:result.evidenceComplete},{code:0,failed:0,blocked:0,complete:true});
  else{
   assert.equal(r.code,1);assert.equal(result.failed,1);assert.equal(result.blocked,0);
   const first=result.cases.find(c=>c.status==='failed');
   if(selected==='during-assertion'||selected==='assertion-export')assert.equal(first.errorCode,'ERR_ASSERTION');
   else if(selected!=='during-export')assert.equal(first.errorCode,'INJECTED_PHASE');
   const exportFailure=selected==='during-export'||selected==='assertion-export';
   assert.equal(result.evidenceComplete,!exportFailure);
   if(exportFailure){assert.equal(result.loggingFailures.length,1);assert.ok(['EEXIST','EISDIR'].includes(result.loggingFailures[0].code));}
   assert.ok(result.phaseMarks.some(m=>m.point===(selected==='assertion-export'?'during-assertion':selected)));
  }
  if(selected==='after-resource-creation')assert.equal(result.cleanup.reconciledResources.filter(r=>r.type==='volume').length,1);
  if(selected==='before-initialization')assert.deepEqual(result.cleanup.reconciledResources,[]);
  const observed={phase:selected,childRun,childExit:r.code,childCases:result.cases,childEvidenceComplete:result.evidenceComplete,loggingFailures:result.loggingFailures,marks:result.phaseMarks,cleanup:result.cleanup,resultsSha256:hash(resultBytes),milliseconds:Date.now()-started,observer:'passed'};
  await save('observed-'+selected+'.json',observed);observations.push(observed);
 }
 return observations;
}
const parserFlags=['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=512m','--memory-swap=512m','--cpus=1','--pids-limit=64','--ulimit=nofile=128:128','--tmpfs=/workspace:rw,noexec,nosuid,size=67108864,mode=1777','--tmpfs=/tmp:rw,noexec,nosuid,size=8388608,mode=1777'];
const pgImage='postgres@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5';
let parserImage,controlImage;
let parserActive=false;
async function probe(command,{network='none',mounts=[],restricted=false,limit=8388608,timeout=10000,inodeVariant=false}={}){
 if(parserActive)throw Error('PARSER_BUSY');
 parserActive=true;try{
 const name=prefix+'-probe-'+seq;
 const allowed=restricted?['--permission','--allow-fs-read=/work/probe.mjs','--allow-fs-read=/work/package.json']: [];
 const flags=parserFlags.map(flag=>inodeVariant&&flag.startsWith('--tmpfs=/workspace:')?flag+',nr_inodes=128':flag);
 await container(name,[...flags,'--network',network,...mounts,parserImage,'node',...allowed,'--max-old-space-size=128','/work/probe.mjs',...command]);
 const execute=async observer=>{
 const result=await docker(['start','-a',name],{timeout,limit,diagnostic:8192});
 if(result.reason)await required(['stop','-t','1',name]);
 const state=json(await docker(['inspect',name]))[0];
 await save('state-'+seq+'.json',{state:state.State,host:state.HostConfig,user:state.Config.User});
 observer?.recordPrimary(result,state);
 return {...result,state:state.State,host:state.HostConfig};
 };
 return command[0]==='memory'?await observeL03({target:owned.at(-1).id,save,
  expectedProbeSha256:async()=>hash(await fs.readFile(path.join(sourceRoot,'tests/intake/t01/probe.mjs'))),
  onFailure:failure=>loggingFailures.push(failure)},execute):await execute();
 }finally{parserActive=false;}
}
async function originalCase(profile,name,folder='fixtures'){
 const source=path.join(sourceRoot,'tests/intake/t01',folder,name);
 const c=prefix+'-format-'+seq;
 await container(c,[...parserFlags,'--network','none','--mount','type=bind,source='+source+',target=/input/original,readonly',parserImage,'node','--permission','--allow-fs-read=/work/reviewed','--allow-fs-read=/input/original','--max-old-space-size=128','/work/reviewed/producer.mjs',profile,'/input/original']);
 const result=await docker(['start','-a',c],{timeout:10000,diagnostic:8192});
 if(result.reason)await required(['stop','-t','1',c]);
 return json(result);
}
let database,controller,network,objectVolume;
async function storageSetup(suffix='main'){
 network=await ownedResource('network',prefix+'-net-'+suffix,['--internal']);
 const pgvol=await ownedResource('volume',prefix+'-pg-'+suffix,[]);
 objectVolume=await ownedResource('volume',prefix+'-objects-'+suffix,[]);
 database=await container(prefix+'-db-'+suffix,['--network',network,'--network-alias','database','--memory=512m','--memory-swap=512m','--cpus=1','--pids-limit=64','--env','POSTGRES_PASSWORD=synthetic-admin','--env','POSTGRES_DB=intake','--mount','type=volume,source='+pgvol+',target=/var/lib/postgresql/data',pgImage]);
 await required(['start',database]);
 let ready=false;for(let i=0;i<50;i++){const r=await docker(['exec',database,'pg_isready','-U','postgres']);if(r.code===0){ready=true;break;}await new Promise(r=>setTimeout(r,150));}assert.ok(ready,'PG readiness');
 const init=await container(prefix+'-owner-'+suffix,['--network','none','--memory=256m','--memory-swap=256m','--cpus=1','--pids-limit=64','--user','0:0','--mount','type=volume,source='+objectVolume+',target=/objects',controlImage,'node','-e',"require('fs').chownSync('/objects',1000,1000)"]);
 await required(['start','-a',init]);
 await startController(suffix);
 const initialized=await cli('init',{},true);assert.equal(initialized.ok,true);
}
async function startController(suffix){
 controller=await container(prefix+'-controller-'+suffix,['--network',network,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=256m','--memory-swap=256m','--cpus=1','--pids-limit=64','--tmpfs=/tmp:rw,size=8388608,mode=1777','--mount','type=volume,source='+objectVolume+',target=/objects',controlImage]);
 await required(['start',controller]);
}
async function cli(action,body={},admin=false){
 const user=admin==='observer'?'intake_observer':admin?'postgres':'intake_runtime';
 const password=admin==='observer'?'synthetic-observer':admin?'synthetic-admin':'synthetic-runtime';
 const r=await docker(['exec','-i','--env','PGUSER='+user,'--env','PGPASSWORD='+password,controller,'node','/work/tests/prototype.mjs',action,'-'],{input:JSON.stringify(body)});
 if(r.reason)throw Error(r.reason);const parsed=JSON.parse(r.stdout);assert.ok([0,2].includes(r.code),r.stderr);return parsed;
}
async function ok(action,body={},admin=false){const r=await cli(action,body,admin);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
async function failed(action,body,code){const r=await cli(action,body);assert.deepEqual({ok:r.ok,error:r.error},{ok:false,error:code});return r;}
const bytes=Buffer.from('Original exact synthetic bytes.\r\nInformación 😀');
const item={key:'object-1',bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')};
let before;
try{
 await fs.mkdir(path.dirname(output),{recursive:true});
 before=await docker(['ps','-a','--format','{{.ID}} {{.Names}} {{.State}}']);
 await save('baseline.json',{group,runId,resourcesPrefix:prefix,node:process.version,executable:process.execPath,head:(await exec('git',['rev-parse','HEAD'])).stdout.trim(),initialDocker:before.stdout});
 const copyFiles=['adapter.mjs','producer.mjs','profile.mjs','process-output.mjs','consumer.mjs','csv-reference.mjs','package.json','package-lock.json','vendor/provenance.json','vendor/xlsx-0.20.3.tgz'];
 const copied=[];for(const name of copyFiles){const b=await fs.readFile(path.join(root,'tests/intake/t01/reviewed',name));copied.push({name,bytes:b.length,sha256:hash(b)});}
 await save('copied-source.json',copied);
 const sourceManifest=[];
 async function snapshot(from,to){
  const stat=await fs.stat(from);
  if(stat.isDirectory()){await fs.mkdir(to,{recursive:true});for(const name of await fs.readdir(from))if(name!=='node_modules')await snapshot(path.join(from,name),path.join(to,name));}
  else {await fs.mkdir(path.dirname(to),{recursive:true});const data=await fs.readFile(from);await fs.writeFile(to,data,{flag:'wx'});sourceManifest.push({name:path.relative(sourceRoot,to).split(path.sep).join('/'),bytes:data.length,sha256:hash(data)});}
 }
 for(const name of ['tests/intake/t01','src/contracts/intake.ts','src/contracts/intake_artifact.ts','src/contracts/intake_bindings.ts','src/contracts/intake_mapping.ts','ci/intake/T01.Dockerfile','ci/intake_t01_check.mjs','ci/intake_l03_observer.mjs','ci/intake_test_summary.mjs','ci/intake_boundary_check.mjs'])
  await snapshot(path.join(root,name),path.join(sourceRoot,name));
 await save('source-manifest.json',sourceManifest);
 if(group==='contracts'){
  for(const [id,description,file]of [['C01','Independent command/artifact/boundary vectors','contracts.mjs'],['C02','Directed test-summary collection guards','test_summary.mjs'],['C04','Per-operation binding contract vectors','bindings.mjs'],['C05','Retained-profile mapping with independent references and fresh consumers','mapping.mjs'],['C06','Directed mapping and binding mutations in retained copies','mapping_mutations.mjs']]){
   await check(id,description,async()=>{
    const args=['--experimental-strip-types','--test','--test-reporter=tap','tests/intake/t01/'+file];
    const r=await exec(process.execPath,args);
    const auxiliaryArgs=['-e','process.stdout.write('+JSON.stringify('auxiliary-after-'+id)+')'];
    const auxiliary=await exec(process.execPath,auxiliaryArgs);
    const report=summarizeNodeTests(r,r.commandRecord);
    await save(id+'-test-summary.json',report);
    const source=JSON.parse(await fs.readFile(path.join(output,report.commandRecord),'utf8'));
    const later=JSON.parse(await fs.readFile(path.join(output,auxiliary.commandRecord),'utf8'));
    assert.equal(commands.at(-1)?.file,auxiliary.commandRecord,'The auxiliary must be the last command for this regression check');
    assert.notEqual(report.commandRecord,auxiliary.commandRecord);
    assert.deepEqual(source.args,args);assert.equal(source.executable,path.basename(process.execPath));
    const {executable, args:recordedArgs, ...recordedResult}=source;
    const {commandRecord, ...childResult}=r;
    assert.deepEqual(recordedResult,JSON.parse(JSON.stringify({...childResult,stdout:redact(r.stdout),stderr:redact(r.stderr)})));
    assert.deepEqual({args:later.args,code:later.code,stdout:later.stdout},{args:auxiliaryArgs,code:0,stdout:'auxiliary-after-'+id});
    await save(id+'-origin-check.json',{childRecord:report.commandRecord,auxiliaryRecord:auxiliary.commandRecord,auxiliaryIsLast:true,argumentsAndResultMatched:true});
    assert.equal(report.status,'passed',JSON.stringify(report));
    return report;
   });
  }
  await check('C03','Added execution metadata preserves existing result consumers and failure causes',async()=>{
   const observed=[];
   for(const [name,args,options,expected]of [
    ['json',['-e','process.stdout.write(JSON.stringify({value:17}))'],{},undefined],
    ['failure',['-e','process.stderr.write("directed-failure");process.exitCode=7'],{},undefined],
    ['limit',['-e','process.stdout.write("x".repeat(1024))'],{limit:16},'output_limit'],
    ['timeout',['-e','setInterval(()=>{},1000)'],{timeout:250},'worker_timeout'],
   ]){
    const r=await exec(process.execPath,args,options);
    const record=JSON.parse(await fs.readFile(path.join(output,r.commandRecord),'utf8'));
    const {executable,args:recordedArgs,...recordedResult}=record;
    const {commandRecord,...childResult}=r;
    assert.deepEqual(recordedArgs,args);
    assert.deepEqual(recordedResult,JSON.parse(JSON.stringify(childResult)));
    assert.equal(r.reason,expected);
    if(name==='json')assert.deepEqual(json(r),{value:17});
    if(name==='failure')assert.deepEqual({code:r.code,stderr:r.stderr},{code:7,stderr:'directed-failure'});
    if(name==='limit')assert.equal(r.stdoutRetainedBytes,16);
    observed.push({name,commandRecord:r.commandRecord,code:r.code,reason:r.reason,oldResultFieldsMatched:true});
   }
    return observed;
   });
 }else if(group==='lifecycle-child'){
  await lifecycleChild();
 }else{
  const info=json(await docker(['info','--format','{{json .}}']));
  assert.deepEqual({os:info.OSType,memory:info.MemoryLimit,swap:info.SwapLimit,cpu:info.CpuCfsQuota,pids:info.PidsLimit},{os:'linux',memory:true,swap:true,cpu:true,pids:true});
  await save('environment.json',{os:info.OSType,version:info.ServerVersion,kernel:info.KernelVersion,cgroup:info.CgroupVersion,controls:{memory:info.MemoryLimit,swap:info.SwapLimit,cpu:info.CpuCfsQuota,pids:info.PidsLimit}});
  for(const target of ['control','parser']){
   const tag='ledgerdesk-intake-t01:'+prefix+'-'+target;
   await required(['build','--target',target,'--label','intake.run='+prefix,'-f',path.join(sourceRoot,'ci/intake/T01.Dockerfile'),'-t',tag,sourceRoot],{timeout:120000});
   const id=await required(['image','inspect',tag,'--format','{{.Id}}']);
   owned.push({type:'image',name:tag,id});
   if(target==='control')controlImage=id;else parserImage=id;
  }
  await save('images.json',{controlImage,parserImage,pgImage});
  await check('ENV','Effective parser controls before workload',async()=>{
   const r=await probe(['environment']);const e=json(r);assert.equal(e.node,'v22.16.0');assert.equal(e.uid,1000);assert.equal(e.memory,'536870912');assert.equal(e.swap,'0');assert.equal(e.pids,'64');assert.equal(e.cpu,'100000 100000');assert.match(e.status,/NoNewPrivs:\s+1/);assert.match(e.status,/Seccomp:\s+2/);assert.match(e.status,/CapEff:\s+0000000000000000/);assert.match(e.limits,/Max open files\s+128\s+128/);return e;
  });
  if(cases.some(c=>c.status==='failed'))throw Error('Effective safety prerequisite failed; workloads not started');
  if(group==='storage'||group==='recovery'){
   await storageSetup();
   await check('S01','Exact original stored and read by independent process',async()=>{
    await ok('reserve',{id:'op-1',payload:'exact-intent-1'});
    assert.deepEqual(await ok('store',item),{bytes:item.bytes,sha256:item.sha256,base64:item.base64});
    const read=await ok('read',{key:item.key});assert.equal(Buffer.from(read.base64,'base64').compare(bytes),0);
    await ok('finalize',{...item,id:'op-1',payload:'exact-intent-1',generation:1});
    return await ok('lookup',{id:'op-1'});
   });
   await check('S02','No overwrite, wrong bytes or unsafe selector',async()=>{
    await failed('store',item,'EEXIST');await failed('store',{...item,key:'wrong',sha256:'0'.repeat(64)},'ORIGINAL_MISMATCH');
    await failed('read',{key:'../object-1'},'UNSAFE_KEY');
    await failed('store',{...item,key:'too-large',base64:Buffer.alloc(1048577).toString('base64'),bytes:1048577},'INPUT_LIMIT');
    await required(['exec',controller,'node','-e',"const fs=require('fs');fs.writeFileSync('/tmp/sentinel','synthetic sentinel');fs.symlinkSync('/tmp/sentinel','/objects/link')"]);
    await failed('read',{key:'link'},'ELOOP');
    await required(['exec',controller,'node','-e',"require('fs').unlinkSync('/objects/link')"]);
   });
   await check('S03','Exact cap and empty storage port inputs',async()=>{
    for(const [key,b]of [['exact-cap',Buffer.alloc(1048576,7)],['empty',Buffer.alloc(0)]]){const x={key,bytes:b.length,sha256:hash(b),base64:b.toString('base64')};assert.equal((await ok('store',x)).sha256,x.sha256);}
   });
   await check('S04','Runtime cannot author schema or delete history',async()=>{
    await failed('observe',{sql:'CREATE TABLE trial.forbidden(id int)'},'42501');
    await failed('observe',{sql:'DELETE FROM trial.evidence'},'42501');
    const rows=await ok('observe',{sql:'SELECT count(*)::int AS n FROM trial.evidence'});assert.equal(rows[0].n,1);
    await failed('observe',{sql:'SET ROLE postgres'},'42501');
    assert.equal((await ok('observe',{sql:'SELECT count(*)::int AS n FROM trial.evidence'},'observer'))[0].n,1);
    assert.equal((await cli('observe',{sql:'DELETE FROM trial.evidence'},'observer')).error,'42501');
   });
   await check('S05','Read-only reader mount denies same-byte and replacement writes',async()=>{
    const c=await container(prefix+'-reader',['--network','none',...parserFlags,'--mount','type=volume,source='+objectVolume+',target=/objects,readonly',controlImage,'node','-e',"const fs=require('fs');console.log(fs.readFileSync('/objects/object-1').length);try{fs.writeFileSync('/objects/object-1','changed');process.exit(2)}catch(e){console.log(e.code)}"]);
    const r=await required(['start','-a',c]);assert.match(r,/EROFS|EACCES/);assert.equal((await ok('read',{key:item.key})).sha256,item.sha256);
   });
   await check('S06','Reviewed UTF-8 CSV and XLSX originals survive exact storage',async()=>{
    const observed=[];for(const name of ['text.txt','table.csv','cache-discrepant.xlsx']){const b=await fs.readFile(path.join(root,'tests/intake/t01/fixtures',name));const key='fixture-'+name.split('.')[0];const x={key,bytes:b.length,sha256:hash(b),base64:b.toString('base64')};await ok('store',x);assert.equal((await ok('read',{key})).base64,x.base64);observed.push({name,bytes:b.length,sha256:x.sha256});}return observed;
   });
   if(group==='storage'){
    for(const competing of [false,true])await check(competing?'G1-B':'G1-A',competing?'Two arrived writers compete for one exclusive generation':'Two arrived writers retain distinct exact originals',async()=>{
     const batch=competing?'race':'distinct';
     const references=['first','second'].map((slot,i)=>{const b=Buffer.from('Independent '+batch+' original '+i+' — 😀\r\n');return{slot,key:competing?'race-object':'distinct-'+slot,bytes:b.length,sha256:hash(b),base64:b.toString('base64'),barrier:{batch,slot,generation:1}};});
     await save('G1-'+batch+'-reference.json',references);
     const operationIds=competing?['g1-race']:['g1-first','g1-second'];
     for(const id of operationIds)await ok('reserve',{id,payload:id});
     for(const key of new Set(references.map(r=>r.key)))assert.deepEqual(await cli('read',{key}),{ok:false,error:'ENOENT'});
     const pending=references.map(reference=>cli('store',reference).then(value=>({value}),error=>({error})));
     let arrivals=[],sessions=[],arrivalError;
     try{
      for(let i=0;i<30;i++){arrivals=await ok('barrier_state',{batch});if(arrivals.length===2)break;await new Promise(r=>setTimeout(r,75));}
      assert.equal(arrivals.length,2,'Both real writers must reach the storage port before release');
      assert.equal(new Set(arrivals.map(a=>a.pid)).size,2);assert.equal(new Set(arrivals.map(a=>a.backendPid)).size,2);
      for(const a of arrivals){const reference=references.find(r=>r.slot===a.slot);assert.ok(reference);assert.equal(a.key,reference.key);assert.equal(a.generation,1);assert.equal(a.point,'before-storage-lock');assert.equal(a.node,'v22.16.0');}
      const ids=arrivals.map(a=>a.backendPid);assert.ok(ids.every(Number.isSafeInteger));
      sessions=await ok('observe',{sql:'SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid IN ('+ids.join(',')+')'},true);
      assert.equal(sessions.length,2);assert.ok(sessions.every(s=>s.state==='idle'&&s.xact_start===null));
      await save('G1-'+batch+'-arrivals.json',{arrivals,sessions,released:false});
     }catch(e){arrivalError=e;}finally{try{await ok('barrier_release',{batch});}catch(e){arrivalError??=e;}}
     const settled=await Promise.all(pending);
     if(arrivalError)throw arrivalError;
     const outcomes=settled.map(r=>{if(r.error)throw r.error;return r.value;});
     if(competing){
      const winner=outcomes.findIndex(r=>r.ok);assert.ok(winner>=0);const loser=outcomes[1-winner];
      const read=await ok('read',{key:'race-object'});
      assert.deepEqual({successes:outcomes.filter(r=>r.ok).length,loser,bytes:read.base64},{successes:1,loser:{ok:false,error:'EEXIST'},bytes:references[winner].base64});
      await ok('finalize',{...references[winner],id:operationIds[0],payload:operationIds[0],generation:1});
     }else{
      assert.ok(outcomes.every(r=>r.ok));
      for(const [i,r]of references.entries()){assert.deepEqual(await ok('read',{key:r.key}),{bytes:r.bytes,sha256:r.sha256,base64:r.base64});await ok('finalize',{...r,id:operationIds[i],payload:operationIds[i],generation:1});}
     }
     const control=await ok('observe',{sql:"SELECT id,state,object_key,bytes,sha256 FROM trial.operation WHERE id IN ("+operationIds.map(id=>"'"+id+"'").join(',')+") ORDER BY id"});
     const expectedControl=operationIds.map((id,index)=>{const r=references[competing?outcomes.findIndex(o=>o.ok):index];return{id,state:'complete',object_key:r.key,bytes:r.bytes,sha256:r.sha256};}).sort((a,b)=>a.id.localeCompare(b.id));
     assert.deepEqual(control,expectedControl);return{arrivals,sessions,outcomes,control,scope:'Requests overlap before the unchanged quota lock; critical sections remain serialized'};
    });
    await check('S07','Aggregate storage budget is observed at its independent port',async()=>{const r=await ok('quota_probe');assert.equal(r.cause,'STORAGE_QUOTA');assert.ok(r.storedBytes<=67108864&&r.accepted>0);return r;});
    await check('S08','Attempt count bound does not prevent known-effect reconciliation',async()=>{
     const existing=(await ok('observe',{sql:'SELECT count(*)::int AS n FROM trial.operation'}))[0].n;
     for(let i=existing;i<32;i++)await ok('reserve',{id:'bounded-'+i,payload:'bounded-'+i});
     await failed('reserve',{id:'too-many',payload:'new'},'ATTEMPT_LIMIT');assert.equal((await ok('reserve',{id:'op-1',payload:'exact-intent-1'})).state,'complete');
     return await ok('observe',{sql:'SELECT count(*)::int AS n FROM trial.operation'});
    });
   }
   if(group==='recovery'){
    await check('R00','Interrupted receiver has no active receipt, SQL idle and explicit new generation',async()=>{
     await ok('reserve',{id:'op-partial',payload:'partial-intent'});
     const running=docker(['exec','--env','PGPASSWORD=synthetic-runtime',controller,'node','/work/tests/prototype.mjs','stage_wait',JSON.stringify({...item,id:'op-partial',key:'partial'})],{timeout:15000});
     let seen=false;for(let i=0;i<30;i++){const rows=await ok('observe',{sql:"SELECT state,xact_start FROM pg_stat_activity WHERE application_name='intake-test-op-partial'"});if(rows.some(r=>r.state==='idle'&&r.xact_start===null)){seen=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(seen);
     await required(['exec',controller,'node','-e',"const f=require('fs');if(f.statSync('/objects/.partial-partial').size!==10)process.exit(2)"]);
     await required(['kill',controller]);const stopped=await running;assert.notEqual(stopped.code,0);
     await startController('resumed');assert.equal((await ok('lookup',{id:'op-partial'})).state,'pending');assert.equal((await ok('resume',{id:'op-partial',generation:1})).generation,2);
    });
    await check('R01','Lost committed response recovers one effect; incompatible intent conflicts',async()=>{
     const x={...item,key:'object-2'};await ok('reserve',{id:'op-2',payload:'exact-intent-2'});await ok('store',x);
     await failed('finalize',{...x,id:'op-2',payload:'exact-intent-2',generation:1,fault:'after_commit'},'INJECTED_RESPONSE_LOSS');
     const r=await ok('lookup',{id:'op-2',payload:'exact-intent-2'});assert.equal(r.state,'complete');
     assert.equal((await ok('lookup',{id:'op-2',payload:'different'})).state,'conflict');
     assert.equal((await ok('observe',{sql:"SELECT count(*)::int AS n FROM trial.evidence WHERE id='op-2'"}))[0].n,1);return r;
    });
    await check('R02','Pre-commit failure preserves sealed orphan without activating receipt',async()=>{
     const x={...item,key:'object-3'};await ok('reserve',{id:'op-3',payload:'exact-intent-3'});await ok('store',x);
     await failed('finalize',{...x,id:'op-3',payload:'exact-intent-3',generation:1,fault:'before_commit'},'INJECTED_PRE_COMMIT');
     assert.equal((await ok('lookup',{id:'op-3'})).state,'pending');assert.equal((await ok('read',{key:x.key})).sha256,x.sha256);
     await ok('resume',{id:'op-3',generation:1});await failed('finalize',{...x,id:'op-3',payload:'exact-intent-3',generation:1},'STALE_ATTEMPT');
    });
    await check('R03','Controller and PostgreSQL restart preserve exact committed effect',async()=>{
     await required(['restart',database]);await required(['restart',controller]);
     let result;for(let i=0;i<30;i++){try{result=await ok('lookup',{id:'op-1'});break;}catch{await new Promise(r=>setTimeout(r,100));}}
     assert.equal(result?.available,true);assert.equal(result?.sha256,item.sha256);return result;
    });
    for(const mode of ['before','after'])await check('RC-'+mode,'Actual PostgreSQL outcome-channel termination '+mode+' commit',async()=>{
     const id='channel-'+mode,x={...item,key:id};await ok('reserve',{id,payload:id});await ok('store',x);
     const pending=cli('finalize',{...x,id,payload:id,generation:1,fault:'channel_'+mode});
     let waiting=false;for(let i=0;i<30;i++){const rows=await ok('observe',{sql:"SELECT wait_event FROM pg_stat_activity WHERE application_name='intake-test-"+id+"'"} ,true);if(rows.some(r=>r.wait_event==='PgSleep')){waiting=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(waiting,'Did not reach controlled commit channel');
     const terminated=await ok('observe',{sql:"SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE application_name='intake-test-"+id+"'"} ,true);assert.deepEqual(terminated,[{stopped:true}]);
     const error=await pending;assert.equal(error.ok,false);const state=await ok('lookup',{id});assert.equal(state.state,mode==='before'?'pending':'complete');return{client:error,authoritativeState:state.state};
    });
    await check('R04','Quiescent operation/object snapshot restored into independent fresh volumes',async()=>{
     const backup=await ok('backup');const ids=new Set(backup.operations.filter(r=>r.state==='complete').map(r=>r.id));
     const selected=backup;
     await save('quiescent-complete-backup.json',selected);
     await storageSetup('restore');assert.equal((await ok('restore',selected)).restored,selected.operations.length);
     assert.equal((await ok('lookup',{id:'op-1'})).available,true);
     const missing=structuredClone(selected);missing.operations[0].object_key='absent';await failed('restore',{...missing,objects:[]},'ENOENT');
     assert.equal((await ok('lookup',{id:'op-partial'})).generation,2);
     return {restoredOperations:selected.operations.length,committed:ids.size};
    });
    await check('R05','Missing and corrupt retained originals do not fabricate availability',async()=>{
     await ok('corrupt',{key:'object-1'});const r=await ok('lookup',{id:'op-1'});assert.equal(r.state,'complete');assert.equal(r.available,false);return r;
    });
    await check('G2','Corrupt backup members reach restore on separate fresh targets',async()=>{
     const backup=JSON.parse(await fs.readFile(path.join(output,'quiescent-complete-backup.json'),'utf8'));
     const operation=backup.operations.find(o=>o.id==='op-1'),object=backup.objects.find(o=>o.key===item.key),evidence=backup.evidence.find(e=>e.id==='op-1');
     assert.deepEqual({bytes:object.bytes,sha256:object.sha256,base64:object.base64},{bytes:item.bytes,sha256:item.sha256,base64:item.base64});
     assert.deepEqual({key:operation.object_key,bytes:operation.bytes,sha256:operation.sha256},{key:item.key,bytes:item.bytes,sha256:item.sha256});
     const reference={operations:[operation],objects:[object],evidence:[evidence]};await save('G2-backup-reference.json',reference);
     const observations=[];
     for(const mode of ['intact','bytes','control']){
      await required(['stop','-t','1',controller]);await required(['stop','-t','1',database]);
      await storageSetup('g2-'+mode);
      const beforeRows=await ok('observe',{sql:'SELECT (SELECT count(*)::int FROM trial.operation) AS operations,(SELECT count(*)::int FROM trial.evidence) AS evidence'});
      assert.deepEqual(beforeRows,[{operations:0,evidence:0}]);assert.equal((await cli('read',{key:item.key})).error,'ENOENT');
      const supplied=structuredClone(reference);
      if(mode!=='intact'){
       const altered=Buffer.from(item.base64,'base64');altered[0]^=1;supplied.objects[0].base64=altered.toString('base64');
       if(mode==='control')supplied.objects[0].sha256=hash(altered);
      }
      await save('G2-'+mode+'-supplied.json',supplied);
      const result=await cli('restore',supplied);
      const control=await ok('observe',{sql:'SELECT (SELECT count(*)::int FROM trial.operation) AS operations,(SELECT count(*)::int FROM trial.evidence) AS evidence'});
      const stored=await cli('read',{key:item.key});
      if(mode==='intact')assert.deepEqual({result,control,stored},{result:{ok:true,result:{restored:1}},control:[{operations:1,evidence:1}],stored:{ok:true,result:{bytes:item.bytes,sha256:item.sha256,base64:item.base64}}});
      else assert.deepEqual({result,control,stored:mode==='bytes'?stored:stored.result?.base64},{result:{ok:false,error:mode==='bytes'?'ORIGINAL_MISMATCH':'RESTORE_MEMBER'},control:[{operations:0,evidence:0}],stored:mode==='bytes'?{ok:false,error:'ENOENT'}:supplied.objects[0].base64});
      observations.push({mode,result,control,stored,point:mode==='bytes'?'object-byte verification':mode==='control'?'restored object against unchanged control reference':'complete restoration'});
     }
     return{observations,limit:'The control-mismatch case retains a sealed orphan until test-resource cleanup; no cross-store atomic rollback is claimed'};
    });
   }
  }
  if(group==='isolation'){
   await check('F01','Actual restricted adapters preserve selected text, CSV, XLSX and partial coverage',async()=>{
    const t=await originalCase('text','text.txt');assert.equal(t.extraction.elements.map(e=>e.text).join(''),(await fs.readFile(path.join(root,'tests/intake/t01/fixtures/text.txt'))).toString('utf8'));
    const c=await originalCase('csv','table.csv');assert.deepEqual(c.extraction.elements[0].rows[1].fields,['001','0','','USD, excludes tax']);
    const x=await originalCase('xlsx','cache-discrepant.xlsx');assert.equal(x.extraction.elements[0].cells.find(c=>c.address==='D2').formula.cached.lexical,'24.00');
    const p=await originalCase('xlsx','unsupported-part.xlsx');assert.equal(p.extraction.outcome,'partial');assert.ok(p.extraction.coverage.unsupported.length);
    return {text:true,csv:true,cachedValue:'24.00',partial:p.extraction.coverage};
   });
   await check('F02','Encoding and XLSX failure controls remain explicit',async()=>{
    assert.equal((await originalCase('csv','invalid-utf8.csv')).error,'invalid_utf8');
    assert.equal((await originalCase('xlsx','external-link.xlsx')).error,'external_relationship');
    assert.equal((await originalCase('xlsx','cache-zero.xlsx')).extraction.elements[0].cells.find(c=>c.address==='D2').formula.cached.lexical,'0');
    assert.equal((await originalCase('xlsx','cache-missing.xlsx')).extraction.elements[0].cells.find(c=>c.address==='D2').formula.cached.availability,'not_available');
   });
   await check('F03','Reviewed XLSX sheet/cell boundaries through the new container wrapper',async()=>{
    const reference=JSON.parse(await fs.readFile(path.join(sourceRoot,'tests/intake/t01/boundaries/expected.json'),'utf8'));
    const observed=[];for(const row of reference.cases){
     const bytes=await fs.readFile(path.join(sourceRoot,'tests/intake/t01/boundaries',row.file));assert.equal(hash(bytes),row.sha256);
     const actual=await originalCase('xlsx',row.file,'boundaries');
     if(row.expected==='completed'){assert.equal(actual.extraction.outcome,'completed');assert.deepEqual(actual.extraction.elements.map(e=>e.cells.length),row.counts);}
     else assert.equal(actual.error,row.expected);
     observed.push({id:row.id,result:actual.error??actual.extraction.outcome});
    }return observed;
   });
   await check('I01','Read-only root, absent secret/socket and bounded workspace',async()=>{
    const r=json(await probe(['filesystem']));assert.notEqual(r.rootWrite,'allowed');assert.notEqual(r.sourceWrite,'allowed');assert.notEqual(r.socket,'allowed');assert.notEqual(r.sentinel,'allowed');assert.equal(r.workspace,'allowed');return r;
   });
   await check('I02','Node profile forbids child execution; harmless control can execute it',async()=>{
    const r=json(await probe(['permissions'],{restricted:true}));assert.equal(r.child,'ERR_ACCESS_DENIED');assert.equal(r.read,'ERR_ACCESS_DENIED');
    const positive=json(await probe(['permissions']));assert.equal(positive.child,'allowed');return {restricted:r,positive};
   });
   await check('I03','TCP UDP and DNS probes discriminate network-none from owned positive',async()=>{
    const n=await ownedResource('network',prefix+'-traps',['--internal']);
    const trap=await container(prefix+'-trap',['--network',n,'--network-alias','trap','--read-only','--memory=64m','--memory-swap=64m','--cpus=1','--pids-limit=32',parserImage,'node','/work/probe.mjs','trap']);
    await required(['start',trap]);await new Promise(r=>setTimeout(r,300));
    const address=json(await docker(['inspect',trap]))[0].NetworkSettings.Networks[n].IPAddress;
    const positive=json(await probe(['network',address],{network:n}));assert.equal(positive.literal,'connected');assert.equal(positive.name,'connected');assert.equal(positive.udp,'reply');assert.equal(positive.dns,true);
    const beforeHits=await required(['logs',trap]);
    const negative=json(await probe(['network',address]));assert.notEqual(negative.literal,'connected');assert.notEqual(negative.name,'connected');assert.notEqual(negative.udp,'reply');assert.equal(negative.dns,false);
    assert.equal(await required(['logs',trap]),beforeHits);return {positive,negative,addressFamily:'IPv4; IPv6 not credited'};
   });
   await check('I04','A present synthetic sentinel distinguishes Node denial from missing-file denial',async()=>{
    const mount=['--mount','type=bind,source='+path.join(sourceRoot,'tests/intake/t01/fixtures/short.txt')+',target=/sentinel/value,readonly'];
    const positive=json(await probe(['permissions'],{mounts:mount}));assert.equal(positive.read,'allowed');
    const negative=json(await probe(['permissions'],{mounts:mount,restricted:true}));assert.equal(negative.read,'ERR_ACCESS_DENIED');
    return{positive:positive.read,negative:negative.read};
   });
  }
  if(group==='limits'){
   await check('G3-B','Valid UTF-8 is cut inside a character by the real container supervisor',async()=>{
    const reference=Buffer.from([0x61,0xf0,0x9f,0x98,0x80]);await save('G3-B-reference.json',{base64:reference.toString('base64'),completeCap:5,cutCap:3,prefixBase64:reference.subarray(0,3).toString('base64')});
    const positive=await probe(['utf8'],{limit:5});const negative=await probe(['utf8'],{limit:3});
    assert.deepEqual({code:positive.code,reason:positive.reason,received:positive.stdoutBytes,retained:positive.stdoutRetainedBytes,encoding:positive.stdoutEncodingError,text:positive.stdout},{code:0,reason:undefined,received:5,retained:5,encoding:false,text:'a😀'});
    assert.deepEqual({reason:negative.reason,received:negative.stdoutBytes,retained:negative.stdoutRetainedBytes,encoding:negative.stdoutEncodingError,running:negative.state.Running},{reason:'output_limit',received:5,retained:3,encoding:true,running:false});
    return{positive,negative,limit:'Calibrated 5/3-byte variant; L01 separately exercises 8 MiB. Encoding error describes the retained prefix, not invalid producer bytes.'};
   });
   await check('G3-A','Finite inode pressure stays below the workspace byte limit',async()=>{
    const r=await probe(['inodes'],{inodeVariant:true});const observed=json(r);
    assert.match(observed.mount,/nr_inodes=128/);assert.equal(observed.initial.files,128);
    assert.ok(observed.positive.freeInodes>0);assert.equal(observed.count,observed.initial.freeInodes);
    assert.deepEqual({error:observed.error,freeInodes:observed.final.freeInodes},{error:'ENOSPC',freeInodes:0});
    assert.ok(observed.final.freeBlocks>observed.final.totalBlocks/2);assert.ok(observed.bytesWritten<256);
    assert.equal(r.host.Memory,536870912);assert.equal(r.host.MemorySwap,536870912);
    return{...observed,host:r.host,limit:'Stricter nr_inodes=128 test mount; unchanged 64 MiB base mount is not assigned this inode limit'};
   });
   await check('L01','Output cap and cap+1 retain primary cause',async()=>{
    const p=await probe(['output','8388608']);assert.equal(p.code,0);assert.equal(p.stdoutRetainedBytes,8388608);
    const n=await probe(['output','8388609']);assert.equal(n.reason,'output_limit');assert.equal(n.stdoutRetainedBytes,8388608);return {positiveBytes:p.stdoutRetainedBytes,negativeCause:n.reason};
   });
   await check('L02','Wall watchdog terminates CPU loop without retry',async()=>{const r=await probe(['cpu']);assert.equal(r.reason,'worker_timeout');assert.ok(r.milliseconds<15000);return{cause:r.reason,milliseconds:r.milliseconds};});
   await check('L03','Native allocation reaches cgroup limit, not only JS heap',async()=>{const r=await probe(['memory']);assert.equal(r.state.OOMKilled,true);assert.equal(r.state.ExitCode,137);return r.state;});
   await check('L04','File descriptors and workspace exhaustion are enforced',async()=>{const f=json(await probe(['files']));assert.equal(f.error,'EMFILE');assert.ok(f.count<128);const w=json(await probe(['workspace']));assert.equal(w.error,'ENOSPC');assert.ok(w.count<=64);return{fileDescriptors:f,workspace:w};});
   await check('L05','Bounded descendant control meets PID ceiling',async()=>{const r=json(await probe(['pids'],{timeout:10000}));assert.equal(r.error,'EAGAIN');assert.ok(r.started<64);return r;});
   await check('L06','A second parser request cannot create a concurrent worker',async()=>{const first=probe(['cpu'],{timeout:500});await assert.rejects(probe(['environment']),/PARSER_BUSY/);assert.equal((await first).reason,'worker_timeout');assert.equal(json(await probe(['environment'])).uid,1000);});
  }
  if(group==='lifecycle'){
   await check('H01','Timed-out held child is stopped before resource cleanup',async()=>{const r=await probe(['cpu'],{timeout:500});assert.equal(r.reason,'worker_timeout');assert.equal(r.state.Running,false);return r.state;});
   await check('H02','Malformed workload failure preserves its original error',async()=>{const r=await probe(['invalid-probe']);assert.notEqual(r.code,0);assert.match(r.stderr,/UNKNOWN_PROBE/);return{exit:r.code};});
   await check('H03','Cleanup refuses a mismatched owner before removing the actual volume',async()=>{
    const name=await ownedResource('volume',prefix+'-guard-probe',[]),entry=owned.find(r=>r.name===name);
    await assert.rejects(remove(entry,'not-this-owner'),/ownership mismatch/);
    assert.equal(json(await docker(['volume','inspect',name]))[0].Labels['intake.run'],prefix);
    await remove(entry);return{mismatchDenied:true,matchingOwnerRemoved:true};
   });
   await check('H04','Artifact budget rejects before writing and reserves terminal evidence space',async()=>{
    const previous=bytesWritten;bytesWritten=2143289344;
    await assert.rejects(save('must-not-exist.json','x'),/EVIDENCE_LIMIT/);
    assert.equal(await fs.stat(path.join(output,'must-not-exist.json')).then(()=>true,()=>false),false);
    bytesWritten=previous;return{artifactBudget:2143289344,terminalReserve:4194304,allocation:'counter fault, not a 2 GiB write'};
   });
   await check('H05','Export redaction preserves outcomes without local roots or credentials',async()=>{
    const value=redact(root+'fixture synthetic-runtime');
    assert.ok(!value.includes(root)&&!value.includes('synthetic-runtime'));
    assert.ok(value.includes('fixture'));return {checked:true};
   });
   await check('G4','Observer distinguishes failed lifecycle children from successful fault experiments',observeLifecycle);
  }
 }
}catch(e){cases.push({id:'SETUP',status:'blocked',error:e.message,errorCode:e.code});console.error(e.message);}
finally{
 // Cleanup has a fresh bounded allowance even if a workload consumed the group budget.
 cleanupMode=true;
 budgetEnd=Date.now()+60000;
 try{
  try{await reconcileOwned();}catch(e){loggingFailures.push({phase:'resource-reconciliation',error:e.message});}
  for(const resource of [...owned].reverse())if(!resource.removed)try{await remove(resource);}catch(e){resource.cleanupError=e.message;}
  try{await save('resources.json',owned);}catch(e){loggingFailures.push({file:'resources.json',error:e.message});}
  const after=await docker(['ps','-a','--format','{{.ID}} {{.Names}} {{.State}}']).catch(e=>({code:1,stdout:'',stderr:e.message}));
  if(after.code!==0)loggingFailures.push({phase:'final-inventory',error:after.stderr});
  const residues=owned.filter(r=>!r.removed);
  const result={group,runId,node:process.version,phase,phaseMarks,cases,passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,blocked:cases.filter(c=>c.status==='blocked').length,evidenceComplete:loggingFailures.length===0,loggingFailures,cleanup:{residues,reconciledResources,after:after.stdout},commands,limitations:['Experimental only; no operational admission, preparation producer or candidate constitution','No full temporal conformity; R24 remains open','No real data or operational format adoption']};
  try{await save('results.json',result);}catch(e){loggingFailures.push({file:'results.json',error:e.message});console.error('Terminal evidence failure: '+redact(e.message));}
  console.log('Evidence: test-results/intake-t01/'+runId);
  if(residues.length||loggingFailures.length||cases.some(c=>c.status!=='passed'))process.exitCode=1;
 }finally{
  if(nestedClaim){if(await fs.readFile(nestedClaim,'utf8')===prefix)await fs.unlink(nestedClaim);}
  else if(await fs.readFile(lockPath,'utf8')===prefix)await fs.unlink(lockPath);
 }
}
