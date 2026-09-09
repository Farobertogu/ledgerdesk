import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withDeadline } from './lifecycle.mjs';

/** Own one exact-port production child. Never reuse an unrelated running Next server. */
export async function startNextTrial({ reservation, env, verifyBuild, trap }) {
  try { await verifyBuild('before owned Next launch'); }
  catch (error) { await reservation.release(); throw error; }
  const url = `http://127.0.0.1:${reservation.port}`;
  await reservation.release();
  const child = spawn(process.execPath, ['ci/reading_start.mjs', String(reservation.port)], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', LEDGERDESK_DEV_IDENTITY: '0',
      LEDGERDESK_READING_TRIAL: '0', LEDGERDESK_READING_ENVIRONMENT: '', LEDGERDESK_READING_SUBJECT: '',
      LEDGERDESK_READING_GENERATION: '', LEDGERDESK_READING_SERVICE_ORIGIN: '',
      DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:${trap.port}/never_connect`, ...env },
  });
  let output = '', ended = false;
  const exited = new Promise((resolve, reject) => {
    child.once('exit', () => { ended = true; resolve(); });
    child.once('error', error => { ended = true; reject(error); });
  });
  exited.catch(() => undefined);
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  async function close() {
    if (!ended) child.kill();
    await withDeadline(() => exited, 'owned Next process exit', 10000);
  }
  try {
    await withDeadline(async () => {
      while (!/Ready in/.test(output)) {
        if (ended || /EADDRINUSE/.test(output)) throw new Error(`Owned Next startup failed: ${output.slice(-1800)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }, 'owned Next readiness', 30000);
    assert.equal(ended, false); await verifyBuild('owned Next ready');
    return { url, pid: child.pid, close, assertAlive: () => assert.equal(ended, false, 'Owned Next exited') };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Next setup and cleanup failed'); }
    throw error;
  }
}
