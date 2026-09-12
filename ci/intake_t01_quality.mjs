import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const id=process.argv[2];if(!id||!/^[a-z0-9-]+$/.test(id))throw Error('Supply a new quality run id');
const directory=path.join(root,'test-results/intake-t01',id);await fs.mkdir(directory);
const checks=[
 ['types',process.execPath,['node_modules/typescript/bin/tsc','--noEmit']],
 ['app-types',process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.app.json']],
 ['intake-boundary',process.execPath,['ci/intake_boundary_check.mjs']],
 ['access-boundary',process.execPath,['ci/access_boundary_check.mjs']],
 ['reading-boundary',process.execPath,['ci/reading_boundary_check.mjs']],
 ['retained-access',process.execPath,['--experimental-strip-types','--test','tests/access/test_contracts.mjs','tests/access/test_transport.mjs','tests/access/test_boundaries_mutations.mjs','tests/access/test_security.mjs','tests/access/test_canonical.mjs']],
 ['repository',process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash',['ci/check.sh']],
 ['build',process.execPath,['node_modules/next/dist/bin/next','build']],
];
const results=[];
for(const [name,bin,args]of checks){
 const result=await new Promise(resolve=>{
  const child=spawn(bin,args,{cwd:root,windowsHide:true,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',LEDGERDESK_READING_TRIAL:'0',LEDGERDESK_DEV_IDENTITY:'0'},stdio:['ignore','pipe','pipe']});
  const out=[],err=[];let bytes=0,cause;const start=Date.now();
  const collect=(list,chunk)=>{bytes+=chunk.length;if(bytes>16777216){cause='output_limit';child.kill();}else list.push(chunk);};
  child.stdout.on('data',c=>collect(out,c));child.stderr.on('data',c=>collect(err,c));
  const timer=setTimeout(()=>{cause='timeout';child.kill();},180000);
  child.on('error',e=>{clearTimeout(timer);resolve({code:null,cause:e.code,stdout:'',stderr:e.message});});
  child.on('close',code=>{clearTimeout(timer);resolve({code,cause,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8'),milliseconds:Date.now()-start});});
 });
 await fs.writeFile(path.join(directory,name+'.json'),JSON.stringify({args,...result},null,2),{flag:'wx'});
 results.push({name,code:result.code,cause:result.cause,milliseconds:result.milliseconds});
 console.log(name+': '+result.code);if(result.code!==0||result.cause)process.exitCode=1;
}
await fs.writeFile(path.join(directory,'quality.json'),JSON.stringify(results,null,2),{flag:'wx'});

