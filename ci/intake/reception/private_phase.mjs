import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
const actions={objects:['append','create','fence','read','read_stage','seal'],verifier:['verify'],extraction:['run','read'],outputs:['seal','read']};
function binding(value,participant){
  const extraction=['extraction','outputs'].includes(participant);
  if(!exact(value,'id,incarnation,namespace,original,evidenceId,participant,actions'+(extraction?',subject':''))||!uuid(value.id)||
    typeof value.incarnation!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value.incarnation)||
    !['intake_trial','intake_restore'].includes(value.namespace)||value.participant!==participant||!uuid(value.evidenceId)||
    !exact(value.original,'id,generation,bytes,sha256')||!uuid(value.original.id)||
    !Number.isInteger(value.original.generation)||value.original.generation<1||value.original.generation>3||
    !Number.isInteger(value.original.bytes)||value.original.bytes<0||value.original.bytes>1048576||
    !/^[a-f0-9]{64}$/.test(value.original.sha256)||!Array.isArray(value.actions)||!value.actions.length||
    new Set(value.actions).size!==value.actions.length||value.actions.some(action=>!actions[participant].includes(action)))throw Error('PHASE_BINDING');
  if(extraction&&(!exact(value.subject,'job_id,attempt_generation,channel_id,binding_sha256')||!uuid(value.subject.job_id)||
    ![1,2].includes(value.subject.attempt_generation)||!uuid(value.subject.channel_id)||!/^[a-f0-9]{64}$/.test(value.subject.binding_sha256)))throw Error('EXTRACTION_PHASE_SUBJECT');
  // Fixed-field private binding, not the public intention canonicalization profile.
  const result={id:value.id,incarnation:value.incarnation,namespace:value.namespace,
    original:{id:value.original.id,generation:value.original.generation,bytes:value.original.bytes,sha256:value.original.sha256},
    evidenceId:value.evidenceId,participant,actions:[...value.actions].sort(),...(extraction?{subject:{job_id:value.subject.job_id,
      attempt_generation:value.subject.attempt_generation,channel_id:value.subject.channel_id,binding_sha256:value.subject.binding_sha256}}:{})};
  return JSON.stringify(result);
}
function bounded(promise,milliseconds){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PHASE_QUIESCENCE_UNCONFIRMED')),milliseconds);})])
    .finally(()=>clearTimeout(timer));
}

/** Local closure prototype. This journal does not authorize a SQL or storage effect. */
export class PrivatePhaseJournal{
  constructor(directory,participant,{maximumEntries=4096,maximumBytes=4194304,closeMs=1200}={}){
    if(process.platform!=='linux'||!actions[participant]||!path.isAbsolute(directory)||
      !Number.isInteger(maximumEntries)||maximumEntries<1||maximumEntries>4096||
      !Number.isInteger(maximumBytes)||maximumBytes<512||maximumBytes>4194304||
      !Number.isInteger(closeMs)||closeMs<10||closeMs>1200)throw Error('PHASE_CONFIGURATION');
    this.directory=directory;this.participant=participant;this.maximumEntries=maximumEntries;this.maximumBytes=maximumBytes;this.closeMs=closeMs;
    this.instance=randomUUID();this.active=new Map();this.poisoned=false;
    fs.mkdirSync(directory,{mode:0o700});
    this.file=path.join(directory,'phases.json');this.rows={};
    this.persist(this.rows);
  }
  static reopen(directory,participant,options={}){
    const journal=Object.create(PrivatePhaseJournal.prototype);
    Object.assign(journal,{directory,participant,maximumEntries:4096,maximumBytes:4194304,closeMs:1200,...options,
      instance:randomUUID(),active:new Map(),poisoned:false,file:path.join(directory,'phases.json')});
    const stat=fs.lstatSync(journal.file);
    if(process.platform!=='linux'||!actions[participant]||stat.isSymbolicLink()||!stat.isFile()||stat.size>journal.maximumBytes)throw Error('PHASE_JOURNAL');
    const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(journal.file)));
    if(parsed.profile!=='intake-private-journal/1'||parsed.participant!==participant||!exact(parsed,'profile,participant,rows')||
      !parsed.rows||Array.isArray(parsed.rows)||Object.keys(parsed.rows).length>journal.maximumEntries)throw Error('PHASE_JOURNAL');
    for(const [id,row]of Object.entries(parsed.rows))if(!uuid(id)||!exact(row,'state,owner,binding')||!uuid(row.owner)||
      !['open','closing','closed'].includes(row.state)||!(row.binding===null||typeof row.binding==='string'&&binding(JSON.parse(row.binding),participant)===row.binding))throw Error('PHASE_JOURNAL');
    journal.rows=parsed.rows;return journal;
  }
  persist(rows){
    if(this.poisoned)throw Error('PHASE_JOURNAL_UNCERTAIN');
    const bytes=Buffer.from(JSON.stringify({profile:'intake-private-journal/1',participant:this.participant,rows}));
    if(Object.keys(rows).length>this.maximumEntries||bytes.length>this.maximumBytes)throw Error('PHASE_JOURNAL_LIMIT');
    const temporary=path.join(this.directory,'pending-'+randomUUID()+'.json');
    try{
      const fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,this.file);
      const parent=fs.openSync(this.directory,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
      this.rows=rows;
    }catch(error){this.poisoned=true;throw error;}
  }
  open(value){
    if(this.poisoned)throw Error('PHASE_JOURNAL_UNCERTAIN');
    const text=binding(value,this.participant),existing=this.rows[value.id];
    if(Object.values(this.rows).some(row=>row.owner!==this.instance&&row.state!=='closed'))throw Error('PHASE_RECOVERY_REQUIRED');
    if(existing){
      if(existing.state!=='open')throw Error('PHASE_CLOSED');
      if(existing.owner!==this.instance)throw Error('PHASE_RECOVERY_REQUIRED');
      if(existing.binding!==text)throw Error('PHASE_BINDING_CONFLICT');
      return{profile:'intake-phase-open/1',id:value.id,binding:digest(text)};
    }
    this.persist({...this.rows,[value.id]:{state:'open',owner:this.instance,binding:text}});
    return{profile:'intake-phase-open/1',id:value.id,binding:digest(text)};
  }
  async execute(phase,command,start){
    if(this.poisoned)throw Error('PHASE_JOURNAL_UNCERTAIN');
    const row=this.rows[phase];
    if(!row||row.state!=='open')throw Error('PHASE_CLOSED');
    if(row.owner!==this.instance)throw Error('PHASE_RECOVERY_REQUIRED');
    if(this.active.has(phase))throw Error('PHASE_BUSY');
    const expected=JSON.parse(row.binding);
    if(!uuid(command.id)||command.incarnation!==expected.incarnation||command.namespace!==expected.namespace||
      command.evidenceId!==expected.evidenceId||!exact(command.original,'id,generation,bytes,sha256')||
      Object.keys(expected.original).some(key=>command.original[key]!==expected.original[key])||
      !expected.actions.includes(command.action)||expected.subject&&(!exact(command.subject,'job_id,attempt_generation,channel_id,binding_sha256')||
        Object.keys(expected.subject).some(key=>command.subject[key]!==expected.subject[key])))throw Error('PHASE_COMMAND_BINDING');
    let operation;
    try{
      operation=start();
      if(!operation||typeof operation.stop!=='function'||!operation.completion?.then)throw Error('PHASE_WORKER_INTERFACE');
    }catch(error){
      // A factory may throw after starting a child. That is not proof of no work.
      this.active.set(phase,{confirmed:false,stop:()=>{},completion:new Promise(()=>{})});
      this.persist({...this.rows,[phase]:{...row,state:'closing'}});throw error;
    }
    const tracked={...operation,confirmed:false};this.active.set(phase,tracked);
    try{
      const result=await operation.completion,t=result?.termination;
      if(t?.profile!=='intake-child-stop/1'||t.requestId!==command.id||!Number.isInteger(t.workerPid)||
        !Number.isSafeInteger(t.startedAtMs)||!Number.isSafeInteger(t.closedAtMs)||t.closedAtMs<t.startedAtMs)throw Error('PHASE_WORKER_UNCONFIRMED');
      tracked.confirmed=true;return result;
    }finally{
      // An unresolved worker stays tracked; absence must never imply quiescence.
      if(tracked.confirmed)this.active.delete(phase);
    }
  }
  async close(id){
    if(this.poisoned)throw Error('PHASE_JOURNAL_UNCERTAIN');
    if(!uuid(id))throw Error('PHASE_ID');
    const row=this.rows[id];
    if(row?.state==='closed')return{profile:'intake-phase-closed/1',id,participant:this.participant};
    if(row&&row.owner!==this.instance)throw Error('PHASE_RECOVERY_REQUIRED');
    // Tombstone an unseen ID too: CLOSE may overtake a delayed OPEN.
    this.persist({...this.rows,[id]:{state:'closing',owner:this.instance,binding:row?.binding??null}});
    const active=this.active.get(id);
    if(active){
      active.stop('phase-closed');
      try{await bounded(active.completion,this.closeMs);}catch{throw Error('PHASE_QUIESCENCE_UNCONFIRMED');}
      if(!active.confirmed)throw Error('PHASE_QUIESCENCE_UNCONFIRMED');
    }
    this.persist({...this.rows,[id]:{state:'closed',owner:this.instance,binding:row?.binding??null}});
    return{profile:'intake-phase-closed/1',id,participant:this.participant};
  }
}
