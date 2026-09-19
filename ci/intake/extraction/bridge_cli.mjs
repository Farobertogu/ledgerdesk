// Trusted harness control. This executable is not reachable through the serving socket.
import fs from 'node:fs';
import {json,uuid,durable,readBounded,hash,subjectMatches} from './storage.mjs';
import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
const action=process.argv[2],channel=process.argv[3];
if(process.platform!=='linux'||process.getuid()!==1000)throw Error('EXTRACTION_BRIDGE_IDENTITY');
if(action==='pending'){
  const entries=fs.readdirSync('/output/queue');if(entries.length>64)throw Error('EXTRACTION_BRIDGE_LIMIT');
  const pending=entries.filter(uuid).filter(id=>fs.existsSync('/output/queue/'+id+'/request.json')&&!fs.existsSync('/output/queue/'+id+'/completion.json'));
  console.log(JSON.stringify(pending.map(id=>({channel:id,...json('/output/queue/'+id+'/request.json'),stopped:fs.existsSync('/output/queue/'+id+'/stop')}))));
}else{
  if(!uuid(channel))throw Error('EXTRACTION_BRIDGE_CHANNEL');
  const directory='/output/queue/'+channel;
  if(action==='stop-state')console.log(JSON.stringify({stopped:fs.existsSync(directory+'/stop')}));
  else if(action==='launched'){
    const launch=json(directory+'/launch.pending.json'),request=json(directory+'/request.json');
    if(!subjectMatches(launch.subject,request.subject)||launch.metadata.channel_id!==channel)throw Error('EXTRACTION_LAUNCH_ASSOCIATION');
    durable(directory+'/launch.json',Buffer.from(JSON.stringify(launch)));console.log(JSON.stringify({recorded:true}));
  }
  else if(action==='publish'){
    const metadata=json(directory+'/completion.pending.json'),request=json(directory+'/request.json');
    if(!subjectMatches(metadata.subject,request.subject)||metadata.requestId!==request.id)throw Error('EXTRACTION_BRIDGE_ASSOCIATION');
    if(metadata.metadata?.raw){
      const raw=readBounded(directory+'/raw.pending',EXTRACTION_BOUNDS.stdoutBytes);
      if(raw.length!==metadata.metadata.raw.bytes||hash(raw)!==metadata.metadata.raw.sha256)throw Error('EXTRACTION_BRIDGE_OUTPUT');
      durable(directory+'/raw.bin',raw);
    }
    durable(directory+'/completion.json',Buffer.from(JSON.stringify(metadata)));console.log(JSON.stringify({published:true}));
  }else throw Error('EXTRACTION_BRIDGE_ACTION');
}
