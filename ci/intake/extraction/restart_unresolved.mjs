// Offline fault harness only. The host first observes the exact old container
// stopped. Removing its stale socket does not close any retained phase.
import fs from 'node:fs';
import {PrivatePhaseJournal} from '../reception/private_phase.mjs';
import {hash} from './storage.mjs';
const input=JSON.parse(process.argv[2]??'{}'),participant=input.participant;
if(process.platform!=='linux'||process.getuid()!==1000||participant!=='outputs'||
  Object.keys(input).sort().join(',')!=='oldContainerId,participant'||!/^[a-f0-9]{64}$/.test(input.oldContainerId??''))
  throw Error('EXTRACTION_UNRESOLVED_RESTART_SCOPE');
const directory='/output/phase-control',before=fs.readFileSync(directory+'/phases.json');
const journal=PrivatePhaseJournal.reopen(directory,participant);
if(!Object.values(journal.rows).some(row=>row.state!=='closed'))throw Error('EXTRACTION_UNRESOLVED_RESTART_PREDECESSOR');
const socket='/run/intake-t03/'+participant+'/channel.sock';
if(fs.existsSync(socket)){
  if(!fs.lstatSync(socket).isSocket())throw Error('EXTRACTION_RESTART_IPC');
  fs.unlinkSync(socket);
}
if(!before.equals(fs.readFileSync(directory+'/phases.json')))throw Error('EXTRACTION_RESTART_JOURNAL_CHANGED');
console.log(JSON.stringify({ok:true,participant,journalSha256:hash(before),rows:journal.rows,
  meaning:'Unresolved rows and their old owners are unchanged. The replacement must refuse them; no closure is manufactured.'}));
