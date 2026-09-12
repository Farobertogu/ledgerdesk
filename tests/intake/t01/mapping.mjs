import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {retain,restore,trialMapping,projectTrial,mappingSourceMatches,trialFailure,producerMapping} from '../../../src/contracts/intake_mapping.ts';
import {serializePreparation,readPreparation,validatePreparation} from '../../../src/contracts/intake_artifact.ts';
import {PROFILE} from './reviewed/profile.mjs';
import {ref} from './fixtures.mjs';
const base=fileURLToPath(new URL('../../../',import.meta.url));
const input=name=>JSON.parse(fs.readFileSync(new URL('./mapping-inputs/'+name+'.json',import.meta.url),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
function setup(id){
 const x=input(id+'-extraction');
 const ctx={preparation:ref('P-T',2),source:{...ref('extraction-'+id),sha256:hash(JSON.stringify(x))},original:{...ref('original'),sha256:x.original.sha256},profile:ref('retained-profile'),resources:[],differences:[],observations:{raw:input(id+'-raw'),profile_definition:PROFILE}};
 return {x,ctx};
}
function consume(p){
 const r=spawnSync(process.execPath,['--experimental-strip-types','tests/intake/t01/artifact-consumer.mjs'],{cwd:base,input:serializePreparation(p),encoding:'utf8',timeout:10000,maxBuffer:8388608});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('Retained observations are byte-identical snapshots, not a new extractor execution',()=>{
 for(const r of input('PROVENANCE').records){const b=fs.readFileSync(new URL('./mapping-inputs/'+r.path,import.meta.url));assert.deepEqual({bytes:b.length,sha256:hash(b)},{bytes:r.bytes,sha256:r.sha256});}
});
for(const id of ['T01','T02','T03','C01','X01','X02','X03','X04','X07'])test('Map retained '+id+' through a fresh consumer with full round trip',()=>{
 const {x,ctx}=setup(id);const p=projectTrial(trialMapping(x,ctx));
 assert.equal(validatePreparation(p),true,id);const received=consume(p);
 assert.deepEqual(restore(received.trial_mapping.source),x);
 assert.deepEqual(restore(received.trial_mapping.context),ctx);
 assert.equal(mappingSourceMatches(received,x,ctx),true);
 assert.equal(received.current_use,'not_evaluated');
});
test('Text uses literal independent Unicode ranges and preserves CRLF and BOM evidence',()=>{
 const {x,ctx}=setup('T01');const p=projectTrial(trialMapping(x,ctx));
 assert.deepEqual({text:p.elements[2].text,range:p.elements[2].antecedents[0].byte_range},{text:'Under condition Z, receipt R replaces receipt Q.\r\n',range:[52,102]});
 assert.deepEqual(restore(p.trial_mapping.source).elements[5].locator.codePointRange,[159,191]);
 assert.equal(restore(p.trial_mapping.source).elements[5].text,'Español: información. Café. 😀\r\n');
});
test('CSV preserves positional duplicate headers and independent exact original ranges, not parser raw',()=>{
 const {x,ctx}=setup('C01');const p=consume(projectTrial(trialMapping(x,ctx)));const t=p.elements[0];
 assert.deepEqual(t.headers,['Code','Value','Value','Note']);
 assert.deepEqual(t.rows[2].fields,['002','12.50','=B2*C2','Line one\r\nLine two']);
 assert.deepEqual(t.rows[0],{index:0,fields:['Code','Value','Value','Note'],raw:'Code,Value,Value,Note\r\n',byte_range:[0,23]});
 assert.equal(restore(p.trial_mapping.context).observations.raw[0].raw,'Code,Value,Value,Note\r');
});
for(const [id,expected]of [['X01','25.00'],['X02','24.00'],['X03',null],['X04','0']])test('Independent Excel cache oracle '+id,()=>{
 const {x,ctx}=setup(id);const p=projectTrial(trialMapping(x,ctx));const sheet=p.elements[0];const c=sheet.cells.find(c=>c.address==='D2');
 assert.equal(c.formula,'B2*C2');assert.deepEqual(c.cached,expected===null?{kind:'missing',lexical:''}:{kind:'number_lexical',lexical:expected});
 assert.deepEqual(sheet.cells.find(c=>c.address==='A2').value,{kind:'text',lexical:'001'});
 assert.equal(p.elements[1].sheet.visibility,'hidden');
 assert.equal(p.elements[1].cells.find(c=>c.address==='B2').value.lexical,'Under condition Z, receipt R replaces receipt Q.');
});
test('X01 Items column A retains customWidth while projecting only the four declared fields',()=>{
 // Literal expectations precede conversion and do not come from its manifest or output.
 const expected={
  retained:{'@_min':'1','@_max':'1','@_width':'19','@_hidden':'0','@_customWidth':'1'},
  projected:{minimum:1,maximum:1,hidden:false,width_lexical:'19'},
 };
 const {x,ctx}=setup('X01');
 const converted=consume(projectTrial(trialMapping(x,ctx)));
 const retainedSheet=restore(converted.trial_mapping.source).elements.find(e=>e.id==='sheet-1');
 const projectedSheet=converted.elements.find(e=>e.id==='sheet-1').sheet;
 assert.deepEqual({retained:[retainedSheet.name,retainedSheet.sourceSheetId],projected:[projectedSheet.name,projectedSheet.source_id]},
  {retained:['Items','1'],projected:['Items','1']});
 const observed={retained:retainedSheet.columns[0],projected:projectedSheet.columns[0]};
 console.log('Column retention/projection: '+JSON.stringify({input:'X01-extraction.json',sheet:'Items',sourceSheetId:'1',column:'A',expected,observed}));
 assert.deepEqual(observed,expected,'The converted result must retain every literal attribute and project exactly the declared fields for the same column');
});

test('X07 preserves scoped unprocessed causes through a selected candidate; text equality is insufficient',()=>{
 const {x,ctx}=setup('X07');const c=input('P08');
 c.canonical.elements=structuredClone(x.elements);c.canonicalSha256=undefined;delete c.canonicalSha256;
 const p=projectTrial(trialMapping(c,ctx,x));assert.equal(p.components[0].coverage,'partial');assert.ok(p.incidents.length>0);
 assert.ok(p.components.slice(1).every(c=>c.execution==='not_attempted'&&c.coverage==='none'));
 const bad=structuredClone(p);bad.components[0].coverage='complete';assert.equal(validatePreparation(bad),false);
 const forged=structuredClone(x);forged.coverage.unsupported=[];forged.outcome='completed';
 const replacement=projectTrial(trialMapping(c,ctx,forged));assert.equal(validatePreparation(replacement),true);
 assert.equal(mappingSourceMatches(replacement,c,ctx,x),false,'Recomputed metadata is not the separately retained antecedent');
});
test('Candidate packet without exact retained extraction context is explicitly rejected',()=>{
 const {ctx}=setup('T01');assert.throws(()=>projectTrial(trialMapping(input('P02'),ctx)),/MAPPING/);
});
test('Text candidate preserves exact selection and preparation relation basis',()=>{
 const {x,ctx}=setup('T01'),c=input('P02');const p=consume(projectTrial(trialMapping(c,ctx,x)));
 assert.deepEqual(p.elements.map(e=>e.id),['line-2','line-3']);
 assert.equal(p.relations[0].scope,'AZ-17 under condition Z');
 assert.equal(restore(p.trial_mapping.source).canonical.relations[0].basis,'explicit synthetic reference annotation, not parser inference');
 const reduced=structuredClone(c);reduced.canonical.elements.pop();reduced.canonical.relations=[];reduced.candidate.selected=['line-2'];
 const smaller=projectTrial(trialMapping(reduced,ctx,x));assert.equal(validatePreparation(smaller),true,'Structure alone is not meaning');
 assert.equal(mappingSourceMatches(smaller,c,ctx,x),false,'Independent original operation rejects replacement');
});
test('Legitimate correction needs the exact difference pair and cannot inherit approval',()=>{
 const {x,ctx}=setup('T01'),c=input('P02');c.canonical.elements[1].text='A separately prepared correction.';
 assert.throws(()=>projectTrial(trialMapping(c,ctx,x)),/UNEXPLAINED_CHANGE/);
 ctx.differences=[{id:'difference',before:ctx.source,after:ctx.preparation,method:'correction',reason:'Explicit synthetic correction; not a new extraction observation.',affected:['line-3'],actor:'synthetic-preparer',recorded_at:100}];
 const p=projectTrial(trialMapping(c,ctx,x));assert.equal(validatePreparation(p),true);assert.equal(p.approved,undefined);assert.equal(p.current_use,'not_evaluated');
 const wrong=structuredClone(ctx);wrong.differences[0].after=ref('other-preparation',2);
 assert.throws(()=>projectTrial(trialMapping(c,wrong,x)),/MAPPING_DIFFERENCE_PAIR/);
});
test('Wrong but intact resource is compared to a separately selected operation; another operation may select it',()=>{
 const {x,ctx}=setup('T01'),c=input('P06-positive');
 ctx.resources=[{trial_id:'R-1',artifact:{id:'R-1',generation:7,bytes:c.canonical.resources[0].bytes,sha256:c.canonical.resources[0].sha256}}];
 ctx.differences=[{id:'visual-preparation',before:ctx.source,after:ctx.preparation,method:'synthesis',reason:'Synthetic resource preparation, not a text extractor observation.',affected:['figure'],actor:'synthetic-preparer',recorded_at:100}];
 const p=projectTrial(trialMapping(c,ctx,x));assert.equal(validatePreparation(p),true);assert.equal(p.elements[0].resource.generation,7);
 const other=structuredClone(c),ctx2=structuredClone(ctx);
 other.canonical.resources[0]={id:'R-2',file:'another.svg',bytes:18,sha256:hash('another intact SVG')};other.canonical.elements[0].resource='R-2';
 ctx2.resources=[{trial_id:'R-2',artifact:{id:'R-2',generation:9,bytes:18,sha256:other.canonical.resources[0].sha256}}];
 const p2=projectTrial(trialMapping(other,ctx2,x));assert.equal(validatePreparation(p2),true);
 assert.equal(mappingSourceMatches(p2,c,ctx,x),false);assert.equal(mappingSourceMatches(p2,other,ctx2,x),true);
 other.canonical.resources.push({...other.canonical.resources[0]});assert.throws(()=>projectTrial(trialMapping(other,ctx2,x)),/DUPLICATE_RESOURCE/);
});
test('Unknown structural fields fail conversion; opaque raw properties are explicitly retained, not interpreted',()=>{
 const {x,ctx}=setup('X02');x.elements[0].newMeaning='not covered';assert.throws(()=>projectTrial(trialMapping(x,ctx)),/MAPPING_EXTRACTION/);
 delete x.elements[0].newMeaning;ctx.observations.raw.additional={unknownMeaning:'retained only',decimal:12.5};
 const p=consume(projectTrial(trialMapping(x,ctx)));assert.deepEqual(restore(p.trial_mapping.context).observations.raw.additional,{unknownMeaning:'retained only',decimal:12.5});
 assert.ok(p.components[0].limitations.includes('raw-properties-retained-not-interpreted'));
});
test('Lossless JSON observation codec distinguishes absence, null, decimals, negative zero and scalar keys',()=>{
 const value={n:12.5,z:-0,null:null,'😀':'Café',rows:[0,false,'001']};assert.deepEqual(restore(retain(value)),value);
 assert.notDeepEqual(retain({}),retain({n:null}));assert.throws(()=>retain({v:undefined}));assert.throws(()=>retain('\ud800'));
 const d=retain({x:1});d.entries.push(d.entries[0]);assert.throws(()=>restore(d),/DUPLICATE/);
});
test('Distinct producer failures remain distinct and cannot manufacture a preparation or epistemic finding',()=>{
 assert.deepEqual(['invalid_utf8','unsupported_profile','member_limit','new_unknown_code'].map(error=>trialFailure({error,detail:'Synthetic observation.'}).cause),['unreadable','route_unoffered','technical_failure','unclassified']);
 for(const error of ['invalid_utf8','unsupported_profile','member_limit'])assert.equal(trialFailure({error,detail:''}).preparation,null);
 assert.throws(()=>projectTrial(trialMapping({error:'invalid_utf8',detail:''},setup('T01').ctx)),/MAPPING_EXTRACTION/);
});
test('Complete producer envelope retains observational runtime separately from resource guarantees',()=>{
 const {x,ctx}=setup('T01');const producer={raw:ctx.observations.raw,extraction:x,runtime:{node:'v22.16.0',sheetjs:'0.20.3',rssBytes:123456}};
 const p=consume(projectTrial(producerMapping(producer,ctx,PROFILE)));
 assert.deepEqual(restore(p.trial_mapping.context).observations.runtime,producer.runtime);
 assert.throws(()=>producerMapping({...producer,authorized:true},ctx,PROFILE),/MAPPING_PRODUCER/);
 const changed=structuredClone(PROFILE);changed.csv.cast=true;assert.throws(()=>projectTrial(producerMapping(producer,ctx,changed)),/MAPPING_ENVELOPE/);
});
