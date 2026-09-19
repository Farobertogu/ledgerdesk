import test from 'node:test';
import assert from 'node:assert/strict';
import {RECEPTION_RESPONSE} from '../../../src/contracts/intake_reception.ts';
import {EXTRACTION_STATUS, RECEPTION_RESPONSE_V2, AVAILABILITY_RESPONSE_V2, receptionV2} from '../../../src/contracts/intake_reception_v2.ts';
const ref = id => ({id, revision: 1, sha256: 'a'.repeat(64)});
const received = () => ({profile: 'intake/1', representation: 'intake-reception/1', operation_id: 'intent-17', reception_id: 'receipt-17', revision: 3,
  state: 'received', original: {id: 'original-17', generation: 1, bytes: 3, sha256: 'b'.repeat(64)}, availability: 'available',
  format_profile: 'text-utf8/1', configuration: ref('config'), attempt_expires_at: 10000, effect: ref('receipt-effect-17'),
  work: {id: 'job-17', state: 'not_started', dispatchable: false}});
test('historical receipt and original identity survive the new representation', () => {
  const old = received(), before = structuredClone(old), next = receptionV2(old, null);
  assert.equal(RECEPTION_RESPONSE(old), true); assert.equal(RECEPTION_RESPONSE_V2(next), true);
  assert.deepEqual(old, before); assert.deepEqual(next.original, old.original); assert.deepEqual(next.effect, old.effect);
  assert.equal(RECEPTION_RESPONSE(next), false);
});
test('real job state never becomes a historical non-started projection', () => {
  const job = {id: 'job-17', revision: 2, state: 'running', attempt_generation: 1, result_effect: null};
  const next = receptionV2(received(), job);
  assert.equal(next.work.state, 'running'); assert.deepEqual(next.work.extraction, job);
  assert.equal(RECEPTION_RESPONSE_V2({...next, work: {...next.work, state: 'not_started'}}), false);
  assert.throws(() => receptionV2(received(), {...job, id: 'other-job'}), /JOB/);
  assert.equal(RECEPTION_RESPONSE_V2({...next, authorized: true}), false);
});
test('accepted identity and retry generation are bounded separately', () => {
  const accepted = {id: 'job-17', revision: 4, state: 'accepted', attempt_generation: 2, result_effect: ref('accept-17')};
  assert.equal(EXTRACTION_STATUS(accepted), true);
  for (const change of [{result_effect: null}, {attempt_generation: 0}, {attempt_generation: 3}, {state: 'running'}])
    assert.equal(EXTRACTION_STATUS({...accepted, ...change}), false);
  assert.equal(RECEPTION_RESPONSE_V2(receptionV2(received(), accepted)), true);
});
test('availability is closed and permits separate receipt and processing availability', () => {
  const row = {format_profile: 'text-utf8/1', configuration: ref('config'), original_bytes: 1048576, reception_available: false, processing_available: true};
  const body = {profile: 'intake/1', representation: 'intake-availability/2', profiles: [row]};
  assert.equal(AVAILABILITY_RESPONSE_V2(body), true);
  assert.equal(AVAILABILITY_RESPONSE_V2({...body, profiles: [row, row]}), false);
  assert.equal(AVAILABILITY_RESPONSE_V2({...body, profiles: [{...row, processing_available: 'unverified'}]}), false);
});
