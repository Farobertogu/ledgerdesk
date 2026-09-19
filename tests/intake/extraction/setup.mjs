import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {grantOriginalCopy} from '../../../ci/intake/extraction/granted_original.mjs';
import {schemaSql, readinessQuery, waitForSchemaDatabase} from '../../../ci/intake/extraction/schema_readiness.mjs';

test('the verified copy alone becomes read-only under an owner-only host directory', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-copy-'));
  t.after(async () => {await fs.chmod(path.join(directory, 'original'), 0o600).catch(() => {}); await fs.rm(directory, {recursive: true});});
  await fs.chmod(directory, 0o700);
  const bytes = Buffer.from('Selected synthetic original.\n');
  const expected = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  await fs.writeFile(path.join(directory, 'original'), bytes, {flag: 'wx', mode: 0o600});
  await fs.writeFile(path.join(directory, 'ungranted'), 'Unrelated synthetic bytes.', {flag: 'wx', mode: 0o600});
  const before = await fs.stat(path.join(directory, 'ungranted'));
  await assert.rejects(grantOriginalCopy(directory, {...expected, sha256: '0'.repeat(64)}), /EXTRACTION_BRIDGE_ORIGINAL/);
  const selected = await grantOriginalCopy(directory, expected);
  assert.deepEqual(await fs.readFile(selected), bytes);
  assert.deepEqual(await fs.stat(path.join(directory, 'ungranted')), before);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(selected)).mode & 0o777, 0o444);
    await fs.chmod(directory, 0o755);
    await assert.rejects(grantOriginalCopy(directory, expected), /EXTRACTION_COPY_OWNER/);
  }
});

test('schema readiness queries the actual database on the same final TCP endpoint as migrations', async () => {
  const calls = [];
  const sql = schemaSql(async (args, options) => {calls.push({args, options}); return 'inc02_synthetic|160015';}, 'owned-container');
  assert.equal(await waitForSchemaDatabase(sql), '160015');
  await sql('SELECT 1;');
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.ok(calls[0].args.includes('psql'));
  assert.ok(calls[0].args.includes('127.0.0.1'));
  assert.equal(calls[0].args.at(-1), 'inc02_synthetic');
  assert.equal(calls[0].options.input, readinessQuery);
});

test('an unprepared database cannot pass readiness; the existing finite probe budget is preserved', async () => {
  const queries = [], delays = [];
  await assert.rejects(waitForSchemaDatabase(async query => {
    queries.push(query); throw Error('database does not exist');
  }, async delay => delays.push(delay)), /EXTRACTION_SCHEMA_DATABASE_NOT_READY/);
  assert.deepEqual(queries, Array(40).fill(readinessQuery));
  assert.deepEqual(delays, Array(40).fill(100));
  let calls = 0;
  assert.equal(await waitForSchemaDatabase(async () => {
    if (++calls === 1) throw Error('connection refused');
    return 'inc02_synthetic|160015';
  }, async () => {}), '160015');
  assert.equal(calls, 2);
  await assert.rejects(waitForSchemaDatabase(async () => 'postgres|160015'), /EXTRACTION_SCHEMA_DATABASE_IDENTITY/);
  await assert.rejects(waitForSchemaDatabase(async () => '0'), /EXTRACTION_SCHEMA_DATABASE_IDENTITY/);
});
