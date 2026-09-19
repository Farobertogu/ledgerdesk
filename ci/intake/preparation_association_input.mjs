/** Invalid intermediate values injected into an identified disposable service
 * copy. The public decoder, actual constructor and admission remain unchanged. */
export function preparationAssociationCopy(relative,source){
  const edits={
    'src/server/intake/preparation/service.ts':[
      '    await persistPreparation(a.db, attempt, produced);',
      "    applyDifferenceInput(produced.record, 'persist');\n"],
    'src/server/intake/preparation/persistence.ts':[
      '  if (!verifyPreparation(record, bytes) || !same(row.descriptor.payload,',
      "  applyDifferenceInput(record, 'consume');\n"],
  };
  if(relative==='src/server/intake/preparation/service.ts'){
    const anchor='    return {...retained, meta};';
    if(source.split(anchor).length!==2)throw Error('PREPARATION_RESOLVER_INPUT_ANCHOR');
    source="import {applyResolvedInput} from '../../../../tests/intake/preparation/resolver_input.mjs';\n"+
      source.replace(anchor,"    applyResolvedInput(retained, 'resolved');\n"+anchor);
  }
  if(relative==='src/server/intake/preparation/persistence.ts'){
    const anchor='  const bytes = Buffer.from(row.payload), payload = readPreparationPayload(bytes);';
    if(source.split(anchor).length!==2)throw Error('PREPARATION_STORAGE_INPUT_ANCHOR');
    source="import {applyStoredInput} from '../../../../tests/intake/preparation/resolver_input.mjs';\n"+
      source.replace(anchor,"  applyStoredInput(row, expected);\n"+anchor);
  }
  if(!edits[relative])return source;
  const [anchor,injection]=edits[relative];
  if(source.split(anchor).length!==2)throw Error('PREPARATION_ASSOCIATION_INPUT_ANCHOR');
  return "import {applyDifferenceInput} from '../../../../tests/intake/preparation/difference_input.mjs';\n"+source.replace(anchor,injection+anchor);
}
