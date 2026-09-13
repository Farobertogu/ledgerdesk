/** Only the inspected exit of this owned container can explain the exec/start race. */
export function expectedStoppedPoll(result, containerId, state) {
  if(result.code!==1||result.reason||result.stdout!==''||state?.Running!==false||state?.Status!=='exited'||state?.ExitCode!==0)return false;
  if(!/^[a-f0-9]{64}$/.test(containerId))return false;
  return result.stderr.trim()===`Error response from daemon: container ${containerId} is not running`;
}
