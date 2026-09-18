/** Mutate the internal component after structural validation, never a public
 * request or the independent expected reference. Used only in source copies. */
export function semanticFaultCopy(relative,source,variant){
  if(!['omit-condition-store','omit-limitation-store','omit-incident-query','omit-resource-relation-store','read-resource-before-validation','allow-resource-swap',
    'xlsx-recalculate-store','xlsx-hide-sheet-store','xlsx-context-store'].includes(variant))throw Error('SEMANTIC_MUTATION_SCOPE');
  if(relative==='src/server/intake/extraction_output.ts'&&variant.startsWith('xlsx-')){
    const anchor='  const normalized=Buffer.from(JSON.stringify(content));\n  if(normalized.length>EXTRACTION_BOUNDS.normalizedBytes)';
    if(source.split(anchor).length!==2)throw Error('XLSX_STORE_MUTATION_ANCHOR');
    const fault={'xlsx-recalculate-store':"const cell=content.elements[0]?.cells.find((c:any)=>c.address==='D2');if(cell?.cached?.lexical==='24.00')cell.cached.lexical='25.00';",
      'xlsx-hide-sheet-store':"content.elements=content.elements.filter((e:any)=>e.sheet?.visibility!=='hidden');",
      'xlsx-context-store':"if(content.elements[0])content.elements[0].antecedents[0].coordinates='xl/worksheets/sheet2.xml';"}[variant];
    return source.replace(anchor,"  if(content.format_profile==='xlsx-cells/1'&&content.outcome!=='failed'){"+fault+'}\n'+anchor);
  }
  if(relative==='src/server/intake/extraction_resources.ts'){
    const replace=(anchor,replacement)=>{if(source.split(anchor).length!==2)throw Error('RESOURCE_MUTATION_ANCHOR');return source.replace(anchor,replacement);};
    if(variant==='omit-resource-relation-store')return replace('  const normalized=Buffer.from(JSON.stringify(content));',
      '  content.relations=[]; // Deliberate internal omission after validation.\n  const normalized=Buffer.from(JSON.stringify(content));');
    if(variant==='read-resource-before-validation')return replace('  const found=structuredClone(value) as any;',
      '  const found=structuredClone(value) as any;\n  if(found.resources.length)await port.read(found.resources[0]);');
    if(variant==='allow-resource-swap')return replace('!same(found.selections,expected.selections)||','false||');
  }
  if(relative==='src/server/intake/extraction_output.ts'&&['omit-condition-store','omit-limitation-store'].includes(variant)){
    const anchor="  const normalized=Buffer.from(JSON.stringify(content));\n  if(normalized.length>EXTRACTION_BOUNDS.normalizedBytes)";
    if(source.split(anchor).length!==2)throw Error('SEMANTIC_STORE_MUTATION_ANCHOR');
    const fault=variant==='omit-condition-store'?
      "  if(content.format_profile==='text-utf8/1')content.elements=content.elements.filter((e:any)=>!e.text?.includes('Under condition Z'));\n":
      "  if(content.format_profile==='xlsx-cells/1')for(const c of content.components)c.limitations=c.limitations.filter((v:string)=>v!=='semantic-fidelity-unverified');\n";
    return source.replace(anchor,fault+anchor);
  }
  if(relative==='src/server/intake/extraction_query.ts'&&variant==='omit-incident-query'){
    const anchor='    body.result={id:r.id,effect:exact(r.effect_id,1,{effectId:r.effect_id}),attempt_generation:r.attempt_generation,content};';
    if(source.split(anchor).length!==2)throw Error('SEMANTIC_QUERY_MUTATION_ANCHOR');
    return source.replace(anchor,"    if(content.format_profile==='xlsx-cells/1'){const omitted=content.incidents.find((i:any)=>i.detail==='xl/media/image1.svg');\n"+
      "      if(omitted){content.incidents=content.incidents.filter((i:any)=>i.id!==omitted.id);content.components=content.components.filter((c:any)=>c.id!==omitted.component);}}\n"+anchor);
  }
  return source;
}
