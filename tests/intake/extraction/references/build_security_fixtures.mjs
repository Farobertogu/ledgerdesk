import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

// Existing outputs must be byte-identical. The retained base is never edited.
const requireWorker=createRequire(new URL('../../../../workers/intake/extraction/package.json',import.meta.url));
const {CFB,version}=requireWorker('xlsx');
assert.equal(version,'0.20.3');
const base=await fs.readFile(new URL('../../t01/fixtures/baseline.xlsx',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(await fs.readFile(new URL('../../t01/fixtures/manifest.json',import.meta.url),'utf8'));
assert.equal(hash(base),manifest.files.find(row=>row.name==='baseline.xlsx').sha256);
const directory=new URL('security/',import.meta.url);
await fs.mkdir(directory,{recursive:true});
async function retain(name,bytes){
  try{await fs.writeFile(new URL(name,directory),bytes,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;assert.deepEqual(await fs.readFile(new URL(name,directory)),Buffer.from(bytes),'Retained fixture changed');}
}
const normalType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const macroType='application/vnd.ms-excel.sheet.macroEnabled.main+xml';
const declaration='<!DOCTYPE workbook [<!ENTITY outside SYSTEM "file:///not-mounted/t06-entity-canary">]>';
const definitions=[
  {name:'repacked.xlsx',expected:'produced'},
  {name:'macro-declared.xlsx',expected:'unsupported_workbook_type'},
  {name:'entity-declared.xlsx',expected:'xml_declaration_forbidden'},
];
const files=[];
for(const definition of definitions){
  const archive=CFB.read(base,{type:'buffer'});
  const replace=(name,transform)=>{
    const item=CFB.find(archive,archive.FullPaths[0]+name);assert.ok(item,name);
    CFB.utils.cfb_add(archive,archive.FullPaths[0]+name,Buffer.from(transform(Buffer.from(item.content).toString('utf8'))));
  };
  if(definition.name==='macro-declared.xlsx')replace('[Content_Types].xml',text=>{
    assert.equal(text.split(normalType).length,2);return text.replace(normalType,macroType);
  });
  if(definition.name==='entity-declared.xlsx')replace('xl/workbook.xml',text=>{
    assert.ok(text.startsWith('<?xml'));return text.replace(/\?>/, '?>'+declaration);
  });
  const bytes=CFB.write(archive,{fileType:'zip',type:'buffer',compression:false});
  await retain(definition.name,bytes);
  files.push({...definition,bytes:bytes.length,sha256:hash(bytes)});
}
await retain('manifest.json',JSON.stringify({
  base:{name:'baseline.xlsx',sha256:hash(base)},files,
  scope:'Fixed-entry workbook-profile and XML-declaration rejection. No executable VBA is supplied; no universal hostile-code or external-entity defense is inferred.',
  independentExpectation:{normalType,macroType,declaration,formula:'B2*C2',cachedValue:'25.00'},
},null,2)+'\n');
