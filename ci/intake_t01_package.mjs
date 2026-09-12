import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
const [runId,reviewedRoot,reuseId]=process.argv.slice(2);
if(!runId||!/^[a-z0-9-]+$/.test(runId)||!reviewedRoot)throw Error('Supply a fresh package ID and the read-only reviewed trial root');
if(reuseId&&!/^[a-z0-9-]+$/.test(reuseId))throw Error('Invalid previous delivery ID');
const target=path.join(root,'test-results/intake-t01',runId);
await fs.mkdir(target);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=async(name,value)=>fs.writeFile(path.join(target,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const command=async(bin,args,cwd=root)=>{
 try{return {...await exec(bin,args,{cwd,windowsHide:true,timeout:120000,maxBuffer:16777216}),code:0};}
 catch(e){return {stdout:e.stdout??'',stderr:e.stderr??'',code:e.code};}
};
async function files(directory){
 const result=[];
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw Error('Unexpected link in input inventory');
  if(entry.name==='node_modules')continue;
  if(entry.isDirectory())for(const child of await files(path.join(directory,entry.name)))result.push(entry.name+'/'+child);
  else result.push(entry.name);
 }
 return result.sort();
}
const groups=[
 ['reviewed',''],
 ['fixtures','outputs/fixtures-2026-09-11T07-47-32-518Z-0cd8d8d5'],
 ['boundaries','outputs/xlsx-boundaries-2026-09-11T15-13-27-592Z-38d81711'],
];
const copies=[];
for(const [copy,source]of groups){
 const copyRoot=path.join(root,'tests/intake/t01',copy);
 for(const name of await files(copyRoot)){
  const actual=await fs.readFile(path.join(copyRoot,name));
  const original=await fs.readFile(path.join(reviewedRoot,source,name));
  if(!actual.equals(original))throw Error('Copied input changed: '+copy+'/'+name);
  copies.push({path:copy+'/'+name,source:[source,name].filter(Boolean).join('/'),bytes:actual.length,sha256:digest(actual)});
 }
}
const provenance={profile:'intake-copy-manifest/1',meaning:'Byte equality with the retained trial; integrity is not source authentication or operational adoption.',files:copies};
const provenanceBytes=JSON.stringify(provenance,null,2)+'\n';
const provenancePath=path.join(root,'tests/intake/t01/PROVENANCE.json');
try{await fs.writeFile(provenancePath,provenanceBytes,{flag:'wx'});}
catch(e){if(e.code!=='EEXIST'||await fs.readFile(provenancePath,'utf8')!==provenanceBytes)throw e;}
await json('copy-verification.json',{checkedAt:new Date().toISOString(),copiedFiles:copies.length,allIdentical:true,manifestSha256:digest(provenanceBytes)});
const mappingManifest=JSON.parse(await fs.readFile(path.join(root,'tests/intake/t01/mapping-inputs/PROVENANCE.json'),'utf8'));
for(const item of mappingManifest.records){
 const local=await fs.readFile(path.join(root,'tests/intake/t01/mapping-inputs',item.path));
 const source=await fs.readFile(path.join(reviewedRoot,item.source));
 if(!local.equals(source)||local.length!==item.bytes||digest(local)!==item.sha256)throw Error('Mapping snapshot differs: '+item.path);
}
await json('mapping-copy-verification.json',{checkedAt:new Date().toISOString(),count:mappingManifest.records.length,allIdentical:true,records:mappingManifest.records});
const contractsId='g-contracts-02',qualityId='g-quality-02';
const infrastructure=['storage','recovery','isolation','limits','lifecycle'].map(group=>({group,id:'g-'+group+'-02'}));
const selectedContracts=JSON.parse(await fs.readFile(path.join(root,'test-results/intake-t01',contractsId,'results.json'),'utf8'));
const selectedQuality=JSON.parse(await fs.readFile(path.join(root,'test-results/intake-t01',qualityId,'quality.json'),'utf8'));
if(selectedContracts.failed||selectedContracts.blocked||selectedContracts.passed!==6||selectedQuality.some(r=>r.code!==0||r.cause))throw Error('Selected execution is not successful');
const contractSource=JSON.parse(await fs.readFile(path.join(root,'test-results/intake-t01',contractsId,'source-manifest.json'),'utf8'));
for(const item of contractSource){
 if(digest(await fs.readFile(path.join(root,item.name)))!==item.sha256)throw Error('Contract source changed after execution: '+item.name);
}
await json('contract-source-verification.json',{run:contractsId,checked:contractSource.length,allIdentical:true});
const infrastructureResults=[];
for(const {group,id}of infrastructure){
 const data=JSON.parse(await fs.readFile(path.join(root,'test-results/intake-t01',id,'results.json'),'utf8'));
 if(data.group!==group||data.failed||data.blocked||data.loggingFailures.length||data.cleanup.residues.length||!data.evidenceComplete)throw Error('Incomplete infrastructure result: '+id);
 const source=JSON.parse(await fs.readFile(path.join(root,'test-results/intake-t01',id,'source-manifest.json'),'utf8'));
 for(const item of source)if(digest(await fs.readFile(path.join(root,item.name)))!==item.sha256)throw Error('Infrastructure source changed: '+id+'/'+item.name);
 infrastructureResults.push({group,id,checkedSources:source.length,data});
}
await json('infrastructure-source-verification.json',infrastructureResults.map(({group,id,checkedSources})=>({group,id,checkedSources,allIdentical:true})));
const matrixDefinitions=[
 ['G1-A','E-STORAGE positives','storage','Two arrivals at the real storage port before release; unchanged quota lock','Two distinct independently fixed original byte strings','Both exact originals and their complete control identities'],
 ['G1-B','E-STORAGE negatives','storage','Competing exclusive creation at a new key/generation','Two coherent contenders with independent bytes; no winner assumed','One successful creation, one EEXIST, exact winner bytes and control'],
 ['G2','E-RECOVERY schedule 7','recovery','Actual restore into three fresh control/object targets','Original op-1 bytes/control verified independently before backup variants','Intact restoration; byte mismatch rejected before storage; coherent wrong object rejected against control; no complete wrong reference'],
 ['G3-A','E-LIMITS inode exhaustion','limits','Actual restricted container tmpfs with nr_inodes=128','Finite observed inode cap; one-byte closed files; free byte blocks','Below-limit positive followed by zero free inodes, ENOSPC and more than half free blocks'],
 ['G3-B','E-LIMITS multibyte output','limits','Real container channel and unchanged output collector','Literal valid five-byte UTF-8 sequence; calibrated caps 5 and 3','Full exact text, then output_limit with 3 retained bytes and retained-prefix encoding error'],
 ['G4','E-LIFECYCLE finite phase schedule','lifecycle','Actual harness child leases, creation, staging, assertion, export and final cleanup','Named fault phases and external observer; H01 covers held child','Normal success; expected child failures stay failures; export failures retain incomplete evidence; no owned residue'],
];
const complementMatrix=matrixDefinitions.map(([id,clause,group,point,reference,expected])=>{
 const run=infrastructureResults.find(r=>r.group===group),actual=run.data.cases.find(c=>c.id===id);
 if(actual?.status!=='passed')throw Error('Missing complement observation: '+id);
 return{id,clause,point,reference,positiveAndNegative:expected,expected,actual,run:run.id,sourceManifest:run.id+'/source-manifest.json',status:'executed-pending-independent-review',limit:id==='G3-A'?'Stricter test mount, not the base inode policy':id==='G3-B'?'Calibrated small cap; L01 separately exercises 8 MiB':id==='G4'?'Child failures are expected experiment inputs, not successful child runs':'Test-contained feasibility, not operational authority or general correctness'};
});
await json('complement-matrix.json',complementMatrix);
const mutationSummary=JSON.parse(await fs.readFile(path.join(root,'test-results/intake-t01',contractsId,'C06-test-summary.json'),'utf8'));
const mutationCommand=JSON.parse(await fs.readFile(path.join(root,'test-results/intake-t01',contractsId,mutationSummary.commandRecord),'utf8'));
const mutationPaths=[...mutationCommand.stdout.matchAll(/^# Mutation evidence: (test-results\/intake-t01\/mapping-mutants-[a-f0-9-]+\/[a-z-]+)$/gm)].map(m=>m[1]);
if(mutationPaths.length!==8)throw Error('Missing directed mutation evidence');
const mutationEvidence=[];
for(const directory of mutationPaths){
 const entries=[];for(const file of await files(path.join(root,directory))){const bytes=await fs.readFile(path.join(root,directory,file));entries.push({file,bytes:bytes.length,sha256:digest(bytes)});}
 mutationEvidence.push({directory,files:entries});
}
await json('mapping-mutation-evidence.json',mutationEvidence);
const dossier=path.dirname(path.resolve(reviewedRoot));
const coordination=path.resolve(dossier,'../../../../coordinacion/expedientes');
const protectedInputs=[
 ['R1',path.join(dossier,'INC-03_T01_INTEGRATION_PROPOSAL.md'),'e530aec6f85832fa4543c98938305243c111d23871951b7a100b7c3f880052b7'],
 ['reviewed-R2',path.join(coordination,'INC-03_T01_INTEGRATION_PROPOSAL_R2.md'),'fb1cbab9c13bd15c367567aaf971f26b50aa3fb9c73e5d2cf6069babb31e6633'],
 ['R2-complement',path.join(dossier,'INC-03_T01_INTEGRATION_PROPOSAL_R2.md'),'240a29313aa379553ddccf7670a3e3229b48cdac7b8e0d02b38a6839e7f837db'],
 ['complement-snapshot',path.join(coordination,'INC-03_T01_R2_RESOURCE_ADDENDUM.md'),'240a29313aa379553ddccf7670a3e3229b48cdac7b8e0d02b38a6839e7f837db'],
 ['execution-brief',path.join(dossier,'INC-03_T01_EXECUTION_BRIEF.md'),'e886e3dc80fade6367109838efdae1701bd1ef4fdd00401d432b53e8dd0262cb'],
 ['B1-1-response',path.join(dossier,'INC-03_T01_B1_1_RESPONSE.md'),'e28e42519fd2635b1ff42b53be91d990c1e0d1802bc5c91fb19afbcc3945e542'],
 ['B1-approved',path.resolve(dossier,'../../respuestas/B1.md'),'74d403954d20927dabc4cc7868f88234cb2ef3da1a1a4f978003aedd1ab72341'],
 ['C2-C4-approved',path.resolve(dossier,'../../respuestas/C2_C3_C4_C7_C8_C11_C12.md'),'cdcbe3fc244e2e8dc50e93418a6c4bf3036ca535f5a2aec650fe18db44c7d213'],
 ['G11-approved',path.resolve(dossier,'../../respuestas/G11.md'),'3e89fef33aff9987f0e6b316d375a48a5351b8369a1499c16899c84ea548767e'],
];
const preserved=[];
for(const [name,file,expected]of protectedInputs){
 const actual=digest(await fs.readFile(file));
 preserved.push({name,sha256:actual,unchanged:actual===expected});
 if(actual!==expected)throw Error('Preserved input differs: '+name);
}
await json('preserved-inputs.json',preserved);
await json('acceptance-map.json',[
 {id:'B0',status:'executed',evidence:['baseline.json','environment.json','resources.json','source-manifest.json'],limit:'No host-security changes; ownership is scoped to recorded run resources.'},
 {id:'B1',status:'independently-reviewed',evidence:[contractsId+'/results.json','docs/intake-contract.md','mapping-copy-verification.json','mapping-mutation-evidence.json'],implemented:['intake-binding/2: personal loading, bounded processing and typed lineage','source-pinned complete processing effect resolution; no deployment rows seeded','unchanged converter with directed retained/projected column observation'],independentlyReviewed:['B1-1 and M-1 closed','conversion property table checked against code and identified tests; not a new runtime probe for every row'],pending:['T02-T04 live authority/admission and real preparation producer','D-FORMAT operational adoption']},
 {id:'B2',status:'complement-executed-pending-independent-review',evidence:['g-storage-02/results.json','g-recovery-02/results.json','complement-matrix.json'],pending:['independent review of G1/G2','T02 actual authority and protected handoff'],limits:['Physical power-loss durability is outside the promised bounded prototype exit']},
 {id:'B3',status:'complement-executed-pending-independent-review',evidence:['g-isolation-02/results.json','g-limits-02/results.json','g-lifecycle-02/results.json','complement-matrix.json'],pending:['independent review of G3/G4 and shared-runner coupling','T03 durable worker and result admission'],limits:['Independent IPv6, general host/daemon and physical-disk failure not accredited','The finite specified lifecycle phases are exercised; this is not every possible failure point']},
 {id:'B4',status:'complement-ready-for-review',evidence:[qualityId+'/quality.json','focused-quality.json','reuse-verification.json','manifest.json','copy-verification.json'],closed:['F1','F2','N3','B1-1','M-1'],pending:['independent complement review','remote required workflow','owner format and acceptance/publication decisions']},
 {id:'R2',status:'specification-plus-structural-vectors',pending:['INT-01 through INT-06 at actual first consumers','OP-V-17 and OP-V-18 at preparation birth and consumption','READ-ADMISSION','RECONCILE with current runtime authority','TEMP E_accept and E_constitute']},
 {id:'R24',status:'open-observed-failure',pending:['writer-free expiry before each protected effect','real-data admission remains prohibited']},
]);

const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const dependencies=[];
const reused=[];
const reuseRoot=reuseId&&path.join(root,'test-results/intake-t01',reuseId);
const reuseManifest=reuseRoot&&JSON.parse(await fs.readFile(path.join(reuseRoot,'manifest.json'),'utf8'));
if(reuseRoot){
 const preservedSource=[];
 for(const item of reuseManifest.changed){
  const actual=digest(await fs.readFile(path.join(reuseRoot,'source',item.path)));
  if(actual!==item.sha256)throw Error('Previous source evidence changed: '+item.path);
  preservedSource.push({path:item.path,sha256:actual});
 }
 await json('previous-source-preservation.json',{delivery:reuseId,manifestSha256:digest(await fs.readFile(path.join(reuseRoot,'manifest.json'))),files:preservedSource});
}
for(const subdir of ['tests/intake/t01','tests/intake/t01/reviewed']){
 const directory=path.join(root,subdir);
 const lockBytes=await fs.readFile(path.join(directory,'package-lock.json'));
 const lock=JSON.parse(lockBytes);
 const name=subdir.endsWith('/reviewed')?'reviewed':'prototype';
 if(reuseRoot){
  if(reuseManifest.changed.find(file=>file.path===subdir+'/package-lock.json')?.sha256!==digest(lockBytes))throw Error('Cannot reuse a changed dependency audit');
  const file='audit-'+name+'.json';const bytes=await fs.readFile(path.join(reuseRoot,file));
  await fs.writeFile(path.join(target,file),bytes,{flag:'wx'});
  reused.push({file,source:reuseId+'/'+file,sha256:digest(bytes),meaning:'Original dated query, not a new advisory lookup'});
 }else{
  const result=await command(process.execPath,[npm,'audit','--json','--ignore-scripts','--registry=https://registry.npmjs.org'],directory);
  await json('audit-'+name+'.json',{checkedAt:new Date().toISOString(),scope:subdir,...result});
 }
 for(const [packagePath,value]of Object.entries(lock.packages??{}))if(packagePath)dependencies.push({scope:name,packagePath,version:value.version,license:value.license??'not recorded in lock',resolved:value.resolved,integrity:value.integrity});
}
await json('dependency-inventory.json',dependencies);
await json('reused-advisories.json',reused);
const focusedQuality=[];
for(const [name,bin,args]of [
 ['summary-syntax',process.execPath,['--check','ci/intake_test_summary.mjs']],
 ['summary-tests-syntax',process.execPath,['--check','tests/intake/t01/test_summary.mjs']],
 ['mapping-tests-syntax',process.execPath,['--check','tests/intake/t01/mapping.mjs']],
 ['runner-syntax',process.execPath,['--check','ci/intake_t01_check.mjs']],
 ['package-syntax',process.execPath,['--check','ci/intake_t01_package.mjs']],
 ['intake-boundary',process.execPath,['ci/intake_boundary_check.mjs']],
 ['repository',process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash',['ci/check.sh']],
]){
 const result=await command(bin,args);
 await json('quality-'+name+'.json',{args,...result});focusedQuality.push({name,code:result.code});
 if(result.code!==0)throw Error('Focused quality failed: '+name);
}
await json('focused-quality.json',focusedQuality);
const tracked=await command('git',['diff','--name-only','-z']);
const added=await command('git',['ls-files','--others','--exclude-standard','-z']);
if(tracked.code!==0||added.code!==0)throw Error('Git inventory failed');
const names=[...new Set((tracked.stdout+added.stdout).split('\0').filter(Boolean))].sort();
const changed=[];
for(const name of names){
 const bytes=await fs.readFile(path.join(root,name));
 const destination=path.join(target,'source',name);
 await fs.mkdir(path.dirname(destination),{recursive:true});
 await fs.writeFile(destination,bytes,{flag:'wx'});
 changed.push({path:name,bytes:bytes.length,sha256:digest(bytes)});
}
await fs.writeFile(path.join(target,'tracked.diff'),(await command('git',['diff','--binary'])).stdout,{flag:'wx'});
const runs=[];
for(const entry of await fs.readdir(path.join(root,'test-results/intake-t01'),{withFileTypes:true})){
 if(!entry.isDirectory()||entry.name===runId)continue;
 for(const type of ['results.json','quality.json']){
  try{
   const bytes=await fs.readFile(path.join(root,'test-results/intake-t01',entry.name,type));
   const result=JSON.parse(bytes);
   runs.push({run:entry.name,type,sha256:digest(bytes),...(type==='results.json'?{passed:result.passed,failed:result.failed,blocked:result.blocked,residues:result.cleanup?.residues,loggingFailures:result.loggingFailures}: {checks:result})});
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
const gitHead=(await command('git',['rev-parse','HEAD'])).stdout.trim();
const branch=(await command('git',['branch','--show-current'])).stdout.trim();
const status=(await command('git',['status','--short'])).stdout;
const resources={};
for(const [key,args]of Object.entries({containers:['ps','-a','--format','{{.ID}} {{.Names}} {{.Status}}'],volumes:['volume','ls','--format','{{.Name}}'],networks:['network','ls','--format','{{.ID}} {{.Name}}'],images:['image','ls','--format','{{.Repository}}:{{.Tag}} {{.ID}}']}))resources[key]=await command('docker',args);
const retained=[];
for(const tag of ['ledgerdesk-intake-t01:control','ledgerdesk-intake-t01:parser']){
 const result=await command('docker',['image','inspect',tag]);
 if(result.code!==0)throw Error('Cannot verify retained image '+tag);
 const image=JSON.parse(result.stdout)[0];
 retained.push({tag,id:image.Id,created:image.Created,runOwner:image.Config.Labels?.['intake.run']??null,disposition:'Retained preliminary image from before per-run labeling; no relabeling or deletion'});
}
const cache=await command('docker',['system','df','--format','{{json .}}']);
await json('retained-preliminary-images.json',{checkedAt:new Date().toISOString(),images:retained,buildCache:{...cache,meaning:'Separate Docker build-cache inventory; not classified as one of the retained named images'},cleanupMeaning:'No residue means no surviving resources owned by the checked runs, not an empty daemon.'});
const selection={
 new:[contractsId+'/results.json',qualityId+'/quality.json',...infrastructure.map(r=>r.id+'/results.json'),'focused-quality.json','mapping-mutation-evidence.json','complement-matrix.json'],
 reused:['Original reviewed trial and unchanged dated dependency advisory records; no infrastructure group or full quality claimed as reused'],
 independentPreviousReview:['aud1-contracts-01','aud1-storage-01','aud1-recovery-01','aud1-isolation-01','aud1-limits-01','aud1-lifecycle-01','aud1-quality-01','aud1-f1f2-01','aud1-b1n3-01','aud1-b1n3-quality-01','aud1-b11-01','aud1-b11-quality-01'],
 closed:['F1','F2','N3','B1-1','M-1'],
 completedIndependentReview:'Conversion property table: code and identified directed tests, plus a separate column probe. Not a new runtime probe for every row or proof of operational authority/persistence.',
 limit:'Previous focal closures remain intact. G1-G4 and their shared-runner effects await independent review. All six main groups and full quality are newly executed; expected failed lifecycle children retain their own failure/incomplete-evidence states. Converter, bindings, collector, copied inputs, Dockerfile and locks remain unchanged. The inode variant is stricter than the base mount; multibyte output uses calibrated caps in addition to L01. T01, D-FORMAT, R24 and later real consumers remain open.',
};
await json('evidence-selection.json',selection);
const previousDelta=reuseManifest&&{
 previousDelivery:reuseId,
 changed:changed.filter(file=>reuseManifest.changed.find(old=>old.path===file.path)?.sha256!==file.sha256),
 removed:reuseManifest.changed.filter(old=>!changed.some(file=>file.path===old.path)).map(file=>file.path),
};
const complementPaths=['docs/intake-contract.md','docs/INC-03-T01.md','tests/intake/t01/prototype.mjs','tests/intake/t01/probe.mjs','ci/intake_t01_check.mjs','ci/intake_t01_package.mjs'];
if(reuseId!=='delivery-b0-b4-09'||!previousDelta||previousDelta.removed.length||previousDelta.changed.some(file=>!complementPaths.includes(file.path))||changed.length!==reuseManifest.changed.length)throw Error('Complement must preserve the reviewed baseline outside its scoped mechanisms/documents');
const preservedIndexes=[];
for(const old of reuseManifest.runs){const bytes=await fs.readFile(path.join(root,'test-results/intake-t01',old.run,old.type));if(digest(bytes)!==old.sha256)throw Error('Historical evidence changed: '+old.run);preservedIndexes.push({run:old.run,type:old.type,sha256:old.sha256});}
await json('reuse-verification.json',{reference:reuseId,unchangedFiles:changed.length-previousDelta.changed.length,localizedDelta:previousDelta.changed.map(file=>file.path),reusedRuns:[],preservedIndexes,meaning:'All six groups and full quality rerun because the shared harness changed. Only unchanged source trial and dated dependency advisories are reused. Historical indexes and source copies remain unchanged; preservation is not a rerun.'});
await json('manifest.json',{createdAt:new Date().toISOString(),gitHead,branch,status,changed,previousDelta,runs,selection,focusedQuality,resources,provenance:'tests/intake/t01/PROVENANCE.json',statusMeaning:'Uncommitted experimental delivery; no operational admission or complete T01/R24 conformity.'});
console.log(JSON.stringify({runId,changed:changed.length,copied:copies.length,runs:runs.length,gitHead,branch}));
