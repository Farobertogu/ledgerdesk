import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKER_REQUEST_V3, WORKER_REPLY_V3, readWorkerRequest, readWorkerReply, workerBindingMatches,
  extractionTransition, COVERAGE_OBSERVATION, receptionRepresentation, RECEPTION_V2_ACCEPT,
  REPRESENTATION_CONFLICT, historicalWorkRepresentable} from '../../../src/contracts/intake_extraction.ts';
import {canonicalIntake} from '../../../src/contracts/intake.ts';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {requestFixture, replyFixture} from './interface_fixtures.mjs';

test('fixed worker request separates immutable original and attempt generations', () => {
  const request = requestFixture();
  assert.equal(WORKER_REQUEST_V3(request), true);
  assert.deepEqual(readWorkerRequest(Buffer.from(JSON.stringify(request))), request);
  assert.equal(request.binding.original.generation, 7); assert.equal(request.binding.attempt_generation, 1);
  for (const change of [{input_path: '/etc/passwd'}, {input_path: '../../secret'}, {command: 'sh'}, {profile: 'intake-worker/1'}, {limits: {...request.limits, stdoutBytes: 99999999}}])
    assert.equal(WORKER_REQUEST_V3({...request, ...change}), false);
});
test('every preserved binding dimension and actual channel discriminates substitution', () => {
  const expected = requestFixture().binding;
  assert.equal(workerBindingMatches(expected, structuredClone(expected), expected.channel_id), true);
  for (const key of Object.keys(expected)) {
    const changed = structuredClone(expected);
    if (key === 'original') changed.original.id = 'other-original';
    else if (typeof changed[key] === 'object') changed[key].id = 'other-reference';
    else if (key === 'attempt_generation') changed[key] = 2;
    else if (key === 'format_profile') changed[key] = 'xlsx-cells/1';
    else if (key === 'output_namespace') changed[key] = 'intake_restore';
    else changed[key] = 'other-id';
    assert.equal(workerBindingMatches(expected, changed, expected.channel_id), false, key);
  }
  assert.equal(workerBindingMatches(expected, expected, 'other-live-channel'), false);
  assert.equal(workerBindingMatches(expected, {...expected, authorized: true}, expected.channel_id), false);
});
test('worker frame is closed and strict while producer observation is not public', () => {
  const value = replyFixture(); assert.equal(WORKER_REPLY_V3(value), true);
  assert.deepEqual(readWorkerReply(Buffer.from(JSON.stringify(value))), value);
  assert.equal(WORKER_REPLY_V3({...value, accepted: true}), false);
  assert.equal(WORKER_REPLY_V3({...value, outcome: {kind: 'failed', producer_code: 'unfamiliar-parser-code'}}), true);
  assert.equal(WORKER_REPLY_V3({...value, outcome: {kind: 'failed', producer_code: 'x', detail: 'secret'}}), false);
  assert.throws(() => readWorkerReply(Buffer.from('{"profile":"x","profile":"intake-worker/3"}')));
  assert.throws(() => readWorkerReply(Buffer.from([0xc3])));
});
test('coverage retains unknown causes and incident/component correspondence', () => {
  const value = {inventory: 'unknown', components: [{id: 'root', execution: 'unknown', coverage: 'unknown', fidelity: 'unchecked', limitations: ['unknown-remainder'], incidents: ['failure']}],
    incidents: [{id: 'failure', component: 'root', cause: 'unknown', code: 'unfamiliar-parser-code'}]};
  assert.equal(COVERAGE_OBSERVATION(value), true);
  for (const change of [{...value, incidents: []}, {...value, components: []}, {...value, components: [...value.components, ...value.components]}]) assert.equal(COVERAGE_OBSERVATION(change), false);
  assert.equal(COVERAGE_OBSERVATION({...value, incidents: [{...value.incidents[0], cause: 'insufficient_knowledge'}]}), false);
});
test('acceptance is terminal; uncertainty is not automatic retry or a stopped process', () => {
  assert.equal(extractionTransition('running', 'result_staged'), true);
  assert.equal(extractionTransition('result_staged', 'accepted'), true);
  assert.equal(extractionTransition('accepted', 'eligible'), false);
  assert.equal(extractionTransition('running', 'eligible'), false);
  assert.equal(extractionTransition('running', 'stopped'), false);
  assert.equal(extractionTransition('stopping', 'stopped'), true);
});
test('representation selection is closed and distinct from semantic intention identity', () => {
  assert.equal(receptionRepresentation(undefined), 1); assert.equal(receptionRepresentation('application/json'), 1);
  assert.equal(receptionRepresentation(RECEPTION_V2_ACCEPT), 2);
  assert.equal(receptionRepresentation(RECEPTION_V2_ACCEPT + ', application/json'), null);
  assert.equal(REPRESENTATION_CONFLICT.status, 409); assert.equal(REPRESENTATION_CONFLICT.code, 'representation_conflict');
  assert.equal(historicalWorkRepresentable(null), true); assert.equal(historicalWorkRepresentable('not_started'), true);
  assert.equal(historicalWorkRepresentable('accepted'), false);
  const body = {profile: 'intake/1', expected_revision: 1};
  const expected = '{"body":{"expected_revision":1,"profile":"intake/1"},"contract":"intake/1","path":{"parameters":{"id":"r1"},"template":"/api/intake/receptions/:id/cancel"},"profile":"canon_m09_1","query":{},"variant":"cancel_reception"}';
  for (const accept of [undefined, RECEPTION_V2_ACCEPT]) { receptionRepresentation(accept); assert.equal(canonicalIntake('cancel_reception', {id: 'r1'}, body, canonicalValue), expected); }
});
