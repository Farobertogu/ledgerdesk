import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'test-results/intake-t02/failure-controls','failure-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
await fs.mkdir(output,{recursive:true});
await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'failure_checks.mjs'),fs.constants.COPYFILE_EXCL);
const rows=[];let failure=null;
try{
  for(const fault of ['before-connect','evidence-export']){
    let stdout='',stderr='';const started=Date.now();
    const args=['ci/intake_t02_check.mjs','--group','runtime','--lifecycle-fault',fault];
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-262144);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
    });
    const summary=stdout.trim().split('\n').flatMap(line=>{try{const r=JSON.parse(line);return r.directory?[r]:[];}catch{return[];}}).at(-1);
    assert.ok(summary);const relative=path.relative(path.join(root,'test-results/intake-t02'),summary.directory);
    assert.ok(/^intake-t02-[A-Za-z0-9-]+$/.test(relative));
    const manifestBytes=await fs.readFile(path.join(summary.directory,'manifest.json')),manifest=JSON.parse(manifestBytes);
    const commands=await Promise.all(manifest.commands.map((_,i)=>fs.readFile(path.join(summary.directory,String(i+1).padStart(3,'0')+'-command.json'),'utf8').then(JSON.parse)));
    const logs=commands.map(c=>c.stdout??'').join('\n');
    const row={fault,args,...result,milliseconds:Date.now()-started,directory:summary.directory,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),
      completed:manifest.completed,failure:manifest.failure,resources:manifest.resources,sqlCleaned:logs.includes('ACCESS_PG_CLEANED'),runtimeCleaned:logs.includes('INTAKE_T02_RUNTIME_CLEANED')};
    rows.push(row);await fs.writeFile(path.join(output,fault+'.json'),JSON.stringify({...row,stdout,stderr},null,2),{flag:'wx'});
    assert.equal(result.code,1);assert.equal(result.signal,null);assert.equal(manifest.completed,false);assert.ok(row.milliseconds<300000);
    assert.ok(manifest.resources.length>0&&manifest.resources.every(r=>r.removed===true));assert.equal(row.sqlCleaned,true);
    assert.equal(await fs.stat(path.join(root,'test-results/intake-t02/.active-run')).then(()=>true,()=>false),false);
    if(fault==='before-connect')assert.match(logs,/EXPECTED_T02_BEFORE_SQL_CONNECT/);
    else{
      assert.equal(row.runtimeCleaned,true);assert.equal(manifest.failure.message,'T02_EVIDENCE_EXPORT_INCOMPLETE');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(summary.directory,'evidence-exports.json'),'utf8')).map(r=>({destination:r.destination,complete:r.complete})),
        [{destination:'runtime',complete:false},{destination:'objects',complete:true},{destination:'verifier',complete:true}]);
    }
    console.log(JSON.stringify({fault,controlledFailure:true,resourcesRemoved:manifest.resources.length,milliseconds:row.milliseconds}));
  }
}catch(error){failure={name:error.name,message:error.message};}
await fs.writeFile(path.join(output,'result.json'),JSON.stringify({rows,failure,completed:failure===null&&rows.length===2},null,2),{flag:'wx'});
console.log(JSON.stringify({output,completed:failure===null&&rows.length===2}));if(failure)process.exitCode=1;
