import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {producerFaultGroups} from './intake/reception/producer_fault.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const output=path.join(root,'test-results/intake-t02/producer-controls','producer-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
await fs.mkdir(output,{recursive:true});await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'producer_checks.mjs'),fs.constants.COPYFILE_EXCL);
const names={
  'original-selection':'original absence and protected ownership',
  'actual-digest':'wrong actual digest cannot produce a receipt',
  'actual-chunk-cap':'actual bounded intake: at-byte-limit',
  'type-recognition':'actual bounded intake: pdf-as-xlsx',
  'compatible-payload':'concurrent compatible intentions share the principal',
  'sealed-as-receipt':'finalization produces one receipt and a distinct unstarted job',
  'whole-original-faculty':'record faculty does not authorize any original storage access',
  'delivery-evidence':'governed JSON and original share durable evidence and idle SQL before handoff',
  'deferred-dispatch':'finalization produces one receipt and a distinct unstarted job',
  'runtime-source':'tests/intake/t02/test_runtime.mjs',
};
const rows=[];let failure=null;
const requested=process.argv.includes('--faults')?process.argv[process.argv.indexOf('--faults')+1].split(','):Object.keys(producerFaultGroups);
assert.ok(requested.length>0&&new Set(requested).size===requested.length&&requested.every(name=>Object.hasOwn(producerFaultGroups,name)),'Explicit known producer mutations required');
async function execute(group,fault=null){
  const args=['ci/intake_t02_check.mjs','--group',group,...(fault?['--producer-mutation',fault]:[])];
  let tail='';const started=Date.now();const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','inherit']});
    child.stdout.setEncoding('utf8');child.stdout.on('data',b=>{tail=(tail+b).slice(-262144);});
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  const summary=tail.trim().split('\n').flatMap(line=>{try{const r=JSON.parse(line);return r.directory?[r]:[];}catch{return[];}}).at(-1);
  assert.ok(summary);assert.match(path.relative(path.join(root,'test-results/intake-t02'),summary.directory),/^intake-t02-[A-Za-z0-9-]+$/);
  const manifestBytes=await fs.readFile(path.join(summary.directory,'manifest.json')),manifest=JSON.parse(manifestBytes);
  const sourceBytes=await fs.readFile(path.join(summary.directory,'source-manifest.json')),sources=JSON.parse(sourceBytes).files;
  const commands=await Promise.all(manifest.commands.map((_,i)=>fs.readFile(path.join(summary.directory,String(i+1).padStart(3,'0')+'-command.json'),'utf8').then(JSON.parse)));
  const logs=commands.map(c=>c.stdout??'').join('\n'),failures=logs.split('\n').filter(line=>/^\s*not ok \d+ - /.test(line));
  const row={group,fault,args,...result,milliseconds:Date.now()-started,directory:summary.directory,manifestSha256:hash(manifestBytes),sourceManifestSha256:hash(sourceBytes),
    completed:manifest.completed,failure:manifest.failure,changed:sources.filter(r=>r.fault),failedNames:[...new Set(failures)],
    allResourcesRemoved:manifest.resources.length>0&&manifest.resources.every(r=>r.removed===true)};
  rows.push(row);await fs.writeFile(path.join(output,(fault??'baseline-'+group)+'.json'),JSON.stringify(row,null,2),{flag:'wx'});
  assert.equal(result.signal,null);assert.ok(row.allResourcesRemoved);assert.ok(row.milliseconds<300000);
  if(!fault){assert.equal(result.code,0);assert.equal(manifest.completed,true);}
  else if(fault==='actual-digest'){
    assert.equal(result.code,0);assert.equal(manifest.completed,true);assert.equal(row.changed.filter(r=>r.fault==='producer-'+fault).length,1);
    const e=JSON.parse(await fs.readFile(path.join(summary.directory,'runtime/digest-order.json'),'utf8'));
    assert.deepEqual(e.observed,{status:400,receipts:0,appendedBytes:17,formatEntries:0});assert.ok(e.readEvents>0);assert.ok(e.positiveVerifier.length>0);
    row.classification='redundant-early-check: broker integrity validation still refuses before format verification';
  }
  else{
    assert.equal(result.code,1);assert.equal(manifest.completed,false);assert.equal(manifest.failure?.message,'T02_RUNTIME_FAILED');
    assert.equal(row.changed.filter(r=>r.fault==='producer-'+fault).length,1);
    assert.ok(row.failedNames.some(name=>name.includes(names[fault])),JSON.stringify(row.failedNames));
    if(fault!=='runtime-source')assert.ok(logs.includes('INTAKE_T02_RUNTIME_CLEANED'));
    if(fault==='runtime-source'){
      assert.ok(logs.includes("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/src/server/intake/authority.ts'"));
      assert.ok(!logs.includes('INTAKE_RUNTIME_IDENTITY'),'Omission fails actual module loading before the runtime or database is initialized');
      row.classification='actual image source omission detected by Node module loading, before SQL initialization';
    }
    if(fault==='original-selection'){
      const e=JSON.parse(await fs.readFile(path.join(summary.directory,'runtime/completion/neutrality-original.json'),'utf8'));
      assert.ok(e.selectedAfter>e.selectedBefore,'Selection must actually occur under the mutation');assert.equal(e.mismatches.length,0);
    }
  }
  console.log(JSON.stringify({group,fault,expectedResult:true,milliseconds:row.milliseconds,directory:summary.directory}));
}
try{
  for(const group of [...new Set(requested.map(name=>producerFaultGroups[name]))]){
    await execute(group);
    for(const fault of requested)if(producerFaultGroups[fault]===group)await execute(group,fault);
  }
}catch(error){failure={name:error.name,message:error.message};}
await fs.writeFile(path.join(output,'result.json'),JSON.stringify({requested,rows,failure,completed:failure===null,scope:'Selected named producer mutations, not the independent 53-variant ledger.'},null,2),{flag:'wx'});
console.log(JSON.stringify({output,completed:failure===null}));if(failure)process.exitCode=1;
