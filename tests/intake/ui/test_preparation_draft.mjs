import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyPreparationDraft, elementChoices, preparationDocument, proposalInspection} from '../../../src/components/intake/preparation.ts';

const reference = {id: 'effect-1', revision: 1, sha256: 'a'.repeat(64)};
const extraction = () => ({view: 'content', extraction: {id: 'job-1'}, result: {effect: reference, content: {
  elements: [{id: 'rule', kind: 'text', text: '  AZ-17  \n', original_range: {bytes: [0, 10], code_points: [0, 10]}},
    {id: 'condition', kind: 'text', text: 'Under Z.\n', original_range: {bytes: [10, 19], code_points: [10, 19]}}],
  relations: [{id: 'context', from: 'rule', to: 'condition', role: 'indispensable', scope: 'AZ-17', origin: 'observed'}],
  components: [{id: 'source-text', execution: 'completed', coverage: 'partial', fidelity: 'unchecked', limitations: ['unexamined'], incidents: []}],
  incidents: [], inventory: 'known'},
}});
const human = () => ({...emptyPreparationDraft(), selected: ['rule', 'condition'],
  classification: {function: {value: 'normative', reason: ''}, basis: {value: 'non_authoritative_reference', reason: ''}, scope: {value: 'situated', reason: ''}},
  examination: {outcome: 'classifiable', reason: 'Explicit human judgment.'}, coverage: {completeSourceClaim: false, reason: 'A selected source, with its retained limits.'}});
test('PUI01 no default classification or unexamined completeness claim is manufactured', () => {
  const draft = emptyPreparationDraft();
  assert.deepEqual(Object.values(draft.classification).map(x => x.value), [null, null, null]);
  assert.equal(draft.coverage.completeSourceClaim, false);
  assert.throws(() => preparationDocument(extraction(), draft));
});
test('PUI02 independent exact text, coordinates and dependency remain in a human request', () => {
  const result = preparationDocument(extraction(), human());
  assert.equal(result.document.transformation, 'exact_selection');
  assert.deepEqual(result.document.elements.map(e => e.text), ['  AZ-17  \n', 'Under Z.\n']);
  assert.deepEqual(result.document.elements[0].antecedents, [{input_id: 'source', kind: 'bytes', coordinates: 'original:0..10', byte_range: [0, 10], code_point_range: [0, 10]}]);
  assert.deepEqual(result.document.relations, [{id: 'source:context', from: 'rule', to: 'condition', role: 'indispensable', scope: 'AZ-17', origin: 'observed'}]);
  assert.deepEqual(result.document.units[0].coverage.components, ['source:source-text']);
  assert.equal(Object.hasOwn(result.document, 'observation'), false, 'Request must not replace retained extraction observations.');
  assert.throws(() => preparationDocument(extraction(), {...human(), selected: ['rule']}), /both ends/);
});
test('PUI03 text correction is distinct, requires a reason and preserves the original reference', () => {
  const source = extraction(), draft = {...human(), corrections: {rule: 'Corrected  AZ-17\n'}};
  assert.throws(() => preparationDocument(source, draft), /Explain/);
  const result = preparationDocument(source, {...draft, changeReason: 'Synthetic human correction.'});
  assert.equal(source.result.content.elements[0].text, '  AZ-17  \n');
  assert.equal(result.document.elements[0].text, 'Corrected  AZ-17\n');
  assert.deepEqual(result.document.differences[0].affected, [{kind: 'element', id: 'rule'}]);
  assert.deepEqual(result.inputs[0].reference, reference);
});
test('PUI04 table display retains lexical, formula, stored-result and absent distinctions', () => {
  const source = extraction();
  source.result.content.elements = [{id: 'sheet', kind: 'table', antecedents: [{coordinates: 'Items!A1:D4'}], cells: [
    {address: 'A1', value: {kind: 'text', lexical: '001'}},
    {address: 'D2', value: {kind: 'number_lexical', lexical: '24'}, formula: 'B2*C2', cached: {kind: 'number_lexical', lexical: '24'}, number_format: '0.00'},
    {address: 'D3', value: {kind: 'missing', lexical: ''}, formula: 'B3*C3'},
    {address: 'D4', value: {kind: 'number_lexical', lexical: '0'}, formula: 'B4*C4', cached: {kind: 'number_lexical', lexical: '0'}},
  ]}];
  const table = elementChoices(source)[0].inspection;
  assert.deepEqual(table.rows, [
    ['A1', 'text', '001', '[absent]', '[absent]', '[absent]', '[absent]'],
    ['D2', 'number_lexical', '24', 'B2*C2', 'number_lexical', '24', '0.00'],
    ['D3', 'missing', '', 'B3*C3', '[absent]', '[absent]', '[absent]'],
    ['D4', 'number_lexical', '0', 'B4*C4', 'number_lexical', '0', '[absent]'],
  ]);
});
test('PUI05 CSV is a positional visible table, not only serialized metadata', () => {
  const source = extraction();
  source.result.content.elements = [{id: 'csv', kind: 'table', antecedents: [{coordinates: 'records:0..2'}], cells: [],
    headers: ['Code', 'Value', 'Value'], rows: [
      {index: 0, fields: ['Code', 'Value', 'Value'], byte_range: [0, 18], raw: 'Code,Value,Value\r\n'},
      {index: 1, fields: ['001', '', 'Line one\r\nLine two'], byte_range: [18, 44], raw: '001,,"Line one\r\nLine two"\r\n'},
    ]}];
  const table = elementChoices(source)[0].inspection;
  assert.deepEqual(table.columns, ['Record', 'Column 1: Code', 'Column 2: Value', 'Column 3: Value']);
  assert.deepEqual(table.rows, [['0', 'Code', 'Value', 'Value'], ['1', '001', '', 'Line one\r\nLine two']]);
});
test('PUI06 an exact proposal does not borrow conditions from another unit sharing its elements', () => {
  const document = preparationDocument(extraction(), human()).document;
  document.units[0].conditions = ['selected-condition'];
  document.units.push({...structuredClone(document.units[0]), id: 'another-unit', conditions: ['other-condition']});
  document.conditions = [{id: 'selected-condition', text: 'Selected condition', scope: 'AZ-17'},
    {id: 'other-condition', text: 'Unselected condition', scope: 'AZ-18'}];
  const record = {reference, payload: {...document, components: [], incidents: [], resource_associations: []}, differences: []};
  const proposal = {unit: document.units[0].id, selected: ['rule', 'condition'], target: {kind: 'new'}, judgment: {kind: 'distinct', reason: 'Synthetic'}, disposition: 'candidate'};
  let blocks = proposalInspection(record, proposal).blocks;
  assert.deepEqual(blocks.filter(b => b.title === 'Condition').map(b => b.text), ['Selected condition']);
  assert.deepEqual(blocks.filter(b => b.title === 'Human declarations').map(b => b.id), ['unit:' + document.units[0].id]);
  document.units.forEach(unit => {unit.inseparable_group = 'same-group';});
  blocks = proposalInspection(record, proposal).blocks;
  assert.deepEqual(blocks.filter(b => b.title === 'Condition').map(b => b.text), ['Selected condition', 'Unselected condition']);
});
