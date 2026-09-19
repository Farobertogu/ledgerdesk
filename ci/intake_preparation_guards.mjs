import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {qualifyExtractionGuard} from './intake_extraction_guard_checks.mjs';

// Reuse the existing bounded runner and assertion/cleanup qualifier. These
// eight controls mutate captured copies; a timeout is never a killed mutant.
export const preparationGuards=Object.freeze([
  {group:'fidelity',name:'drop-retained-context',tests:['H01 independently declared reorder']},
  {group:'formats',name:'drop-retained-limitation',tests:['F03 X07 retains']},
  {group:'resources',name:'swap-resource-at-birth',tests:['R02 OP-V-17 persists']},
  {group:'resources',name:'swap-resource-at-consume',tests:['R02 OP-V-17 persists']},
  {group:'mixed',name:'flatten-component-causes',tests:['M-known preserves component causes']},
  {group:'identity',name:'ignore-c9-conditions',tests:['C02 condition incompatibility']},
  {group:'concurrency',name:'drop-item-lock',tests:['K-same-item real overlapping']},
  {group:'prior-act',name:'drop-prior-target',tests:['A02 valid integrity']},
]);

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,2,'The CI guard entry runs the complete finite list.');
  const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
  const output=path.join(root,'test-results/intake-extraction/guard-controls','preparation-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  await fs.mkdir(output,{recursive:true});await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'guard_checks.mjs'),fs.constants.COPYFILE_EXCL);
  const plan=[],seen=new Set(),rows=[];let failure=null;
  for(const c of preparationGuards){if(!seen.has(c.group)){plan.push({group:c.group,name:null});seen.add(c.group);}plan.push(c);}
  try{for(const c of plan){
    const args=['--experimental-strip-types','ci/intake_t02_check.mjs','--group','extraction','--extraction-cases','preparation',
      '--preparation-cases',c.group,...(c.name?['--preparation-mutation',c.name]:[])];
    let tail='';const started=Date.now();
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','inherit']});
      child.stdout.on('data',b=>{tail=(tail+b).slice(-262144);});
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
    });
    const summary=tail.trim().split('\n').flatMap(line=>{try{const v=JSON.parse(line);return v.directory?[v]:[];}catch{return[];}}).at(-1);
    assert.ok(summary,'Runner must retain evidence including failed executions.');
    assert.match(path.relative(path.join(root,'test-results/intake-extraction'),summary.directory),/^intake-extraction-[A-Za-z0-9-]+$/);
    const mb=await fs.readFile(path.join(summary.directory,'manifest.json')),sb=await fs.readFile(path.join(summary.directory,'source-manifest.json'));
    const m=JSON.parse(mb),s=JSON.parse(sb),records=await Promise.all(m.commands.map(c=>fs.readFile(path.join(summary.directory,c.file),'utf8').then(JSON.parse)));
    const executions=records.filter(r=>r.program==='docker'&&r.args?.[0]==='start'&&r.args?.[1]==='-a'&&r.args?.[2]?.endsWith('-runtime'));
    assert.equal(executions.length,1);const execution=executions[0];
    rows.push({group:c.group,mutation:c.name,args,...result,milliseconds:Date.now()-started,directory:summary.directory,
      manifestSha256:hash(mb),sourceManifestSha256:hash(sb)});
    assert.equal(result.signal,null);assert.equal(execution.reason??null,null);assert.equal(execution.code,c.name?1:0);
    if(c.name){assert.equal(result.code,1);qualifyExtractionGuard(c,m,s,execution.stdout);}
    else{assert.equal(result.code,0);assert.equal(m.completed,true);assert.ok(m.resources.every(r=>r.removed===true));}
    console.log(JSON.stringify({group:c.group,mutation:c.name,qualified:true,directory:summary.directory}));
  }}catch(error){failure={name:error.name,message:error.message};}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({profile:'intake-preparation-guards/1',rows,failure,completed:!failure},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,completed:!failure}));if(failure)process.exitCode=1;
}
