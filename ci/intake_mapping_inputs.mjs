import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.resolve(process.argv[2]??'');
if(!process.argv[2]||path.basename(source)!=='intake_profile_trial')throw Error('Supply the preserved trial root');
const run='runs/2026-09-11T15-36-33-839Z-9011f64c';
const target=path.join(root,'tests/intake/t01/mapping-inputs');
await fs.mkdir(target,{recursive:true});
const names=['T01','T02','T03','C01','X01','X02','X03','X04','X07'].flatMap(id=>['extraction','raw'].map(kind=>[`${id}-${kind}.json`,`${run}/${id}/${kind}.json`]));
names.push(...['P02','P06-positive','P07','P08'].map(id=>[`${id}.json`,`${run}/exchange/${id}.json`]));
const records=[];
for(const [name,relative]of names){
 const bytes=await fs.readFile(path.join(source,relative));const destination=path.join(target,name);
 try{await fs.writeFile(destination,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(!(await fs.readFile(destination)).equals(bytes))throw Error('Existing snapshot differs: '+name);}
 records.push({path:name,source:relative,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const manifest=JSON.stringify({purpose:'Byte-exact retained observations for conversion tests, not new extraction results',records},null,2)+'\n';
try{await fs.writeFile(path.join(target,'PROVENANCE.json'),manifest,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await fs.readFile(path.join(target,'PROVENANCE.json'),'utf8')!==manifest)throw e;}
console.log(JSON.stringify({copied:records.length,unchanged:true}));
