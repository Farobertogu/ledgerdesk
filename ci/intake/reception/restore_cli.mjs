// Test-owned administration executable. It is not reachable through the serving socket.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const action=process.argv[2],request=JSON.parse(process.argv[3]??'{}');
if(process.platform!=='linux'||process.getuid()!==1000)throw Error('RESTORE_ADMIN_IDENTITY');
const archive='/output/retained-backup.json',target='/restored';
const memberName=/^(?:[a-f0-9-]{36}-[1-3]\.(?:json|sealed)|intake-data\.json)$/;
const fail=reason=>{console.log(JSON.stringify({ok:false,reason}));};
function checkedMembers(members){
  if(!Array.isArray(members)||members.length>193)throw Error('ARCHIVE_MEMBER_BOUND');
  const names=new Set();let total=0;
  return members.map(member=>{
    if(!memberName.test(member.name)||names.has(member.name))throw Error('ARCHIVE_MEMBER_NAME');names.add(member.name);
    const bytes=Buffer.from(member.data,'base64');total+=bytes.length;
    if(bytes.toString('base64')!==member.data||bytes.length>(member.name==='intake-data.json'?8388608:1049600)||total>75563008||member.bytes!==bytes.length||member.sha256!==hash(bytes))throw Error('ARCHIVE_MEMBER_CONTENT');
    return{name:member.name,bytes:bytes.length,sha256:hash(bytes),data:member.data};
  });
}
function inventory(members){return members.map(({name,bytes,sha256})=>({name,bytes,sha256})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);}
function save(file,bytes){const fd=fs.openSync(file,'wx',0o400);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
try {
  if(action==='backup') {
    if(fs.existsSync(archive))throw Error('BACKUP_ALREADY_EXISTS');
    if(!Array.isArray(request.objects)||request.objects.length>96)throw Error('BACKUP_OBJECT_BOUND');
    if(!/^[a-f0-9-]{36}$/.test(request.cutId??''))throw Error('BACKUP_CUT_ID');
    const dataFile='/output/cut-data-'+request.cutId+'.json';
    if(fs.statSync(dataFile).size>8388608)throw Error('BACKUP_DATA_BOUND');
    const data=fs.readFileSync(dataFile);
    const members=[{name:'intake-data.json',bytes:data.length,sha256:hash(data),data:data.toString('base64')}];
    for(const object of request.objects){
      if(!/^[a-f0-9-]{36}$/.test(object.id)||!Number.isInteger(object.generation)||object.generation<1||object.generation>3)throw Error('BACKUP_OBJECT_REFERENCE');
      for(const suffix of ['json','sealed']){
        const name=`${object.id}-${object.generation}.${suffix}`,file=path.join('/objects',name);
        const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
        try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1049600)throw Error('BACKUP_MEMBER_BOUND');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
        if(suffix==='sealed'&&(bytes.length!==object.bytes||hash(bytes)!==object.sha256))throw Error('BACKUP_OBJECT_CHANGED');
        members.push({name,bytes:bytes.length,sha256:hash(bytes),data:bytes.toString('base64')});
      }
    }
    const checked=checkedMembers(members),manifest=inventory(checked),manifestSha256=hash(Buffer.from(JSON.stringify(manifest)));
    save(archive,Buffer.from(JSON.stringify({profile:'intake-backup/1',manifestSha256,members:checked})));
    console.log(JSON.stringify({ok:true,manifestSha256,members:manifest,archiveBytes:fs.statSync(archive).size}));
  } else if(action==='restore') {
    const original=JSON.parse(fs.readFileSync(archive,'utf8'));
    let candidate=structuredClone(original);
    if(request.variant==='forged-manifest') {
      const member=candidate.members.find(m=>m.name.endsWith('.sealed'));
      const bytes=Buffer.from(member.data,'base64');if(bytes.length)bytes[bytes.length-1]^=1;
      member.data=bytes.toString('base64');member.sha256=hash(bytes);
      candidate.manifestSha256=hash(Buffer.from(JSON.stringify(inventory(candidate.members))));
    } else if(request.variant==='missing-member')candidate.members.pop();
    else if(request.variant!=='intact')throw Error('RESTORE_VARIANT');
    const checked=checkedMembers(candidate.members),observed=inventory(checked),observedHash=hash(Buffer.from(JSON.stringify(observed)));
    if(!/^[a-f0-9-]{36}$/.test(request.attemptId??''))throw Error('RESTORE_ATTEMPT_ID');
    const capture='/output/arriving-'+request.attemptId;fs.mkdirSync(capture);
    save(path.join(capture,'manifest.json'),Buffer.from(JSON.stringify(observed)));
    for(const member of checked)save(path.join(capture,member.name),Buffer.from(member.data,'base64'));
    // The retained SQL anchor is passed by the test controller, not read from this archive.
    if(observedHash!==request.anchorSha256||candidate.manifestSha256!==request.anchorSha256){fail('RETAINED_ANCHOR_MISMATCH');}
    else {
      if(fs.readdirSync(target).length)throw Error('RESTORE_TARGET_NOT_EMPTY');
      for(const member of checked)save(path.join(target,member.name),Buffer.from(member.data,'base64'));
      const directory=fs.openSync(target,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
      const persisted=checked.map(member=>{const bytes=fs.readFileSync(path.join(target,member.name));return{name:member.name,bytes:bytes.length,sha256:hash(bytes)};});
      if(JSON.stringify(persisted)!==JSON.stringify(checked.map(({name,bytes,sha256})=>({name,bytes,sha256}))))throw Error('RESTORE_READBACK');
      console.log(JSON.stringify({ok:true,manifestSha256:observedHash,members:persisted}));
    }
  } else if(action==='inspect') {
    const source=fs.readdirSync('/objects').sort();
    const objects=source.filter(name=>/^[a-f0-9-]{36}-[1-3]\.(stage|sealed)$/.test(name)).map(name=>{
      const bytes=fs.readFileSync(path.join('/objects',name));return{name,bytes:bytes.length,sha256:hash(bytes)};});
    console.log(JSON.stringify({ok:true,source,objects,restored:fs.readdirSync(target).sort()}));
  } else if(action==='arm-stall') {
    if(!/^[a-f0-9-]{36}$/.test(request.artifactId??'')||![1,2,3].includes(request.generation)||request.offset!==41)throw Error('STALL_TARGET');
    save('/output/stall-target.json',Buffer.from(JSON.stringify({artifactId:request.artifactId,generation:request.generation,offset:request.offset})));
    console.log(JSON.stringify({ok:true}));
  } else throw Error('ADMIN_ACTION');
}catch(error){fail(/^[A-Z0-9_]+$/.test(error.message)?error.message:'RESTORE_ADMIN_FAILURE');}
