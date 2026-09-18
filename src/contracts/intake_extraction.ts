import {
  array, artifactReference, choice, closed, decodeIntake, decodeStrict,
  exactReference, identifier, integer, record, revision, digest, text, type Rule,
} from './intake.ts';

export const EXTRACTION_REPRESENTATION = 'intake-extraction/1' as const;
export const WORKER_PROTOCOL = 'intake-worker/3' as const;
export const RECEPTION_V2_ACCEPT = 'application/vnd.ledgerdesk.intake.v2+json' as const;
export const EXTRACTION_FORMATS = ['text-utf8/1', 'markdown-inert/1', 'csv-utf8/1', 'xlsx-cells/1'] as const;
export type ExtractionFormat = typeof EXTRACTION_FORMATS[number];
export const EXTRACTION_BOUNDS = Object.freeze({
  commandBytes: 65536, originalBytes: 1048576, stdoutBytes: 41943040,
  normalizedBytes: 16777216, conservedBytes: 58720256, failureBytes: 65536,
  responseBytes: 16842752, privateBytes: 83886080, textElements: 1048576,
  diagnosticBytes: 8192, expandedBytes: 8388608,
  members: 128, sheets: 8, cells: 10000, csvRecords: 1000, csvColumns: 64,
  csvRecordUnits: 65536, wallMs: 10000, heapMiB: 128, memoryMiB: 512,
  pids: 64, fileDescriptors: 128, concurrency: 1, maximumAttempts: 2,
});
export type Exact = {id: string; revision: number; sha256: string};
export type Artifact = {id: string; generation: number; bytes: number; sha256: string};
/** T03 artifacts have distinct quotas; the T01 preparation and T02 original limits do not change. */
export const extractionArtifact=(maximum:number):Rule=>closed({id:identifier,generation:revision,
  bytes:value=>integer(value)&&Number(value)<=maximum,sha256:digest});
export const EXTRACTION_RAW=extractionArtifact(EXTRACTION_BOUNDS.stdoutBytes);
export const EXTRACTION_NORMALIZED=extractionArtifact(EXTRACTION_BOUNDS.normalizedBytes);
export function decodeExtractionJson(bytes:Uint8Array){return decodeStrict(bytes,EXTRACTION_BOUNDS.stdoutBytes,
  path=>path[0]==='outcome'&&path[1]==='observation');}
export function decodeExtractionContent(bytes:Uint8Array){return decodeStrict(bytes,EXTRACTION_BOUNDS.normalizedBytes,true);}
export function decodeExtractionPrivate(bytes:Uint8Array){return decodeStrict(bytes,EXTRACTION_BOUNDS.privateBytes,true);}
export type WorkerBinding = {
  deployment: string; control: Exact; job: Exact; receipt: Exact;
  request: Exact; plan: Exact; assignment: Exact; worker: Exact;
  configuration: Exact; limits: Exact; dispatch_effect: Exact;
  attempt_generation: number; claim_id: string; channel_id: string;
  original: Artifact; format_profile: ExtractionFormat;
  output_namespace: 'intake_trial' | 'intake_restore';
};
const original: Rule = value => artifactReference(value) && record(value) && Number(value.bytes) <= EXTRACTION_BOUNDS.originalBytes;
export const WORKER_BINDING: Rule = closed({
  deployment: identifier, control: exactReference, job: exactReference, receipt: exactReference,
  request: exactReference, plan: exactReference, assignment: exactReference, worker: exactReference,
  configuration: exactReference, limits: exactReference, dispatch_effect: exactReference,
  attempt_generation: revision, claim_id: identifier, channel_id: identifier, original,
  format_profile: choice(...EXTRACTION_FORMATS), output_namespace: choice('intake_trial', 'intake_restore'),
});
export type WorkerRequest = {
  profile: typeof WORKER_PROTOCOL; kind: 'extract'; binding: WorkerBinding;
  input_path: '/input/original'; limits: typeof EXTRACTION_BOUNDS;
};
const limitShape = closed(Object.fromEntries(Object.entries(EXTRACTION_BOUNDS).map(([key, value]) => [key, choice(value)])));
export const WORKER_REQUEST_V3: Rule = value => closed({
  profile: choice(WORKER_PROTOCOL), kind: choice('extract'), binding: WORKER_BINDING,
  input_path: choice('/input/original'), limits: limitShape,
})(value);
export function readWorkerRequest(bytes: Uint8Array): WorkerRequest {
  const value = decodeIntake(bytes);
  if (!WORKER_REQUEST_V3(value)) throw Error('EXTRACTION_REQUEST');
  return value as WorkerRequest;
}

/** Preserve the actual outer bytes separately. A producer object grants no authority. */
export type WorkerReply = {
  profile: typeof WORKER_PROTOCOL; kind: 'result'; binding: WorkerBinding;
  outcome: {kind: 'produced'; observation: Record<string,unknown>} | {kind: 'failed'; producer_code: string};
};
export const WORKER_REPLY_V3: Rule = closed({
  profile: choice(WORKER_PROTOCOL), kind: choice('result'), binding: WORKER_BINDING,
  outcome: value => closed({kind: choice('produced'), observation: record})(value) ||
    closed({kind: choice('failed'), producer_code: text(128)})(value) && record(value) && String(value.producer_code).length > 0,
});
export function readWorkerReply(bytes: Uint8Array): WorkerReply {
  const value = decodeExtractionJson(bytes);
  if (!WORKER_REPLY_V3(value)) throw Error('EXTRACTION_REPLY');
  return value as WorkerReply;
}

/** Compare every association with preserved service state AND the actual observed channel. */
export function workerBindingMatches(expected: unknown, received: unknown, actualChannel: string): boolean {
  if (!WORKER_BINDING(expected) || !WORKER_BINDING(received) || !record(expected) || !record(received) ||
    expected.channel_id !== actualChannel) return false;
  return Object.keys(expected).every(key => {
    const left = expected[key], right = received[key];
    if (record(left) && record(right)) return Object.keys(left).every(field => left[field] === right[field]);
    return left === right;
  });
}

export const EXTRACTION_STATES = ['not_started', 'eligible', 'claimed', 'running', 'result_staged', 'accepted', 'stopping', 'stopped', 'uncertain'] as const;
export type ExtractionState = typeof EXTRACTION_STATES[number];
const transitions: Record<ExtractionState, readonly ExtractionState[]> = {
  not_started: ['eligible', 'stopping'], eligible: ['claimed', 'stopping'],
  claimed: ['running', 'uncertain', 'stopping'], running: ['result_staged', 'uncertain', 'stopping'],
  result_staged: ['accepted', 'uncertain', 'stopping'], accepted: [],
  stopping: ['stopped', 'uncertain'], stopped: [], uncertain: ['running', 'result_staged', 'accepted', 'eligible', 'stopping'],
};
export function extractionTransition(from: ExtractionState, to: ExtractionState): boolean {
  return Object.hasOwn(transitions, from) && transitions[from].includes(to);
}
export type ExecutionObservation = 'completed' | 'failed' | 'not_attempted' | 'unknown';
const component = closed({
  id: identifier, execution: choice('completed', 'failed', 'not_attempted', 'unknown'),
  coverage: choice('complete', 'partial', 'none', 'unknown'), fidelity: choice('unchecked', 'checked', 'disputed'),
  limitations: array(identifier, 128), incidents: array(identifier, 128),
});
const incident = closed({id: identifier, component: identifier,
  cause: choice('unreadable', 'route_unoffered', 'technical_failure', 'unknown'), code: text(128)});
export const COVERAGE_OBSERVATION: Rule = value => {
  if (!closed({inventory: choice('known', 'unknown'), components: array(component, 10000), incidents: array(incident, 10000)})(value) || !record(value)) return false;
  const components = value.components as Record<string, unknown>[], incidents = value.incidents as Record<string, unknown>[];
  if (new Set(components.map(row => row.id)).size !== components.length || new Set(incidents.map(row => row.id)).size !== incidents.length) return false;
  return components.every(row => (row.incidents as string[]).every(id => incidents.some(item => item.id === id && item.component === row.id))) &&
    incidents.every(item => components.some(row => row.id === item.component && (row.incidents as string[]).includes(String(item.id))));
};

/** Pure compatibility result. The caller must re-evaluate under its effect/response fence. */
export function receptionRepresentation(accept: string | undefined): 1 | 2 | null {
  if (accept === undefined || accept === '*/*' || accept === 'application/json') return 1;
  return accept === RECEPTION_V2_ACCEPT ? 2 : null;
}
export const REPRESENTATION_CONFLICT = Object.freeze({
  profile: 'intake/1', representation: 'intake-reception/2', status: 409,
  type: 'urn:ledgerdesk:intake:representation-conflict', title: 'Representation unavailable', code: 'representation_conflict',
});
export function historicalWorkRepresentable(state: ExtractionState | null): boolean {
  return state === null || state === 'not_started';
}
/** Structural observation of an actual close; it is not a synthetic lease expiration. */
export const WORKER_TERMINATION: Rule = closed({
  channel_id: identifier, container_id: identifier, process_id: revision, start_ticks: text(64),
  started_at: integer, closed_at: integer, exit_code: value => value === null || Number.isInteger(value),
  signal: value => value === null || text(32)(value), reason: value => value === null || choice('timeout', 'output_limit', 'stopped', 'spawn_failure', 'observation_failure')(value),
});
