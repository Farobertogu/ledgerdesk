import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {authorizedReadingMigration} from '../../../ci/access_material_schema.mjs';

/** DDL/privilege experiment. Seeded rows here are not a received-original journey. */
export async function schemaCases({sql, observe}) {
  const cases = [];
  const check = async (name, work) => {await work(); cases.push(name); await observe({case: name, outcome: 'passed'});};
  const source = async name => readFile(new URL('../../../src/server/' + name, import.meta.url), 'utf8');
  await sql(await source('access/postgres/001_identity.sql'));
  await sql(await source('access/postgres/002_invitations.sql'));
  await sql(authorizedReadingMigration());
  for (const file of ['001_reception.sql', '002_data.sql', '003_private_fence.sql']) await sql(await source('intake/postgres/' + file));
  await sql(`INSERT INTO intake_control.live VALUES(true,'schema-control',false,1,1,'schema-incarnation','{}','{}','{}',4102444800000);
    INSERT INTO intake_control.namespace_admission VALUES('intake_trial','schema-control',1,NULL,false);
    INSERT INTO intake_trial.reception VALUES('00000000-0000-4000-8000-000000000001','inc02-synthetic',
      '00000000-0000-4000-8000-000000000002','synthetic-schema-principal','synthetic-schema-session',1,1,'reserved',
      '{"bytes":3,"sha256":"original-literal"}','text-utf8/1','{}','{}','{}','00000000-0000-4000-8000-000000000003',false,1);
    INSERT INTO intake_trial.intention VALUES('00000000-0000-4000-8000-000000000004','inc02-synthetic',
      '00000000-0000-4000-8000-000000000002','CARGAR_MATERIAL','reserve_reception','preserved-key','canon_m09_1',1,
      repeat('a',64),'00000000-0000-4000-8000-000000000001',NULL,1);`);
  const before = await sql(`SELECT jsonb_build_object('reception',(SELECT jsonb_agg(to_jsonb(r)) FROM intake_trial.reception r),
    'intention',(SELECT jsonb_agg(to_jsonb(i)) FROM intake_trial.intention i))::text;`);
  await check('populated upgrade preserves receipt predecessors and existing canonical intentions', async () => {
    await sql(await source('intake/postgres/004_extraction_control.sql'));
    await sql(await source('intake/postgres/005_extraction_data.sql'));
    await sql(await source('intake/postgres/006_extraction_fence.sql'));
    await sql(await source('intake/postgres/007_extraction_capacity.sql'));
    assert.equal(await sql(`SELECT jsonb_build_object('reception',(SELECT jsonb_agg(to_jsonb(r)) FROM intake_trial.reception r),
      'intention',(SELECT jsonb_agg(to_jsonb(i)) FROM intake_trial.intention i))::text;`), before);
    assert.equal(await sql('SELECT count(*) FROM intake_trial.extraction_job;'), '0');
    assert.equal(await sql('SELECT count(*) FROM intake_control.processing_current;'), '0');
  });
  await check('runtime and reader cannot manufacture processing authority or update jobs directly', async () => {
    const observed = await sql(`SELECT jsonb_build_object(
      'runtime_reads',has_table_privilege('inc03_intake_runtime','intake_control.processing_declaration','SELECT'),
      'runtime_authority_write',has_table_privilege('inc03_intake_runtime','intake_control.processing_declaration','INSERT,UPDATE,DELETE'),
      'runtime_current_write',has_table_privilege('inc03_intake_runtime','intake_control.processing_current','INSERT,UPDATE,DELETE'),
      'runtime_job_update',has_table_privilege('inc03_intake_runtime','intake_trial.extraction_job','UPDATE'),
      'runtime_capacity_write',has_table_privilege('inc03_intake_runtime','intake_trial.extraction_capacity','INSERT,UPDATE,DELETE'),
      'reader_reservation_write',has_table_privilege('inc03_intake_reader','intake_trial.extraction_reservation','INSERT,UPDATE,DELETE'),
      'reader_claim',has_function_privilege('inc03_intake_reader','intake_trial.claim_extraction(uuid,integer,uuid,uuid,uuid,jsonb,uuid,bigint)','EXECUTE'),
      'reader_accept',has_function_privilege('inc03_intake_reader','intake_trial.accept_extraction(uuid,integer,uuid)','EXECUTE'),
      'reader_result_insert',has_table_privilege('inc03_intake_reader','intake_trial.extraction_result','INSERT'),
      'runtime_claim',has_function_privilege('inc03_intake_runtime','intake_trial.claim_extraction(uuid,integer,uuid,uuid,uuid,jsonb,uuid,bigint)','EXECUTE'),
      'public_claim',EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid='intake_trial.claim_extraction(uuid,integer,uuid,uuid,uuid,jsonb,uuid,bigint)'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE'))::text;`);
    assert.deepEqual(JSON.parse(observed), {runtime_reads: true, runtime_authority_write: false, runtime_current_write: false,
      runtime_job_update: false, runtime_capacity_write: false, reader_reservation_write: false,
      reader_claim: false, reader_accept: false, reader_result_insert: false, runtime_claim: true, public_claim: false});
  });
  await check('data-only restore installation does not replace current authority or the live fence', async () => {
    const control = await sql('SELECT to_jsonb(f)::text FROM intake_control.fence_head f;');
    await sql((await source('intake/postgres/002_data.sql')).replaceAll('intake_trial', 'intake_restore'));
    await sql((await source('intake/postgres/005_extraction_data.sql')).replaceAll('intake_trial', 'intake_restore'));
    await sql((await source('intake/postgres/007_extraction_capacity.sql')).replaceAll('intake_trial', 'intake_restore'));
    assert.equal(await sql('SELECT to_jsonb(f)::text FROM intake_control.fence_head f;'), control);
    assert.equal(await sql("SELECT count(*) FROM intake_control.namespace_admission WHERE namespace='intake_restore';"), '0');
    assert.equal(await sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='intake_restore' AND table_name LIKE 'processing%';"), '0');
  });
  return {cases, limitation: 'Migration and effective privilege checks only; no runtime authority or end-to-end receipt is claimed.'};
}
