import test from 'node:test';
import assert from 'node:assert/strict';
import {constructPreparation} from '../../../src/server/intake/preparation/producer.ts';
import {artifactFor, byteDigest, verifyPreparation} from '../../../src/server/intake/preparation/records.ts';
import {PREPARATION_PAYLOAD} from '../../../src/contracts/intake_preparation.ts';
import {comparisonDisposition,targetIdentity} from '../../../src/server/intake/preparation/comparison.ts';
const ref = id => ({id, revision: 1, sha256: 'a'.repeat(64)});
const unresolved = () => ({value: null, reason: 'Not decided by extraction.'});
const clone = value => structuredClone(value);

test('C9 exact reference and typed target are distinct from byte equivalence and explanatory prose',()=>{
  const version=ref('candidate'),existing={reference:version,content_identity:'exact-item'};
  const relationship={kind:'relationship',unit_id:'candidate',version,declaration:'First explanation.'};
  assert.deepEqual(targetIdentity(relationship),targetIdentity({...relationship,declaration:'Another explanation.'}));
  assert.equal(comparisonDisposition(relationship,{kind:'same_version',evidence:version},'exact-item',existing),'relationship_recorded');
  assert.equal(comparisonDisposition(relationship,{kind:'same_version',evidence:version},'changed-item',existing),'identity_collision');
  assert.equal(comparisonDisposition(relationship,{kind:'possible_duplicate',evidence:version},'exact-item',existing),'possible_duplicate');
  assert.equal(comparisonDisposition({kind:'new'},{kind:'distinct'},'exact-item',null),'constituted');
  for(const evidence of [undefined,{...version,revision:2}])assert.throws(()=>
    comparisonDisposition(relationship,{kind:'same_version',evidence},'exact-item',existing),e=>e.status===409);
});

// Unit-level immutable source packets; no claim of service acceptance or current authority.
function inputCase({resource = false} = {}) {
  const original = artifactFor('original', 1, Buffer.from('AZ-17\nRule Q.\nUnder Z, R.\n'));
  const root = ref('output');
  const resourceBytes = Buffer.from('<svg>AZ-17 R</svg>');
  const resourceArtifact = artifactFor('A-17', 7, resourceBytes);
  const source = {profile: 'intake-extraction-content/1', original, source: root, format_profile: 'text-utf8/1', outcome: 'partial',
    elements: [
      {id: 'rule', kind: 'text', text: 'Rule Q.\n', original_range: {bytes: [6, 14], code_points: [6, 14]}},
      {id: 'exception', kind: 'text', text: 'Under Z, R.\n', original_range: {bytes: [14, 26], code_points: [14, 26]}},
    ], relations: [{id: 'context', from: 'rule', to: 'exception', role: 'indispensable', scope: 'AZ-17 under Z', origin: 'observed'}],
    resources: [], components: [{id: 'text', execution: 'completed', coverage: 'partial', fidelity: 'unchecked', limitations: ['unread-picture'], incidents: ['picture']}],
    incidents: [{id: 'picture', component: 'text', cause: 'route_unoffered', detail: 'figure not examined'}],
    inventory: 'unknown', current_use: 'not_evaluated'};
  if (resource) {
    source.elements.push({id: 'figure', kind: 'resource', resource: resourceArtifact, antecedents: [{antecedent: root, kind: 'bytes', coordinates: 'figure'}]});
    source.resources.push(resourceArtifact);
  }
  const bytes = Buffer.from(JSON.stringify(source));
  const resolved = {id: 'input', kind: 'extraction', job_id: 'job', reference: ref('accepted-effect'), receipt: ref('receipt'), original,
    source: root, source_artifact: artifactFor('normalized', 1, bytes)};
  const doc = {profile: 'preparation-document/1', transformation: 'exact_selection',
    elements: [
      {id: 'rule', kind: 'text', text: 'Rule Q.\n', antecedents: [{input_id: 'input', kind: 'bytes', coordinates: 'original:6..14', byte_range: [6, 14], code_point_range: [6, 14]}]},
      {id: 'exception', kind: 'text', text: 'Under Z, R.\n', antecedents: [{input_id: 'input', kind: 'bytes', coordinates: 'original:14..26', byte_range: [14, 26], code_point_range: [14, 26]}]},
    ], relations: [{id: 'input:context', from: 'rule', to: 'exception', role: 'indispensable', scope: 'AZ-17 under Z', origin: 'observed'}], conditions: [],
    units: [{id: 'unit', elements: ['rule', 'exception'], conditions: [], inseparable_group: null,
      classification: {function: unresolved(), basis: unresolved(), scope: unresolved()},
      examination: {outcome: 'classifiable', reason: 'Synthetic source selection.'},
      coverage: {components: ['input:text'], complete_source_claim: false, reason: 'Partial parent remains partial.'}}], differences: []};
  const selection = [{input_id: 'input', element_id: 'rule', local_id: 'rule'}, {input_id: 'input', element_id: 'exception', local_id: 'exception'}];
  if (resource) {
    doc.elements.push({id: 'figure', kind: 'resource', resource: resourceArtifact, antecedents: [{input_id: 'input', kind: 'bytes', coordinates: 'figure'}]});
    doc.units[0].elements.push('figure');
    selection.push({input_id: 'input', element_id: 'figure', local_id: 'figure', local_resource_id: 'R-1', resource: resourceArtifact});
  }
  return {document: doc, sources: [{input: resolved, bytes}], id: 'prepared', revision: 1, artifactId: 'payload',
    operation: ref('operation'), actor: 'actor', recordedAt: 1,
    resourceBodies: resource ? [{artifact: resourceArtifact, bytes: resourceBytes}] : [],
    reservation: {profile: 'intake/1', representation: 'intake-preparation/1',
      inputs: [{id: 'input', kind: 'extraction', job_id: 'job', reference: resolved.reference}], base: null, selection,
      context: {scope_id: 'scope', purpose_id: 'purpose', treatment_revision: ref('treatment')}}};
}
function stage(args) {
  args.stagedBytes = Buffer.from(JSON.stringify(args.document));
  args.staged = artifactFor('staged', 1, args.stagedBytes);
  args.reservation.document = {bytes: args.staged.bytes, sha256: args.staged.sha256};
  return args;
}
test('Producer retains exact selected text, Unicode positions and partial source facts', () => {
  const args = stage(inputCase()), result = constructPreparation(args);
  assert.equal(verifyPreparation(result.record, result.bytes), true);
  assert.deepEqual(result.record.payload.elements.map(e => e.text), ['Rule Q.\n', 'Under Z, R.\n']);
  assert.deepEqual(result.record.payload.elements[1].antecedents[0].byte_range, [14, 26]);
  assert.deepEqual(result.record.payload.components[0], {id: 'input:text', execution: 'completed', coverage: 'partial', fidelity: 'unchecked', limitations: ['unread-picture'], incidents: ['input:picture']});
  assert.equal(result.record.payload.incidents[0].detail, 'figure not examined');
  assert.equal(result.record.payload.inventory, 'unknown');
});
test('Removing a selected exception and its edge is rejected after the public document is accepted', () => {
  const args = inputCase(); args.document.elements.pop(); args.document.relations = []; args.document.units[0].elements.pop();
  assert.throws(() => constructPreparation(stage(args)), /SELECTION_LOSS/);
});
test('Changing the reserved selection cannot sever a known indispensable source relation', () => {
  const args = inputCase(); args.reservation.selection.pop(); args.document.elements.pop(); args.document.relations = []; args.document.units[0].elements.pop();
  assert.throws(() => constructPreparation(stage(args)), /DEPENDENCY_CLOSURE/);
});
test('Rehashing a changed staged document does not authorize an undeclared content correction', () => {
  const args = inputCase(); args.document.elements[1].text = 'Under Z, S.\n';
  assert.throws(() => constructPreparation(stage(args)), /UNDECLARED_CHANGE:element/);
});
test('Attributable correction preserves its exact before and after targets without inherited fidelity', () => {
  const args = inputCase(); args.document.transformation = 'correction'; args.document.elements[1].text = 'Under Z, S.\n';
  args.document.differences.push({before: ['input'], method: 'correction', transformation: 'cleanup',
    reason: 'Illustrative correction, not an automatic source truth claim.', affected: [{kind: 'element', id: 'exception'}]});
  const result = constructPreparation(stage(args)), difference = result.record.differences[0];
  assert.deepEqual(difference.body.before, [{input: args.sources[0].input.reference, payload: args.sources[0].input.source_artifact}]);
  assert.deepEqual(difference.body.after, {id: 'prepared', revision: 1, payload: result.record.descriptor.payload});
  assert.equal(result.record.payload.components[0].fidelity, 'unchecked');
  const later = structuredClone(args); later.revision = 2;
  const next = constructPreparation(later).record.differences[0];
  assert.notEqual(next.reference.id, difference.reference.id, 'Different transitions must not collide on the difference lookup identifier.');
  assert.equal(next.body.after.revision, 2);
});
test('Equivalent source tuple fields must match the retained source bytes and declaration', () => {
  const args = inputCase(); args.sources[0].bytes = Buffer.from('{}');
  assert.throws(() => constructPreparation(stage(args)), /SOURCE_INTEGRITY/);
  const other = stage(inputCase()); other.document.elements[0].text = 'Not the staged bytes';
  assert.throws(() => constructPreparation(other), /PRODUCTION_INPUT/);
});
test('Valid alternative resource cannot replace this operation selection; another operation can select it', () => {
  const args = stage(inputCase({resource: true})), positive = constructPreparation(args);
  assert.equal(positive.resources[0].bytes.toString(), '<svg>AZ-17 R</svg>');
  assert.deepEqual(positive.record.payload.resource_associations, [{local_id: 'R-1', element_id: 'figure', artifact: args.resourceBodies[0].artifact}]);
  const wrong = inputCase({resource: true}), data = Buffer.from('<svg>AZ-18 S</svg>'), r = artifactFor('A-18', 9, data);
  wrong.document.elements.at(-1).resource = r; wrong.resourceBodies.push({artifact: r, bytes: data});
  assert.throws(() => constructPreparation(stage(wrong)), /RESOURCE_CHANGE/);
  const alternative = inputCase({resource: true}), source = JSON.parse(alternative.sources[0].bytes);
  source.elements.at(-1).resource = r; source.resources = [r];
  alternative.sources[0].bytes = Buffer.from(JSON.stringify(source));
  alternative.sources[0].input.source_artifact = artifactFor('other-normalized', 1, alternative.sources[0].bytes);
  alternative.reservation.selection.at(-1).resource = r; alternative.document.elements.at(-1).resource = r;
  alternative.resourceBodies = [{artifact: r, bytes: data}];
  assert.equal(constructPreparation(stage(alternative)).resources[0].bytes.toString(), '<svg>AZ-18 S</svg>');
});
test('Unknown or partial parent cannot be silently turned into a complete-source claim', () => {
  const args = inputCase(); args.document.units[0].coverage.complete_source_claim = true;
  assert.throws(() => constructPreparation(stage(args)), /COVERAGE_CLAIM/);
});
test('Corrupt resource bytes never enter a sealed preparation resource set', () => {
  const args = inputCase({resource: true}); args.resourceBodies[0].bytes = Buffer.from('incorrect');
  assert.throws(() => constructPreparation(stage(args)), /RESOURCE_INTEGRITY/);
});
test('A new retained revision does not mutate an earlier packet', () => {
  const first = constructPreparation(stage(inputCase())), saved = Buffer.from(first.bytes);
  const second = inputCase(); second.revision = 2; second.document.transformation = 'correction';
  second.document.elements[1].text = 'Under Z, S.\n'; second.document.differences.push({before: ['input'], method: 'correction',
    transformation: 'cleanup', reason: 'Later correction.', affected: [{kind: 'element', id: 'exception'}]});
  constructPreparation(stage(second));
  assert.equal(first.bytes.equals(saved), true);
  assert.equal(verifyPreparation(first.record, saved), true);
  assert.equal(first.record.payload.elements[1].text, 'Under Z, R.\n');
});
test('A declared synthesis may combine text without losing its exact source spans or indispensable context', () => {
  const args = inputCase(), before = clone(args.document.elements);
  args.document.transformation = 'synthesis';
  args.document.transformations = [{from: 'rule', to: 'authored'}, {from: 'exception', to: 'authored'}];
  args.document.elements = [{id: 'authored', kind: 'text', text: 'Use Q unless Z; under Z use R.',
    antecedents: before.flatMap(e => e.antecedents.map(a => ({...a, kind: 'nonliteral'})))}];
  args.document.relations[0] = {...args.document.relations[0], from: 'authored', to: 'authored', origin: 'prepared'};
  args.document.units[0].elements = ['authored'];
  args.document.differences = [{before: ['input'], method: 'synthesis', transformation: 'redaction', reason: 'Combined formulation with the same recorded condition.',
    affected: [{kind: 'element', id: 'rule'}, {kind: 'element', id: 'exception'}, {kind: 'element', id: 'authored'}, {kind: 'relation', id: 'input:context'}]}];
  const result = constructPreparation(stage(args));
  assert.deepEqual(result.record.payload.elements[0].antecedents.map(a => [a.kind, a.byte_range]),
    [['nonliteral', [6, 14]], ['nonliteral', [14, 26]]]);
  assert.deepEqual(result.record.payload.transformations, [{from: 'rule', to: 'authored'}, {from: 'exception', to: 'authored'}]);
  assert.equal(result.record.payload.relations[0].scope, 'AZ-17 under Z');
  const missing = clone(args); missing.document.elements[0].antecedents.pop();
  assert.throws(() => constructPreparation(stage(missing)), /AUTHORED_SOURCE_LOSS/);
});

test('A preparation interruption may reference the exact retained incident without copying or relabeling its cause', () => {
  const args = inputCase(), source = JSON.parse(args.sources[0].bytes);
  source.components.push({id:'D',execution:'failed',coverage:'unknown',fidelity:'unchecked',limitations:[],incidents:['D-failure']});
  source.incidents.push({id:'D-failure',component:'D',cause:'technical_failure'});
  args.sources[0].bytes=Buffer.from(JSON.stringify(source));
  args.sources[0].input.source_artifact=artifactFor('normalized',1,args.sources[0].bytes);
  args.document.transformation='correction';
  args.document.differences=[{before:['input'],method:'correction',transformation:'cleanup',reason:'Attributed interruption statement.',affected:[{kind:'coverage',id:'E'}]}];
  args.document.observation={components:[{id:'E',execution:'not_attempted',coverage:'none',fidelity:'unchecked',limitations:[],incidents:[]}],
    incidents:[],inventory:'unknown',interruptions:[{component:'E',incident_id:'input:D-failure'}]};
  const result=constructPreparation(stage(args));
  assert.deepEqual(result.record.payload.interruptions,[{component:'statement:E',incident_id:'input:D-failure',
    source:{id:args.staged.id,revision:1,sha256:args.staged.sha256},origin:'preparation_annotation'}]);
  assert.equal(result.record.payload.incidents.length,2);
  const missing=clone(args);missing.document.observation.interruptions[0].incident_id='missing';
  assert.throws(()=>constructPreparation(stage(missing)),/INTERRUPTION_SOURCE/);
  const wrong=clone(args);wrong.document.observation.interruptions[0].incident_id='input:picture';
  assert.throws(()=>constructPreparation(stage(wrong)),/INTERRUPTION_SOURCE/);
});
