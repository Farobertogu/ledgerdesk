import { digest, openBeneath, shape, success } from './observation.mjs';
import { fixedReference } from './revision3.mjs';
import { originals } from './references.mjs';

export const id=x=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\u0000-\u001f\u007f]/u.test(x);
export const n=x=>Number.isSafeInteger(x)&&x>=0, pos=x=>n(x)&&x>0;
export const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const bool=x=>typeof x==='boolean', obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export const nullable=f=>x=>x===null||f(x), word=(...xs)=>x=>xs.includes(x);
export const originalFields={id,generation:pos,bytes:n,sha256:sha};
export const exactFields={id,revision:pos,sha256:sha};
export const fileFields={root:word('fixture','evidence'),file:id,bytes:n,sha256:sha};
export function fileBytes(c,locations,f,label,root) {
  shape(c,f,fileFields,label);if(root)c.eq(f.root,root,`${label}.provenance`);
  const bytes=openBeneath(c,locations[f.root==='fixture'?'fixtureRoot':'evidenceRoot'],f.file,1048577,label);
  c.eq([bytes.length,digest(bytes)],[f.bytes,f.sha256],`${label}.actual-bytes`);return bytes;
}
export function fixedBytes(c,locations,name){
  c.ok(Object.hasOwn(originals,name),'bytes.fixed-fixture');const bytes=openBeneath(c,locations.fixtureRoot,name,1048577,'bytes.fixed-original');
  c.eq([bytes.length,digest(bytes)],[originals[name].bytes,originals[name].sha256],'bytes.independent-original');return bytes;
}
export function boundary(c,o,callId) {const rows=o.requestBoundaries.filter(x=>x.callId===callId);c.eq(rows.length,1,'variant.actual-boundary');return rows[0];}
export function reached(c,o,callId,kind) {
  const b=boundary(c,o,callId);c.eq([b.requestClass,b.server.boundary,b.admission.result,b.admission.source],[kind,'application-consumer','accepted','current-sql-admission'],'variant.admitted-actual-consumer');return b;
}
export function transfer(c,o,locations,t) {
  shape(c,t,{origin:word('client-stream-and-owned-object-observers'),callId:id,receptionId:id,artifactId:id,generation:pos,declared:obj,sent:obj,consumed:obj,staged:obj},'transfer');
  shape(c,t.declared,{origin:word('independent-reservation-sql'),observedAtMs:n,original:obj,declarationFile:obj},'transfer.declared');shape(c,t.declared.original,originalFields,'transfer.declared.original');
  shape(c,t.sent,{origin:word('https-client-body'),observedAtMs:n,body:obj,ended:bool},'transfer.sent');
  shape(c,t.consumed,{origin:word('application-stream-boundary'),firstReadAtMs:nullable(n),lastReadAtMs:nullable(n),body:nullable(obj),bytes:n,sha256:sha,completed:bool},'transfer.consumed');
  shape(c,t.staged,{origin:word('owned-physical-object-observer'),observedAtMs:n,present:bool,body:nullable(obj),artifactId:id,generation:pos},'transfer.staged');
  const declaration=fileBytes(c,locations,t.declared.declarationFile,'transfer.declaration','fixture');
  let declared;try{declared=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(declaration));}catch{c.ok(false,'transfer.valid-independent-declaration');}
  c.eq(t.declared.original,declared.original,'transfer.fixed-declaration');
  c.eq([t.artifactId,t.generation,t.staged.artifactId,t.staged.generation],[t.declared.original.id,t.declared.original.generation,t.artifactId,t.generation],'transfer.reserved-target');
  const a=o.after.attempts.find(x=>x.receptionId===t.receptionId&&x.generation===t.generation);c.ok(a,'transfer.actual-reserved-attempt');
  c.eq([a.artifactId,a.reservedBytes],[t.artifactId,t.declared.original.bytes],'transfer.reservation-identity');
  const sent=fileBytes(c,locations,t.sent.body,'transfer.sent-capture','evidence');
  let consumed=Buffer.alloc(0),staged=null;
  if(t.consumed.bytes===0)c.eq([t.consumed.body,t.consumed.firstReadAtMs,t.consumed.lastReadAtMs,t.consumed.sha256],[null,null,null,digest(consumed)],'transfer.empty-consumption');
  else {
    consumed=fileBytes(c,locations,t.consumed.body,'transfer.consumed-capture','evidence');
    c.eq([consumed.length,digest(consumed)],[t.consumed.bytes,t.consumed.sha256],'transfer.independent-consumed-identity');
    c.ok(n(t.consumed.firstReadAtMs)&&n(t.consumed.lastReadAtMs)&&t.consumed.firstReadAtMs<=t.consumed.lastReadAtMs,'transfer.actual-read-times');
    c.ok(t.sent.body.file!==t.consumed.body.file,'transfer.sent-is-not-consumption-capture');
  }
  if(t.staged.present){
    staged=fileBytes(c,locations,t.staged.body,'transfer.staged-capture','evidence');
    c.ok(![t.sent.body.file,t.consumed.body?.file].includes(t.staged.body.file),'transfer.staged-is-separate-observation');
  }else c.eq(t.staged.body,null,'transfer.absent-object-no-capture');
  c.ok(t.declared.observedAtMs<=t.sent.observedAtMs&&t.staged.observedAtMs>=t.sent.observedAtMs,'transfer.observed-order');
  return {sent,consumed,staged};
}
export function digestCase(c,o,locations,h) {
  c.eq(o.input.fixture,'baseline.xlsx','digest.fixed-declaration-fixture');
  const expected=fixedBytes(c,locations,'baseline.xlsx'),wrong=fixedBytes(c,locations,'cache-discrepant.xlsx');
  c.ok(expected.length===wrong.length&&!expected.equals(wrong),'digest.same-length-actual-mismatch');
  c.eq(o.byteTransfers?.length,2,'digest.positive-and-negative-transfers');
  const negative=o.byteTransfers.find(x=>x.callId===o.input.subject.callId),positive=o.byteTransfers.find(x=>x.callId!==o.input.subject.callId);
  c.ok(negative&&positive,'digest.distinct-controls');
  for(const [t,bytes,label]of [[negative,wrong,'negative'],[positive,expected,'positive']]){
    const b=reached(c,o,t.callId,'binary-transfer');c.eq([b.receptionId,t.receptionId],[t.receptionId,t.receptionId],'digest.selected-reception');
    const seen=transfer(c,o,locations,t);
    c.eq([t.declared.original.bytes,t.declared.original.sha256],[expected.length,digest(expected)],'digest.declaration-not-replaced');
    c.eq([seen.sent,seen.consumed,t.sent.ended,t.consumed.completed],[bytes,bytes,true,true],`digest.${label}-actual-consumption`);
    if(seen.staged)c.eq(seen.staged,bytes,`digest.${label}-actual-staged-bytes`);
    if(label==='positive'){
      const receipt=o.after.receipts.find(x=>x.receptionId===t.receptionId),r=h.response(c,o,'positive');
      c.ok(receipt&&o.after.jobs.some(x=>x.receiptId===receipt.id),'digest.matching-positive-finalization');
      c.eq([receipt.artifactId,receipt.generation,receipt.bytes,receipt.sha256],[t.artifactId,t.generation,expected.length,digest(expected)],'digest.positive-exact-receipt');
      c.eq({success:success(r),bytes:openBeneath(c,locations.evidenceRoot,r.bodyFile,1048576,'digest.positive-original')},{success:true,bytes:expected},'digest.positive-served-original');
    }
  }
  const r=h.response(c,o);
  c.eq({rejected:[400,409].includes(r.status),binary:r.bodyFile,receipts:o.after.receipts.filter(x=>x.receptionId===negative.receptionId).length,jobs:o.after.jobs.filter(x=>x.originalId===negative.artifactId).length},{rejected:true,binary:null,receipts:0,jobs:0},'digest.mismatch-outcome-and-no-effect');
  h.unchanged(c,o);
}
