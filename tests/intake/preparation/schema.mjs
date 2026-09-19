import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {authorizedReadingMigration} from '../../../ci/access_material_schema.mjs';

/** Schema-only fixtures are not received originals, admitted preparations or constituted candidates. */
export async function preparationSchemaCases({sql, sourceRoot}) {
  const source = relative => fs.readFile(path.join(sourceRoot, relative), 'utf8');
  await sql(await source('src/server/access/postgres/001_identity.sql'));
  await sql(await source('src/server/access/postgres/002_invitations.sql'));
  await sql(authorizedReadingMigration());
  for (const file of ['001_reception.sql', '002_data.sql', '003_private_fence.sql', '004_extraction_control.sql',
    '005_extraction_data.sql', '006_extraction_fence.sql', '007_extraction_capacity.sql'])
    await sql(await source('src/server/intake/postgres/' + file));
  await sql(`INSERT INTO intake_trial.reception VALUES('00000000-0000-4000-8000-000000000001','inc02-synthetic',
    '00000000-0000-4000-8000-000000000002','schema-person','schema-session',1,1,'reserved',
    '{}','text-utf8/1','{}','{}','{}','00000000-0000-4000-8000-000000000003',false,1);
    INSERT INTO intake_trial.intention VALUES('00000000-0000-4000-8000-000000000004','inc02-synthetic',
    '00000000-0000-4000-8000-000000000002','CARGAR_MATERIAL','reserve_reception','old-client-key','canon_m09_1',1,
    repeat('a',64),'00000000-0000-4000-8000-000000000001',NULL,1);`);
  const before = await sql(`SELECT jsonb_build_object('reception',(SELECT jsonb_agg(to_jsonb(r)) FROM intake_trial.reception r),
    'intention',(SELECT jsonb_agg(to_jsonb(i)) FROM intake_trial.intention i))::text;`);
  const ddl = await source('src/server/intake/postgres/008_preparation_data.sql');
  await sql(ddl);
  await sql(await source('src/server/intake/postgres/009_preparation_control.sql'));
  assert.equal(await sql('SELECT count(*) FROM intake_control.preparation_comparison;'), '0');
  assert.equal(await sql(`SELECT jsonb_build_object('reception',(SELECT jsonb_agg(to_jsonb(r)) FROM intake_trial.reception r),
    'intention',(SELECT jsonb_agg(to_jsonb(i)) FROM intake_trial.intention i))::text;`), before);
  const privileges = JSON.parse(await sql(`SELECT jsonb_build_object(
    'runtime_preparation_insert',has_table_privilege('inc03_intake_runtime','intake_trial.preparation','INSERT'),
    'runtime_preparation_update',has_table_privilege('inc03_intake_runtime','intake_trial.preparation','UPDATE,DELETE'),
    'runtime_stage_update',has_table_privilege('inc03_intake_runtime','intake_trial.preparation_stage','UPDATE,DELETE'),
    'runtime_resource_read_insert',has_table_privilege('inc03_intake_runtime','intake_trial.preparation_resource_read','INSERT'),
    'runtime_resource_read_update',has_table_privilege('inc03_intake_runtime','intake_trial.preparation_resource_read','UPDATE,DELETE'),
    'runtime_attempt_update',has_table_privilege('inc03_intake_runtime','intake_trial.preparation_attempt','UPDATE'),
    'runtime_capacity_write',has_table_privilege('inc03_intake_runtime','intake_trial.preparation_capacity','INSERT,UPDATE,DELETE'),
    'runtime_transition',has_function_privilege('inc03_intake_runtime','intake_trial.advance_preparation_attempt(uuid,text,text)','EXECUTE'),
    'reader_transition',has_function_privilege('inc03_intake_reader','intake_trial.advance_preparation_attempt(uuid,text,text)','EXECUTE'),
    'reader_preparation_write',has_table_privilege('inc03_intake_reader','intake_trial.preparation','INSERT,UPDATE,DELETE'),
    'runtime_authority_write',has_table_privilege('inc03_intake_runtime','intake_control.catalog_entry','INSERT,UPDATE,DELETE'),
    'runtime_comparison_write',has_table_privilege('inc03_intake_runtime','intake_control.preparation_comparison','INSERT,UPDATE,DELETE'),
    'control_comparison_write',has_table_privilege('inc03_intake_control','intake_control.preparation_comparison','INSERT,UPDATE,DELETE'))::text;`));
  assert.deepEqual(privileges, {runtime_preparation_insert: true, runtime_preparation_update: false,
    runtime_stage_update: false, runtime_resource_read_insert: true, runtime_resource_read_update: false,
    runtime_attempt_update: false, runtime_capacity_write: false, runtime_transition: true,
    reader_transition: false, reader_preparation_write: false, runtime_authority_write: false, runtime_comparison_write: false, control_comparison_write: false});
  const foreignKeys = JSON.parse(await sql(`SELECT jsonb_agg(confrelid::regclass::text ORDER BY confrelid::regclass::text)::text
    FROM pg_constraint WHERE conrelid='intake_trial.editorial_intention'::regclass AND contype='f';`));
  assert.deepEqual(foreignKeys, ['intake_trial.editorial_effect']);
  assert.equal(await sql("SELECT is_nullable FROM information_schema.columns WHERE table_schema='intake_trial' AND table_name='intention' AND column_name='reception_id';"), 'NO');
  assert.equal(await sql('SELECT charged_bytes FROM intake_trial.preparation_capacity;'), '0');
  assert.equal(await sql('SELECT count(*) FROM intake_trial.candidate;'), '0');
  for (const file of ['002_data.sql', '005_extraction_data.sql', '007_extraction_capacity.sql'])
    await sql((await source('src/server/intake/postgres/' + file)).replaceAll('intake_trial', 'intake_restore'));
  const liveBefore = await sql('SELECT to_jsonb(f)::text FROM intake_control.fence_head f;');
  await sql(ddl.replaceAll('intake_trial', 'intake_restore'));
  assert.equal(await sql('SELECT to_jsonb(f)::text FROM intake_control.fence_head f;'), liveBefore);
  assert.equal(await sql("SELECT count(*) FROM intake_control.namespace_admission WHERE namespace='intake_restore';"), '0');
  assert.equal(await sql('SELECT count(*) FROM intake_restore.preparation;'), '0');
  return {cases: ['populated predecessors unchanged', 'effective append-only and reader privileges',
    'editorial intentions have no fabricated receipt dependency', 'empty bounded capacity and no candidates',
    'data-only restore remains unauthorized'], privileges,
    limitation: 'DDL and effective privileges only. No runtime source admission, candidate journey or restored data recovery is credited.'};
}
