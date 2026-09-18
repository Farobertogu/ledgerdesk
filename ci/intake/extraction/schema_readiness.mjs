import {setTimeout as pause} from 'node:timers/promises';

export const schemaDatabase = 'inc02_synthetic';
export const schemaPassword = 'isolated-synthetic-schema-only';
export const readinessQuery = 'SELECT current_database(), current_setting(\'server_version_num\');';

export const schemaSql = (command, id, database = schemaDatabase) => input => command([
  'exec', '-i', '-e', 'PGPASSWORD=' + schemaPassword, id, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-h', '127.0.0.1', '-U', 'postgres', '-d', database,
], {input});

/** Read-only target-database probe; never retry a migration or an effect. */
export async function waitForSchemaDatabase(sql, delay = pause) {
  for (let attempt = 0; attempt < 40; attempt++) {
    let observed;
    try {observed = await sql(readinessQuery);}
    catch {await delay(100); continue;}
    if (!/^inc02_synthetic\|16[0-9]{4}$/.test(observed)) throw Error('EXTRACTION_SCHEMA_DATABASE_IDENTITY');
    return observed.split('|')[1];
  }
  throw Error('EXTRACTION_SCHEMA_DATABASE_NOT_READY');
}
