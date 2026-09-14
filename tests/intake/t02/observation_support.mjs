import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const responseHeaders=new Set(['content-type','content-length','cache-control','pragma','expires','vary',
  'access-control-allow-origin','access-control-allow-credentials','access-control-allow-methods',
  'access-control-allow-headers','access-control-max-age','content-disposition','location','etag',
  'last-modified','transfer-encoding','content-encoding','x-content-type-options','content-security-policy']);
export const save=(file,value)=>writeFileSync(file,Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});

export async function snapshot(admin){
  await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    const raw={};
    for(const table of ['reception','intention','attempt','receipt','work'])raw[table]=(await admin.query('SELECT * FROM intake_trial.'+table+' ORDER BY 1,2')).rows;
    const bindings=(await admin.query('SELECT id,person_ref,revision FROM access_trial.account ORDER BY id')).rows;
    const later=(await admin.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='intake_trial' AND c.relkind IN ('r','p') AND c.relname IN ('extraction','candidate','publication')")).rows;
    assert.deepEqual(later,[], 'This reception namespace must not silently acquire later-stage effect tables');
    const observation=(await admin.query('SELECT pg_backend_pid() AS pid,txid_current_snapshot()::text AS snapshot,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0];
    await admin.query('COMMIT');
    const atMs=Number(observation.now);
    return {raw,observer:observation,packet:{origin:'sql-observer',atMs,database:'inc02_synthetic',schema:'intake_trial',
      receptions:raw.reception.map(r=>({id:r.id,principal:r.principal,personId:r.person_ref,originSessionId:r.origin_session,
        generation:r.generation,revision:r.revision,state:r.state,stopped:r.stopped})),
      intentions:raw.intention.map(i=>({id:i.id,receptionId:i.reception_id,deployment:i.deployment,principal:i.principal,
        act:i.act,variant:i.variant,clientKey:i.client_key,canonicalProfile:i.canonical_profile,keyVersion:i.key_version,
        storedPayloadDigest:i.payload_digest,effectId:i.effect_id,createdAtMs:Number(i.created_at)})),
      attempts:raw.attempt.map(a=>({receptionId:a.reception_id,generation:a.generation,artifactId:a.artifact_id,
        incarnation:a.incarnation,state:a.state,reservedBytes:a.reserved_bytes,actualBytes:a.actual_bytes,
        actualSha256:a.actual_sha256,expiresAtMs:Number(a.expires_at)})),
      receipts:raw.receipt.map(r=>({id:r.id,operationId:r.operation_id,receptionId:r.reception_id,
        principal:raw.reception.find(x=>x.id===r.reception_id).principal,artifactId:r.artifact_id,generation:r.generation,
        bytes:r.bytes,sha256:r.sha256,effectId:r.effect_id,personId:r.person_ref,executorRef:r.executor_ref})),
      jobs:raw.work.map(w=>({id:w.id,receiptId:w.receipt_id,originalId:w.original_id,generation:w.generation,state:w.state,dispatchable:w.dispatchable})),
      principalBindings:bindings.map(b=>({origin:'independent-sql-observer',accountId:b.id,personId:b.person_ref,accountRevision:b.revision,atMs})),
      counts:{receptions:raw.reception.length,receipts:raw.receipt.length,jobs:raw.work.length,extractions:0,candidates:0,publications:0}}};
  }catch(error){await admin.query('ROLLBACK');throw error;}
}

