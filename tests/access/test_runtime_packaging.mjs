import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSourceComposition, prepareFinalRoutes } from '../../ci/access_final_routes.mjs';
import { createEvidenceDirectory } from '../../ci/access_evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const completeCopy = 'COPY src/contracts/ ./src/contracts/';
const oldCopy = 'COPY src/contracts/access*.ts ./src/contracts/\nCOPY src/contracts/material_reading.ts src/contracts/reading_origin.ts ./src/contracts/';
const completeContext = '!src/contracts/**';
const oldContext = '!src/contracts/access*.ts\n!src/contracts/material_reading.ts\n!src/contracts/reading_origin.ts';
const omittedContext = '\nsrc/contracts/intake*.ts\nsrc/contracts/future_packaging_probe.ts\n';
const mutation = process.env.ACCESS_PACKAGING_MUTATION ?? '';
assert(['', 'omit-contract-copy', 'omit-contract-context'].includes(mutation), 'Named packaging mutation');
function replaceOnce(value, before, after) {
  assert.equal(value.split(before).length - 1, 1, 'Exact packaging mutation site');
  return value.replace(before, after);
}
function cloneSource(destination, source) {
  for (const { directory, entries } of source.inventory) {
    mkdirSync(path.join(destination, directory), { recursive: true });
    for (const entry of entries)
      if (entry.kind === 'directory') mkdirSync(path.join(destination, directory, entry.name), { recursive: true });
  }
  for (const { file } of [...source.files, ...source.excluded]) {
    const target = path.join(destination, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
}

test('runtime contract packaging preserves the independent pre-filter source through context and COPY', { timeout: 240000 }, async t => {
  const runId = 'access-packaging-' + randomUUID();
  const evidence = createEvidenceDirectory(path.join(root, 'test-results'), 'access-journey', mutation || 'packaging', runId);
  const scratch = mkdtempSync(path.join(tmpdir(), 'ld-access-pkg-'));
  const outcomes = [];
  t.after(() => {
    const resolved = path.resolve(scratch);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert(path.basename(resolved).startsWith('ld-access-pkg-'));
    rmSync(resolved, { recursive: true, force: true });
    writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ runId, mutation, outcomes, cleaned: !existsSync(resolved) }, null, 2));
    console.log('ACCESS_PACKAGING_CLEANED ' + runId);
    console.log('PACKAGING_EVIDENCE ' + evidence);
  });
  const initialSource = inspectSourceComposition(root);
  const actualDockerfile = readFileSync(path.join(root, 'ci/access/Runtime.Dockerfile'));
  const actualIgnore = readFileSync(path.join(root, 'ci/access/Runtime.Dockerfile.dockerignore'));
  const copyLines = actualDockerfile.toString('utf8').replaceAll('\r\n', '\n').split('\n').filter(line => line.startsWith('COPY src/contracts'));
  assert(copyLines.length > 0, 'The actual runtime recipe declares its contract COPY inputs');
  const actualCopy = copyLines.join('\n');
  const ignore = actualIgnore.toString('utf8').replaceAll('\r\n', '\n');
  const sourceRoot = path.join(scratch, 'source');
  cloneSource(sourceRoot, initialSource);
  // This prospective family exists only in the synthetic pre-filter source, never in the repository.
  const prospective = 'src/contracts/future_packaging_probe.ts';
  writeFileSync(path.join(sourceRoot, prospective), 'export const syntheticPackagingProbe = 17;\n');
  const expected = inspectSourceComposition(sourceRoot);
  const expectedContracts = expected.files.filter(entry => entry.file.startsWith('src/contracts/'));
  const omitted = expectedContracts.filter(entry => !/^src\/contracts\/access[^/]*\.ts$/.test(entry.file) && !['src/contracts/material_reading.ts', 'src/contracts/reading_origin.ts'].includes(entry.file));
  assert(omitted.some(entry => entry.file === 'src/contracts/intake.ts'), 'Current new family is independently classified');
  assert(omitted.some(entry => entry.file === prospective), 'Future family is independently classified');
  writeFileSync(path.join(evidence, 'expected-source.json'), JSON.stringify(expected, null, 2));
  writeFileSync(path.join(evidence, 'packaging-source.json'), JSON.stringify({ dockerfileSHA256: hash(actualDockerfile), ignoreSHA256: hash(actualIgnore), copyLines, mutation, scope: 'Real Docker context filtering and contract COPY instructions, projected into a scratch export; the full runtime image and journey are separate consumers.' }, null, 2));
  const cases = [
    { name: 'complete', copy: mutation === 'omit-contract-copy' ? replaceOnce(actualCopy, completeCopy, oldCopy) : actualCopy, ignore: mutation === 'omit-contract-context' ? ignore + omittedContext : ignore, missing: [] },
    // Docker's earlier parent-directory inclusion already admitted these children.
    // Keep the observed positive instead of misreporting that filter as the original failure.
    { name: 'legacy-context-with-complete-copy', copy: actualCopy, ignore: replaceOnce(ignore, completeContext, oldContext), missing: [] },
    { name: 'omission-in-copy', copy: replaceOnce(actualCopy, completeCopy, oldCopy), ignore, missing: omitted },
    { name: 'omission-in-context', copy: actualCopy, ignore: ignore + omittedContext, missing: omitted },
  ];
  for (const item of cases) await t.test(item.name, () => {
    const caseRoot = path.join(scratch, item.name);
    mkdirSync(caseRoot);
    // Preserve the actual Dockerfile/context relationship so Docker applies its companion ignore file.
    const dockerfile = path.join(sourceRoot, 'ci/access/Runtime.Dockerfile');
    mkdirSync(path.dirname(dockerfile), { recursive: true });
    const output = path.join(caseRoot, 'export');
    writeFileSync(dockerfile, 'FROM scratch\nWORKDIR /work\n' + item.copy + '\n');
    // Docker, not a second implementation of its glob rules, applies this exact context filter.
    writeFileSync(dockerfile + '.dockerignore', item.ignore);
    const args = ['build', '--network=none', '--progress=plain', '--output', 'type=local,dest=' + output, '-f', dockerfile, sourceRoot];
    const at = new Date().toISOString();
    const built = spawnSync('docker', args, { cwd: root, encoding: null, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    writeFileSync(path.join(evidence, item.name + '.stdout.log'), built.stdout ?? '');
    writeFileSync(path.join(evidence, item.name + '.stderr.log'), built.stderr ?? '');
    writeFileSync(path.join(evidence, item.name + '.command.json'), JSON.stringify({ at, args, status: built.status, signal: built.signal, error: built.error?.message, recipe: readFileSync(dockerfile, 'utf8'), ignore: item.ignore }, null, 2));
    assert.equal(built.status, 0, 'Packaging must reach the source assertion, not fail to start Docker: ' + built.stderr);
    const packaged = path.join(output, 'work');
    for (const { file } of expected.files.filter(entry => !entry.file.startsWith('src/contracts/'))) {
      const target = path.join(packaged, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(sourceRoot, file), target);
    }
    const actualMissing = expectedContracts.filter(entry => !existsSync(path.join(packaged, entry.file))).map(entry => entry.file);
    for (const entry of expectedContracts.filter(entry => !actualMissing.includes(entry.file))) assert.equal(hash(readFileSync(path.join(packaged, entry.file))), entry.sha256, entry.file);
    let failure = '', manifest;
    const destination = path.join(caseRoot, 'prepared');
    try { manifest = prepareFinalRoutes(packaged, destination, expected); } catch (error) { failure = error.message; }
    const observed = { missing: actualMissing, failure, destinationCreated: existsSync(destination) };
    outcomes.push({ name: item.name, ...observed });
    assert.deepEqual(observed, { missing: item.missing.map(entry => entry.file), failure: item.missing.length ? 'FINAL_ROUTES_SOURCE_FILES' : '', destinationCreated: item.missing.length === 0 });
    if (!item.missing.length) assert.deepEqual(manifest.files, expected.files, 'Complete source bytes, not just a successful build');
    assert.deepEqual(inspectSourceComposition(sourceRoot), expected, 'Independent source stays fixed across filtering and construction');
  });
});
