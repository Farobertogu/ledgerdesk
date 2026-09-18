import {EXTRACTION_BOUNDS} from '../../../src/contracts/intake_extraction.ts';
// Literal operation references are fixed before any producer executes.
const ref = id => ({id, revision: 1, sha256: 'a'.repeat(64)});
export function requestFixture() {
  return {profile: 'intake-worker/3', kind: 'extract', input_path: '/input/original', limits: {...EXTRACTION_BOUNDS}, binding: {
    deployment: 'inc02-synthetic', control: ref('control-1'), job: ref('job-17'), receipt: ref('receipt-17'),
    request: ref('processing-request-17'), plan: ref('plan-17'), assignment: ref('assignment-17'), worker: ref('worker-17'),
    configuration: ref('configuration-1'), limits: ref('limits-1'), dispatch_effect: ref('dispatch-17'),
    attempt_generation: 1, claim_id: 'claim-17', channel_id: 'channel-17',
    original: {id: 'original-17', generation: 7, bytes: 3, sha256: '9'.repeat(64)},
    format_profile: 'text-utf8/1', output_namespace: 'intake_trial',
  }};
}
export function replyFixture() {
  return {profile: 'intake-worker/3', kind: 'result', binding: requestFixture().binding,
    outcome: {kind: 'produced', observation: {raw:{text:'No.',bomBytes:0},extraction:{schema:'extraction-trial/1'},runtime:{node:'v22.16.0'}}}};
}
