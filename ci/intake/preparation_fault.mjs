/** Directed construction regressions in a captured source copy only. */
export function preparationFaultCopy(relative,source,variant){
  if(!['drop-retained-context','drop-retained-limitation','swap-resource-at-birth','swap-resource-at-consume','flatten-component-causes','ignore-c9-conditions','drop-item-lock','drop-prior-target',
    'hash-identity','hidden-duplicate-status','auto-publish-candidate'].includes(variant))throw Error('PREPARATION_MUTATION_SCOPE');
  if(variant==='hash-identity'){
    if(relative!=='src/server/intake/preparation/proposals.ts')return source;
    const pattern=/const disposition = comparisonDisposition\(([^\n]+)\);/g;
    if([...source.matchAll(pattern)].length!==2)throw Error('PREPARATION_HASH_MUTATION_ANCHOR');
    // Exercise both real consumers without disabling the helper's unit guard.
    return source.replace(pattern,(_whole,args)=>{
      const [target,,identity]=args.split(',').map(value=>value.trim());
      return `const disposition = ((value: string) => value==='possible_duplicate'&&${target}.kind==='relationship'&&`+
        `${identity}===compared?.candidate.content_identity?'relationship_recorded':value)(comparisonDisposition(${args}));`;
    });
  }
  if(variant==='hidden-duplicate-status'){
    if(relative!=='src/server/intake/preparation/comparison.ts')return source;
    const anchor="  if (!meta || !same(current, meta.context)) throw new IntakeFailure(404);";
    if(source.split(anchor).length!==2)throw Error('PREPARATION_COMPARISON_MUTATION_ANCHOR');
    return source.replace(anchor,
      '  if (!meta) throw new IntakeFailure(404);\n  if (!same(current, meta.context)) throw new IntakeFailure(409);');
  }
  if(variant==='auto-publish-candidate'){
    let anchor,replacement;
    if(relative==='src/server/intake/postgres/008_preparation_data.sql'){
      anchor="editorial_state text NOT NULL CHECK(editorial_state='candidate')";
      replacement="editorial_state text NOT NULL CHECK(editorial_state IN ('candidate','published'))";
    }else if(relative==='src/server/intake/preparation/proposals.ts'){
      anchor="$8,$9,$10,\\'candidate\\')";replacement="$8,$9,$10,\\'published\\')";
    }else return source;
    if(source.split(anchor).length!==2)throw Error('PREPARATION_EDITORIAL_MUTATION_ANCHOR');
    return source.replace(anchor,replacement);
  }
  if(variant==='drop-prior-target'){
    if(relative!=='src/server/intake/preparation/prior_act.ts')return source;
    const anchor='  if (!same(prior.body.target, expected)) throw new IntakeFailure(404);';
    if(source.split(anchor).length!==2)throw Error('PREPARATION_PRIOR_TARGET_ANCHOR');
    return source.replace(anchor,'  void expected; // Deliberate captured-copy correspondence regression.');
  }
  if(variant==='drop-item-lock'){
    if(relative!=='src/server/intake/preparation/service.ts')return source;
    const anchor="keys = ['intake:constitution-slot:' + meta.slot_id,";
    if(source.split(anchor).length!==2)throw Error('PREPARATION_SLOT_MUTATION_ANCHOR');
    return source.replace(anchor,'keys = [');
  }
  if(variant==='ignore-c9-conditions'){
    if(relative!=='src/server/intake/preparation/proposals.ts')return source;
    const pattern=/const disposition = comparisonDisposition\(([^\n]+)\);/g;
    if([...source.matchAll(pattern)].length!==2)throw Error('PREPARATION_C9_MUTATION_ANCHOR');
    // Mutate the two real orchestration consumers after the comparison, not the
    // helper already discriminated by its unit test. Admission remains intact.
    return source.replace(pattern,"const disposition = ((value: string) => value === 'identity_collision' ? 'relationship_recorded' : value)(comparisonDisposition($1));");
  }
  if(variant==='swap-resource-at-consume'){
    if(relative!=='src/server/intake/preparation/service.ts')return source;
    const anchor='    const artifact = association.artifact;';
    if(source.split(anchor).length!==2)throw Error('PREPARATION_RESOURCE_CONSUME_ANCHOR');
    return source.replace(anchor,"    const artifact = association.artifact.id === 'A-17' ?\n"+
      "      (await a.db.query(\"SELECT id,generation,bytes,sha256 FROM $INTAKE.preparation_resource WHERE id='A-18' AND generation=9\")).rows[0] : association.artifact;");
  }
  if(relative!=='src/server/intake/preparation/producer.ts')return source;
  const anchor='  const bytes = encodePayload(payload), target = {';
  if(source.split(anchor).length!==2)throw Error('PREPARATION_MUTATION_ANCHOR');
  // All input/schema/source/authority checks have already run. The changed
  // constructor emits a structurally valid but semantically incomplete packet;
  // ordinary sealing recalculates every digest. Only the independent expected
  // result can discriminate this deliberate regression.
  const injected=variant==='flatten-component-causes'?
    "  if(d.units[0]?.id === 'Mixed') payload.incidents = payload.incidents.map((i: Row) => i.cause === 'unreadable' ? {...i, cause:'technical_failure'} : i);\n":variant==='swap-resource-at-birth'?
    "  if(d.units[0]?.id === 'Resource17' && sourceMap.has('alternative')){\n"+
    "    const other = sourceMap.get('alternative')!.content.instrumented_resources.payloads[0];\n"+
    "    resources.splice(0, resources.length, copy(other.artifact));\n"+
    "    payload.elements.find((e: Row) => e.id === 'figure')!.resource = copy(other.artifact);\n"+
    "    payload.resource_associations[0].artifact = copy(other.artifact);\n"+
    "    args.resourceBodies.push({artifact: copy(other.artifact), bytes: Buffer.from(other.data, 'base64')});\n"+
    "  }\n":variant==='drop-retained-limitation'?
    "  if(d.units[0]?.id === 'X07') payload.components = payload.components.map((c: Row) => ({...c, limitations: c.limitations.filter((l: string) => l !== 'semantic-fidelity-unverified')}));\n":
    "  if(r.base && d.transformation === 'correction' && d.elements[0]?.id === 'exception'){\n"+
    "    payload.elements = payload.elements.filter((e: Row) => e.id !== 'exception');\n"+
    "    payload.relations = [];\n"+
    "    payload.units = payload.units.map((u: Row) => ({...u, elements: u.elements.filter((id: string) => id !== 'exception')}));\n"+
    "  }\n";
  return source.replace(anchor,injected+anchor);
}
