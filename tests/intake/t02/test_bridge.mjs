import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedStoppedPoll,failedRuntimeStoppedPoll} from '../../../ci/intake/reception/bridge_status.mjs';
test('only a corroborated owned-container exit explains a polling race',()=>{
  const id='a'.repeat(64),state={Running:false,Status:'exited',ExitCode:0};
  const result={code:1,reason:null,stdout:'',stderr:`Error response from daemon: container ${id} is not running\n`};
  assert.equal(expectedStoppedPoll(result,id,state),true);
  for(const changed of [{code:127},{stderr:'Error: application fixture failed'},{stdout:'partial failure'},{reason:'worker_timeout'},
    {stderr:result.stderr.replace(id,'b'.repeat(64))}])assert.equal(expectedStoppedPoll({...result,...changed},id,state),false);
  for(const changed of [{Running:true},{Status:'dead'},{ExitCode:1}])assert.equal(expectedStoppedPoll(result,id,{...state,...changed}),false);
});
test('a corroborated failed runtime explains only its secondary stopped poll',()=>{
  const id='a'.repeat(64),state={Running:false,Status:'exited',ExitCode:1,OOMKilled:false,Dead:false,Error:''};
  const execution={code:1,signal:null,reason:null};
  const poll={code:1,reason:null,stdout:'',stderr:`Error response from daemon: container ${id} is not running\n`};
  assert.equal(failedRuntimeStoppedPoll(poll,id,state,execution),true);
  assert.equal(expectedStoppedPoll(poll,id,state),false,'This never qualifies a successful run');
  assert.deepEqual({runtimeExit:execution.code,containerExit:state.ExitCode},{runtimeExit:1,containerExit:1});
  for(const changed of [{code:127},{reason:'worker_timeout'},{stdout:'partial failure'},{stderr:'unrelated bridge failure'},
    {stderr:poll.stderr.replace(id,'b'.repeat(64))}])assert.equal(failedRuntimeStoppedPoll({...poll,...changed},id,state,execution),false);
  for(const changed of [{Running:true},{Status:'dead'},{ExitCode:0},{ExitCode:2},{OOMKilled:true},{Dead:true},{Error:'runtime fault'}])
    assert.equal(failedRuntimeStoppedPoll(poll,id,{...state,...changed},execution),false);
  for(const changed of [{code:0},{code:2},{code:null},{signal:'SIGTERM'},{reason:'worker_timeout'}])
    assert.equal(failedRuntimeStoppedPoll(poll,id,state,{...execution,...changed}),false);
});
import './test_admin_observation.mjs';
import './test_observation_fault.mjs';
