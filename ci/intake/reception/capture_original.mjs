// Read-only test administration, inaccessible from the public or serving socket.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const request=JSON.parse(process.argv[2]);
if(process.platform!=='linux'||process.getuid()!==1000||Object.keys(request).sort().join(',')!=='artifactId,generation'||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.artifactId)||
  ![1,2,3].includes(request.generation))throw Error('ORIGINAL_OBSERVER_SCOPE');
const file=`/objects/${request.artifactId}-${request.generation}.sealed`;
const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1048576)throw Error('ORIGINAL_OBSERVER_BOUND');
  const body=fs.readFileSync(fd);
  if(body.length!==stat.size)throw Error('ORIGINAL_OBSERVER_SIZE');
  console.log(JSON.stringify({origin:'owned-physical-object-observer',observedAtMs:Date.now(),present:true,
    artifactId:request.artifactId,generation:request.generation,bytes:body.length,
    sha256:createHash('sha256').update(body).digest('hex'),data:body.toString('base64'),file,
    stat:{size:stat.size,mode:stat.mode,ino:stat.ino,dev:stat.dev}}));
}finally{fs.closeSync(fd);}
