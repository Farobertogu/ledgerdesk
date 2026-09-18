// Owned verification command, unavailable through either serving socket.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {uuid,json,hash,durable} from './storage.mjs';
const input=JSON.parse(process.argv[2]??'{}');
if(process.platform!=='linux'||process.getuid()!==1000||Object.keys(input).sort().join(',')!=='currentChannel,oldChannel'||
  !uuid(input.oldChannel)||!uuid(input.currentChannel)||input.oldChannel===input.currentChannel)throw Error('REPLAY_PROBE_SCOPE');
const oldDirectory='/output/queue/'+input.oldChannel,currentDirectory='/output/queue/'+input.currentChannel;
const old=json(oldDirectory+'/completion.json'),current=json(currentDirectory+'/completion.json');
assert.equal(old.closed,true);assert.equal(current.closed,true);
assert.equal(old.subject.job_id,current.subject.job_id);assert.equal(old.subject.attempt_generation,1);assert.equal(current.subject.attempt_generation,2);
const paths=['raw.bin','completion.json','request.json','launch.json'];
const snapshot=()=>Object.fromEntries(paths.map(p=>[p,hash(fs.readFileSync(currentDirectory+'/'+p))]));
const before=snapshot(),pending=currentDirectory+'/completion.pending.json';
const retained=pending+'.'+randomUUID()+'.retained';
const result=[];
for(const [label,metadata]of [['old-completion',old],['duplicate-current',current]]){
  const backup=retained+'.'+label;
  fs.renameSync(pending,backup);
  try{
    durable(pending,Buffer.from(JSON.stringify(metadata)));
    const child=spawnSync(process.execPath,['--experimental-strip-types','/work/ci/intake/extraction/bridge_cli.mjs','publish',input.currentChannel],
      {encoding:'utf8',timeout:3000,maxBuffer:16384});
    assert.equal(child.error,undefined);assert.equal(child.signal,null);
    result.push({label,code:child.status,stdout:child.stdout,stderr:child.stderr});
  }finally{fs.renameSync(pending,backup+'.injected');fs.renameSync(backup,pending);}
  assert.deepEqual(snapshot(),before);
}
process.stdout.write(JSON.stringify({ok:true,before,after:snapshot(),old,current,result}));
