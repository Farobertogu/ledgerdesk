import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
export const guardCases=[
  {name:'pre-capture',group:'boundaries',args:['--boundary-mutation','early-read'],fault:'explicit-read-before-intake-admission',failure:'T02_RUNTIME_FAILED',test:'structured metadata at 65536 bytes'},
  {name:'continuation-epoch',group:'fence-continuation',args:['--omit-epoch-check'],fault:'omit-continuation-epoch-check',failure:'T02_RUNTIME_FAILED',test:'F14 treatment changes after closure'},
  {name:'closed-before-open',group:'phase-prototype',args:['--forget-unseen-close'],fault:'forget-unseen-close',failure:'PHASE_PROTOTYPE_FAILED',test:'CLOSE before OPEN is durable'},
];
export function qualifyGuard(c,m,s,logs){
  assert.equal(m.completed,false);assert.equal(m.failure?.message,c.failure);
  assert.equal(s.files.filter(r=>r.fault===c.fault).length,1);
  assert.ok(m.resources.length>0&&m.resources.every(r=>r.removed===true));
  assert.ok(logs.split('\n').some(l=>/^\s*not ok \d+ - /.test(l)&&l.includes(c.test)),c.name);
  if(c.group!=='phase-prototype')assert.ok(logs.includes('INTAKE_T02_RUNTIME_CLEANED'));
  return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const output=path.join(root,'test-results/intake-t02/guard-controls','guards-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  await fs.mkdir(output,{recursive:true});await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'guard_checks.mjs'),fs.constants.COPYFILE_EXCL);
  const rows=[];let failure=null;
  try{for(const c of guardCases)for(const mutation of [false,true]){
    const args=['ci/intake_t02_check.mjs','--group',c.group,...(mutation?c.args:[])];let tail='';const start=Date.now();
    const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','inherit']});
      child.stdout.on('data',b=>tail=(tail+b).slice(-262144));child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    const summary=tail.trim().split('\n').flatMap(l=>{try{const r=JSON.parse(l);return r.directory?[r]:[];}catch{return[];}}).at(-1);assert.ok(summary);
    assert.match(path.relative(path.join(root,'test-results/intake-t02'),summary.directory),/^intake-t02-[A-Za-z0-9-]+$/);
    const mb=await fs.readFile(path.join(summary.directory,'manifest.json')),sb=await fs.readFile(path.join(summary.directory,'source-manifest.json')),m=JSON.parse(mb),s=JSON.parse(sb);
    const logs=(await Promise.all(m.commands.map(x=>fs.readFile(path.join(summary.directory,x.file),'utf8').then(JSON.parse)))).map(x=>x.stdout??'').join('\n');
    rows.push({name:c.name,mutation,args,...result,milliseconds:Date.now()-start,directory:summary.directory,manifestSha256:hash(mb),sourceManifestSha256:hash(sb)});
    assert.equal(result.signal,null);assert.ok(rows.at(-1).milliseconds<300000);
    if(mutation){assert.equal(result.code,1);qualifyGuard(c,m,s,logs);}else{assert.equal(result.code,0);assert.equal(m.completed,true);assert.ok(m.resources.every(r=>r.removed===true));}
  }}catch(e){failure={name:e.name,message:e.message};}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({rows,failure,completed:!failure},null,2),{flag:'wx'});
  console.log(JSON.stringify({output,completed:!failure}));if(failure)process.exitCode=1;
}
