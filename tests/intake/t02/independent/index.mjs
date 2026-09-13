import { checker, digest, fixture, openBeneath, success, validate } from './observation.mjs';
import { originalLimit, originals } from './references.mjs';
import { extendedCase } from './extensions.mjs';
import { subjectReceipt, invocationCaseR3 } from './revision3.mjs';
import { corruptCase, framingCase, resumedCase, restartCase } from './variant_cases.mjs';
import { digestCase } from './byte_observations.mjs';
import { protectedReadKinds, protectedWriteKinds } from './protected_access.mjs';
import { selectedCompletedDeliveries } from './selected_delivery.mjs';

export const OBSERVATION_PROFILE = 'intake-observation/1';
export const supportedVariants = Object.freeze(Object.fromEntries(Object.entries({
  IC01: ['round-trip'],
  IC02: ['at-limit', 'over-limit', 'framing', 'digest-mismatch'],
  IC03: ['admitted', 'denied-capture', 'wrong-origin'],
  IC04: ['compatible', 'incompatible', 'concurrent', 'other-principal'],
  IC05: ['receipt', 'invalid-linkage'],
  IC06: ['partial', 'resumed'],
  IC07: ['sealed-uncommitted'],
  IC08: ['lost-response', 'query-without-load', 'query-denied', 'uncertain'],
  IC09: ['late-generation'],
  IC10: ['cancel-first', 'finalize-first'],
  IC11: ['intact', 'missing', 'query-only', 'corrupt'],
  IC12: ['restore', 'post-backup-withdrawal', 'control-unavailable', 'forged-manifest', 'restart'],
  IC13: ['before-capture', 'between-chunks', 'before-finalize'],
  IC14: ['whole', 'record-only', 'fragment-only', 'hidden-absent'],
  IC15: ['prior-evidence', 'evidence-failure', 'writer-first', 'handoff-first'],
  IC16: ['before-deadline', 'already-expired', 'writer-free-expiry'],
  IC17: ['migration', 'isolation', 'overwrite'],
  IC18: ['profiles', 'siblings', 'safe-output'],
}).map(([k, values]) => [k, Object.freeze(values)])));
export const supportedCases = Object.freeze(Object.keys(supportedVariants));
export const unsupportedVariants = Object.freeze({});
export const MODULE_RELEASE='t02-independent/6';
export const REQUIRED_OBSERVATION=Object.freeze({profile:OBSERVATION_PROFILE,interfaceRevision:3,interfaceAddendum:'3.2'});
export const SUPPORTED_OBSERVATION_ADDENDA=Object.freeze(['3.2','3.3']);

function response(c, o, label = 'subject') {
  const r = o.responses.find(x => x.label === label);
  c.ok(r, `response.${label}.required`);
  return r;
}
function barrier(c, o, label) {
  const b = o.barriers.filter(x => x.label === label);
  c.eq(b.length, 1, `barrier.${label}.one-reached`);
  return b[0];
}
function control(c, o, action, gate) {
  const rows = o.control.filter(x => x.action === action && (gate === undefined || x.gate === gate));
  c.eq(rows.length, 1, `control.${action}.${gate ?? 'target'}.required`);
  c.eq(rows[0].available, action !== 'unavailable', 'control.availability-consistent');
  return rows[0];
}
const bodyKinds = new Set(protectedReadKinds);
const writeKinds = new Set(protectedWriteKinds);
function access(o, kinds, since = -1) {
  // A zero-access claim covers the subject call across every object/generation.
  // R1/R2 have no call identity: their complete isolated window is the scope.
  return o.storage.filter(x => x.atMs >= since && kinds.has(x.kind) &&
    (o.interfaceRevision !== 3 || x.callId === o.input.subject.callId));
}
function originalAccess(o, kinds) {
  return access(o, kinds).filter(x => x.artifactId === o.input.artifactId && x.generation === o.input.generation);
}
function vector(o, since = -1) {
  return {receipts:o.after.counts.receipts, jobs:o.after.counts.jobs, opens:access(o, bodyKinds, since).length, writes:access(o, writeKinds, since).length};
}
function emptyEffects(c, o) {
  c.eq([o.after.counts.receipts, o.after.counts.jobs], [0, 0], 'effects.no-receipt-or-job');
}
function unchanged(c, o) {
  c.eq([o.after.receipts, o.after.jobs], [o.before.receipts, o.before.jobs], 'effects.history-unchanged');
}
function oneReceipt(c, o) {
  c.eq([o.after.counts.receipts, o.after.counts.jobs], [1, 1], 'effects.one-receipt-and-job');
  const r = o.interfaceRevision===3?subjectReceipt(c,o):o.after.receipts[0];
  const fixed = originals[o.input.fixture];
  if(o.interfaceRevision===3)c.eq([r.artifactId,r.generation,r.bytes,r.sha256],[o.input.artifactId,o.input.generation,fixed.bytes,fixed.sha256],'effects.exact-receipt-identity');
  else c.eq([r.operationId,r.artifactId,r.generation,r.personId,r.bytes,r.sha256], [o.input.operationId,o.input.artifactId,o.input.generation,o.input.principal,fixed.bytes,fixed.sha256], 'effects.exact-receipt-identity');
  return r;
}
function exactBody(c, o, r, locations) {
  const input = fixture(c, o, locations);
  c.ok(r.bodyFile !== null, 'original.actual-capture-required');
  const output = openBeneath(c, locations.evidenceRoot, r.bodyFile, originalLimit, 'original-capture');
  c.eq({success:success(r), bytes:output, length:r.bytes, hash:r.sha256}, {success:true, bytes:input, length:input.length, hash:digest(input)}, 'original.exact-bytes-and-outcome');
  const reads = originalAccess(o, new Set(['read']));
  c.ok(reads.length > 0, 'original.real-read-required');
  c.ok(reads.reduce((sum, e) => sum + e.bytes, 0) >= input.length, 'original.read-covers-source');
}
function successfulReceipt(c, o) {
  const r = response(c, o);
  c.eq({success:success(r), receipts:o.after.counts.receipts, jobs:o.after.counts.jobs}, {success:true, receipts:1, jobs:1}, 'receipt.outcome-and-effects');
  oneReceipt(c, o);
  const seal = originalAccess(o, new Set(['seal']));
  const prior=o.interfaceAddendum==='3.3'&&o.phaseLineage.priorUploads.some(x=>x.finalizeCallId===o.input.subject.callId);
  c.ok(prior||seal.some(x => x.bytes === originals[o.input.fixture].bytes), 'receipt.exact-seal-observed');
}
function denied(c, o, statuses, {write = false, read = false, since = -1, retained = false} = {}) {
  const r = response(c, o);
  const v = vector(o, since);
  c.eq({allowedStatus:statuses.includes(r.status), binary:r.bodyFile, receipts:v.receipts, jobs:v.jobs, ...(write ? {writes:v.writes} : {}), ...(read ? {opens:v.opens} : {})},
    {allowedStatus:true, binary:null, receipts:retained ? o.before.counts.receipts : 0, jobs:retained ? o.before.counts.jobs : 0, ...(write ? {writes:0} : {}), ...(read ? {opens:0} : {})}, 'denial.outcome-and-effects-and-access');
  if (retained) unchanged(c, o);
}
function priorEvidence(c, o, events) {
  c.ok(events.length > 0, 'access.observed-positive-required');
  for (const e of events) {
    const v = o.evidence.find(x => x.id === e.evidenceId);
    c.ok(v, 'access.prior-evidence-required');
    const phase = bodyKinds.has(e.kind) ? 'read_admission' : 'capture_admission';
    c.eq([v.phase,v.operationId,v.artifactId,v.generation,v.principal], [phase,o.interfaceRevision===3?e.operationId:o.input.operationId,e.artifactId,e.generation,o.input.principal], 'access.evidence-identity');
    if(o.interfaceRevision===3)c.eq([v.callId,v.receptionId],[e.callId,e.receptionId],'access.actual-call-and-reception');
    c.ok(v.atMs <= e.atMs, 'access.evidence-before-access');
  }
}
function handoff(c, o, r) {
  const b = barrier(c, o, 'before_handoff');
  c.eq([b.clientBytesAtPause,b.transactionOpen], [0,false], 'handoff.client-empty-sql-idle');
  c.ok(Number.isSafeInteger(b.backendPid) && b.backendPid > 0, 'handoff.backend-observed');
  const t = o.transport.filter(x => x.route === r.route && (o.interfaceRevision===3?x.callId===o.input.subject.callId:x.operationId===o.input.operationId) && x.kind === 'handoff');
  c.ok(t.length > 0, 'handoff.actual-terminal-required');
  for (const e of t) {
    const v = o.evidence.find(x => x.id === e.evidenceId);
    c.ok(v, 'handoff.durable-evidence-required');
    c.eq([v.phase,v.operationId,v.principal,v.backendPid,v.transactionOpen], ['delivery',o.interfaceRevision===3?e.operationId:o.input.operationId,o.input.principal,b.backendPid,false], 'handoff.evidence-identity');
    if(o.interfaceRevision===3)c.eq([v.callId,v.receptionId],[e.callId,e.receptionId],'handoff.actual-call-and-reception');
    c.ok(v.atMs <= b.reachedAtMs && b.releasedAtMs <= e.atMs && e.atMs <= r.atMs, 'handoff.observed-order');
  }
  c.eq(t.reduce((sum,x) => sum + x.bytes, 0), r.bytes, 'handoff.client-byte-corroboration');
  c.ok(r.headers['cache-control']?.split(',').map(x=>x.trim().toLowerCase()).includes('no-store'),'handoff.no-store');
  return {b, t};
}

function temporalCase(c, o, variant, locations) {
  const t = o.temporal;
  c.ok(t !== null, 'temporal.required');
  c.eq(t.writerParticipated, false, 'temporal.no-writer');
  c.eq(o.control.filter(x => x.action === 'withdraw').length, 0, 'temporal.no-withdrawal-observed');
  c.ok(['handoff','receipt_commit'].includes(t.point), 'temporal.known-point');
  c.ok(t.conformity !== 'not_measurable', 'temporal.measurement-evidence-not-optional');
  const p = response(c, o, 'positive');
  const e = response(c, o, 'expired');
  const s = response(c, o);
  c.eq([p.route,e.route,s.route], [t.route,t.route,t.route], 'temporal.same-route-controls');
  c.eq({positive:success(p), positiveBefore:p.atMs < t.deadlineMs, expired:[403,404].includes(e.status), expiredAfter:e.atMs >= t.deadlineMs, expiredBinary:e.bodyFile}, {positive:true,positiveBefore:true,expired:true,expiredAfter:true,expiredBinary:null}, 'temporal.valid-positive-and-expired-controls');
  c.ok(p.bytes > 0 && p.bodyFile !== null || p.bytes > 0 && p.body !== null, 'temporal.positive-not-empty-denial');
  if (t.route.endsWith('/original') && p.bodyFile !== null) {
    const expected = fixture(c,o,locations);
    const capture = openBeneath(c,locations.evidenceRoot,p.bodyFile,originalLimit,'temporal-positive');
    c.eq(capture, expected, 'temporal.original-positive-exact');
  }
  c.ok(t.resumedMs >= t.lastEvaluationMs && s.atMs >= t.resumedMs, 'temporal.clock-order');
  const subject=x=>o.interfaceRevision===3?x.callId===o.input.subject.callId:x.operationId===o.input.operationId;
  const terminal = o.transport.filter(x => x.kind === 'handoff' && x.route === t.route && subject(x) && x.atMs >= t.resumedMs && x.atMs <= s.atMs);
  const effects = o.evidence.filter(x => x.phase === 'effect' && subject(x) && x.atMs >= t.resumedMs && x.atMs <= s.atMs);
  c.eq(o.transport.filter(x=>x.route===t.route&&subject(x)&&x.atMs>=t.resumedMs&&x.atMs<=s.atMs&&x.kind!=='handoff').length,0,'temporal.no-unknown-transfer-outcome');
  const observedBytes = terminal.reduce((sum,x) => sum + x.bytes,0);
  const observedEffects = effects.length;
  c.eq([t.observedBytes,t.observedEffects], [observedBytes,observedEffects], 'temporal.counters-corroborated');
  c.eq(observedEffects, o.after.counts.receipts - o.before.counts.receipts, 'temporal.effects-match-sql-delta');
  if (t.point === 'handoff') {
    c.eq(observedEffects,0,'temporal.query-no-receipt-effect');
    c.eq(observedBytes, success(s) ? s.bytes : 0, 'temporal.client-corroborates-governed-bytes');
    c.ok(!success(s) || s.bytes > 0, 'temporal.success-is-observable');
  }
  const crossed = t.point === 'handoff' ? terminal.some(x => x.bytes > 0 && x.atMs >= t.deadlineMs) : effects.some(x => x.atMs >= t.deadlineMs);
  if (variant === 'before-deadline') {
    c.eq({success:success(s), before:s.atMs < t.deadlineMs, evidence:t.point === 'handoff' ? observedBytes > 0 : observedEffects === 1}, {success:true,before:true,evidence:true}, 'temporal.before-deadline-positive');
  } else if (variant === 'already-expired') {
    c.eq({expired:t.lastEvaluationMs >= t.deadlineMs, denied:[403,404].includes(s.status), bytes:observedBytes,effects:observedEffects}, {expired:true,denied:true,bytes:0,effects:0}, 'temporal.already-expired-negative');
  } else {
    const b = barrier(c,o,'after_last_clock');
    c.ok(t.lastEvaluationMs < t.deadlineMs && b.reachedAtMs >= t.lastEvaluationMs && b.releasedAtMs >= t.deadlineMs && t.resumedMs >= b.releasedAtMs, 'temporal.directed-deadline-crossing');
    c.eq(b.writerCommittedAtMs,null,'temporal.barrier-without-writer');
  }
  c.eq(t.conformity, crossed ? 'violated' : 'satisfied_in_observation', 'temporal.truthful-classification');
  return {temporalViolation:crossed, temporalConformity:t.conformity};
}

export function assertCase(caseId, variant, observation, locations) {
  const c = checker(caseId, variant);
  c.ok(typeof caseId==='string'&&typeof variant==='string'&&Object.hasOwn(supportedVariants,caseId) && supportedVariants[caseId].includes(variant), 'coverage.unsupported-case-or-variant');
  const o = observation;
  validate(c,o,caseId,variant,locations);
  // Earlier packets lack an independent account/person mapping and actual call
  // and transaction joins. Do not silently upgrade them into acceptance evidence.
  c.eq(o.interfaceRevision,3,'coverage.requires-r3.2-for-revised-acceptance');
  const specialized={'IC02/framing':framingCase,'IC02/digest-mismatch':digestCase,'IC06/resumed':resumedCase,'IC11/corrupt':corruptCase,'IC12/restart':restartCase}[`${caseId}/${variant}`];
  if(specialized){specialized(c,o,locations,{response,barrier,control,unchanged,oneReceipt,successfulReceipt,exactBody,denied});selectedCompletedDeliveries(c,o);return {caseId,variant,assertions:c.count};}
  let extra = {};
  switch (caseId) {
    case 'IC01':
      c.ok(['text.txt','bom.txt','inert.md','table.csv','bom.csv','unicode-records.csv','short.txt','baseline.xlsx','cache-discrepant.xlsx','cache-missing.xlsx','cache-zero.xlsx'].includes(o.input.fixture),'original.admitted-round-trip-input');
      oneReceipt(c,o); exactBody(c,o,response(c,o),locations); break;
    case 'IC02':
      if (variant === 'at-limit') {
        c.eq(o.input.fixture,'at-byte-limit.txt','limit.independent-boundary-fixture');
        successfulReceipt(c,o); exactBody(c,o,response(c,o),locations);
      } else {
        c.eq(o.input.fixture, variant === 'over-limit' ? 'over-byte-limit.txt' : 'baseline.xlsx','limit.negative-fixture');
        denied(c,o,variant === 'over-limit' ? [400,413] : [400,409],{write:true,read:true});
        const appended = access(o,new Set(['append']));
        c.ok(appended.reduce((sum,x) => sum+x.bytes,0) <= originalLimit,'limit.bounded-retained-bytes');
        c.ok(access(o,new Set(['capture'])).every(x => x.bytes <= originalLimit),'limit.bounded-capture-event');
        emptyEffects(c,o);
      }
      break;
    case 'IC03':
      if (variant === 'admitted') { successfulReceipt(c,o); priorEvidence(c,o,access(o,new Set(['capture']))); }
      else { denied(c,o,[403],{write:true,read:true}); control(c,o,'read',variant === 'wrong-origin' ? 'origin' : undefined); }
      break;
    case 'IC04': case 'IC05':
      invocationCaseR3(c,o,locations,{response,barrier,control,unchanged,oneReceipt,successfulReceipt,exactBody,denied});break;
    case 'IC12': case 'IC17':
      extendedCase(c,o,locations,{response,barrier,control,unchanged,oneReceipt,successfulReceipt,exactBody,denied});break;
    case 'IC06': {
      const b = barrier(c,o,'between_chunks');
      c.eq([b.transactionOpen,b.clientBytesAtPause],[false,0],'partial.idle-database');
      c.eq(access(o,new Set(['append'])).reduce((sum,x)=>sum+x.bytes,0),10,'partial.exact-prefix-length');
      c.eq(access(o,new Set(['seal'])).length,0,'partial.no-complete-seal');
      c.eq(response(c,o).status,null,'partial.actual-response-loss'); emptyEffects(c,o); break;
    }
    case 'IC07':
      barrier(c,o,'before_receipt_commit');
      c.ok(access(o,new Set(['seal'])).some(x=>x.bytes===originals[o.input.fixture].bytes),'orphan.actual-complete-seal');
      c.ok(response(c,o).status === null || response(c,o).status === 503,'orphan.no-false-success'); emptyEffects(c,o); break;
    case 'IC08':
      if (variant === 'lost-response') { c.eq(response(c,o).status,null,'lookup.lost-response'); barrier(c,o,'after_receipt_commit'); oneReceipt(c,o); c.ok(success(response(c,o,'lookup')),'lookup.recovered-known-effect'); }
      else if (variant === 'query-without-load') { control(c,o,'withdraw','load'); control(c,o,'read','query'); c.ok(success(response(c,o)),'lookup.independent-query-allowed'); unchanged(c,o); }
      else if (variant === 'query-denied') denied(c,o,[403,404],{read:true,write:true,retained:true});
      else { control(c,o,'unavailable'); denied(c,o,[503],{read:true,write:true,retained:true}); }
      c.eq(access(o,bodyKinds).length,0,'lookup.zero-original-access');
      if (variant !== 'lost-response') c.eq(access(o,writeKinds).length,0,'lookup.no-material-writes');
      break;
    case 'IC09': {
      oneReceipt(c,o); unchanged(c,o);
      const stale = o.storage.filter(x=>x.artifactId===o.input.artifactId && x.generation<o.input.generation && x.kind==='failed_write');
      c.ok(stale.length>0,'generation.late-actor-reached-object-fence');
      c.eq(o.storage.filter(x=>x.artifactId===o.input.artifactId && x.generation<o.input.generation && writeKinds.has(x.kind)).length,0,'generation.no-stale-write');
      c.eq(response(c,o).status,409,'generation.stale-conflict'); break;
    }
    case 'IC10':
      c.ok(success(response(c,o,'cancel')),'cancel.actual-stop-response');
      if (variant==='cancel-first') denied(c,o,[403,409]);
      else { c.ok(success(response(c,o)),'cancel.committed-finalization'); oneReceipt(c,o); unchanged(c,o); }
      break;
    case 'IC11':
      oneReceipt(c,o); unchanged(c,o);
      if (variant==='intact') exactBody(c,o,response(c,o),locations);
      else if (variant==='missing') { denied(c,o,[404,409,503],{retained:true}); c.ok(access(o,new Set(['failed_open'])).length>0,'availability.actual-failed-open'); c.eq(access(o,new Set(['read'])).length,0,'availability.no-substitute-body'); }
      else { c.ok(success(response(c,o)),'availability.record-query-positive'); c.eq(access(o,bodyKinds).length,0,'availability.record-does-not-open-original'); }
      break;
    case 'IC13': {
      const b = barrier(c,o,variant==='before-capture'?'before_capture':variant==='between-chunks'?'between_chunks':'before_original_read');
      const w = control(c,o,'withdraw');
      c.ok(b.reachedAtMs <= w.atMs && w.atMs <= b.releasedAtMs,'withdrawal.actual-writer-order');
      c.eq(b.writerCommittedAtMs,w.atMs,'withdrawal.barrier-corroborates-writer');
      denied(c,o,[403,404,409],{read:true,write:true,since:w.atMs});
      if (variant==='between-chunks') { c.ok(access(o,new Set(['append'])).some(x=>x.bytes>0 && x.atMs<w.atMs),'withdrawal.earlier-positive-chunk'); c.eq(b.transactionOpen,false,'withdrawal.no-upload-long-transaction'); }
      break;
    }
    case 'IC14':
      if (variant==='whole') { oneReceipt(c,o); exactBody(c,o,response(c,o),locations); }
      else if (variant==='record-only') { c.ok(success(response(c,o)),'view.record-positive'); unchanged(c,o); c.eq(access(o,bodyKinds).length,0,'view.record-zero-body-access'); }
      else if (variant==='fragment-only') { c.ok(success(response(c,o,'fragment')),'view.allowed-fragment-positive'); denied(c,o,[403,404],{read:true,retained:true}); }
      else {
        const h=response(c,o,'hidden'), a=response(c,o,'absent'), p=response(c,o,'positive');
        const projection=x=>({status:x.status,headers:x.headers,body:x.body,bodyFile:x.bodyFile,bytes:x.bytes,sha256:x.sha256});
        c.eq({hidden:projection(h),positive:success(p),bodyAccess:access(o,bodyKinds).length},{hidden:projection(a),positive:true,bodyAccess:0},'view.hidden-absent-full-tuple');
        c.ok([403,404].includes(h.status),'view.neutral-not-global-failure');
      }
      break;
    case 'IC15':
      if (variant==='evidence-failure') { barrier(c,o,'before_original_read'); denied(c,o,[503],{read:true,retained:true}); }
      else if (variant==='writer-first') {
        const w=control(c,o,'withdraw'), b=barrier(c,o,'before_handoff');
        c.ok(b.reachedAtMs<=w.atMs && w.atMs<=b.releasedAtMs,'handoff.writer-first-order');
        denied(c,o,[403,404],{retained:true});
        c.eq(o.transport.filter(x=>x.callId===o.input.subject.callId&&x.kind==='handoff' && x.atMs>=w.atMs).length,0,'handoff.no-stale-transfer');
        c.eq([b.clientBytesAtPause,b.transactionOpen],[0,false],'handoff.writer-first-empty-idle');
      } else {
        const r=response(c,o); c.ok(success(r),'handoff.positive');
        if (r.bodyFile!==null) { exactBody(c,o,r,locations); priorEvidence(c,o,access(o,bodyKinds)); }
        else { c.eq(access(o,bodyKinds).length,0,'handoff.json-no-original-access'); c.ok(r.body!==null && r.bytes>0,'handoff.actual-json-positive'); }
        const {t}=handoff(c,o,r);
        if (variant==='handoff-first') { const w=control(c,o,'withdraw'); c.ok(t.every(x=>x.atMs<w.atMs),'handoff.transfer-before-writer'); c.eq(o.transport.filter(x=>x.callId===o.input.subject.callId&&x.kind==='handoff' && x.atMs>=w.atMs).length,0,'handoff.no-later-dependent-transfer'); }
      }
      break;
    case 'IC16': extra=temporalCase(c,o,variant,locations); break;
    case 'IC18':
      if(variant==='siblings') {
        c.eq([o.before.receipts.length,o.after.receipts.length,o.after.jobs.length],[1,1,1],'siblings.real-success-preserved');unchanged(c,o);
        const pending=o.after.receptions.find(x=>x.id===o.input.subject.receptionId);
        c.ok(pending,'siblings.pending-operation-present');
        c.ok(o.after.receptions.length>=2&&!o.after.receipts.some(x=>x.receptionId===pending.id),'siblings.no-false-second-receipt');
        const r=response(c,o);
        c.eq({positive:success(response(c,o,'positive')),secondSuccess:success(r)},{positive:true,secondSuccess:false},'siblings.separate-visible-outcomes');
        if(r.status===null)barrier(c,o,'between_chunks');
      } else extendedCase(c,o,locations,{response,barrier,control,unchanged,oneReceipt,successfulReceipt,exactBody,denied});
      break;
    default: c.ok(false,'coverage.missing-handler');
  }
  selectedCompletedDeliveries(c,o);
  return {caseId,variant,assertions:c.count,...extra};
}
