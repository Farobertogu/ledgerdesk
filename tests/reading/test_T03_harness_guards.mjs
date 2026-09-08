import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { readTrialConfig } from '../../src/server/reading/config.mjs';
import { assertNoTrialData, captureBuildIdentity, reserveLoopbackPort, startDatabaseTrap } from './harness_guards.mjs';

const config = readTrialConfig({ LEDGERDESK_READING_TRIAL: '1', LEDGERDESK_READING_ENVIRONMENT: 'local-synthetic',
  LEDGERDESK_READING_SUBJECT: 'synthetic-http-harness-33bf5297fca145e0',
  LEDGERDESK_READING_GENERATION: 'http-harness-generation-33bf5297fca145e0' });
test('HTML guard accepts an empty shell and requires actual configuration', () => {
  assert.doesNotThrow(() => assertNoTrialData('<main>Material library</main>', config));
  assert.throws(() => assertNoTrialData('<main/>', null), /requires an enabled/);
});
for (const [label, value] of Object.entries({ subject: config.subjectId, generation: config.generation,
  deployment: config.deploymentId, scope: config.scopeId, body: 'original_text' })) {
  test(`HTML guard detects injected ${label}`, () => {
    assert.throws(() => assertNoTrialData(`<script>${JSON.stringify({ value })}</script>`, config), /forbidden trial field/);
  });
}
async function temporaryBuild(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reading-build-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'BUILD_ID');
  await writeFile(path, 'synthetic-build-a');
  return path;
}
test('build guard accepts stable identity and rejects replacement', async t => {
  const path = await temporaryBuild(t); const verify = await captureBuildIdentity(path);
  await verify('before launch'); await writeFile(path, 'synthetic-build-b');
  await assert.rejects(verify('after request'), /Build identity changed/);
});
test('build guard rejects a missing identity', async t => {
  const path = await temporaryBuild(t); const verify = await captureBuildIdentity(path);
  await unlink(path); await assert.rejects(verify('after launch'), { code: 'ENOENT' });
});
test('build guard detects rewriting the same identity file', async t => {
  const path = await temporaryBuild(t); const verify = await captureBuildIdentity(path);
  await utimes(path, new Date('2020-01-01'), new Date('2020-01-01'));
  await assert.rejects(verify('after run'), /Build identity changed/);
});
test('port reservation refuses a listening process and releases its own listener', async () => {
  const reservation = await reserveLoopbackPort();
  try { await assert.rejects(reserveLoopbackPort(reservation.port), { code: 'EADDRINUSE' }); }
  finally { await reservation.release(); }
  const available = await reserveLoopbackPort(reservation.port); await available.release();
});
test('trap records a deliberate hit with source port, timestamp and stage and fails its assertion', async () => {
  let report;
  const observed = new Promise(resolve => { report = resolve; });
  const trap = await startDatabaseTrap(() => 'intentional sentinel self-test', report);
  try {
    trap.assertUntouched();
    const socket = createConnection({ host: '127.0.0.1', port: trap.port });
    // Subscribe before connecting: the trap closes accepted connections immediately.
    const closed = new Promise((resolve, reject) => { socket.once('close', resolve); socket.once('error', reject); });
    const hit = await observed; await closed;
    assert.ok(Number.isInteger(hit.remotePort)); assert.equal(hit.remoteAddress, '127.0.0.1');
    assert.ok(Number.isFinite(Date.parse(hit.timestamp))); assert.equal(hit.stage, 'intentional sentinel self-test');
    assert.equal(trap.count(), 1); assert.throws(() => trap.assertUntouched(), /Legacy database trap received connections/);
  } finally { await trap.close(); }
});
