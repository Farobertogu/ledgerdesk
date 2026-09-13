// Read-only diagnostic of the declared file-mode control, not hostile-owner confinement.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const b=JSON.parse(process.argv[2]);
if(process.platform!=='linux'||process.getuid()!==1000||Object.keys(b).sort().join(',')!=='artifactId,sha256'||
  !/^[a-f0-9-]{36}$/.test(b.artifactId)||!/^[a-f0-9]{64}$/.test(b.sha256))throw Error('PRIVILEGE_PROBE_SCOPE');
const file='/objects/'+b.artifactId+'-1.sealed';
const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),stat=fs.fstatSync(fd);let original;
try{if(!stat.isFile()||stat.uid!==1000||stat.size!==17)throw Error('PRIVILEGE_PROBE_TARGET');original=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');if(sha(original)!==b.sha256)throw Error('PRIVILEGE_PROBE_REFERENCE');
let writeCode=null;
try{const writable=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);fs.closeSync(writable);}catch(error){writeCode=error.code;}
const result={uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),mode:stat.mode&0o777,bytes:original.length,
  sha256:sha(original),writeCode,afterSha256:sha(fs.readFileSync(file)),limitation:'The owner could chmod its own file; this measures the existing mode, not malicious-owner immutability.'};
fs.writeFileSync('/output/privileges-'+b.artifactId+'.json',JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,...result}));
