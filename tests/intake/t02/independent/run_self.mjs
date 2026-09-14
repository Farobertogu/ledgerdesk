import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=process.argv[2];
if(!root||!path.isAbsolute(root))throw new Error('An absolute, exclusively owned evidence root is required.');
const baselineRoot=process.argv[3],probeRoot=process.argv[4];
const r2Sources=process.argv[5],r2Probes=process.argv[6],r2Followups=process.argv[7];
const r3Sources=process.argv[8],r3Probes=process.argv[9],r3Followups=process.argv[10];
const r4Sources=process.argv[11],seamsRoot=process.argv[12];
const r5Sources=process.argv[13],realReplay=process.argv[14],target=process.argv[15];
if([r5Sources,realReplay].some(x=>x&&!path.isAbsolute(x)))throw new Error('R5 sources and real replay must be absolute read-only inputs.');
if(target&&target!=='r6')throw new Error('Only the bounded R6 targeted mode is supported.');
if([r4Sources,seamsRoot].some(x=>x&&!path.isAbsolute(x)))throw new Error('R4 source and real seam roots must be absolute read-only inputs.');
if([r3Sources,r3Probes,r3Followups].some(x=>x&&!path.isAbsolute(x)))throw new Error('R3 source, probe and followup roots must be absolute read-only inputs.');
if([r2Sources,r2Probes,r2Followups].some(x=>x&&!path.isAbsolute(x)))throw new Error('R2 source, probe and followup roots must be absolute read-only inputs.');
if((baselineRoot&&!path.isAbsolute(baselineRoot))||(probeRoot&&!path.isAbsolute(probeRoot)))throw new Error('Baseline and probe roots must be absolute read-only inputs.');
const here=path.dirname(fileURLToPath(import.meta.url));
const run=path.join(root,`self-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`);
mkdirSync(run,{recursive:true});mkdirSync(path.join(run,'sources'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const sources=[];
for(const name of readdirSync(here).filter(n=>/\.(mjs|md)$/.test(n)).sort()) {
  const bytes=readFileSync(path.join(here,name));writeFileSync(path.join(run,'sources',name),bytes,{flag:'wx'});
  sources.push({name,bytes:bytes.length,sha256:sha(bytes)});
}
const startedAt=new Date().toISOString();
const command=[process.execPath,'--test',path.join(here,target==='r6'?'test_correction_r6.mjs':'test_self.mjs')];
const result=spawnSync(command[0],command.slice(1),{cwd:here,env:{...process.env,T02_SELF_RUN_ROOT:run,T02_BASELINE_ROOT:baselineRoot??'',T02_PROBE_ROOT:probeRoot??'',T02_R2_SOURCES:r2Sources??'',T02_R2_PROBES:r2Probes??'',T02_R2_FOLLOWUPS:r2Followups??'',T02_R3_SOURCES:r3Sources??'',T02_R3_PROBES:r3Probes??'',T02_R3_FOLLOWUPS:r3Followups??'',T02_R4_SOURCES:r4Sources??'',T02_SEAMS_ROOT:seamsRoot??'',T02_R5_SOURCES:r5Sources??'',T02_R6_REAL_REPLAY:realReplay??''},encoding:null,timeout:120000,maxBuffer:32*1024*1024,windowsHide:true});
writeFileSync(path.join(run,'stdout.log'),result.stdout??Buffer.alloc(0),{flag:'wx'});
writeFileSync(path.join(run,'stderr.log'),result.stderr??Buffer.alloc(0),{flag:'wx'});
const changed=sources.filter(s=>sha(readFileSync(path.join(here,s.name)))!==s.sha256).map(s=>s.name);
const manifest={kind:'isolated-module-self-test-not-service-evidence',node:process.version,platform:process.platform,architecture:process.arch,command,readOnlyInputs:{baselineRoot:baselineRoot??null,probeRoot:probeRoot??null,r2Sources:r2Sources??null,r2Probes:r2Probes??null,r2Followups:r2Followups??null,r3Sources:r3Sources??null,r3Probes:r3Probes??null,r3Followups:r3Followups??null,r4Sources:r4Sources??null,seamsRoot:seamsRoot??null,r5Sources:r5Sources??null,realReplay:realReplay??null},startedAt,finishedAt:new Date().toISOString(),status:result.status,signal:result.signal,error:result.error?{name:result.error.name,code:result.error.code}:null,sources,changedSources:changed,stdoutSha256:sha(result.stdout??Buffer.alloc(0)),stderrSha256:sha(result.stderr??Buffer.alloc(0))};
writeFileSync(path.join(run,'run.json'),`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx'});
console.log(JSON.stringify({run,...manifest},null,2));
process.exitCode=result.status===0&&changed.length===0?0:1;
