import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import {spawnSync,spawn} from 'node:child_process';
const [kind,arg]=process.argv.slice(2);
const attempt=fn=>{try{fn();return 'allowed';}catch(e){return e.code??e.message;}};
if(kind==='environment'){
 const read=p=>attempt(()=>{})==='allowed'&&fs.readFileSync(p,'utf8').trim();
 console.log(JSON.stringify({uid:process.getuid(),node:process.version,memory:read('/sys/fs/cgroup/memory.max'),swap:read('/sys/fs/cgroup/memory.swap.max'),cpu:read('/sys/fs/cgroup/cpu.max'),pids:read('/sys/fs/cgroup/pids.max'),status:read('/proc/self/status'),limits:read('/proc/self/limits')}));
}else if(kind==='permissions'){
 console.log(JSON.stringify({read:attempt(()=>fs.readFileSync('/sentinel/value')),write:attempt(()=>fs.writeFileSync('/work/forbidden','x')),child:attempt(()=>{const r=spawnSync(process.execPath,['-e','process.exit(0)']);if(r.error)throw r.error;if(r.status!==0)throw Error('child_failed');}),workspace:attempt(()=>fs.writeFileSync('/workspace/allowed','x'))}));
}else if(kind==='filesystem'){
 console.log(JSON.stringify({sourceWrite:attempt(()=>fs.writeFileSync('/work/tests/fixtures/text.txt','x')),rootWrite:attempt(()=>fs.writeFileSync('/forbidden','x')),sentinel:attempt(()=>fs.readFileSync('/sentinel/value')),socket:attempt(()=>fs.readFileSync('/var/run/docker.sock')),workspace:attempt(()=>fs.writeFileSync('/workspace/allowed','x'))}));
}else if(kind==='network'){
 const tcp=host=>new Promise(resolve=>{const s=net.connect({host,port:32101});s.setTimeout(700);s.on('connect',()=>{s.write('probe');s.end();resolve('connected');});s.on('error',e=>resolve(e.code));s.on('timeout',()=>{s.destroy();resolve('timeout');});});
 const udp=()=>new Promise(resolve=>{const s=dgram.createSocket('udp4');const timer=setTimeout(()=>{s.close();resolve('timeout');},700);s.on('error',e=>{clearTimeout(timer);s.close();resolve(e.code);});s.on('message',()=>{clearTimeout(timer);s.close();resolve('reply');});s.send('probe',32102,arg);});
 console.log(JSON.stringify({literal:await tcp(arg),name:await tcp('trap'),udp:await udp(),dns:await dns.lookup('trap').then(()=>true,()=>false)}));
}else if(kind==='trap'){
 net.createServer(s=>{console.log('TCP_HIT');s.end();}).listen(32101,'0.0.0.0');
 const u=dgram.createSocket('udp4');u.on('message',(m,r)=>{console.log('UDP_HIT');u.send('ok',r.port,r.address);});u.bind(32102,'0.0.0.0');
 console.log('TRAP_READY');
}else if(kind==='cpu'){while(true){}}
else if(kind==='memory'){const chunks=[];while(true){const b=Buffer.alloc(16*1024*1024,1);chunks.push(b);}}
else if(kind==='files'){let count=0;const handles=[];try{while(true){handles.push(fs.openSync('/dev/null','r'));count++;}}catch(e){console.log(JSON.stringify({count,error:e.code}));}}
else if(kind==='workspace'){let count=0;try{while(true){fs.writeFileSync('/workspace/f-'+count,Buffer.alloc(1048576));count++;}}catch(e){console.log(JSON.stringify({count,error:e.code}));}}
else if(kind==='inodes'){
 const before=fs.statfsSync('/workspace');
 if(before.type!==0x01021994||before.files!==128||before.ffree<64)throw Error('INODE_PREREQUISITE');
 const snapshot=()=>{const s=fs.statfsSync('/workspace');return{files:s.files,freeInodes:s.ffree,blockSize:s.bsize,freeBlocks:s.bfree,totalBlocks:s.blocks};};
 const initial=snapshot();let count=0,error,positive;
 try{for(;count<256;count++){fs.writeFileSync('/workspace/i-'+count,'x',{flag:'wx'});if(count===15)positive=snapshot();}}
 catch(e){error=e.code;}
 console.log(JSON.stringify({node:process.version,initial,positive,final:snapshot(),count,error,bytesWritten:count,mount:fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').find(l=>l.includes(' /workspace '))}));
}
else if(kind==='pids'){const children=[];let error;for(let i=0;i<80;i++){const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'});children.push(child);child.on('error',e=>{error=e.code;});await new Promise(r=>setTimeout(r,20));if(error)break;}for(const child of children)child.kill();console.log(JSON.stringify({started:children.filter(c=>c.pid).length,error}));}
else if(kind==='output'){process.stdout.write(Buffer.alloc(Number(arg),120));}
else if(kind==='utf8'){process.stdout.write(Buffer.from([0x61,0xf0,0x9f,0x98,0x80]));}
else throw Error('UNKNOWN_PROBE');
