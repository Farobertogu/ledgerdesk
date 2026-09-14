import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {IntakeAuthority} from '../../../src/server/intake/authority.ts';
import {selected} from '../../../src/server/intake/reception.ts';
import {sessionToken} from '../../../src/server/access/transport.ts';

export const tables=['reception','intention','attempt','artifact','evidence','receipt','work','availability','transport'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function administration(action,body) {
  const id=randomUUID(),file='/work/output/admin-response-'+id+'.json';
  writeFileSync('/work/output/admin-request.json',JSON.stringify({id,action,body}));
  const deadline=Date.now()+20000;
  while(!existsSync(file)){if(Date.now()>deadline)throw Error('ADMIN_BRIDGE_TIMEOUT');await delay(50);}
  return {id,...JSON.parse(readFileSync(file,'utf8'))};
}
export async function dataSnapshot(admin,namespace) {
  assert.ok(['intake_trial','intake_restore'].includes(namespace));
  const result={};for(const name of tables)result[name]=(await admin.query(`SELECT * FROM ${namespace}.${name} ORDER BY 1,2`)).rows;
  return result;
}
async function preserved(admin){
  const queries={access_trial:'SELECT id,account_id,revoked,revision FROM access_trial.session ORDER BY id',
    intake_control:'SELECT * FROM intake_control.backup_anchor ORDER BY id'};
  const result={};
  // Session uses digest as its primary key; names/credentials are excluded from this observation.
  queries.access_trial='SELECT digest,account_id,revoked,revision FROM access_trial.session ORDER BY digest';
  for(const [namespace,query] of Object.entries(queries)){
    const rows=(await admin.query(query)).rows,bytes=Buffer.from(JSON.stringify(rows));
    result[namespace]={bytes:bytes.length,sha256:digest(bytes),rowCount:rows.length};
  }
  return result;
}
export async function recoveryCases(t,{env,intake,client,master,received,original,request,post,flow,messages,digestSession,restart}) {
  const observations=[],authorizer=new IntakeAuthority(intake,digestSession);
  const req={route:'original',parameters:{id:received.reception_id},method:'GET',contentLength:0,clientKey:null,csrf:null};
  let backup,cut,cutAtMs,anchor;
  await t.test('backup freezes exact data and objects while current authority stays outside its set',async()=>{
    await env.admin.query('SELECT pg_advisory_lock(20202,1)');
    try{
      await env.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      cutAtMs=Number((await env.admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).rows[0].n);
      const snapshot=(await env.admin.query('SELECT txid_current_snapshot()::text AS snapshot')).rows[0].snapshot;
      cut=await dataSnapshot(env.admin,'intake_trial');
      writeFileSync('/work/output/backup-data.json',JSON.stringify(cut));
      backup=await administration('backup',{objects:cut.artifact.map(o=>({id:o.id,generation:o.generation,bytes:o.bytes,sha256:o.sha256}))});
      assert.equal(backup.ok,true,JSON.stringify(backup));
      assert.ok(backup.members.some(m=>m.name==='intake-data.json'));
      assert.ok(!backup.members.some(m=>/access_trial|intake_control/.test(m.name)));
      const id=randomUUID();
      await env.admin.query('INSERT INTO intake_control.backup_anchor VALUES($1,$2,$3,$4,$5)',
        [id,'live-control',backup.manifestSha256,JSON.stringify(backup.members),Date.now()]);
      await env.admin.query('COMMIT');
      anchor=(await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1',[id])).rows[0];
      writeFileSync('/work/output/retained-anchor-reference.json',JSON.stringify(anchor),{flag:'wx'});
      observations.push({variant:'backup',cutAtMs,snapshot,receiptIds:cut.receipt.map(r=>r.id),anchor,backup});
    }catch(error){await env.admin.query('ROLLBACK');throw error;}
    finally{await env.admin.query('SELECT pg_advisory_unlock(20202,1)');}
  });
  async function restore(variant){
    const before=await preserved(env.admin),startedAtMs=Date.now();let admission;
    const activationBefore=(await env.admin.query("SELECT * FROM intake_control.namespace_admission WHERE namespace='intake_restore'")).rows;
    try{
      admission=await authorizer.open(req,sessionToken(client.cookie),['intake:restore'],()=>{},'inc03_intake_reader');
      await authorizer.beforeMetadata(admission,'original');
      for(const receipt of cut.receipt){
        const {reception}=await selected(admission.db,receipt.reception_id,admission.session.account_id);
        await authorizer.resolve(admission,'original',undefined,reception);
      }
      await admission.db.commit();
      const retained=(await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1',[anchor.id])).rows[0];
      assert.deepEqual(retained,anchor);
      const imported=await administration('restore',{variant,anchorSha256:retained.manifest_sha256});
      if(!imported.ok)return {status:409,imported,startedAtMs};
      const bytes=readFileSync('/work/output/restore-data.json');
      const member=anchor.members.find(m=>m.name==='intake-data.json');
      assert.deepEqual({bytes:bytes.length,sha256:digest(bytes)}, {bytes:member.bytes,sha256:member.sha256});
      const data=JSON.parse(bytes);assert.deepEqual(Object.keys(data),tables);
      assert.equal((await env.admin.query("SELECT to_regnamespace('intake_restore') AS namespace")).rows[0].namespace,null);
      const schema=readFileSync(new URL('../../../src/server/intake/postgres/002_data.sql',import.meta.url),'utf8');
      await env.admin.query(schema.replaceAll('intake_trial','intake_restore'));
      await env.admin.query('BEGIN');
      try{
        for(const name of tables)await env.admin.query(`INSERT INTO intake_restore.${name} SELECT * FROM jsonb_populate_recordset(NULL::intake_restore.${name},$1::jsonb)`,[JSON.stringify(data[name])]);
        assert.deepEqual(await dataSnapshot(env.admin,'intake_restore'),cut);
        assert.ok(await admission.db.now()<admission.deadline);
        await env.admin.query('SELECT intake_control.activate_namespace($1,$2,$3)',['intake_restore',anchor.id,anchor.manifest_sha256]);
        await env.admin.query('COMMIT');
      }catch(error){await env.admin.query('ROLLBACK');throw error;}
      return {status:200,imported,startedAtMs};
    }catch(error){if([403,404,503].includes(error.status))return{status:error.status,startedAtMs};throw error;}
    finally{
      await admission?.db.close();
      const activationAfter=(await env.admin.query("SELECT * FROM intake_control.namespace_admission WHERE namespace='intake_restore'")).rows;
      const after=await preserved(env.admin);assert.deepEqual(after,before);
      observations.push({variant,startedAtMs,finishedAtMs:Date.now(),activationBefore,activationAfter,preservedBefore:before,preservedAfter:after});
    }
  }
  await t.test('unavailable current control blocks restore with an intact historical archive',async()=>{
    await env.admin.query('SELECT intake_control.set_enabled(false)');
    try{assert.equal((await restore('intact')).status,503);}
    finally{await env.admin.query('SELECT intake_control.set_enabled(true)');}
    assert.deepEqual((await env.admin.query("SELECT * FROM intake_control.namespace_admission WHERE namespace='intake_restore'")).rows,[]);
  });
  await t.test('forged content and recalculated arriving hashes do not replace the retained anchor',async()=>{
    const result=await restore('forged-manifest');assert.equal(result.status,409);
    assert.equal(result.imported.reason,'RETAINED_ANCHOR_MISMATCH');
    assert.deepEqual((await administration('inspect',{})).restored,[]);
  });
  await t.test('a missing archive member leaves the fresh target unadmitted',async()=>{
    const result=await restore('missing-member');assert.equal(result.status,409);
    assert.equal(result.imported.reason,'RETAINED_ANCHOR_MISMATCH');
    assert.deepEqual((await administration('inspect',{})).restored,[]);
  });
  await t.test('a real post-backup withdrawal is not undone by the restore attempt',async()=>{
    const prior=(await env.admin.query("SELECT * FROM access_trial.grant_record WHERE permission_id='intake_original' AND faculty='exercise' AND NOT withdrawn")).rows[0];
    assert.equal((await post(`/grants/${prior.id}/withdraw`,{expected_revision:prior.revision,reason:'Synthetic withdrawal after backup'},master)).status,200);
    const after=(await env.admin.query('SELECT * FROM access_trial.grant_record WHERE id=$1',[prior.id])).rows[0];
    assert.equal(after.withdrawn,true);assert.ok(after.revision>prior.revision);
    const result=await restore('intact');assert.equal(result.status,404);
    observations.push({variant:'post-backup-withdrawal',cutAtMs,grantBefore:prior,grantAfter:after,result});
    assert.equal((await request(`/api/intake/receptions/${received.reception_id}/original`,{client})).status,404);
    assert.deepEqual((await administration('inspect',{})).restored,[]);
  });
  await t.test('fresh authority is produced through another invitation, not restored or seeded',async()=>{
    const offered=await post('/invitations',{email:'reader@example.test',family:'application',expires_at:Date.now()+300000,
      grants:[{permission_id:'intake_original',exercise_or_grant:'exercise',scope_ref:'organisation',support_ref:'domain'}]},master);
    assert.equal(offered.status,200,JSON.stringify(offered.body));
    const receiving=await flow();assert.equal((await post(`/invitations/${offered.body.invitation_id}/challenges`,{},receiving)).status,200);
    const challenge=messages.at(-1),verified=await post(`/invitation-proofs/${challenge.challenge_id}/verify`,{code:challenge.code},receiving);
    assert.equal(verified.status,200);
    const accepted=await post(`/invitations/${offered.body.invitation_id}/accept`,{expected_revision:offered.body.revision,proof_id:verified.body.proof_id},receiving);
    assert.equal(accepted.status,200,JSON.stringify(accepted.body));
    assert.equal((await request(`/api/intake/receptions/${received.reception_id}/original`,{client})).status,200);
  });
  await t.test('legitimate restore preserves prior receipt identities and serves the actual restored bytes',async()=>{
    const result=await restore('intact');assert.equal(result.status,200,JSON.stringify(result));
    await restart({...intake,namespace:'intake_restore'});
    const response=await request(`/api/intake/receptions/${received.reception_id}/original`,{client});
    assert.deepEqual({status:response.status,bytes:response.bytes},{status:200,bytes:original});
    const rows=(await env.admin.query('SELECT id,effect_id,artifact_id,generation FROM intake_restore.receipt ORDER BY id')).rows;
    assert.deepEqual(rows,cut.receipt.map(({id,effect_id,artifact_id,generation})=>({id,effect_id,artifact_id,generation})).sort((a,b)=>a.id.localeCompare(b.id)));
    observations.push({variant:'restore',result,actualBytesSha256:digest(response.bytes),receiptIds:rows.map(r=>r.id)});
  });
  writeFileSync('/work/output/recovery-observations.json',JSON.stringify(observations,null,2));
}
