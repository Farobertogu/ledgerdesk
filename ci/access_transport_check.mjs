import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--mutation=drop-origin')) {
  throw new Error('Usage: node ci/access_transport_check.mjs [--mutation=drop-origin]');
}
const mutationArgs = args.length ? ['--env', 'LEDGERDESK_ACCESS_MUTATION=drop-origin'] : [];

const root = fileURLToPath(new URL('../', import.meta.url));
const owner = `access-t01-${randomUUID()}`;
const image = 'ledgerdesk-access-transport:1';
let stopping = false;
function clean() {
  if (stopping) return;
  stopping = true;
  const result = spawnSync('docker', ['inspect', '--format', '{{index .Config.Labels "ledgerdesk.test-owner"}}', owner], { encoding: 'utf8', timeout: 10000 });
  if (result.status === 0 && result.stdout.trim() === owner) {
    const removed = spawnSync('docker', ['rm', '--force', owner], { stdio: 'inherit', timeout: 20000 });
    if (removed.status !== 0) process.exitCode = 1;
  } else if (result.error || (result.status !== 0 && !/No such (?:object|container)/i.test(result.stderr ?? ''))) {
    console.error('Container cleanup could not be verified'); process.exitCode = 1;
  } else if (result.status === 0) {
    console.error('Container ownership mismatch; no removal attempted'); process.exitCode = 1;
  }
}
async function command(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, stdio: 'inherit' });
    const timer = setTimeout(() => { clean(); child.kill(); reject(new Error(`Docker operation exceeded ${timeoutMs} ms`)); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Docker operation failed: ${code ?? signal}`)); });
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clean(); process.exit(1); });
try {
  await command(['build', '--file', 'ci/access/Dockerfile', '--tag', image, '.'], 900000);
  await command(['run', '--rm', '--init', '--name', owner, '--label', `ledgerdesk.test-owner=${owner}`,
    '--network', 'none', '--shm-size', '1g', '--cap-drop', 'ALL', ...mutationArgs, image], 180000);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { clean(); }
