import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
export const target='a'.repeat(64),boot='1'.repeat(32),pid=417,group='/system.slice/docker-'+target+'.scope';
export const from=1700000000000000n,baseMono=123400000n;
export const binding={target,pid,boot,cgroup:group,startTicks:'12300',observedRealtimeUs:String(from+100n),observedMonotonicUs:String(baseMono)};
export const position={cursor:'s=synthetic;i=1',boot,realtimeUs:String(from-1000000n),monotonicUs:String(baseMono-1000000n)};
export const window={fromUs:String(from),toUs:String(from+250000n)};
export const ctx='oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg='+group+',task_memcg='+group+',task=node,pid=417,uid=1000';
export const victim='Memory cgroup out of memory: Killed process 417 (node) total-vm:900000kB, anon-rss:510000kB, file-rss:4000kB, shmem-rss:0kB, UID:1000 pgtables:1200kB oom_score_adj:0';
export const row=(message,index=2,{real=from+BigInt(index)*1000n,mono=baseMono+BigInt(index)*1000n}={})=>({__CURSOR:'s=synthetic;i='+index,__REALTIME_TIMESTAMP:String(real),__MONOTONIC_TIMESTAMP:String(mono),_BOOT_ID:boot,_TRANSPORT:'kernel',MESSAGE:message});
export const text=(...rows)=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const hash=v=>createHash('sha256').update(v).digest('hex');
function archive(name,content){const b=Buffer.from(content),tar=Buffer.alloc(512+Math.ceil(b.length/512)*512+1024);tar.write(name);tar.write(b.length.toString(8).padStart(11,'0')+'\0',124);tar.write('0',156);tar.fill(32,148,156);let sum=0;for(const n of tar.subarray(0,512))sum+=n;tar.write(sum.toString(8).padStart(6,'0')+'\0 ',148);b.copy(tar,512);return tar;}
// Same directed identity/message references as the independent review. This
// calls the actual extracted probe and supplied actual observer, not a stand-in.
export async function composed({source,observeL03,kernel,mode}){
 const actual=source.slice(source.indexOf('async function probe('),source.indexOf('async function originalCase('));
 const make=new Function('context',`const {prefix,seq,parserFlags,parserImage,container,docker,json,save,owned,sourceRoot,hash,fs,path,observeL03,loggingFailures,required}=context;let parserActive=false;return (${actual});`);
 const image='sha256:'+'c'.repeat(64),started=new Date(Date.now()-20).toISOString(),first={Id:target,Image:image,State:{StartedAt:started,FinishedAt:new Date().toISOString(),OOMKilled:false,ExitCode:137,Pid:pid},HostConfig:{},Config:{User:'1000:1000'}};
 let emit,record,launches=0,clients=0,inspects=0;const originalError=Error('primary owned exception');
 const bound={...binding,observedRealtimeUs:String(BigInt(Date.now())*1000n)};
 const response=b=>({code:0,signal:null,error:null,reason:null,closed:true,pendingBytes:0,encodingError:false,received:b.length,retained:b.length,stderrBytes:0,stdout:Buffer.from(b)});
 const io=async(_cmd,options)=>{clients++;const payload=clients===1?text(row('kernel ready',1,{real:from-1000000n,mono:baseMono-1000000n})):text(row(ctx,2,{real:BigInt(bound.observedRealtimeUs)+1000n}),row(victim,3,{real:BigInt(bound.observedRealtimeUs)+2000n}));return kernel.boundedKernelClient({executable:process.execPath,args:['-e','process.stdout.write('+JSON.stringify(payload)+');process.stderr.write("L03_RESOURCE user=0.01 system=0.00 rss=1234\\n")']},options);};
 const probe=make({prefix:'owned',seq:1,parserFlags:[],parserImage:image,container:async()=>{},owned:[{id:target}],sourceRoot:'synthetic',hash,fs:{readFile:async()=>Buffer.from('synthetic')},path:{join:()=>''},loggingFailures:[],required:async()=>{throw Error('Unexpected target stop');},json:r=>r,
 docker:async args=>{if(args[0]==='start'){launches++;emit?.(JSON.stringify({Type:'container',Action:'start',Actor:{ID:target},timeNano:'1'}));if(mode==='primary-throw')throw originalError;return {code:137,signal:null};}return[first];},save:async()=>{},
 observeL03:async(options,work)=>observeL03({...options,run:async args=>{if(args[0]==='cp')return response(archive(args[1].includes('probe.mjs')?'probe.mjs':'docker-entrypoint.sh','synthetic'));if(args[0]==='inspect'&&++inspects===3&&['later-failure','primary-throw'].includes(mode))throw Error('private: later failure');return response(JSON.stringify(args[0]==='image'?[{Id:image,Config:{},RootFS:{Layers:[]}}]:[first]));},openEvents:(_args,onLine)=>{emit=onLine;return {stop:()=>{},done:Promise.resolve({...response(''),reason:'observer_stop'})};},leafReader:async()=>({samples:[],identity:bound}),kernelFactory:()=>kernel.createKernelCase({target,bootReader:async()=>boot,client:io}),save:async(_name,value)=>{record=value;}},work)});
 let result;if(mode==='primary-throw')await assert.rejects(probe(['memory']),e=>e===originalError);else{result=await probe(['memory']);assert.equal(result.code,137);assert.equal(result.state,first.State);}
 assert.equal(launches,1);assert(!JSON.stringify(record).includes('private:'));
 return {record,launches,clients,primary:result?.state??'original-exception'};
}
