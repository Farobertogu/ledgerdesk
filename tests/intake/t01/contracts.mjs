import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {INTAKE_ROUTES,validateIntake,intakePath,decodeIntake,canonicalIntake,WORKER_RESULT,reconcileDisposition,PROFILE_REGISTRY} from '../../../src/contracts/intake.ts';
import {serializePreparation,readPreparation,validatePreparation,resourceSelectionMatches,validateIntakeProjection} from '../../../src/contracts/intake_artifact.ts';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {intakeViolations,checkIntake} from '../../../ci/intake_boundary_check.mjs';
import {prepared,commands,ref,resource} from './fixtures.mjs';
import {fileURLToPath} from 'node:url';
const base=fileURLToPath(new URL('../../../',import.meta.url));
for(const [key,body] of Object.entries(commands()))test('Command '+key+' has a positive and rejects authority injection',()=>{
 assert.equal(validateIntake(key,body),true);assert.equal(validateIntake(key,{...body,actor:'injected'}),false);
 const params=Object.fromEntries([...INTAKE_ROUTES[key].path.matchAll(/:([a-z_]+)/g)].map(m=>[m[1],['revision','generation'].includes(m[1])?'1':'opaque']));
 assert.ok(intakePath(key,params).startsWith('/api/intake/'));assert.throws(()=>intakePath(key,{...params,arbitrary:'x'}));
 if(!(body instanceof Uint8Array))assert.equal(validateIntake(key,{...body,profile:'access/1'}),false);
});
for(const invalid of ['{"x":1.0}','{"x":1e0}','{"x":-0}','{"x":01}','{"x":9007199254740992}','{"x":1,"x":2}','{"x":"\\ud800"}','{"x":0} false','\ufeff{}'])test('Strict decoder rejects '+invalid,()=>assert.throws(()=>decodeIntake(Buffer.from(invalid))));
test('Strict decoder preserves scalar strings, absent/null and non-BMP ordering',()=>{
 assert.deepEqual(decodeIntake(Buffer.from('{"x":null,"s":"Café 😀","i":1}')),{x:null,s:'Café 😀',i:1});
 assert.equal(canonicalValue({'\u{10000}':'B','\ue000':'A'}),'{"":"A","𐀀":"B"}');
 assert.notEqual(canonicalValue({}),canonicalValue({x:null}));assert.throws(()=>decodeIntake(new Uint8Array([0xc3])));
});
test('Canonical envelope is independent of insertion order and keeps object in payload',()=>{
 const first=commands().cancel_reception;
 const actual=canonicalIntake('cancel_reception',{id:'r1'},first,canonicalValue);
 assert.equal(actual,'{"body":{"expected_revision":1,"profile":"intake/1"},"contract":"intake/1","path":{"parameters":{"id":"r1"},"template":"/api/intake/receptions/:id/cancel"},"profile":"canon_m09_1","query":{},"variant":"cancel_reception"}');
 assert.equal(actual,canonicalIntake('cancel_reception',{id:'r1'},{expected_revision:1,profile:'intake/1'},canonicalValue));
 assert.notEqual(actual,canonicalIntake('cancel_reception',{id:'r2'},first,canonicalValue));
 assert.notEqual(actual,canonicalIntake('cancel_reception',{id:'r1'},{...first,expected_revision:2},canonicalValue));
});
test('Constitution requires the prior exact act only for an authorized consequence',()=>{
 const v=commands().constitute;assert.equal(validateIntake('constitute',{...v,mode:'authorized_consequence'}),false);
 assert.equal(validateIntake('constitute',{...v,mode:'authorized_consequence',prior_act:ref('act')}),true);
 assert.equal(validateIntake('constitute',{...v,prior_act:ref('act')}),false);
});
test('Fresh process reads a preserved representation without an oracle or producer objects',()=>{
 const p=prepared(),bytes=serializePreparation(p);
 const child=spawnSync(process.execPath,['--experimental-strip-types','tests/intake/t01/artifact-consumer.mjs'],{cwd:base,input:bytes,encoding:'utf8',timeout:10000,maxBuffer:8388608});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),p);
 p.elements[1].text='Later revision';assert.equal(readPreparation(Buffer.from(bytes)).elements[1].text,'Under Z, R replaces Q.');
});
for(const [name,mutate] of [
 ['dangling dependency',p=>p.elements.splice(1,1)],
 ['duplicate resource',p=>p.resources.push(structuredClone(p.resources[0]))],
 ['wrong resource generation',p=>p.elements[2].resource.generation=9],
 ['wrong difference pair',p=>p.differences[0].after=ref('other',2)],
 ['incident attributed to unexamined component',p=>p.incidents[0].component='unexamined'],
])test('Preparation rejects '+name,()=>{const p=prepared();assert.ok(validatePreparation(p));mutate(p);assert.equal(validatePreparation(p),false);});
test('X07 and component causes survive serialization; no schema-only semantic guarantee',()=>{
 const p=prepared();p.components.push({id:'other',execution:'not_attempted',coverage:'unknown',fidelity:'unchecked',limitations:[],incidents:['incident-2']});
 p.incidents.push({id:'incident-2',component:'other',cause:'technical_failure',detail:'Not examined after worker failure.'});
 assert.deepEqual(readPreparation(Buffer.from(serializePreparation(p))),p);
 const reduced=prepared();reduced.elements.splice(1,1);reduced.relations=[];reduced.differences=[];
 assert.equal(validatePreparation(reduced),true);
 assert.notDeepEqual(reduced.elements.map(e=>e.id),['rule','exception','figure','values']);
});
test('A valid wrong resource is not the independently selected resource; another operation can select it',()=>{
 const a=[{antecedent:ref('A-17'),element_id:'g7',resource:resource('R-1',7)}];
 const b=[{antecedent:ref('A-18'),element_id:'g9',resource:resource('R-2',9)}];
 assert.ok(resourceSelectionMatches(a,structuredClone(a)));assert.equal(resourceSelectionMatches(a,b),false);assert.ok(resourceSelectionMatches(b,structuredClone(b)));
});
test('Worker diagnostics describe retained bytes without overwriting primary cause',()=>{
 const v={profile:'intake-worker/1',operation_id:'op',generation:1,execution:'failed',output:null,primary_cause:'output_limit',diagnostics:{stdoutEncodingError:true,stderrEncodingError:false,stdoutTruncated:true,stderrTruncated:false}};
 assert.ok(WORKER_RESULT(v));assert.equal(v.primary_cause,'output_limit');assert.equal(WORKER_RESULT({...v,authenticated:true}),false);
});
test('Known effect, incompatible payload and uncertainty are distinct; no automatic execution',()=>{
 assert.equal(reconcileDisposition(true,true),'known_effect');assert.equal(reconcileDisposition(true,false),'conflict');assert.equal(reconcileDisposition(false,true),'uncertain');
});
test('Boundary rejects production imports, prototype escapes and contract implementation dependencies',()=>{
 assert.deepEqual(checkIntake(base).errors,[]);
 for(const [file,source]of[
 ['src/server/kb/x.ts',"import x from '../../contracts/intake.ts'"],
 ['src/contracts/intake.ts',"import fs from 'node:fs'"],
 ['src/contracts/intake_artifact.ts',"import p from '../server/access/policy.ts'"],
 ['src/app/x.ts',"import x from '../../tests/intake/t01/prototype.mjs'"],
 ['src/contracts/intake.ts',"const p=await import(target)"],
 ])assert.ok(intakeViolations(file,source).length,{file,source});
 assert.deepEqual(intakeViolations('src/contracts/intake_artifact.ts',"import {closed} from './intake.ts'"),[]);
});
test('Projection shapes keep receipt, preparation and constitution distinct',()=>{
 const op={profile:'intake/1',operation_id:'op',state:'known_effect',effect:ref('effect')};
 assert.ok(validateIntakeProjection('lookup_operation',op));
 assert.equal(validateIntakeProjection('lookup_operation',{...op,effect:null}),false);
 assert.equal(validateIntakeProjection('lookup_operation',{...op,state:'uncertain'}),false);
 assert.ok(validateIntakeProjection('preparation',{profile:'intake/1',preparation:prepared()}));
 assert.equal(validateIntakeProjection('preparation',{profile:'intake/1',preparation:prepared(),approved:true}),false);
 const candidate={profile:'intake/1',operation_id:'op',effect:ref('effect'),outcome:'constituted',candidates:[ref('candidate')]};
 assert.ok(validateIntakeProjection('constitute',candidate));
 assert.equal(validateIntakeProjection('constitute',{...candidate,outcome:'blocked'}),false);
 const neutral={profile:'intake/1',type:'about:blank',title:'Unavailable',status:404,code:'unavailable'};
 for(const key of Object.keys(INTAKE_ROUTES)){assert.ok(validateIntakeProjection(key,neutral));assert.equal(validateIntakeProjection(key,{...neutral,hidden_reason:'missing investiture'}),false);}
});
test('Prepared JSON rejects duplicate keys and preserves table context and lexical values',()=>{
 const p=prepared();p.elements[3].headers=['Value','Value'];
 p.elements[3].rows=[{index:0,fields:['001','0'],raw:'001,0\r\n',byte_range:[0,7]}];
 p.elements[3].sheet={source_id:'1',name:'Items',visibility:'hidden',merged:['A1:B1'],hidden_rows:['2'],columns:[{minimum:1,maximum:2,hidden:true,width_lexical:'12.50'}]};
 assert.deepEqual(readPreparation(Buffer.from(serializePreparation(p))),p);
 assert.throws(()=>readPreparation(Buffer.from('{"profile":"wrong",'+serializePreparation(p).slice(1))),/DUPLICATE/);
 p.inputs.push({...ref(),revision:2});assert.ok(validatePreparation(p));
 const sparse=prepared();sparse.inputs=new Array(1);assert.equal(validatePreparation(sparse),false);
});
test('Lost first receipt can be queried by stable intention without a client-authoritative digest',()=>{
 const body={profile:'intake/1',by:'intention',act:'load',variant:'reserve_reception',client_key:'key-1'};
 assert.ok(validateIntake('lookup_operation',body));
 assert.equal(validateIntake('lookup_operation',{...body,principal:'other'}),false);
 assert.equal(validateIntake('lookup_operation',{...body,compared:ref('self-authenticating')}),false);
});
test('Experimental profile cannot enable an operational route or silently loosen a bound',()=>{
 const profile={profile:'intake-profile/1',revision:1,operational:false,node:'22.16.0',candidates:[{format:'csv-utf8/1',adapter:'csv',source:ref()}],
 limits:{input_bytes:1048576,expanded_bytes:8388608,members:128,sheets:8,cells:10000,csv_records:1000,csv_columns:64,csv_record_utf16_units:65536,stdout_bytes:8388608,stderr_bytes:8192,wall_ms:10000,heap_mib:128,container_memory_mib:512,container_swap_mib:0,cpu_quota:1,pids:64,file_descriptors:128,concurrency:1}};
 assert.ok(PROFILE_REGISTRY(profile));assert.equal(PROFILE_REGISTRY({...profile,operational:true}),false);
 assert.equal(PROFILE_REGISTRY({...profile,limits:{...profile.limits,cells:10001}}),false);
 assert.equal(PROFILE_REGISTRY({...profile,candidates:[{...profile.candidates[0],adapter:'xlsx'}]}),false);
 assert.equal(PROFILE_REGISTRY({...profile,candidates:[...profile.candidates,...profile.candidates]}),false);
});

test('Prototype dependency lock contains no repository link or extraneous package',async()=>{
 const fs=await import('node:fs/promises');
 const lock=JSON.parse(await fs.readFile(new URL('./package-lock.json',import.meta.url),'utf8'));
 assert.deepEqual(lock.packages[''].dependencies,{pg:'8.23.0'});
 for(const [key,value]of Object.entries(lock.packages)){
  assert.ok(key===''||key.startsWith('node_modules/'),key);
  assert.equal(value.extraneous,undefined,key);
  assert.equal(value.link,undefined,key);
  if(value.resolved)assert.ok(value.resolved.startsWith('https://registry.npmjs.org/'),key);
 }
});
