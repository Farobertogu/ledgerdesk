import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {referenceFor,sealDifference} from '../../../src/server/intake/preparation/records.ts';
import {PREPARATION_DIFFERENCE} from '../../../src/contracts/intake_preparation.ts';
const control='/work/output/t04-difference-input.json';

/** Imported only into the captured association-test service, never production. */
export function applyDifferenceInput(record,phase){
  if(!existsSync(control))return;
  const configured=JSON.parse(readFileSync(control,'utf8'));
  if(configured.phase!==phase||phase==='consume'&&(record.reference.id!==configured.target.id||record.reference.revision!==configured.target.revision))return;
  const current=record.differences[0];
  const wrong=configured.kind==='other-pair'?configured.other:sealDifference(current.reference.id,current.reference.revision,
    {...current.body,before:[configured.before]});
  if(!PREPARATION_DIFFERENCE(wrong.body)||JSON.stringify(referenceFor('preparation-difference/1',wrong.reference.id,wrong.reference.revision,wrong.body))!==JSON.stringify(wrong.reference))
    throw Error('DIFFERENCE_TEST_INPUT_INVALID');
  const expected={target:record.descriptor.id,revision:record.descriptor.revision,before:current.body.before};
  record.differences=[wrong];record.descriptor.differences=[wrong.reference];
  record.reference=referenceFor('preparation-descriptor/1',record.descriptor.id,record.descriptor.revision,record.descriptor);
  writeFileSync(configured.observation,JSON.stringify({phase,kind:configured.kind,expected,actual:wrong,representationValid:true,pid:process.pid}),{flag:'wx'});
}
