/** Instrument an identified service copy at its internal normalization entry.
 * Public JSON/IPC admission and the real original worker remain unchanged. */
export function associationBoundaryCopy(relative,source){
  if(relative!=='src/server/intake/extraction_output.ts')return source;
  const anchor='export function materializeExtraction(raw:Buffer,expected:WorkerBinding,actualChannel:string):ExtractionMaterial {\n';
  if(source.split(anchor).length!==2)throw Error('ASSOCIATION_BOUNDARY_ANCHOR');
  return source.replace(anchor,anchor+
    '  const injected=(globalThis as any).__t03AssociationInput?.(raw,expected,actualChannel);\n'+
    '  if(injected){raw=injected.raw;actualChannel=injected.channel;}\n');
}
