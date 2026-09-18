import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
// Actual entry points in a freshly installed Linux package. This is the
// dependency/wiring slice; service and worker containers run in their owned
// harnesses, not through a daemon socket granted to this container.
const commands=[
  ['--experimental-strip-types','--test','tests/intake/extraction/seal.mjs'],
  ['--test','tests/intake/t02/test_ci_wiring.mjs','tests/intake/extraction/ci_evidence.mjs'],
  ['ci/intake_ci_check.mjs'],['ci/intake_boundary_check.mjs'],['ci/access_boundary_check.mjs'],
  ['--experimental-strip-types','ci/intake_extraction_check.mjs','--group','units'],
  ['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.app.json']
];
const results=[];
for(const args of commands){
  const start=Date.now();
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{stdio:'inherit'});child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
  });
  results.push({args,...result,milliseconds:Date.now()-start});
  if(result.code!==0||result.signal!==null)break;
}
const completed=results.length===commands.length&&results.every(r=>r.code===0&&r.signal===null);
await writeFile('/work/test-results/clean-package.json',JSON.stringify({profile:'intake-extraction-clean-package/1',node:process.version,results,completed},null,2)+'\n',{flag:'wx'});
if(!completed)process.exitCode=1;
