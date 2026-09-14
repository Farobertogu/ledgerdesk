import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { base, originals } from './references.mjs';
import { snapshotR3, validateR3 } from './revision3.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const success = r => r.status !== null && r.status >= 200 && r.status < 300;
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(x);
const nat = x => Number.isSafeInteger(x) && x >= 0;
const positive = x => nat(x) && x > 0;
const bool = x => typeof x === 'boolean';
const nullable = rule => x => x === null || rule(x);
const word = (...values) => x => values.includes(x);
const countKeys = ['receptions', 'receipts', 'jobs', 'extractions', 'candidates', 'publications'];
const headers = new Set(['content-type', 'content-length', 'cache-control', 'pragma', 'expires', 'vary', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age', 'content-disposition', 'location', 'etag', 'last-modified', 'transfer-encoding', 'content-encoding', 'x-content-type-options', 'content-security-policy']);

export function checker(caseId, variant) {
  let count = 0;
  const prefix=`${typeof caseId==='string'?caseId:'[invalid-case]'}/${typeof variant==='string'?variant:'[invalid-variant]'}`;
  return {
    ok(value, rule) { count++; assert.ok(value, `${prefix}: ${rule}`); },
    eq(actual, expected, rule) { count++; assert.deepStrictEqual(actual, expected, `${prefix}: ${rule}`); },
    get count() { return count; },
  };
}

function record(c, value, label) {
  c.ok(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, `${label}.record`);
}

export function shape(c, value, fields, label) {
  record(c, value, label);
  c.eq(Object.keys(value).sort(), Object.keys(fields).sort(), `${label}.keys`);
  for (const [key, rule] of Object.entries(fields)) c.ok(rule(value[key]), `${label}.${key}`);
}

export function rows(c, values, fields, label) {
  c.ok(Array.isArray(values) && values.length <= 100000, `${label}.array`);
  values.forEach((value, i) => shape(c, value, fields, `${label}[${i}]`));
}

function unique(c, values, key, label) {
  c.eq(new Set(values.map(x => x[key])).size, values.length, `${label}.unique-${key}`);
}

function snapshot(c, s, label, revision) {
  if (revision === 3) return snapshotR3(c,s,label);
  shape(c, s, {origin: word('sql-observer'), atMs: nat, database: word('inc02_synthetic'), schema: id, operations: Array.isArray, receipts: Array.isArray, jobs: Array.isArray, counts: x => x !== null && typeof x === 'object'}, label);
  shape(c, s.counts, Object.fromEntries(countKeys.map(k => [k, nat])), `${label}.counts`);
  rows(c, s.operations, {id, principal:id, clientKey:id, variant:id, canonicalProfile:id, generation:positive, revision:positive, state:id, artifactId:nullable(id), originSessionId:nullable(id)}, `${label}.operations`);
  rows(c, s.receipts, {id, operationId:id, artifactId:id, generation:positive, bytes:nat, sha256:sha, effectId:id, personId:id, ...(revision===2 ? {executorRef:id} : {})}, `${label}.receipts`);
  rows(c, s.jobs, {id, receiptId:id, originalId:id, generation:positive, state:id, dispatchable:bool}, `${label}.jobs`);
  for (const key of ['operations', 'receipts', 'jobs']) unique(c, s[key], 'id', `${label}.${key}`);
  unique(c, s.receipts, 'effectId', `${label}.receipts`);
  c.eq([s.counts.receptions, s.counts.receipts, s.counts.jobs], [s.operations.length, s.receipts.length, s.jobs.length], `${label}.counts-have-rows`);
  c.eq([s.counts.extractions, s.counts.candidates, s.counts.publications], [0, 0, 0], `${label}.no-later-effects`);
  for (const r of s.receipts) {
    const op = s.operations.find(x => x.id === r.operationId);
    c.ok(op, `${label}.receipt-operation-exists`);
    c.eq([r.artifactId, r.generation, r.personId], [op.artifactId, op.generation, op.principal], `${label}.receipt-linkage`);
  }
  for (const j of s.jobs) {
    const r = s.receipts.find(x => x.id === j.receiptId);
    c.ok(r, `${label}.job-receipt-exists`);
    c.eq([j.originalId, j.generation, j.dispatchable], [r.artifactId, r.generation, false], `${label}.pending-job-linkage`);
  }
}

// Validate plain JSON without evaluating getters or accepting class instances.
function jsonTree(c, value, depth = 0, seen = new Set()) {
  c.ok(depth <= 32, 'json.depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { c.ok(Number.isFinite(value), 'json.finite-number'); return; }
  c.ok(typeof value === 'object' && !seen.has(value), 'json.no-cycle-or-executable');
  c.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype, 'json.plain-object');
  seen.add(value);
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  c.ok(entries.length <= 100000, 'json.entry-bound');
  for (const [key, d] of entries) {
    if (Array.isArray(value) && key === 'length') continue;
    c.ok(Object.hasOwn(d, 'value') && d.enumerable && !['__proto__', 'constructor', 'prototype'].includes(key), 'json.data-property');
    jsonTree(c, d.value, depth + 1, seen);
  }
  seen.delete(value);
}

export function openBeneath(c, root, name, maxBytes, label) {
  c.ok(typeof root === 'string' && path.isAbsolute(root), `${label}.absolute-root`);
  c.ok(typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\u0000-\u001f\u007f:]/u.test(name) && !path.posix.isAbsolute(name) && !path.win32.isAbsolute(name), `${label}.relative-path`);
  const parts = name.split(/[\\/]/);
  c.ok(parts.every(p => p !== '' && p !== '.' && p !== '..' && !/[ .]$/.test(p)), `${label}.no-path-escape`);
  let fd;
  try {
    const canonicalRoot = realpathSync(root);
    c.ok(lstatSync(canonicalRoot).isDirectory(), `${label}.directory-root`);
    let current = canonicalRoot;
    for (const part of parts) {
      current = path.join(current, part);
      c.ok(!lstatSync(current).isSymbolicLink(), `${label}.no-symbolic-link`);
    }
    const actual = realpathSync(current);
    const relative = path.relative(canonicalRoot, actual);
    c.ok(relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), `${label}.contained-file`);
    fd = openSync(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    c.ok(stat.isFile() && nat(stat.size) && stat.size <= maxBytes, `${label}.bounded-regular-file`);
    const buffer=Buffer.alloc(stat.size+1);let offset=0;
    while(offset<buffer.length){const n=readSync(fd,buffer,offset,buffer.length-offset,offset);if(n===0)break;offset+=n;}
    const bytes = buffer.subarray(0,offset);
    c.eq(bytes.length, stat.size, `${label}.stable-file-length`);
    return bytes;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    c.ok(false, `${label}.file-unavailable`);
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function validate(c, o, caseId, variant, locations) {
  jsonTree(c, o);
  if(o.profile==='intake-observation/1')c.eq(o.interfaceRevision,3,'coverage.legacy-observation-not-revised-acceptance');
  jsonTree(c, locations);
  shape(c, locations, {fixtureRoot: x => typeof x === 'string' && path.isAbsolute(x), evidenceRoot: x => typeof x === 'string' && path.isAbsolute(x)}, 'locations');
  let actualFixtureRoot, actualEvidenceRoot;
  try { actualFixtureRoot=realpathSync(locations.fixtureRoot); actualEvidenceRoot=realpathSync(locations.evidenceRoot); } catch { c.ok(false,'locations.roots-unavailable'); }
  const relativeRoots = path.relative(actualFixtureRoot, actualEvidenceRoot);
  const reverseRoots = path.relative(actualEvidenceRoot, actualFixtureRoot);
  c.ok(relativeRoots !== '' && (path.isAbsolute(relativeRoots) || relativeRoots.startsWith(`..${path.sep}`) || relativeRoots === '..') && (path.isAbsolute(reverseRoots) || reverseRoots.startsWith(`..${path.sep}`) || reverseRoots === '..'), 'locations.disjoint-roots');
  const extensions={};
  if (Object.hasOwn(o,'interfaceRevision')) {
    extensions.interfaceRevision=word(2,3);
    for (const key of ['restoration','privilegeProbes','preservedData','roleInventory','diagnosticFiles','profileControls','routeInventory','invocations','comparisons']) if (Object.hasOwn(o,key)) extensions[key]=x=>x===null || typeof x==='object';
    if(o.interfaceRevision===3) {
      extensions.interfaceAddendum=word('3.2','3.3');
      if(o.interfaceAddendum==='3.3')extensions.phaseLineage=x=>x!==null&&typeof x==='object';
      extensions.requestBoundaries=Array.isArray;
      for(const key of ['correlations','ingress','objectFault','processes','startup','incumbentComparisons','byteTransfers','continuation']) if(Object.hasOwn(o,key))extensions[key]=x=>x!==null&&typeof x==='object';
    }
  }
  shape(c, o, {profile:word('intake-observation/1'), caseId:word(caseId), variant:word(variant), runId:id, source:x => x !== null && typeof x === 'object', input:x => x !== null && typeof x === 'object', before:x => x !== null && typeof x === 'object', after:x => x !== null && typeof x === 'object', responses:Array.isArray, storage:Array.isArray, control:Array.isArray, evidence:Array.isArray, transport:Array.isArray, barriers:Array.isArray, temporal:x => x === null || typeof x === 'object', ...extensions}, 'envelope');
  shape(c, o.source, {base:word(base), manifestSha256:sha, imageId:x => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x)}, 'source');
  shape(c, o.input, {fixture:x => typeof x === 'string' && Object.hasOwn(originals, x), artifactId:o.interfaceRevision===3?nullable(id):id, generation:o.interfaceRevision===3?nullable(positive):positive, principal:id, ...(o.interfaceRevision===3?{subject:x=>x!==null&&typeof x==='object'}:{operationId:id})}, 'input');
  snapshot(c, o.before, 'before',o.interfaceRevision); snapshot(c, o.after, 'after',o.interfaceRevision);
  c.ok(o.after.atMs >= o.before.atMs, 'snapshots.time-order');
  rows(c, o.responses, {origin:word('https-client'), label:id, route:x => typeof x === 'string' && /^\/api\/intake(?:\/[A-Za-z0-9_./:-]+)?$/.test(x) && !x.includes('..'), status:nullable(x => Number.isInteger(x) && x >= 100 && x <= 599), headers:x => x !== null && typeof x === 'object' && !Array.isArray(x), body:() => true, bodyFile:nullable(id), bytes:nat, sha256:nullable(sha), atMs:nat}, 'responses');
  unique(c, o.responses, 'label', 'responses');
  for (const r of o.responses) {
    for (const [key, value] of Object.entries(r.headers)) c.ok(headers.has(key) && typeof value === 'string' && !/[\r\n\u0000]/u.test(value), 'responses.public-header-allowlist');
    if (r.status === null) c.eq([r.body, r.bodyFile, r.bytes, r.sha256, Object.keys(r.headers).length], [null, null, 0, null, 0], 'responses.no-reply-shape');
    else {
      c.ok(sha(r.sha256), 'responses.actual-digest-required');
      if (r.bodyFile !== null) {
        c.eq(r.body, null, 'responses.binary-not-json');
        const bytes = openBeneath(c, locations.evidenceRoot, r.bodyFile, 8388608, 'response-capture');
        c.eq([bytes.length, digest(bytes)], [r.bytes, r.sha256], 'responses.actual-capture-integrity');
      } else c.ok(r.body === null || typeof r.body === 'object', 'responses.json-body');
    }
  }
  const eventKeys=o.interfaceRevision===3?{callId:id,receptionId:nullable(id),operationId:nullable(id)}:{};
  rows(c, o.storage, {origin:word('object-boundary'), kind:word('capture','append','seal','open','read','restore_write','failed_open','failed_write'), artifactId:id, generation:positive, bytes:nat, offset:nullable(nat), evidenceId:nullable(id), atMs:nat, incarnation:id,...eventKeys}, 'storage');
  if(o.interfaceRevision!==3) {
    const scopedArtifacts=new Set([o.input.artifactId,...o.before.operations.map(x=>x.artifactId),...o.after.operations.map(x=>x.artifactId)]);
    for(const e of o.storage)c.ok(scopedArtifacts.has(e.artifactId),'storage.no-unscoped-access-evidence');
  }
  rows(c, o.control, {origin:word('current-control'), label:id, sourceId:id, sourceSchema:id, revision:positive, atMs:nat, available:bool, gate:id, action:word('read','withdraw','restore_admit','unavailable'), objectId:id}, 'control');
  for (const [i,e] of o.evidence.entries()) shape(c,e, {origin:word('sql-observer'), id, phase:word('capture_admission','read_admission','effect','delivery','query'), operationId:id, artifactId:nullable(id), generation:nullable(positive), principal:id, status:nullable(x => Number.isInteger(x) && x >= 100 && x <= 599), atMs:nat, backendPid:positive, transactionOpen:o.interfaceAddendum==='3.3'?nullable(bool):bool,...(o.interfaceRevision>=2 && e.phase==='effect' ? {personRef:id,executorRef:id} : {}),...eventKeys}, `evidence[${i}]`);
  unique(c, o.evidence, 'id', 'evidence');
  rows(c, o.transport, {origin:word('terminal-boundary'), route:id, operationId:id, evidenceId:nullable(id), kind:word('handoff','interrupted','observation_failed'), bytes:nat, atMs:nat,...eventKeys}, 'transport');
  rows(c, o.barriers, {origin:word('test-controller'), label:word('before_capture','between_chunks','before_original_read','before_receipt_commit','after_receipt_commit','before_handoff','after_last_clock','before_restore_admission'), reachedAtMs:nat, releasedAtMs:nullable(nat), writerCommittedAtMs:nullable(nat), clientBytesAtPause:nullable(nat), backendPid:nullable(positive), transactionOpen:nullable(bool)}, 'barriers');
  for (const b of o.barriers) c.ok(b.releasedAtMs !== null && b.releasedAtMs >= b.reachedAtMs, 'barriers.reached-and-released');
  for (const e of o.storage) if (e.kind === 'failed_open' || e.kind === 'failed_write') c.eq(e.bytes, 0, 'storage.failed-call-no-successful-bytes');
  for (const s of o.interfaceRevision===3?[]:[o.before, o.after]) {
    const op = s.operations.find(x => x.id === o.input.operationId);
    if (op) c.eq(op.principal, o.input.principal, 'input.principal-linkage');
  }
  if (o.temporal !== null) shape(c, o.temporal, {origin:word('test-controller'), route:id, point:id, deadlineMs:nat, lastEvaluationMs:nat, resumedMs:nat, writerParticipated:bool, observedEffects:nat, observedBytes:nat, conformity:word('satisfied_in_observation','violated','not_measurable')}, 'temporal');
  if(o.interfaceRevision===3)validateR3(c,o,locations);
}

export function fixture(c, o, locations) {
  const bytes = openBeneath(c, locations.fixtureRoot, o.input.fixture, 1048577, 'fixed-original');
  c.eq([bytes.length, digest(bytes)], [originals[o.input.fixture].bytes, originals[o.input.fixture].sha256], 'fixed-original.independent-reference');
  return bytes;
}

export function diagnosticInventory(c,root) {
  const names=[];
  try {
    const canonical=realpathSync(root);
    const walk=(relative,depth)=>{
      c.ok(depth<=8&&names.length<=4096,'diagnostics.inventory-bound');
      const current=path.join(canonical,relative),stat=lstatSync(current);
      c.ok(!stat.isSymbolicLink(),'diagnostics.no-inventory-symlink');
      if(stat.isDirectory())for(const name of readdirSync(current))walk(`${relative}/${name}`,depth+1);
      else {c.ok(stat.isFile(),'diagnostics.regular-inventory-file');names.push(relative);}
    };
    walk('logs',0);
  }catch(error){if(error instanceof assert.AssertionError)throw error;c.ok(false,'diagnostics.inventory-unavailable');}
  return names.sort();
}
