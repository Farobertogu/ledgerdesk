// Test-owned control executable, unreachable through either serving socket.
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const action=process.argv[2],input=JSON.parse(process.argv[3]??'{}');
if(process.platform!=='linux'||process.getuid()!==1000||!['observe','stop'].includes(action)||
  !/^[a-f0-9-]{36}$/.test(input.phaseId??''))throw Error('PROCESS_CONTROL_SCOPE');
const journal=JSON.parse(fs.readFileSync('/output/phase-control/phases.json','utf8'));
const row=journal.rows[input.phaseId];
if(!row?.binding)throw Error('PROCESS_CONTROL_PHASE');
const binding=JSON.parse(row.binding),target=JSON.parse(fs.readFileSync('/output/stall-target-used.json','utf8'));
if(binding.original.id!==target.artifactId||binding.original.generation!==target.generation)throw Error('PROCESS_CONTROL_TARGET');
const events=()=>fs.readFileSync('/output/events.ndjson','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const started=events().findLast(e=>e.origin==='private-supervisor'&&e.kind==='started'&&e.phaseId===input.phaseId&&e.action==='append');
if(!started?.processRef)throw Error('PROCESS_CONTROL_START');
const expected=started.processRef;
function inspect(checkCommand=true){
  let stat;try{stat=fs.readFileSync('/proc/'+expected.pid+'/stat','utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  if(!/^\d+$/.test(fields[19]??''))throw Error('PROCESS_CONTROL_START_TICKS');
  const actual={pid:expected.pid,startTicks:BigInt(fields[19]).toString(10),bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('PROCESS_CONTROL_IDENTITY');
  // After the exact live process was selected and signalled, executable/UID
  // files may disappear before /proc itself. Never count that transition as exit.
  if(!checkCommand)return{...actual,state:fields[0],parentPid:Number(fields[1])};
  const status=fs.readFileSync('/proc/'+expected.pid+'/status','utf8');
  const cmdline=fs.readFileSync('/proc/'+expected.pid+'/cmdline').toString('utf8').split('\0').filter(Boolean);
  if(!/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status)||!cmdline.includes('/work/operation_worker.mjs')||cmdline.at(-1)!=='objects')throw Error('PROCESS_CONTROL_IDENTITY');
  return{...actual,state:fields[0],parentPid:Number(fields[1]),namespacePid:status.split('\n').find(s=>s.startsWith('NSpid:')),cmdline};
}
const before=inspect(),requestedAtMs=Date.now();
if(action==='stop'){
  if(!before||before.state==='Z')throw Error('PROCESS_ALREADY_ENDED_BEFORE_CONTROL');
  process.kill(expected.pid,'SIGKILL');
  const deadline=Date.now()+1500;
  while(inspect(false)!==null||!events().some(e=>e.kind==='closed'&&e.requestId===started.requestId)){
    if(Date.now()>=deadline)throw Error('PROCESS_CLOSURE_UNCONFIRMED');await delay(10);
  }
}
const closure=events().findLast(e=>e.kind==='closed'&&e.requestId===started.requestId)??null;
const after=inspect(action!=='stop');
if(action==='stop'&&(!closure||closure.signal!=='SIGKILL'||closure.workerPid!==expected.pid))throw Error('PROCESS_CLOSE_OBSERVATION_MISSING');
console.log(JSON.stringify({ok:true,action,phaseId:input.phaseId,target,started,before,after,closure,requestedAtMs,observedAtMs:Date.now()}));
