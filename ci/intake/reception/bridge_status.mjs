function matchingStoppedPoll(result, containerId, state) {
  if(result.code!==1||result.reason||result.stdout!==''||state?.Running!==false||state?.Status!=='exited')return false;
  if(!/^[a-f0-9]{64}$/.test(containerId))return false;
  return result.stderr.trim()===`Error response from daemon: container ${containerId} is not running`;
}
/** Only the inspected successful exit can excuse a poll in a successful run. */
export function expectedStoppedPoll(result, containerId, state) {
  return state?.ExitCode===0&&matchingStoppedPoll(result,containerId,state);
}
/** This classifies the secondary poll; the attached process remains a failure. */
export function failedRuntimeStoppedPoll(result, containerId, state, execution) {
  if(!Number.isSafeInteger(state?.ExitCode)||state.ExitCode<=0||state.OOMKilled!==false||state.Dead!==false||state.Error!==''||
    execution?.code!==state.ExitCode||execution.signal!==null||execution.reason)return false;
  return matchingStoppedPoll(result,containerId,state);
}
