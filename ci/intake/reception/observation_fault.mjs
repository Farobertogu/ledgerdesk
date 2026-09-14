/** Captured-source faults for the post-handoff observation experiment only. */
export function observationFaultCopy(relative,text,fault){
  if(!['drop-fallback','destroy-after-observation'].includes(fault))throw Error('OBSERVATION_FAULT_SCOPE');
  if(relative!=='src/server/intake/terminal.ts')return text;
  const anchor=fault==='drop-fallback'
    ? "console.error('INTAKE_OBSERVATION_FAILURE '+JSON.stringify({...event,receiver}));"
    : "await observe(prepared,'handed_off',bytes.length);";
  if(text.split(anchor).length!==2)throw Error('OBSERVATION_FAULT_ANCHOR');
  return text.replace(anchor,fault==='drop-fallback'?'void event;':anchor+' res.destroy();');
}
