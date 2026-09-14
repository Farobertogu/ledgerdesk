import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
async function read(file){const h=await fs.open(file,'r');try{const b=Buffer.alloc(4097),r=await h.read(b,0,b.length,0);assert(r.bytesRead<=4096,'PROFILE_FILE_LIMIT');return new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,r.bytesRead));}finally{await h.close();}}
export async function readHierarchy(binding,{readFile=read,realpath=fs.realpath}={}){
 assert(binding?.cgroup?.startsWith('/')&&!binding.cgroup.split('/').includes('..'),'UNBOUND_HIERARCHY');
 const root=await realpath('/sys/fs/cgroup'),leaf=await realpath(root+binding.cgroup);
 assert(leaf.startsWith(root+'/'),'PROFILE_PATH_ESCAPE');
 const rows=[];let at=leaf;
 for(let n=0;n<8;n++){
  const values={},missing=[];
  for(const key of ['memory.max','memory.high','memory.swap.max','cpu.max','pids.max'])try{
   const value=(await readFile(at+'/'+key)).trim();
   assert(key==='cpu.max'?/^(max|\d+) \d+$/.test(value):/^(max|\d+)$/.test(value),'PROFILE_VALUE');values[key]=value;
  }catch(e){missing.push(key);}
  rows.push({path:at.slice(root.length)||'/',values,missing});if(at===root)break;at=path.posix.dirname(at);
 }
 assert.equal(rows.at(-1).path,'/','PROFILE_DEPTH_LIMIT');
 assert.equal(rows[0].values['memory.max'],'536870912','TARGET_MEMORY_LIMIT');
 assert.equal(rows[0].values['memory.swap.max'],'0','TARGET_SWAP_LIMIT');
 assert.equal(rows[0].values['cpu.max'],'100000 100000','TARGET_CPU_LIMIT');assert.equal(rows[0].values['pids.max'],'64','TARGET_PID_LIMIT');
 assert(rows.filter(r=>r.path!=='/').every(r=>r.missing.length===0),'ANCESTOR_LIMIT_UNAVAILABLE');
 return {status:'observed',target:binding.target,rows,scope:'Sequential target and relevant ancestor constraints; not a victim oracle or atomic snapshot. Root files absent where unsupported remain explicitly missing.'};
}
