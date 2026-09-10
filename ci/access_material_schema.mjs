import { readFileSync } from 'node:fs';

/** Derive storage, not INC-01's roles, control functions or admission domain. */
export function materialDefinition(source) {
  const start = source.indexOf('CREATE TABLE reading_trial.material (');
  const end = source.indexOf('CREATE TABLE reading_trial.access_evidence (');
  if (start < 0 || end <= start || source.indexOf('CREATE TABLE reading_trial.material (', start + 1) !== -1)
    throw new Error('MATERIAL_SOURCE_BOUNDARY');
  const block = source.slice(start, end);
  if ((block.match(/CREATE TABLE /g) ?? []).length !== 2 || /CREATE (ROLE|FUNCTION)|GRANT |10404/.test(block))
    throw new Error('MATERIAL_SOURCE_CONTENT');
  return block.replaceAll('reading_trial.', 'material_trial.')
    .replaceAll("'inc01-synthetic'", "'inc02-synthetic'")
    .replaceAll("'inc01-material'", "'inc02-material'");
}
export function authorizedReadingMigration() {
  const source = readFileSync(new URL('../src/server/reading/postgres/001_trial.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../src/server/access/postgres/003_authorized_reading.sql', import.meta.url), 'utf8');
  const marker = '-- MATERIAL_DEFINITION_FROM_INC01';
  if (migration.split(marker).length !== 2) throw new Error('MATERIAL_MIGRATION_MARKER');
  return migration.replace(marker, materialDefinition(source));
}
