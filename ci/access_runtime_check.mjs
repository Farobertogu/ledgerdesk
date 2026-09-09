import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const owner = `access-t02-${randomUUID()}`,
  image = 'ledgerdesk-access-runtime:2';
const mutation = process.argv[2] ?? '';
let transcript = '';
if (
  ![
    '',
    '--mutation=drop-decoy',
    '--mutation=drop-csrf',
    '--mutation=drop-origin',
    '--mutation=drop-intent',
    '--mutation=drop-proof-consumption',
    '--mutation=drop-login-peer',
    '--mutation=drop-login-account-limit',
    '--mutation=drop-session-cookie',
    '--mutation=early-failure',
  ].includes(mutation)
)
  throw new Error('Unknown mutation');
function docker(args, timeout = 15000) {
  return spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout });
}
function clean() {
  const found = docker([
    'inspect',
    '--format',
    '{{index .Config.Labels "ledgerdesk.test-owner"}}',
    owner,
  ]);
  if (found.status === 0) {
    if (found.stdout.trim() !== owner)
      throw new Error('Container ownership mismatch');
    const removed = docker(['rm', '--force', owner], 30000);
    if (removed.status !== 0) throw new Error('Owned container cleanup failed');
  } else if (!/No such (?:object|container)/i.test(found.stderr ?? ''))
    throw new Error('Container cleanup not verified');
}
async function command(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        transcript += chunk.toString();
        process.stdout.write(chunk);
      });
    const timer = setTimeout(() => {
      try {
        clean();
      } finally {
        child.kill();
        reject(new Error('Bounded Docker operation timed out'));
      }
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Docker exit ${code}`));
    });
  });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    try {
      clean();
    } finally {
      process.exit(1);
    }
  });
try {
  await command(
    ['build', '-f', 'ci/access/Runtime.Dockerfile', '-t', image, '.'],
    900000,
  );
  await command(
    [
      'run',
      '--init',
      '--name',
      owner,
      '--label',
      `ledgerdesk.test-owner=${owner}`,
      '--network',
      'none',
      '--shm-size',
      '1g',
      '--cap-drop',
      'ALL',
      ...(mutation
        ? ['--env', `ACCESS_RUNTIME_MUTATION=${mutation.slice(11)}`]
        : []),
      image,
    ],
    300000,
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  const info = docker([
    'inspect',
    '--format',
    '{{index .Config.Labels "ledgerdesk.test-owner"}}',
    owner,
  ]);
  if (info.status === 0 && info.stdout.trim() === owner) {
    const target = fileURLToPath(
      new URL(
        `../test-results/access-runtime/${mutation ? mutation.slice(11) : 'baseline'}/`,
        import.meta.url,
      ),
    );
    mkdirSync(target, { recursive: true });
    writeFileSync(
      new URL(
        `../test-results/access-runtime/${mutation ? mutation.slice(11) : 'baseline'}/run.log`,
        import.meta.url,
      ),
      transcript,
    );
    const copy = docker(['cp', `${owner}:/work/output/.`, target], 15000);
    if (copy.status !== 0) {
      console.error('Evidence copy failed');
      process.exitCode = 1;
    }
  }
  clean();
  console.log(`ACCESS_RUNTIME_CLEANED ${owner}`);
}
