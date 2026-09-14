/** Mutations are applied only to the captured source after an exact anchor check. */
export function observerFaultCopy(relative, source, mutation) {
  const replace = (text, old, value) => {
    if (text.split(old).length !== 2) throw Error('OBSERVER_MUTATION_ANCHOR');
    return text.replace(old, value);
  };
  if (mutation === 'response-byte' && relative === 'src/server/intake/service.ts') {
    return "import {existsSync as observerArmed} from 'node:fs';\n" + replace(source,
      'prepared.originalBytes=bytes;',
      "if(observerArmed('/work/output/observer-fault-armed'))bytes[bytes.length-1]^=1;\n    prepared.originalBytes=bytes;");
  }
  if (mutation === 'omit-physical-read' && relative === 'ci/intake/reception/object_store.mjs') {
    return replace(source, 'function event(request,kind,bytes=0,offset=0) {',
      "function event(request,kind,bytes=0,offset=0) {\n    if(kind==='read'&&fs.existsSync('/output/observer-fault-armed'))return;");
  }
  return source;
}
