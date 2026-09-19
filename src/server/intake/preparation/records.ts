import {createHash} from 'node:crypto';
import {canonicalValue} from '../../../contracts/access_canonical.ts';
import {exactReference, artifactReference, identifier, revision} from '../../../contracts/intake.ts';
import {
  PREPARATION_BOUNDS, PREPARATION_DESCRIPTOR, PREPARATION_DIFFERENCE, PREPARATION_PAYLOAD,
  PREPARATION_RECORD, type Artifact, type Exact,
} from '../../../contracts/intake_preparation.ts';

export type Row = Record<string, any>;
export class PreparationLimit extends RangeError {
  constructor() { super('PREPARATION_LIMIT'); }
}
export type DifferenceRecord = {reference: Exact; body: Row};
export type PreparedRecord = {
  profile: typeof PREPARATION_RECORD; reference: Exact; descriptor: Row;
  payload: Row; differences: DifferenceRecord[];
};
export const byteDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const same = (a: unknown, b: unknown) => canonicalValue(a) === canonicalValue(b);

/** Fixed versioned domain; references are never hashes of their own enclosing envelope. */
export function domainBytes(domain: string, body: unknown): Buffer {
  if (!['preparation-descriptor/1', 'preparation-difference/1', 'preparation-operation/1',
    'preparation-proposal/1', 'preparation-effect/1', 'preparation-comparison/1',
    'constitution-prior-act/1', 'constitution-express-authorization/1', 'constitution-exact-target/1'].includes(domain)) throw Error('PREPARATION_DOMAIN');
  return Buffer.from(canonicalValue({domain, body}), 'utf8');
}
export function referenceFor(domain: string, id: string, number: number, body: unknown): Exact {
  if (!identifier(id) || !revision(number)) throw Error('PREPARATION_REFERENCE_ID');
  return {id, revision: number, sha256: byteDigest(domainBytes(domain, body))};
}
export function artifactFor(id: string, generation: number, bytes: Uint8Array): Artifact {
  const artifact = {id, generation, bytes: bytes.byteLength, sha256: byteDigest(bytes)};
  if (!artifactReference(artifact)) throw Error('PREPARATION_ARTIFACT');
  return artifact;
}
export function encodePayload(payload: unknown): Buffer {
  if (!PREPARATION_PAYLOAD(payload)) throw Error('PREPARATION_PAYLOAD');
  const bytes = Buffer.from(canonicalValue(payload), 'utf8');
  if (bytes.length > PREPARATION_BOUNDS.payloadBytes) throw new PreparationLimit();
  return bytes;
}
export function sealDifference(id: string, number: number, body: Row): DifferenceRecord {
  if (!PREPARATION_DIFFERENCE(body)) throw Error('PREPARATION_DIFFERENCE');
  return {reference: referenceFor('preparation-difference/1', id, number, body), body};
}
export function differenceMatches(difference: DifferenceRecord, inputs: Row[], target: {id: string; revision: number; payload: Artifact}): boolean {
  if (!difference || !exactReference(difference.reference) || !PREPARATION_DIFFERENCE(difference.body)) return false;
  const d = difference.body;
  return same(referenceFor('preparation-difference/1', difference.reference.id, difference.reference.revision, d), difference.reference) &&
    same(d.after, target) && d.before.every((before: Row) => inputs.some(input =>
      same(input.reference, before.input) && same(input.source_artifact, before.payload))) &&
    new Set(d.before.map((before: Row) => canonicalValue(before.input))).size === d.before.length;
}
export function sealPreparation(args: {
  id: string; revision: number; artifactId: string; payload: Row; differences: DifferenceRecord[];
  operation: Exact; actor: string; recordedAt: number;
}): {record: PreparedRecord; bytes: Buffer} {
  const bytes = encodePayload(args.payload), payload = artifactFor(args.artifactId, args.revision, bytes);
  const target = {id: args.id, revision: args.revision, payload};
  if (!args.differences.every(d => differenceMatches(d, args.payload.inputs, target))) throw Error('PREPARATION_DIFFERENCE_ASSOCIATION');
  if (new Set(args.differences.map(d => d.reference.id)).size !== args.differences.length) throw Error('PREPARATION_DIFFERENCE_DUPLICATE');
  const descriptor = {profile: 'preparation-descriptor/1', id: args.id, revision: args.revision, payload,
    inputs: args.payload.inputs, differences: args.differences.map(d => d.reference),
    operation: args.operation, actor: args.actor, recorded_at: args.recordedAt};
  if (!PREPARATION_DESCRIPTOR(descriptor)) throw Error('PREPARATION_DESCRIPTOR');
  return {bytes, record: {profile: PREPARATION_RECORD,
    reference: referenceFor('preparation-descriptor/1', args.id, args.revision, descriptor),
    descriptor, payload: args.payload, differences: args.differences}};
}
/** Integrity and correspondence only: current source/read/effect admission is a caller obligation. */
export function verifyPreparation(record: PreparedRecord, bytes: Uint8Array): boolean {
  try {
    if (!record || record.profile !== PREPARATION_RECORD || !exactReference(record.reference) ||
      !PREPARATION_DESCRIPTOR(record.descriptor) || !PREPARATION_PAYLOAD(record.payload) || !Array.isArray(record.differences)) return false;
    const d = record.descriptor;
    return same(record.reference, referenceFor('preparation-descriptor/1', d.id, d.revision, d)) &&
      same(d.payload, artifactFor(d.payload.id, d.payload.generation, bytes)) &&
      Buffer.from(bytes).equals(encodePayload(record.payload)) && same(d.inputs, record.payload.inputs) &&
      same(d.differences, record.differences.map(x => x.reference)) &&
      new Set(d.differences.map((x: Exact) => x.id)).size === d.differences.length &&
      record.differences.every(x => differenceMatches(x, d.inputs, {id: d.id, revision: d.revision, payload: d.payload}));
  } catch { return false; }
}
