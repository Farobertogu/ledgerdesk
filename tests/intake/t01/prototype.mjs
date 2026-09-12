// Test-contained storage/control experiment. Not a product service or authority evaluator.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {constants} from 'node:fs';
const root='/objects';
const hash=b=>createHash('sha256').update(b).digest('hex');
const valid=s=>typeof s==='string'&&/^[a-z0-9-]{1,64}$/.test(s);
const [action,payload='{}']=process.argv.slice(2);
const chunks=[];if(payload==='-')for await(const chunk of process.stdin)chunks.push(chunk);
const a=JSON.parse(payload==='-'?Buffer.concat(chunks).toString('utf8'):payload);
const db=new pg.Client({host:'database',user:process.env.PGUSER??'intake_runtime',password:process.env.PGPASSWORD,database:'intake',application_name:'intake-test-'+(a.id??'observer'),connectionTimeoutMillis:5000,query_timeout:15000});
db.on('error',()=>{});
await db.connect();
async function ensureRoot(){await fs.mkdir(root,{recursive:true});if((await fs.lstat(root)).isSymbolicLink())throw Error('UNSAFE_ROOT');}
async function file(key){if(!valid(key))throw Error('UNSAFE_KEY');await ensureRoot();return path.join(root,key);}
async function inspect(key){const p=await file(key);const handle=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const bytes=await handle.readFile();return{bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')};}finally{await handle.close();}}
async function barrier(declared,key){
 if(!declared.barrier)return;
 const {batch,slot,generation}=declared.barrier;
 if(!valid(batch)||!valid(slot)||!Number.isSafeInteger(generation)||generation<1)throw Error('INVALID_TEST_BARRIER');
 const backendPid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const marker='/tmp/intake-'+batch+'-'+slot;
 await fs.writeFile(marker+'.pending',JSON.stringify({batch,slot,key,generation,pid:process.pid,backendPid,node:process.version,point:'before-storage-lock'}),{flag:'wx'});
 await fs.rename(marker+'.pending',marker+'.json');
 const deadline=Date.now()+12000;
 while(Date.now()<deadline){try{await fs.access('/tmp/intake-'+batch+'.release');return;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,25));}
 throw Error('STORAGE_BARRIER_TIMEOUT');
}
async function store(key,bytes,declared){
 if(bytes.length>1048576)throw Error('INPUT_LIMIT');
 if(bytes.length!==declared.bytes||hash(bytes)!==declared.sha256)throw Error('ORIGINAL_MISMATCH');
 const p=await file(key);
 await barrier(declared,key);
 await db.query('SELECT pg_advisory_lock(30301,1)');
 try {
 const entries=await fs.readdir(root);let total=0;for(const e of entries){const s=await fs.lstat(path.join(root,e));if(s.isFile())total+=s.size;}
 if(total+bytes.length>67108864)throw Error('STORAGE_QUOTA');
 const h=await fs.open(p,'wx',0o444);
 try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
 const directory=await fs.open(root,'r');try{await directory.sync();}finally{await directory.close();}
 return await inspect(key);
 } finally { await db.query('SELECT pg_advisory_unlock(30301,1)'); }
}
async function init(){
 await db.query("CREATE ROLE intake_runtime LOGIN PASSWORD 'synthetic-runtime'; CREATE ROLE intake_observer LOGIN PASSWORD 'synthetic-observer'; CREATE SCHEMA trial; REVOKE CREATE ON SCHEMA public FROM PUBLIC;");
 await db.query("CREATE TABLE trial.operation(id text PRIMARY KEY, payload text NOT NULL, generation integer NOT NULL CHECK(generation>0), state text NOT NULL CHECK(state IN ('pending','complete','stopped')), object_key text UNIQUE, bytes integer, sha256 text); CREATE TABLE trial.evidence(id text PRIMARY KEY REFERENCES trial.operation(id), outcome text NOT NULL); GRANT USAGE ON SCHEMA trial TO intake_runtime,intake_observer; GRANT SELECT,INSERT,UPDATE ON trial.operation TO intake_runtime; GRANT SELECT,INSERT ON trial.evidence TO intake_runtime; GRANT SELECT ON ALL TABLES IN SCHEMA trial TO intake_observer;");
}
let result;
try{
 if(action==='init'){await init();result={initialized:true};}
 else if(action==='reserve'){
   await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(30301,2)');
   const prior=(await db.query('SELECT * FROM trial.operation WHERE id=$1',[a.id])).rows[0];
   if(prior){if(prior.payload!==a.payload)throw Error('INTENTION_CONFLICT');await db.query('COMMIT');result=prior;}
   else{
   const count=Number((await db.query('SELECT count(*) FROM trial.operation')).rows[0].count);if(count>=32)throw Error('ATTEMPT_LIMIT');
   await db.query("INSERT INTO trial.operation(id,payload,generation,state) VALUES($1,$2,1,'pending') ON CONFLICT DO NOTHING",[a.id,a.payload]);
   const row=(await db.query('SELECT * FROM trial.operation WHERE id=$1',[a.id])).rows[0];
   if(row.payload!==a.payload)throw Error('INTENTION_CONFLICT');await db.query('COMMIT');result=row;}
 }else if(action==='store')result=await store(a.key,Buffer.from(a.base64,'base64'),a);
 else if(action==='read')result=await inspect(a.key);
 else if(action==='lookup'){
   const row=(await db.query('SELECT * FROM trial.operation WHERE id=$1',[a.id])).rows[0];
   if(!row)result={state:'unknown'};else if(a.payload!==undefined&&row.payload!==a.payload)result={state:'conflict'};
   else if(row.state==='complete'){
     try{const actual=await inspect(row.object_key);result=actual.sha256===row.sha256&&actual.bytes===row.bytes?{...row,available:true}:{...row,available:false};}
     catch{result={...row,available:false};}
   }else result=row;
 }else if(action==='finalize'){
   const actual=await inspect(a.key);if(actual.bytes!==a.bytes||actual.sha256!==a.sha256)throw Error('ORIGINAL_MISMATCH');
   await db.query('BEGIN');
   const row=(await db.query('SELECT * FROM trial.operation WHERE id=$1 FOR UPDATE',[a.id])).rows[0];
   if(!row||row.payload!==a.payload)throw Error('INTENTION_CONFLICT');
   if(row.state==='complete'){await db.query('ROLLBACK');result={...row,reconciled:true};}
   else {
     if(row.state!=='pending'||row.generation!==a.generation)throw Error('STALE_ATTEMPT');
     await db.query("UPDATE trial.operation SET state='complete',object_key=$2,bytes=$3,sha256=$4 WHERE id=$1",[a.id,a.key,a.bytes,a.sha256]);
     await db.query("INSERT INTO trial.evidence VALUES($1,'complete')",[a.id]);
     if(a.fault==='before_commit')throw Error('INJECTED_PRE_COMMIT');
     if(a.fault==='channel_before')await db.query('SELECT pg_sleep(10); COMMIT');
     else if(a.fault==='channel_after')await db.query('COMMIT; SELECT pg_sleep(10)');
     else await db.query('COMMIT');
     if(a.fault==='after_commit')throw Error('INJECTED_RESPONSE_LOSS');
     result={id:a.id,committed:true};
   }
 }else if(action==='resume'){
   const r=await db.query("UPDATE trial.operation SET generation=generation+1 WHERE id=$1 AND generation=$2 AND state='pending' RETURNING *",[a.id,a.generation]);
   if(r.rowCount!==1)throw Error('RESUME_CONFLICT');result=r.rows[0];
 }else if(action==='observe')result=(await db.query(a.sql)).rows;
 else if(action==='barrier_state'){
   if(!valid(a.batch))throw Error('INVALID_TEST_BARRIER');
   const names=(await fs.readdir('/tmp')).filter(n=>n.startsWith('intake-'+a.batch+'-')&&n.endsWith('.json'));
   result=await Promise.all(names.map(n=>fs.readFile('/tmp/'+n,'utf8').then(JSON.parse)));
 }else if(action==='barrier_release'){
   if(!valid(a.batch))throw Error('INVALID_TEST_BARRIER');
   await fs.writeFile('/tmp/intake-'+a.batch+'.release','release',{flag:'wx'});result={released:true};
 }
 else if(action==='quota_probe'){
   const bytes=Buffer.alloc(1048576,3);let accepted=0,cause;
   for(let i=0;i<65;i++){try{await store('quota-'+i,bytes,{bytes:bytes.length,sha256:hash(bytes)});accepted++;}catch(e){cause=e.message;break;}}
   let storedBytes=0;for(const e of await fs.readdir(root)){const s=await fs.lstat(path.join(root,e));if(s.isFile())storedBytes+=s.size;}
   result={accepted,cause,storedBytes};
 }
 else if(action==='stage_wait'){
   if(!valid(a.key))throw Error('UNSAFE_KEY');await ensureRoot();const h=await fs.open(path.join(root,'.partial-'+a.key),'wx');await h.writeFile(Buffer.from(a.base64,'base64').subarray(0,10));await h.sync();await h.close();console.log('PARTIAL_STAGED');await new Promise(()=>{});
 }else if(action==='corrupt'){const p=await file(a.key);await fs.chmod(p,0o644);await fs.writeFile(p,'injected storage fault');result={faulted:true};}
 else if(action==='backup')result={operations:(await db.query('SELECT * FROM trial.operation ORDER BY id')).rows,evidence:(await db.query('SELECT * FROM trial.evidence ORDER BY id')).rows,objects:await Promise.all((await fs.readdir(root)).filter(valid).map(async key=>({key,...await inspect(key)})))};
 else if(action==='restore'){
   for(const object of a.objects)await store(object.key,Buffer.from(object.base64,'base64'),object);
   await db.query('BEGIN');
   for(const r of a.operations){if(r.state==='complete'){const object=await inspect(r.object_key);if(object.bytes!==r.bytes||object.sha256!==r.sha256)throw Error('RESTORE_MEMBER');}await db.query('INSERT INTO trial.operation VALUES($1,$2,$3,$4,$5,$6,$7)',[r.id,r.payload,r.generation,r.state,r.object_key,r.bytes,r.sha256]);}
   for(const r of a.evidence)await db.query('INSERT INTO trial.evidence VALUES($1,$2)',[r.id,r.outcome]);await db.query('COMMIT');result={restored:a.operations.length};
 }else throw Error('UNKNOWN_TEST_ACTION');
 console.log(JSON.stringify({ok:true,result}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.log(JSON.stringify({ok:false,error:e.code??e.message}));process.exitCode=2;}
finally{await db.end();}
