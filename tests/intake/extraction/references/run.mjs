import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const id = `s2-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const output = path.join(root, 'test-results/intake-extraction', id);
await fs.mkdir(output, { recursive: true });
const files = [];
async function snapshot(relative) {
  const full = path.join(root, relative);
  for (const entry of await fs.readdir(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await snapshot(name);
    else {
      const bytes = await fs.readFile(path.join(root, name));
      const destination = path.join(output, 'source', name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: 'wx' });
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await snapshot('workers/intake/extraction');
await snapshot('tests/intake/extraction/references');
for (const relative of ['tests/intake/extraction/adapter_cases.mjs', 'tests/intake/extraction/interface_fixtures.mjs',
  'src/contracts/intake_extraction.ts', 'src/contracts/intake.ts']) {
  const bytes = await fs.readFile(path.join(root, relative));
  const destination = path.join(output, 'source', relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes, { flag: 'wx' });
  files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
// Retain the actual immutable inputs/manifests with this execution, not only source filenames.
for (const directory of ['tests/intake/t01/fixtures', 'tests/intake/t01/boundaries']) {
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:txt|csv|xlsx|json|md)$/.test(entry.name)) continue;
    const relative = `${directory}/${entry.name}`;
    const bytes = await fs.readFile(path.join(root, relative));
    const destination = path.join(output, 'source', relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' });
    files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
const args = ['--max-old-space-size=128', '--experimental-strip-types', '--test', '--test-concurrency=1', 'tests/intake/extraction/adapter_cases.mjs'];
const started = new Date().toISOString();
const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, INTAKE_S2_EVIDENCE_DIR: output }, windowsHide: true });
const stdout = [], stderr = [];
child.stdout.on('data', chunk => { stdout.push(chunk); process.stdout.write(chunk); });
child.stderr.on('data', chunk => { stderr.push(chunk); process.stderr.write(chunk); });
const timer = setTimeout(() => child.kill(), 120000);
let execution;
try {
  execution = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
} finally { clearTimeout(timer); }
await fs.writeFile(path.join(output, 'stdout.log'), Buffer.concat(stdout), { flag: 'wx' });
await fs.writeFile(path.join(output, 'stderr.log'), Buffer.concat(stderr), { flag: 'wx' });
const manifest = { id, scope: 'Host adapter and request/reply checks; not fixed-path Linux entry or physical containment',
  command: [process.execPath, ...args], node: process.version, platform: process.platform,
  started, finished: new Date().toISOString(), execution, files };
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(`Evidence: ${output}\n`);
process.exitCode = execution.code ?? 1;
