import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEvidenceDirectory } from './access_evidence.mjs';
import { UI_MUTATIONS } from '../tests/access/ui_mutation.mjs';
import { withSourceComposition } from './access_final_routes.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const invitations = process.argv.includes('--invitations');
const reading = process.argv.includes('--reading');
const administration = process.argv.includes('--administration');
const journey = process.argv.includes('--journey');
if ([reading, invitations, administration, journey].filter(Boolean).length > 1)
  throw new Error('Choose one runtime suite');
const owner = `access-${journey ? 't06' : administration ? 't05' : reading ? 't04' : invitations ? 't03' : 't02'}-${randomUUID()}`,
  image = 'ledgerdesk-access-runtime:2';
const mutation = process.argv.find((a) => a.startsWith('--mutation=')) ?? '';
const evidenceFolder = journey
  ? 'access-journey'
  : administration
    ? 'access-administration'
    : reading
      ? 'access-reading'
      : invitations
        ? 'access-invitations'
        : 'access-runtime';
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
    '--mutation=drop-invitation-revision',
    '--mutation=drop-invitation-support',
    '--mutation=drop-invitation-incompatibility',
    '--mutation=drop-invitation-proof',
    '--mutation=drop-canonical-target',
    '--mutation=drop-flow-coordination',
    '--mutation=drop-cursor-session',
    '--mutation=drop-reading-authority',
    '--mutation=drop-reading-evidence',
    '--mutation=drop-reading-admission',
    '--mutation=drop-reading-generation',
    '--mutation=disclose-hidden-capability',
    '--mutation=disclose-private-reason',
    '--mutation=drop-invitation-view-admission',
    '--mutation=offer-withdrawn-grant',
    '--mutation=drop-bootstrap-materialization',
    '--mutation=drop-bootstrap-revision',
    '--mutation=drop-bootstrap-root-binding',
    '--mutation=drop-bootstrap-exercise-bound',
    '--mutation=drop-journey-reading-authority',
    '--mutation=drop-journey-evidence',
    ...Object.keys(UI_MUTATIONS).map((name) => '--mutation=' + name),
  ].includes(mutation)
)
  throw new Error('Unknown mutation');
if (mutation && mutation !== '--mutation=early-failure') {
  const invitationMutation =
    (mutation.startsWith('--mutation=drop-invitation-') &&
      mutation !== '--mutation=drop-invitation-view-admission') ||
    mutation === '--mutation=drop-canonical-target' ||
    mutation === '--mutation=drop-flow-coordination';
  const readingMutation =
    mutation.startsWith('--mutation=drop-reading-') ||
    mutation === '--mutation=drop-cursor-session';
  const administrationMutation = [
    '--mutation=disclose-hidden-capability',
    '--mutation=disclose-private-reason',
    '--mutation=drop-invitation-view-admission',
    '--mutation=offer-withdrawn-grant',
    ...Object.keys(UI_MUTATIONS).map((name) => '--mutation=' + name),
  ].includes(mutation);
  const journeyMutation =
    mutation.startsWith('--mutation=drop-bootstrap-') ||
    mutation.startsWith('--mutation=drop-journey-');
  if (
    invitations !== invitationMutation ||
    reading !== readingMutation ||
    administration !== administrationMutation ||
    journey !== journeyMutation
  )
    throw new Error('Mutation belongs to the other runtime suite');
}
function docker(args, timeout = 15000) {
  return spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout });
}
const variant = mutation ? mutation.slice(11) : 'baseline';
const target = createEvidenceDirectory(
  path.join(root, 'test-results'),
  evidenceFolder,
  variant,
  owner,
);
const startedAt = new Date().toISOString();
let copied = false,
  cleaned = false,
  builtImage = '';
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
  const build = (compositionArgs) => command(
    [
      'build',
      ...compositionArgs,
      '-f',
      'ci/access/Runtime.Dockerfile',
      '--iidfile',
      path.join(target, 'image.id'),
      '--build-arg',
      'ACCESS_FINAL_ROUTES=' + (journey ? '1' : '0'),
      '--build-arg',
      'ACCESS_UI_MUTATION=' +
        (Object.hasOwn(UI_MUTATIONS, variant) ? variant : ''),
      '-t',
      image,
      '.',
    ],
    900000,
  );
  if (journey)
    await withSourceComposition(root, path.join(target, 'source-composition.json'),
      ({ filename, sha256 }) => build([
        '--secret', 'id=access_composition,src=' + filename,
        '--build-arg', 'ACCESS_COMPOSITION_SHA256=' + sha256,
      ]));
  else await build([]);
  builtImage = readFileSync(path.join(target, 'image.id'), 'utf8').trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(builtImage))
    throw new Error('Invalid built image identity');
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
      builtImage,
      ...(invitations || reading || administration || journey
        ? [
            'node',
            '--experimental-strip-types',
            '--test',
            '--test-concurrency=1',
            journey
              ? 'tests/access/test_whole_journey.mjs'
              : administration
                ? 'tests/access/test_administration.mjs'
                : reading
                  ? 'tests/access/test_authorized_reading.mjs'
                  : 'tests/access/test_invitations.mjs',
          ]
        : []),
    ],
    300000,
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try {
    const info = docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "ledgerdesk.test-owner"}}',
      owner,
    ]);
    if (info.status === 0 && info.stdout.trim() === owner) {
      const copy = docker(['cp', `${owner}:/work/output/.`, target], 15000);
      copied = copy.status === 0;
      if (copy.status !== 0) {
        console.error('Evidence copy failed');
        process.exitCode = 1;
      }
    }
  } finally {
    try {
      clean();
      cleaned = true;
      transcript += `\nACCESS_RUNTIME_CLEANED ${owner}\n`;
      console.log(`ACCESS_RUNTIME_CLEANED ${owner}`);
    } finally {
      writeFileSync(path.join(target, 'run.log'), transcript);
      writeFileSync(
        path.join(target, 'run.json'),
        JSON.stringify(
          {
            runId: owner,
            suite: evidenceFolder,
            variant,
            image: builtImage,
            startedAt,
            finishedAt: new Date().toISOString(),
            evidenceCopied: copied,
            cleaned,
            exitCode: process.exitCode || (cleaned ? 0 : 1),
          },
          null,
          2,
        ),
      );
      console.log('ACCESS_EVIDENCE ' + target);
    }
  }
}
