/** Identified disposable-source fault after a durable raw artifact. */
export function interruptedSealCopy(source){
  const anchor="    }else durable(directory+'/'+name,bytes);";
  if(source.split(anchor).length!==2)throw Error('EXTRACTION_SEAL_FAULT_ANCHOR');
  return source.replace(anchor,anchor+`
    // Test-only process death; not a producer flag or a returned failure object.
    const armed='/output/test-seal-fault.json',used='/output/test-seal-fault-used.json';
    if(name==='raw.bin'&&fs.existsSync(armed)&&!fs.existsSync(used)&&json(armed).channel===bundle.id){
      durable(used,Buffer.from(JSON.stringify({channel:bundle.id,pid:process.pid,signal:'SIGKILL',after:'raw.bin'})));
      process.kill(process.pid,'SIGKILL');
    }`);
}
