import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PREPARATION_DOCUMENT} from '../../../src/contracts/intake_preparation.ts';
import {preparationContext} from './runtime_control.mjs';

export const preparationProfile={profile:'intake/1',representation:'intake-preparation/1'};
export const preparationHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const preparationAxis=value=>({value,reason:null});

/** Real public reservation/staging/finalization, not seeded prepared output. */
export async function persistDocument({call,check,document,inputs,selection,base=null,expectedStatus=200,context=preparationContext}){
  assert.equal(PREPARATION_DOCUMENT(document),true,'The staged operation must satisfy its declared public representation.');
  const bytes=Buffer.from(JSON.stringify(document));
  const reservation={...preparationProfile,inputs,base,selection,
    document:{bytes:bytes.length,sha256:preparationHash(bytes)},context};
  const reserved=await call('/preparation-attempts',{body:reservation,key:randomUUID()});check(reserved,202);
  const attempt=reserved.body.result;
  const staged=await call(`/preparation-attempts/${attempt.attempt_id}/content`,{bytes});check(staged,200);
  const finalized=await call(`/preparation-attempts/${attempt.attempt_id}/finalize`,{key:randomUUID(),body:{...preparationProfile,
    expected_revision:attempt.preparation.revision,document:staged.body.result.document,differences:[]}});check(finalized,expectedStatus);
  if(expectedStatus!==200)return {attempt,rejection:finalized};
  const reference=finalized.body.result.preparation;
  const queried=await call(`/preparations/${reference.id}/revisions/${reference.revision}`);check(queried,200);
  return {reference,record:queried.body.preparation,attempt,documentBytes:bytes.length};
}

export async function constituteDocument({call,check,prepared,unit}){
  const r=prepared.reference;
  const proposed=await call(`/preparations/${r.id}/revisions/${r.revision}/proposals`,{key:randomUUID(),body:{...preparationProfile,unit,
    target:{kind:'new',declaration:'A distinct item in this controlled synthetic operation.'},
    judgment:{kind:'distinct',reason:'Explicit independent preparation judgment; no automatic identity equivalence or approval.'}}});check(proposed,200);
  const constituted=await call('/constitutions',{key:randomUUID(),body:{...preparationProfile,proposal:proposed.body.result.proposal,mode:'person'}});check(constituted,200);
  return {proposal:proposed.body,constitution:constituted.body};
}
