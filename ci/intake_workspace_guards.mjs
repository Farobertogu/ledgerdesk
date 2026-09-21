import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {qualifyExtractionGuard} from './intake_extraction_guard_checks.mjs';

export const workspaceGuard=Object.freeze({name:'omit-post-response-session',tests:['W23 original-inspection guards its actual response adoption']});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,2);
  const root=fileURLToPath(new URL('../',import.meta.url)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const output=path.join(root,'test-results/intake-extraction/guard-controls','workspace-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  await fs.mkdir(output,{recursive:true});
  await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'guard_checks.mjs'),fs.constants.COPYFILE_EXCL);
  const rows=[];let failure=null;
  try{for(const mutated of [false,true]){
    const args=['--experimental-strip-types','ci/intake_t02_check.mjs','--group','extraction','--extraction-cases','preparation',
      '--preparation-cases','ui-adoption-reception','--adoption-site','original-inspection',
      ...(mutated?['--workspace-mutation',workspaceGuard.name]:[])];
    let tail='';const started=Date.now();
    // The bounded runner owns command deadlines and resource cleanup. Do not
    // terminate its parent independently or treat a timeout as discrimination.
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','inherit']});
      child.stdout.on('data',bytes=>{tail=(tail+bytes).slice(-262144);});
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
    });
    const summary=tail.trim().split('\n').flatMap(line=>{try{const value=JSON.parse(line);return value.directory?[value]:[];}catch{return[];}}).at(-1);
    assert.ok(summary,'Both executions must retain their evidence.');
    assert.match(path.relative(path.join(root,'test-results/intake-extraction'),summary.directory),/^intake-extraction-[A-Za-z0-9-]+$/);
    const mb=await fs.readFile(path.join(summary.directory,'manifest.json')),sb=await fs.readFile(path.join(summary.directory,'source-manifest.json'));
    const manifest=JSON.parse(mb),source=JSON.parse(sb);
    const records=await Promise.all(manifest.commands.map(c=>fs.readFile(path.join(summary.directory,c.file),'utf8').then(JSON.parse)));
    const executions=records.filter(r=>r.program==='docker'&&r.args?.[0]==='start'&&r.args?.[1]==='-a'&&r.args?.[2]?.endsWith('-runtime'));
    assert.equal(executions.length,1);const execution=executions[0];
    rows.push({mutation:mutated?workspaceGuard.name:null,args,...result,milliseconds:Date.now()-started,directory:summary.directory,
      manifestSha256:hash(mb),sourceManifestSha256:hash(sb)});
    assert.equal(result.signal,null);assert.equal(execution.reason??null,null);assert.equal(execution.code,mutated?1:0);
    if(mutated){assert.equal(result.code,1);qualifyExtractionGuard(workspaceGuard,manifest,source,execution.stdout);}
    else{assert.equal(result.code,0);assert.equal(manifest.completed,true);assert.ok(manifest.resources.every(r=>r.removed===true));}
    console.log(JSON.stringify({mutation:mutated?workspaceGuard.name:null,qualified:true,directory:summary.directory}));
  }}catch(error){failure={name:error.name,message:error.message};}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({profile:'intake-workspace-guards/1',rows,failure,completed:!failure},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,completed:!failure}));if(failure)process.exitCode=1;
}
