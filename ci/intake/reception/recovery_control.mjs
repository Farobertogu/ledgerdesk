// Offline, test-owned reconciliation. The host verifies and fences the exact
// old container before launching this helper; JSON alone is not that proof.
import fs from 'node:fs';
import {PrivatePhaseJournal} from './private_phase.mjs';
const input=JSON.parse(process.argv[2]??'{}');
if(process.platform!=='linux'||process.getuid()!==1000||input.profile!=='intake-offline-phase-recovery/1'||
  !/^[a-f0-9]{64}$/.test(input.oldContainerId??'')||!/^sha256:[a-f0-9]{64}$/.test(input.oldImageId??'')||
  !/^[a-f0-9-]{36}$/.test(input.phaseId??'')||input.runtimeProcess?.observed!=='closed')throw Error('OFFLINE_RECOVERY_SCOPE');
const journal=PrivatePhaseJournal.reopen('/output/phase-control','objects'),row=journal.rows[input.phaseId];
if(!row?.binding||row.state==='closed'||Object.entries(journal.rows).some(([id,r])=>id!==input.phaseId&&r.state!=='closed'))throw Error('OFFLINE_RECOVERY_PREDECESSOR');
const binding=JSON.parse(row.binding);
if(binding.incarnation!==input.incarnation||binding.evidenceId!==input.evidenceId||binding.original.id!==input.originalId||
  binding.original.generation!==input.generation)throw Error('OFFLINE_RECOVERY_BINDING');
const file='/output/phase-recovery-'+input.phaseId+'.json',fd=fs.openSync(file,'wx',0o600);
try{fs.writeFileSync(fd,JSON.stringify({input,before:row,atMs:Date.now()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
// Every delayed OPEN/command for this phase remains terminal after replacement.
journal.persist({...journal.rows,[input.phaseId]:{...row,state:'closed'}});
const socket='/run/intake-t02/objects/channel.sock';
if(fs.existsSync(socket)){if(!fs.lstatSync(socket).isSocket())throw Error('OFFLINE_RECOVERY_IPC');fs.unlinkSync(socket);}
console.log(JSON.stringify({ok:true,phaseId:input.phaseId,state:'closed',oldContainerId:input.oldContainerId}));
