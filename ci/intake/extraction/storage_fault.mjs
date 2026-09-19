// Test-owned control executable; not reachable through a serving socket.
import fs from 'node:fs';
import {json,uuid,hash,readBounded} from './storage.mjs';
const action=process.argv[2],body=JSON.parse(process.argv[3]??'{}');
if(process.platform!=='linux'||process.getuid()!==1000||!['arm','inspect'].includes(action)||
  Object.keys(body).join(',')!=='channel'||!uuid(body.channel))throw Error('EXTRACTION_STORAGE_FAULT_SCOPE');
if(action==='arm'){
  fs.writeFileSync('/output/test-seal-fault.json',JSON.stringify(body),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({ok:true,channel:body.channel}));
}else{
  const directory='/output/bundles/'+body.channel,result={};
  for(const name of ['seal-intent.json','raw.bin','normalized.bin','manifest.json']){
    const file=directory+'/'+name;
    if(!fs.existsSync(file)){result[name]=null;continue;}
    const bytes=readBounded(file,41943040);result[name]={bytes:bytes.length,sha256:hash(bytes)};
  }
  const used=fs.existsSync('/output/test-seal-fault-used.json')?json('/output/test-seal-fault-used.json'):null;
  console.log(JSON.stringify({ok:true,channel:body.channel,files:result,used,
    scope:'Offline test inspection, not an authorized public content query.'}));
}
