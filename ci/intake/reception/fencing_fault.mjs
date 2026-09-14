/** Owned-copy experiment: suspend after valid append admission, before its write. */
export function suspendedAppendCopy(source){
  const anchor="const fd=fs.openSync(stage,'a');";
  if(source.split(anchor).length!==2)throw Error('FENCING_FAULT_ANCHOR');
  return source.replace(anchor,`if(fs.existsSync('/output/stall-target.json')){
      const target=JSON.parse(fs.readFileSync('/output/stall-target.json','utf8'));
      if(target.artifactId===original.id&&target.generation===original.generation&&target.offset===request.offset){
        fs.renameSync('/output/stall-target.json','/output/stall-target-used.json');
        console.log('INTAKE_STORAGE_STALL_REACHED '+JSON.stringify({artifactId:original.id,generation:original.generation,offset:request.offset,atMs:Date.now()}));
        const holdDeadline=Date.now()+15000;
        while(!fs.existsSync('/output/stall-release')){
          if(Date.now()>=holdDeadline)throw Error('OWNED_FAULT_RELEASE_TIMEOUT');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
        }
      }
    }
    ${anchor}`);
}

/** Reintroduce the old blanket incarnation check in an owned SQL copy. */
export function rejectRetainedIncarnationCopy(source){
  const needle="(a.incarnation<>p_incarnation AND NOT(e.route IN ('cancel_reception','resume_reception') OR\n      (e.route IN ('original','finalize_reception') AND a.state='sealed')))";
  if(source.split(needle).length!==2)throw Error('RETAINED_INCARNATION_FAULT_ANCHOR');
  return source.replace(needle,'a.incarnation<>p_incarnation');
}
