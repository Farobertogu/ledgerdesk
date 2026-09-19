import test from 'node:test';
test('The operational terminal imports under the actual strip-only Node runtime', async () => {
  const {createIntakeTerminal} = await import('../../../src/server/intake/terminal.ts');
  if (typeof createIntakeTerminal !== 'function') throw Error('PREPARATION_TERMINAL_IMPORT');
});
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PREPARATION_BOUNDS, PREPARATION_DOCUMENT, PREPARATION_PAYLOAD, PREPARATION_CLASSIFICATION,
  readPreparationDocument, readPreparationPayload, validatePreparationCommand, preparationCanonical} from '../../../src/contracts/intake_preparation.ts';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {validateIntake, INTAKE_ROUTES} from '../../../src/contracts/intake.ts';
import {byteDigest, domainBytes, artifactFor, encodePayload, referenceFor, sealDifference,
  sealPreparation, verifyPreparation, differenceMatches} from '../../../src/server/intake/preparation/records.ts';
import {commands as historicalCommands} from '../t01/fixtures.mjs';
import {validatePreparationResponse, preparationProblem} from '../../../src/contracts/intake_preparation_response.ts';

// These synthetic vectors exercise contracts, not receipts or admitted source state.
const exact = (id, revision = 1) => ({id, revision, sha256: 'a'.repeat(64)});
const artifact = (id = 'source-payload') => ({id, generation: 1, bytes: 3,
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'});
const unresolved = () => ({value: null, reason: 'Needs examination.'});
const classification = () => ({function: unresolved(), basis: unresolved(), scope: unresolved()});
function payload() {
  return {profile: 'preparation-content/1', inputs: [{id: 'input', kind: 'preparation', reference: exact('before'), source_artifact: artifact()}],
    elements: [{id: 'rule', kind: 'text', text: 'No.', antecedents: [{input_id: 'input', kind: 'bytes', coordinates: 'original:0..3', byte_range: [0, 3], code_point_range: [0, 3]}]}],
    relations: [], resources: [], resource_associations: [], conditions: [],
    units: [{id: 'unit', elements: ['rule'], conditions: [], inseparable_group: null, classification: classification(),
      examination: {outcome: 'classifiable', reason: 'Examined only for this synthetic case.'},
      coverage: {components: ['text'], complete_source_claim: false, reason: 'Selected source only.'}}],
    components: [{id: 'text', execution: 'completed', coverage: 'partial', fidelity: 'unchecked', limitations: ['unexamined-context'], incidents: []}],
    incidents: [], inventory: 'unknown', current_use: 'not_evaluated', interruptions: []};
}
function document() {
  const p = payload();
  return {profile: 'preparation-document/1', transformation: 'exact_selection', elements: p.elements,
    relations: [], conditions: [], units: p.units, differences: []};
}
function reserve() {
  return {profile: 'intake/1', representation: 'intake-preparation/1',
    inputs: [{id: 'input', kind: 'preparation', reference: exact('before')}], base: exact('before'),
    selection: [{input_id: 'input', element_id: 'source-rule', local_id: 'rule'}],
    document: {bytes: 3, sha256: artifact().sha256},
    context: {scope_id: 'scope', purpose_id: 'purpose', treatment_revision: exact('treatment')}};
}
function sealed() {
  const p = payload(), bytes = encodePayload(p);
  const target = {id: 'prepared', revision: 2, payload: artifactFor('payload', 2, bytes)};
  const difference = sealDifference('difference', 1, {profile: 'preparation-difference/1',
    before: [{input: p.inputs[0].reference, payload: p.inputs[0].source_artifact}], after: target,
    method: 'exact_selection', transformation: 'reproducible_normalization',
    affected: [{kind: 'provenance', id: 'rule'}], reason: 'Retained exact selected source.', actor: 'actor', recorded_at: 1});
  return sealPreparation({id: 'prepared', revision: 2, artifactId: 'payload', payload: p, differences: [difference],
    operation: exact('operation'), actor: 'actor', recordedAt: 1});
}
test('Explicit representation does not reinterpret any historical command', () => {
  for (const [name, body] of Object.entries(historicalCommands())) assert.equal(validateIntake(name, body), true, name);
  assert.equal(validatePreparationCommand('reserve_preparation', reserve()), true);
  assert.equal(validateIntake('reserve_preparation', reserve()), false);
  assert.equal(validatePreparationCommand('reserve_preparation', historicalCommands().reserve_preparation), false);
  assert.equal(validatePreparationCommand('reserve_preparation', {...reserve(), representation: 'prepared-material/1'}), false);
});
test('Each operational command has a positive and rejects authority injection', () => {
  const commands = {
    reserve_preparation: reserve(), upload_preparation: new Uint8Array([1]),
    finalize_preparation: {expected_revision: 1, document: artifact(), differences: []},
    preparation: {}, resource: {}, difference: {},
    propose: {unit: 'unit', target: {kind: 'new', declaration: 'Distinct synthetic unit.'}, judgment: {kind: 'distinct', reason: 'Examined.'}},
    constitute: {proposal: exact('proposal'), mode: 'person'}, lookup_operation: {operation_id: 'operation'},
  };
  for (const [name, partial] of Object.entries(commands)) {
    const body = partial instanceof Uint8Array ? partial : {profile: 'intake/1', representation: 'intake-preparation/1', ...partial};
    assert.equal(validatePreparationCommand(name, body), true, name);
    if (!(body instanceof Uint8Array)) assert.equal(validatePreparationCommand(name, {...body, authorized: true}), false, name);
  }
});
test('Selection names an existing input and unique local IDs before resource production', () => {
  const r = reserve();
  r.selection[0] = {...r.selection[0], resource: artifact(), local_resource_id: 'R-1'};
  assert.equal(validatePreparationCommand('reserve_preparation', r), true);
  for (const change of [x => delete x.selection[0].local_resource_id,
    x => x.selection.push({...x.selection[0]}), x => x.selection[0].input_id = 'unretained',
    x => x.selection.push({...x.selection[0], local_id: 'second'})]) {
    const bad = structuredClone(r); change(bad); assert.equal(validatePreparationCommand('reserve_preparation', bad), false);
  }
});
test('Authorized consequence has an exact prior act; a person cannot inject one', () => {
  const c = {profile: 'intake/1', representation: 'intake-preparation/1', proposal: exact('proposal'), mode: 'authorized_consequence'};
  assert.equal(validatePreparationCommand('constitute', c), false);
  assert.equal(validatePreparationCommand('constitute', {...c, prior_act: exact('prior')}), true);
  assert.equal(validatePreparationCommand('constitute', {...c, mode: 'person', prior_act: exact('prior')}), false);
});
test('Canonical typed path and profile are compared payload, with a literal expected envelope', () => {
  const body = {profile: 'intake/1', representation: 'intake-preparation/1'};
  assert.equal(preparationCanonical('preparation', {id: 'p', revision: '2'}, body, canonicalValue),
    '{"body":{"profile":"intake/1","representation":"intake-preparation/1"},"contract":"intake/1","path":{"parameters":{"id":"p","revision":"2"},"template":"/api/intake/preparations/:id/revisions/:revision"},"profile":"canon_m09_1","query":{},"variant":"preparation"}');
  assert.throws(() => preparationCanonical('preparation', {id: 'p', revision: '02'}, body, canonicalValue));
  assert.throws(() => preparationCanonical('preparation', {id: '../p', revision: '2'}, body, canonicalValue));
  assert.notEqual(preparationCanonical('preparation', {id: 'p', revision: '2'}, body, canonicalValue),
    preparationCanonical('preparation', {id: 'q', revision: '2'}, body, canonicalValue));
});
test('Prepared document decoding preserves Unicode and rejects ambiguous lexical input', () => {
  const d = document(); d.elements[0].text = 'Cafe\u0301 😀';
  assert.deepEqual(readPreparationDocument(Buffer.from(JSON.stringify(d))), d);
  for (const bytes of [Buffer.from([0xc3]), Buffer.from('{"n":1e0}'), Buffer.from('{"n":1,"n":2}'), Buffer.from('{"n":"\\ud800"}')]) {
    assert.throws(() => readPreparationDocument(bytes));
  }
  assert.equal(PREPARATION_DOCUMENT({...d, trial_mapping: {}}), false);
});
test('The operational descriptor has a noncircular byte-domain reference', () => {
  const {record, bytes} = sealed();
  assert.equal(byteDigest(Buffer.from('abc')), artifact().sha256);
  const literal = '{"body":{"a":1},"domain":"preparation-operation/1"}';
  assert.equal(domainBytes('preparation-operation/1', {a: 1}).toString(), literal);
  assert.equal(referenceFor('preparation-operation/1', 'operation', 1, {a: 1}).sha256,
    createHash('sha256').update(literal).digest('hex'));
  assert.equal(verifyPreparation(record, bytes), true);
  assert.deepEqual(readPreparationPayload(bytes), record.payload);
  assert.equal(record.descriptor.payload.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(Object.hasOwn(record.payload, 'preparation'), false);
  assert.throws(() => domainBytes('arbitrary', {}));
});
test('A valid difference for another revision pair cannot be attached or consumed', () => {
  const {record, bytes} = sealed(), d = record.differences[0];
  const wrong = sealDifference(d.reference.id, 1, {...d.body, after: {...d.body.after, id: 'other'}});
  assert.equal(differenceMatches(wrong, record.payload.inputs, d.body.after), false);
  const changed = structuredClone(record); changed.differences = [wrong];
  assert.equal(verifyPreparation(changed, bytes), false);
  assert.throws(() => sealPreparation({id: 'prepared', revision: 2, artifactId: 'payload', payload: record.payload,
    differences: [wrong], operation: exact('operation'), actor: 'actor', recordedAt: 1}), /ASSOCIATION/);
});
test('Coherently resealed data demonstrates integrity only, not authenticity or exact-source fidelity', () => {
  const original = sealed(), changed = structuredClone(original.record.payload);
  changed.elements[0].text = 'Altered.';
  const resealed = sealPreparation({id: 'prepared', revision: 2, artifactId: 'payload', payload: changed, differences: [],
    operation: exact('operation'), actor: 'actor', recordedAt: 1});
  assert.equal(verifyPreparation(resealed.record, resealed.bytes), true);
  assert.notDeepEqual(resealed.record.reference, original.record.reference);
  assert.notEqual(resealed.record.payload.elements[0].text, 'No.');
});
test('Public validation is not an oracle for a coherently omitted limitation', () => {
  const p = payload(); p.components[0].limitations = [];
  assert.equal(PREPARATION_PAYLOAD(p), true);
  assert.notDeepEqual(p.components[0].limitations, ['unexamined-context']);
});
test('Preparation-local R-1 is independent from artifact ID and bound to the resource element', () => {
  const p = payload(), r = {...artifact('A-17'), generation: 7};
  p.elements.push({id: 'figure', kind: 'resource', resource: r, antecedents: []});
  p.resources = [r]; p.resource_associations = [{local_id: 'R-1', element_id: 'figure', artifact: r}];
  assert.equal(PREPARATION_PAYLOAD(p), true);
  for (const change of [x => x.resource_associations[0].artifact = {...r, id: 'A-18'},
    x => x.resource_associations.push({...x.resource_associations[0]}),
    x => x.resources.push({...r, id: 'hidden'})]) {
    const bad = structuredClone(p); change(bad); assert.equal(PREPARATION_PAYLOAD(bad), false);
  }
});
test('A separately attributed interruption does not convert its unexamined component into failure', () => {
  const p = payload();
  p.components.push({id: 'D', execution: 'failed', coverage: 'unknown', fidelity: 'unchecked', limitations: [], incidents: ['D-failure']},
    {id: 'E', execution: 'not_attempted', coverage: 'none', fidelity: 'unchecked', limitations: [], incidents: []});
  p.incidents.push({id: 'D-failure', component: 'D', cause: 'technical_failure'});
  p.interruptions.push({component: 'E', incident_id: 'D-failure', source: exact('staged-input'), origin: 'instrumented_preparation'});
  assert.equal(PREPARATION_PAYLOAD(p), true);
  const changed = structuredClone(p); changed.components.at(-1).execution = 'failed';
  assert.equal(PREPARATION_PAYLOAD(changed), false);
  assert.equal(Object.hasOwn(p.incidents[0], 'code'), false);
  assert.equal(Object.hasOwn(p.incidents[0], 'detail'), false);
});
test('C1 unresolved axes need a reason and cannot silently use an other classification', () => {
  assert.equal(PREPARATION_CLASSIFICATION(classification()), true);
  assert.equal(PREPARATION_CLASSIFICATION({...classification(), scope: {value: null, reason: null}}), false);
  assert.equal(PREPARATION_CLASSIFICATION({...classification(), function: {value: 'other', reason: null}}), false);
});
test('Prepared storage quota is not the accepted extraction quota', () => {
  assert.equal(PREPARATION_BOUNDS.payloadBytes, 8388608);
  assert.equal(validatePreparationCommand('upload_preparation', new Uint8Array(8388608)), true);
  assert.equal(validatePreparationCommand('upload_preparation', new Uint8Array(8388609)), false);
  const p = payload(); p.inputs[0] = {id: 'input', kind: 'extraction', reference: exact('accepted-result'), job_id: 'job',
    receipt: exact('receipt'), original: artifact('original'), source: exact('worker-output'),
    source_artifact: {...artifact('normalized'), bytes: 16777216}};
  assert.equal(PREPARATION_PAYLOAD(p), true);
  p.inputs[0].source_artifact.bytes++;
  assert.equal(PREPARATION_PAYLOAD(p), false);
  assert.equal(INTAKE_ROUTES.upload_original.maxBytes, 1048576);
});
test('Operational response vectors reject extra fields, wrong profile and contradictory outcomes', () => {
  const prefix={profile:'intake/1',representation:'intake-preparation/1'},r=sealed().record;
  const outcome={outcome:'constituted',block_kind:null,outcome_id:'outcome',candidates:[exact('candidate')],relationships:[],blocks:[]};
  const result={state:'proposed',proposal:exact('proposal'),preparation:r.reference,item:'unit:unit'};
  const inspection={proposal:{profile:'preparation-proposal/1',preparation:r.reference,unit:'unit',item:'unit:unit',slot_id:'slot',
    target:{kind:'new',declaration:'Distinct.'},judgment:{kind:'distinct',reason:'Examined.'},selected:['rule'],identity:'a'.repeat(64),
    disposition:'constituted',context:reserve().context},preparation:r};
  const vectors=[
    ['reserve_preparation',202,{result:{state:'reserved',attempt_id:'attempt',preparation:{id:'prepared',revision:2},document:artifact(),
      continuation:{operation:'upload_preparation',mode:'authorized_consequence',target:'source-payload',origin_session_bound:true}}}],
    ['upload_preparation',200,{result:{state:'staged',attempt_id:'attempt',preparation:{id:'prepared',revision:2},document:artifact()}}],
    ['finalize_preparation',200,{result:{state:'prepared',preparation:r.reference,differences:r.descriptor.differences}}],
    ['propose',200,{result,inspection}],['constitute',200,{result:outcome}],
    ['lookup_operation',200,{state:'known_effect',result:outcome}],
  ];
  for(const [name,status,fields] of vectors){
    const body={...prefix,operation_id:'operation',effect:exact('effect'),...fields};
    assert.equal(validatePreparationResponse(name,status,body),true,name);
    assert.equal(validatePreparationResponse(name,status,{...body,authorized:true}),false,name);
    assert.equal(validatePreparationResponse(name,status,{...body,representation:'intake-reception/1'}),false,name);
  }
  for(const [name,fields] of [['preparation',{preparation:r}],['difference',{preparation:r.reference,difference:r.differences[0]}],
    ['resource',{preparation:r.reference,element_id:'figure',local_resource_id:'R-1',artifact:artifact(),encoding:'base64',data:'YWJj'}]]){
    const body={...prefix,...fields};assert.equal(validatePreparationResponse(name,200,body),true,name);
    assert.equal(validatePreparationResponse(name,200,{...body,hidden:1}),false,name);
  }
  const body={...prefix,operation_id:'operation',effect:exact('effect'),result:{...outcome,candidates:[]}};
  assert.equal(validatePreparationResponse('constitute',200,body),false);
  assert.equal(validatePreparationResponse('constitute',202,{...body,result:outcome}),false);
  assert.equal(validatePreparationResponse('preparation',200,{...body,state:'known_effect',result:outcome}),false);
  assert.deepEqual(preparationProblem(413),{...prefix,status:413,type:'urn:ledgerdesk:intake:input-limit',title:'Input limit exceeded',code:'input_limit'});
});
test('Detached difference references are not an offered finalization input',()=>{
  const body={profile:'intake/1',representation:'intake-preparation/1',expected_revision:1,document:artifact(),differences:[exact('detached')]};
  assert.equal(validatePreparationCommand('finalize_preparation',body),false);
  assert.equal(validatePreparationCommand('finalize_preparation',{...body,differences:[]}),true);
});
import {intakeViolations} from '../../../ci/intake_boundary_check.mjs';
import {accessSourceViolations} from '../../../ci/access_boundary_check.mjs';

test('Preparation boundaries permit only named shared primitives and reject reverse or implementation imports',()=>{
  for(const file of ['intake_preparation','intake_preparation_bindings','intake_preparation_response']){
    const name='src/contracts/'+file+'.ts';
    assert.deepEqual(intakeViolations(name,"import {closed} from './intake.ts'"),[]);
    for(const source of ["import fs from 'node:fs'","import x from '../server/intake/preparation/service.ts'",
      "import React from 'react'","import {x} from './access.ts'","const x=await import(target)"])
      assert.ok(intakeViolations(name,source).length>0);
    assert.ok(intakeViolations('src/server/kb/x.ts',"import x from '../../contracts/"+file+".ts'").length>0);
  }
  const named='src/contracts/intake_preparation_bindings.ts',canonical="import {canonicalValue} from './access_canonical.ts'";
  assert.deepEqual(intakeViolations(named,canonical),[]);assert.deepEqual(accessSourceViolations(named,canonical),[]);
  for(const file of ['src/contracts/intake_preparation.ts','src/contracts/intake_preparation_response.ts']){
    assert.ok(intakeViolations(file,canonical).length>0);assert.ok(accessSourceViolations(file,canonical).length>0);
  }
  const terminal='src/server/intake/preparation/terminal.ts';
  assert.deepEqual(intakeViolations(terminal,"import {sessionToken} from '../../access/transport.ts'"),[]);
  assert.ok(intakeViolations(terminal,"import x from '../../access/service.ts'").length>0);
  assert.ok(accessSourceViolations(terminal,"import x from '../../access/service.ts'").length>0);
  assert.ok(intakeViolations('src/server/intake/preparation/service.ts',"import pg from 'pg'").length>0);
});
