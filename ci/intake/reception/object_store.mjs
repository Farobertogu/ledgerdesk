import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function objectStore(root,events) {
  const resolved=fs.realpathSync(root);
  const syncDirectory=()=>{const fd=fs.openSync(resolved,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const save=(file,bytes,mode=0o600)=>{const fd=fs.openSync(file,'wx',mode);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory();};
  function event(request,kind,bytes=0,offset=0) {
    events({origin:'object-boundary',kind,artifactId:request.original.id,generation:request.original.generation,bytes,offset,
      evidenceId:request.evidenceId,atMs:Date.now(),incarnation:request.incarnation});
  }
  return request=>{
    const original=request.original;
    if(!uuid.test(request.id??'')||!uuid.test(request.evidenceId??'')||!uuid.test(original?.id??'')||
      !Number.isInteger(original.generation)||original.generation<1||original.generation>3||
      !Number.isInteger(original.bytes)||original.bytes<0||original.bytes>1048576||!/^[a-f0-9]{64}$/.test(original.sha256??'')||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.incarnation??'')||
      !['create','append','seal','read','read_stage','fence'].includes(request.action))throw Error('INVALID_OBJECT_REQUEST');
    const prefix=path.join(resolved,original.id+'-'+original.generation),meta=prefix+'.json',stage=prefix+'.stage',sealed=prefix+'.sealed',fenced=prefix+'.fenced';
    const result=(outcome,bytes=0,extra={})=>({id:request.id,ok:['created','appended','sealed','read','fenced'].includes(outcome),outcome,bytes,...extra});
    if(request.action==='fence') {if(!fs.existsSync(fenced))save(fenced,Buffer.from(request.incarnation));return result('fenced');}
    if(request.action==='create') {
      if(fs.existsSync(meta)||fs.existsSync(fenced)||fs.existsSync(stage)||fs.existsSync(sealed))return result('denied');
      const records=fs.readdirSync(resolved).filter(name=>/^[a-f0-9-]{36}-[1-3]\.json$/.test(name));
      const reserved=records.reduce((n,name)=>n+JSON.parse(fs.readFileSync(path.join(resolved,name),'utf8')).original.bytes,0);
      if(records.length>=96||reserved+original.bytes>67108864)return result('denied');
      save(meta,Buffer.from(JSON.stringify({original,incarnation:request.incarnation})),0o400);
      save(stage,Buffer.alloc(0));return result('created');
    }
    if(!fs.existsSync(meta))return result('missing');
    const stored=JSON.parse(fs.readFileSync(meta,'utf8'));
    if(stored.original.id!==original.id||stored.original.generation!==original.generation||stored.original.bytes!==original.bytes||stored.original.sha256!==original.sha256)return result('denied');
    if(['append','seal','read_stage'].includes(request.action)&&(stored.incarnation!==request.incarnation||fs.existsSync(fenced)))return result('denied');
    if(request.action==='append') {
      if(fs.existsSync(sealed)||!Number.isInteger(request.offset)||request.offset<0||typeof request.data!=='string'||
        request.data.length>87384||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data))return result('denied');
      const bytes=Buffer.from(request.data,'base64');
      if(bytes.length>65536||fs.statSync(stage).size!==request.offset||request.offset+bytes.length>original.bytes)return result('denied');
      const fd=fs.openSync(stage,'a');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      event(request,'append',bytes.length,request.offset);return result('appended',bytes.length);
    }
    if(request.action==='seal') {
      if(fs.existsSync(sealed))return result('denied');
      const bytes=fs.readFileSync(stage);event(request,'read',bytes.length);
      if(bytes.length!==original.bytes||hash(bytes)!==original.sha256)return result('corrupt');
      const fd=fs.openSync(stage,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.chmodSync(stage,0o400);fs.linkSync(stage,sealed);syncDirectory();fs.unlinkSync(stage);syncDirectory();
      event(request,'seal',bytes.length);return result('sealed',bytes.length,{sha256:original.sha256});
    }
    const file=request.action==='read_stage'?stage:sealed;
    if(!fs.existsSync(file)){event(request,'failed_open');return result('missing');}
    let fd;
    try {
      fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);event(request,'open');
      const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==original.bytes||stat.size>1048576)return result('corrupt');
      const bytes=fs.readFileSync(fd);event(request,'read',bytes.length);
      if(bytes.length!==original.bytes||hash(bytes)!==original.sha256)return result('corrupt');
      return result('read',bytes.length,{sha256:original.sha256,data:bytes.toString('base64')});
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  };
}
