import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const output=path.join(root,'test-results/intake-t01','mapping-mutants-'+randomUUID());
await fs.mkdir(output,{recursive:true});
const files=['package.json','src/contracts/intake.ts','src/contracts/intake_artifact.ts','src/contracts/intake_extraction.ts','src/contracts/intake_mapping.ts','src/contracts/intake_bindings.ts',
 'tests/intake/t01/fixtures.mjs','tests/intake/t01/artifact-consumer.mjs','tests/intake/t01/mapping.mjs','tests/intake/t01/bindings.mjs','tests/intake/t01/binding_fixtures.mjs','tests/intake/t01/binding_regressions.mjs','tests/intake/t01/reviewed/profile.mjs'];
const results=[];
for(const [id,file,before,after,suite,expected]of [
 ['lose-coverage','src/contracts/intake_mapping.ts',"coverage:x.outcome==='partial'?'partial':'complete'","coverage:'complete'",'mapping.mjs','X07 preserves scoped unprocessed causes'],
 ['accept-replacement','src/contracts/intake_mapping.ts','return same(preparation,projectTrial(trialMapping(source,context,antecedent)));','return true;','mapping.mjs','Wrong but intact resource'],
 ['coerce-identifier','src/contracts/intake_mapping.ts',"lexical:String(c.value??c.storedLexical??'')","lexical:String(Number(c.value??c.storedLexical??''))",'mapping.mjs','Independent Excel cache oracle X02'],
 ['grant-as-exercise','src/contracts/intake_bindings.ts',"faculty:choice('exercise')","faculty:choice('exercise','grant')",'bindings.mjs','Binding reserve_reception resolves exact references'],
 ['loading-consequence','src/contracts/intake_bindings.ts',"'stage-exact-original-attempt','FN-APROBACION',person,","'stage-exact-original-attempt','FN-APROBACION',continuation,",'bindings.mjs','Independent approved loading modes'],
 ['accept-as-load','src/contracts/intake_bindings.ts',"definition('intake-extraction-resolution/1','accept-current-worker-result'","definition('CARGAR_MATERIAL','accept-current-worker-result'",'bindings.mjs','Worker acceptance cannot be relabeled'],
 ['widen-processing','src/contracts/intake_bindings.ts',"if(!equal(s,processingSignature(value.operation as string,value)))return false;","if(false)return false;",'bindings.mjs','All eight processing dimensions'],
 ['merge-effects','src/contracts/intake_bindings.ts',"if(sameId(w.acceptance_effect,l.receipt_effect)||sameId(w.id,l.intention)||sameId(w.worker,l.person))return false;","if(false)return false;",'bindings.mjs','Receipt job and result acceptance'],
])test('Directed mutation '+id+' is caught at its independent observation',async()=>{
 const copy=path.join(output,id);const manifest=[];
 for(const relative of [...files,...(await fs.readdir(path.join(root,'tests/intake/t01/mapping-inputs'))).map(n=>'tests/intake/t01/mapping-inputs/'+n)]){
  let bytes=await fs.readFile(path.join(root,relative));
  if(relative===file){const source=bytes.toString('utf8');assert.equal(source.split(before).length-1,1);bytes=Buffer.from(source.replace(before,after));}
  await fs.mkdir(path.dirname(path.join(copy,relative)),{recursive:true});await fs.writeFile(path.join(copy,relative),bytes,{flag:'wx'});
  manifest.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-reporter=tap','tests/intake/t01/'+suite],{cwd:copy,env:environment,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:8388608});
 const observed={id,file,before,after,expected,code:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr};
 await fs.writeFile(path.join(copy,'execution.json'),JSON.stringify(observed,null,2),{flag:'wx'});
 await fs.writeFile(path.join(copy,'source-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
 assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,1);
 assert.ok(r.stdout.split('\n').some(line=>line.startsWith('not ok ')&&line.includes(expected)),r.stdout);
 results.push({id,expected,code:r.status,caught:true});
 await fs.writeFile(path.join(copy,'observation.json'),JSON.stringify(results.at(-1),null,2),{flag:'wx'});
 console.log('Mutation evidence: '+path.relative(root,copy).split(path.sep).join('/'));
});
