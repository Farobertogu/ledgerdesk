// Offline harness helper, invoked only after the host observes and removes the
// exact old container. The input record alone does not prove process closure.
import fs from 'node:fs';
import {PrivatePhaseJournal} from '../reception/private_phase.mjs';
import {hash} from './storage.mjs';
const input=JSON.parse(process.argv[2]??'{}'),participant=input.participant;
if(process.platform!=='linux'||process.getuid()!==1000||!['extraction','outputs'].includes(participant)||
  Object.keys(input).sort().join(',')!=='oldContainerId,participant'||!/^[a-f0-9]{64}$/.test(input.oldContainerId??''))
  throw Error('EXTRACTION_RESTART_SCOPE');
const directory='/output/phase-control',before=fs.readFileSync(directory+'/phases.json');
const journal=PrivatePhaseJournal.reopen(directory,participant);
if(Object.values(journal.rows).some(row=>row.state!=='closed'))throw Error('EXTRACTION_RESTART_UNCONFIRMED_PHASE');
const socket='/run/intake-t03/'+participant+'/channel.sock';
if(fs.existsSync(socket)){
  if(!fs.lstatSync(socket).isSocket())throw Error('EXTRACTION_RESTART_IPC');
  fs.unlinkSync(socket);
}
const after=fs.readFileSync(directory+'/phases.json');
if(!before.equals(after))throw Error('EXTRACTION_RESTART_JOURNAL_CHANGED');
console.log(JSON.stringify({ok:true,participant,journalSha256:hash(before),rows:journal.rows,
  meaning:'Every retained phase was already closed; no closure or termination was manufactured by replacement.'}));
