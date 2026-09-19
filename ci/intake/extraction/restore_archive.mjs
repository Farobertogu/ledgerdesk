// Offline trial administration, never reachable through the serving socket.
// The controller retains current authority and the independent SQL cut.
import fs from 'node:fs';
import {hash,uuid,readBounded,durable,sameStructure} from './storage.mjs';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';

if(process.platform!=='linux'||process.getuid()!==1000)throw Error('EXTRACTION_RESTORE_IDENTITY');
const action=process.argv[2],request=JSON.parse(process.argv[3]??'{}');
const archive='/output/retained-extraction-backup.json',target='/output/restored';
const totalBound=67108864,archiveBound=90000000;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const inventory=members=>members.map(({name,bytes,sha256})=>({name,bytes,sha256})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
const event=value=>fs.appendFileSync('/output/restore-events.ndjson',JSON.stringify({action,atMs:Date.now(),...value})+'\n');
function checked(members){
  if(!Array.isArray(members)||members.length<3||members.length>12)throw Error('EXTRACTION_RESTORE_MEMBER_COUNT');
  const names=new Set();let total=0;
  for(const m of members){
    const match=/^([a-f0-9-]{36})\/(raw\.bin|normalized\.bin|manifest\.json)$/.exec(m.name??'');
    if(!match||!uuid(match[1])||names.has(m.name))throw Error('EXTRACTION_RESTORE_MEMBER_NAME');names.add(m.name);
    const maximum=match[2]==='raw.bin'?EXTRACTION_BOUNDS.stdoutBytes:match[2]==='normalized.bin'?EXTRACTION_BOUNDS.normalizedBytes:65536;
    if(typeof m.data!=='string'||m.data.length>4*Math.ceil(maximum/3))throw Error('EXTRACTION_RESTORE_ENCODED_BOUND');
    const bytes=Buffer.from(m.data,'base64');total+=bytes.length;
    if(bytes.length>maximum||total>totalBound||bytes.toString('base64')!==m.data||bytes.length!==m.bytes||hash(bytes)!==m.sha256)throw Error('EXTRACTION_RESTORE_MEMBER_CONTENT');
  }
  for(const name of names){const id=name.split('/')[0];for(const tail of ['raw.bin','normalized.bin','manifest.json'])
    if(!names.has(id+'/'+tail))throw Error('EXTRACTION_RESTORE_INCOMPLETE_BUNDLE');}
  return members;
}
try{
  let result;
  if(action==='backup'){
    if(!Array.isArray(request.bundles)||!request.bundles.length||request.bundles.length>4)throw Error('EXTRACTION_BACKUP_BUNDLE_COUNT');
    const members=[],ids=new Set();
    for(const bundle of request.bundles){
      if(!uuid(bundle.id)||ids.has(bundle.id)||bundle.namespace!=='intake_trial')throw Error('EXTRACTION_BACKUP_BUNDLE');ids.add(bundle.id);
      for(const [tail,maximum,expected]of [['raw.bin',EXTRACTION_BOUNDS.stdoutBytes,bundle.raw],['normalized.bin',EXTRACTION_BOUNDS.normalizedBytes,bundle.normalized],['manifest.json',65536,null]]){
        const bytes=readBounded('/output/bundles/'+bundle.id+'/'+tail,maximum);
        if(expected&&(bytes.length!==expected.bytes||hash(bytes)!==expected.sha256))throw Error('EXTRACTION_BACKUP_CHANGED');
        if(!expected&&!sameStructure(JSON.parse(bytes),bundle))throw Error('EXTRACTION_BACKUP_ASSOCIATION');
        members.push({name:bundle.id+'/'+tail,bytes:bytes.length,sha256:hash(bytes),data:bytes.toString('base64')});
      }
    }
    checked(members);const list=inventory(members),manifestSha256=hash(Buffer.from(JSON.stringify(list)));
    const bytes=Buffer.from(JSON.stringify({profile:'intake-extraction-backup/1',manifestSha256,members}));
    if(bytes.length>archiveBound)throw Error('EXTRACTION_RESTORE_ARCHIVE_BOUND');durable(archive,bytes);
    result={ok:true,manifestSha256,members:list,archiveBytes:bytes.length};
  }else if(action==='restore'){
    if(!uuid(request.attemptId)||!uuid(request.anchorId)||!digest(request.anchorSha256))throw Error('EXTRACTION_RESTORE_INPUT');
    event({kind:'protected-archive-read',attemptId:request.attemptId});
    const candidate=JSON.parse(readBounded(archive,archiveBound));
    if(candidate.profile!=='intake-extraction-backup/1')throw Error('EXTRACTION_RESTORE_PROFILE');
    if(request.variant==='forged-manifest'){
      const row=candidate.members.find(m=>m.name.endsWith('/normalized.bin')),bytes=Buffer.from(row.data,'base64');
      bytes[0]^=1;row.data=bytes.toString('base64');row.sha256=hash(bytes);
      candidate.manifestSha256=hash(Buffer.from(JSON.stringify(inventory(candidate.members))));
    }else if(request.variant==='missing-member')candidate.members.pop();
    else if(request.variant!=='intact')throw Error('EXTRACTION_RESTORE_VARIANT');
    const arriving='/output/arriving-extraction-'+request.attemptId+'.json';
    durable(arriving,Buffer.from(JSON.stringify(candidate)));
    const members=checked(candidate.members),list=inventory(members),observed=hash(Buffer.from(JSON.stringify(list)));
    if(observed!==request.anchorSha256||candidate.manifestSha256!==request.anchorSha256)throw Error('EXTRACTION_RETAINED_ANCHOR_MISMATCH');
    if(fs.existsSync(target))throw Error('EXTRACTION_RESTORE_TARGET_EXISTS');fs.mkdirSync(target,{mode:0o700});
    fs.mkdirSync(target+'/bundles',{mode:0o700});
    for(const m of members){const folder=target+'/bundles/'+m.name.split('/')[0];
      if(!fs.existsSync(folder))fs.mkdirSync(folder,{mode:0o700});durable(target+'/bundles/'+m.name,Buffer.from(m.data,'base64'));}
    const persisted=members.map(m=>{const bytes=readBounded(target+'/bundles/'+m.name,EXTRACTION_BOUNDS.stdoutBytes);return{name:m.name,bytes:bytes.length,sha256:hash(bytes)};});
    if(!sameStructure(inventory(persisted),list))throw Error('EXTRACTION_RESTORE_READBACK');
    durable(target+'/anchor.json',Buffer.from(JSON.stringify({id:request.anchorId,sha256:request.anchorSha256})));
    result={ok:true,manifestSha256:observed,members:persisted};
  }else if(action==='inspect'){
    result={ok:true,targetExists:fs.existsSync(target),
      events:fs.existsSync('/output/restore-events.ndjson')?fs.readFileSync('/output/restore-events.ndjson','utf8').trim().split('\n').map(JSON.parse):[]};
  }else throw Error('EXTRACTION_RESTORE_ACTION');
  event({kind:'completed',ok:true});process.stdout.write(JSON.stringify(result));
}catch(error){
  const reason=/^[A-Z0-9_]{1,80}$/.test(error.message??'')?error.message:'EXTRACTION_RESTORE_FAILED';
  event({kind:'rejected',reason});process.stdout.write(JSON.stringify({ok:false,reason}));
}
