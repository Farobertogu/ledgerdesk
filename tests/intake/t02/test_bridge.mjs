import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedStoppedPoll} from '../../../ci/intake/reception/bridge_status.mjs';
test('only a corroborated owned-container exit explains a polling race',()=>{
  const id='a'.repeat(64),state={Running:false,Status:'exited',ExitCode:0};
  const result={code:1,reason:null,stdout:'',stderr:`Error response from daemon: container ${id} is not running\n`};
  assert.equal(expectedStoppedPoll(result,id,state),true);
  for(const changed of [{code:127},{stderr:'Error: application fixture failed'},{stdout:'partial failure'},{reason:'worker_timeout'},
    {stderr:result.stderr.replace(id,'b'.repeat(64))}])assert.equal(expectedStoppedPoll({...result,...changed},id,state),false);
  for(const changed of [{Running:true},{Status:'dead'},{ExitCode:1}])assert.equal(expectedStoppedPoll(result,id,{...state,...changed}),false);
});
import './test_admin_observation.mjs';
import './test_observation_fault.mjs';
