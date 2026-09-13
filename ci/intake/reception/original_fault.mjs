// Test-only fault administration. No public or private service dispatch imports this file.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const b=JSON.parse(process.argv[2]),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(process.platform!=='linux'||process.getuid()!==1000||Object.keys(b).sort().join(',')!=='artifactId,bytes,generation,mode,sha256'||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(b.artifactId)||
  b.generation!==1||b.bytes!==17||!/^[a-f0-9]{64}$/.test(b.sha256)||!['corrupt','missing'].includes(b.mode))throw Error('ORIGINAL_FAULT_SCOPE');
if(fs.realpathSync('/objects')!=='/objects'||fs.realpathSync('/output')!=='/output')throw Error('ORIGINAL_FAULT_ROOT');
const prefix=path.join('/objects',b.artifactId+'-1'),file=prefix+'.sealed',preserved=prefix+'.retained-by-test';
if(path.dirname(file)!=='/objects'||path.dirname(preserved)!=='/objects'||fs.existsSync(preserved))throw Error('ORIGINAL_FAULT_TARGET');
const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.uid!==1000||stat.size!==17)throw Error('ORIGINAL_FAULT_FILE');bytes=fs.readFileSync(fd);}
finally{fs.closeSync(fd);}
if(bytes.length!==b.bytes||sha(bytes)!==b.sha256)throw Error('ORIGINAL_FAULT_BASELINE');
const before={bytes:bytes.length,sha256:sha(bytes),data:bytes.toString('base64')};
fs.writeFileSync('/output/fault-'+b.artifactId+'-before.bin',bytes,{flag:'wx',mode:0o400});
// Retain the intact file; never overwrite it. The replacement is a test fault,
// not a receipt repair or a product mutation endpoint.
fs.renameSync(file,preserved);
let after=null;
if(b.mode==='corrupt'){
  const wrong=Buffer.from(bytes);wrong[wrong.length-1]^=1;
  fs.writeFileSync(file,wrong,{flag:'wx',mode:0o400});
  const observed=fs.readFileSync(file);after={bytes:observed.length,sha256:sha(observed),data:observed.toString('base64')};
  fs.writeFileSync('/output/fault-'+b.artifactId+'-after.bin',observed,{flag:'wx',mode:0o400});
}
const record={origin:'owned-original-fault',mode:b.mode,artifactId:b.artifactId,generation:1,observedAtMs:Date.now(),
  before,after,present:fs.existsSync(file),retainedOriginal:preserved,retainedSha256:sha(fs.readFileSync(preserved))};
fs.writeFileSync('/output/fault-'+b.artifactId+'.json',JSON.stringify(record,null,2),{flag:'wx',mode:0o400});
console.log(JSON.stringify({ok:true,...record}));
