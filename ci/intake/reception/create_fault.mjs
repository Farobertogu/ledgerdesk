// Faults affect only the identified disposable composition, never the working source.
export function createFailureCopy(file, source) {
  const replace = (text, anchor, next) => {
    if (text.split(anchor).length !== 2) throw Error('CREATE_FAULT_ANCHOR');
    return text.replace(anchor, next);
  };
  if (file === 'ci/intake/reception/object_store.mjs') {
    source = replace(source, "    if(request.action==='create') {", `    if(request.action==='create') {
      const file='/output/create-fault.json';
      const injected=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
      const selected=injected?.artifactId===original.id&&injected.generation===original.generation;
      if(selected&&injected.mode==='denied')save(fenced,Buffer.from(request.incarnation));`);
    return replace(source, '      save(stage,Buffer.alloc(0));', `      if(selected&&['failed','unclosed'].includes(injected.mode))throw Error('INJECTED_CREATE_AFTER_METADATA');
      save(stage,Buffer.alloc(0));`);
  }
  if (file === 'ci/intake/reception/server.mjs') {
    source = replace(source, "from 'node:fs';", "from 'node:fs';\nimport {readFileSync} from 'node:fs';");
    return replace(source, "      if(request.profile==='intake-phase-control/1'){", `      if(request.profile==='intake-phase-control/1'){
        if(mode==='objects'&&request.action==='close'&&existsSync('/output/create-fault.json')){
          const fault=JSON.parse(readFileSync('/output/create-fault.json'));
          const binding=JSON.parse(journal.rows[request.phaseId]?.binding??'null');
          if(fault.mode==='unclosed'&&binding?.original.id===fault.artifactId&&binding.original.generation===fault.generation)
            throw Error('INJECTED_CREATE_UNCLOSED');
        }`);
  }
  return source;
}
