import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {plans} from './intake/t02_plan.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const suite=process.argv[3];
if(process.argv.length!==4||process.argv[2]!=='--suite'||!Object.hasOwn(plans,suite))throw Error('EXPLICIT_T02_SUITE_REQUIRED');
const rows=plans[suite];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const runId=suite+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
const output=path.join(root,'test-results/intake-t02/suites',runId);
await fs.mkdir(output,{recursive:true});
const ownSource=await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(output,'matrix.mjs'),ownSource,{flag:'wx'});
const results=[];let failure=null,sharedSources=null;
await fs.writeFile(path.join(output,'plan.json'),JSON.stringify({profile:'intake-t02-matrix/1',runId,suite,
  sourceSha256:hash(ownSource),rows},null,2)+'\n',{flag:'wx'});
try{
  for(const [name,args] of rows){
    const startedAt=new Date().toISOString(),started=Date.now();let tail='';
    // The inner runner owns deadlines, evidence export and all resource cleanup.
    // This parent never kills it on a second timer or creates another container.
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['ci/intake_t02_check.mjs',...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','inherit']});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{process.stdout.write(chunk);tail=(tail+chunk).slice(-131072);});
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
    });
    const summaries=tail.trim().split(/\r?\n/).flatMap(line=>{try{const row=JSON.parse(line);return typeof row.directory==='string'?[row]:[];}catch{return[];}});
    const summary=summaries.at(-1);let observed=null;
    if(summary){
      const relative=path.relative(path.join(root,'test-results/intake-t02'),path.resolve(summary.directory));
      if(relative.startsWith('..')||path.isAbsolute(relative)||relative.includes(path.sep)||!/^intake-t02-[A-Za-z0-9-]+$/.test(relative))throw Error('MATRIX_CHILD_PATH');
      if((await fs.lstat(summary.directory)).isSymbolicLink())throw Error('MATRIX_CHILD_LINK');
      const bytes=await fs.readFile(path.join(summary.directory,'manifest.json')),manifest=JSON.parse(bytes);
      const sources=await fs.readFile(path.join(summary.directory,'source-manifest.json'));
      const sourceRows=JSON.parse(sources).files;
      const originals=new Map(sourceRows.map(row=>[row.path,row.originalSha256??row.sha256]));
      if(!sharedSources)sharedSources=originals;
      else for(const [file,expected]of sharedSources)if(originals.get(file)!==expected)throw Error('MATRIX_SOURCE_CHANGED: '+file);
      observed={runId:manifest.runId,directory:relative,manifestSha256:hash(bytes),sourceManifestSha256:hash(sources),
        completed:manifest.completed,group:manifest.group,sharedSourceFiles:sharedSources.size,sharedSourcesUnchanged:true,
        cleanupComplete:manifest.resources.every(r=>r.removed===true)};
      if(manifest.runId!==relative||manifest.group!==args[1]||hash(sources)!==manifest.sourceManifestSha256)throw Error('MATRIX_CHILD_IDENTITY');
    }
    const record={name,args,startedAt,milliseconds:Date.now()-started,...result,observed};results.push(record);
    await fs.writeFile(path.join(output,name+'.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
    if(result.code!==0||result.signal!==null||!observed?.completed||!observed.cleanupComplete)throw Error('MATRIX_CHILD_FAILED: '+name);
  }
}catch(error){failure={name:error.name,message:error.message};}
await fs.writeFile(path.join(output,'result.json'),JSON.stringify({profile:'intake-t02-matrix/1',runId,suite,results,failure,
  completed:failure===null&&results.length===rows.length,milliseconds:results.reduce((sum,r)=>sum+r.milliseconds,0)},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({suite,output,completed:failure===null&&results.length===rows.length}));
if(failure)process.exitCode=1;
