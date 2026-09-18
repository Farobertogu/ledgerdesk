import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
export const extractionGuards=Object.freeze({
  resources:[
    {group:'resources',name:'omit-resource-relation-store',tests:['RES01 actual admitted','RES04 a distinct operation']},
    {group:'resources',name:'read-resource-before-validation',tests:['RES02 invalid association','RES03 invalid association']},
    {group:'resources',name:'allow-resource-swap',tests:['RES02 invalid association']},
    {group:'semantics',name:'omit-condition-store',tests:['SEM semantic.txt']},
    {group:'semantics',name:'omit-limitation-store',tests:['SEM unsupported-part.xlsx']},
    {group:'semantics',name:'omit-incident-query',tests:['SEM unsupported-part.xlsx']},
  ],
  formats:[
    {group:'format-negatives',name:'xlsx-recalculate-store',tests:['FN cache-discrepant.xlsx']},
    {group:'format-negatives',name:'xlsx-hide-sheet-store',tests:['FN cache-discrepant.xlsx']},
    {group:'format-negatives',name:'xlsx-context-store',tests:['FN cache-discrepant.xlsx']},
  ],
});
export function qualifyExtractionGuard(control,m,s,logs){
  assert.equal(m.completed,false);assert.equal(m.failure?.message,'T02_RUNTIME_FAILED');
  assert.equal(s.files.filter(r=>r.fault===control.name).length,1);
  assert.ok(m.resources.length>0&&m.resources.every(r=>r.removed===true));
  assert.ok(logs.includes('INTAKE_T02_RUNTIME_CLEANED')&&logs.includes('ACCESS_PG_CLEANED'));
  assert.match(logs,/^# cancelled 0$/m);
  assert.doesNotMatch(logs,/testTimeoutFailure|Extraction capacity occupied|MAPPING_PRODUCER|EXTRACTION_RESOURCE_SHAPE/);
  for(const name of control.tests){
    // Match the actual failed subtest and its own assertion block, not a later
    // timeout, parent failure or a different case with the same exit status.
    const blocks=logs.split(/(?=^\s*(?:not )?ok \d+ - )/m);
    assert.ok(blocks.some(b=>b.split('\n')[0].includes('not ok ')&&b.split('\n')[0].includes(name)&&
      b.includes("code: 'ERR_ASSERTION'")),control.name+': '+name);
  }
  return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);assert.equal(args.length,2);assert.equal(args[0],'--suite');
  const cases=extractionGuards[args[1]];assert.ok(cases,'Explicit finite guard suite required');
  const output=path.join(root,'test-results/intake-extraction/guard-controls',args[1]+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
  await fs.mkdir(output,{recursive:true});await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'guard_checks.mjs'),fs.constants.COPYFILE_EXCL);
  const plan=[],baselines=new Set();
  for(const c of cases){if(!baselines.has(c.group)){plan.push({group:c.group,name:null});baselines.add(c.group);}plan.push(c);}
  const rows=[];let failure=null;
  try{for(const c of plan){
    const runArgs=['--experimental-strip-types','ci/intake_t02_check.mjs','--group','extraction','--extraction-cases',c.group,
      ...(c.name?['--extraction-mutation',c.name]:[])];let tail='';const started=Date.now();
    // The existing runner owns bounded commands and cleanup. Do not kill its
    // parent independently and leave resources behind.
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,runArgs,{cwd:root,windowsHide:true,stdio:['ignore','pipe','inherit']});
      child.stdout.on('data',b=>{tail=(tail+b).slice(-262144);});
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
    });
    const summary=tail.trim().split('\n').flatMap(l=>{try{const v=JSON.parse(l);return v.directory?[v]:[];}catch{return[];}}).at(-1);
    assert.ok(summary,'Runner must retain its identified failed or successful evidence');
    assert.match(path.relative(path.join(root,'test-results/intake-extraction'),summary.directory),/^intake-extraction-[A-Za-z0-9-]+$/);
    const mb=await fs.readFile(path.join(summary.directory,'manifest.json')),sb=await fs.readFile(path.join(summary.directory,'source-manifest.json'));
    const m=JSON.parse(mb),s=JSON.parse(sb),records=await Promise.all(m.commands.map(c=>fs.readFile(path.join(summary.directory,c.file),'utf8').then(JSON.parse)));
    // Only the attached runtime execution, not later docker-log retrieval.
    const executions=records.filter(r=>r.program==='docker'&&r.args?.[0]==='start'&&r.args?.[1]==='-a'&&r.args?.[2]?.endsWith('-runtime'));
    assert.equal(executions.length,1);const logs=executions[0].stdout;
    assert.equal(executions[0].code,c.name?1:0);assert.equal(executions[0].reason??null,null);
    assert.match(logs,/^# cancelled 0$/m);
    rows.push({group:c.group,mutation:c.name,args:runArgs,...result,milliseconds:Date.now()-started,directory:summary.directory,
      manifestSha256:hash(mb),sourceManifestSha256:hash(sb)});
    assert.equal(result.signal,null);
    if(c.name){assert.equal(result.code,1);qualifyExtractionGuard(c,m,s,logs);}
    else{assert.equal(result.code,0);assert.equal(m.completed,true);assert.ok(m.resources.every(r=>r.removed===true));}
    console.log(JSON.stringify({group:c.group,mutation:c.name,qualified:true,directory:summary.directory}));
  }}catch(error){failure={name:error.name,message:error.message};}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({profile:'intake-extraction-guards/1',rows,failure,completed:!failure},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,completed:!failure}));if(failure)process.exitCode=1;
}
