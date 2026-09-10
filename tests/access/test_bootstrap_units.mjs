import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initialFaculties } from '../../src/server/access/bootstrap.ts';
import * as composition from '../../ci/access_final_routes.mjs';

async function compositionUnderTest() {
  const mutation = process.env.ACCESS_COMPOSITION_MUTATION;
  if (!mutation) return composition;
  const sites = {
    'drop-root-classification': 'JSON.stringify(entries) !== JSON.stringify(wanted)',
    'drop-proxy-classification': "hash(proxy.replace(/\\r\\n/g, '\\n')) !== proxySourceHash",
    'drop-source-recheck': 'encoded(inspectSourceComposition(root)) !== bytes',
  };
  assert.ok(Object.hasOwn(sites, mutation), 'Named composition mutation');
  const scratch = mkdtempSync(path.join(tmpdir(), 'access-composition-mutant-'));
  after(() => {
    assert.ok(scratch.startsWith(path.join(tmpdir(), 'access-composition-mutant-')));
    rmSync(scratch, { recursive: true, force: true });
    console.log('ACCESS_COMPOSITION_MUTANT_CLEANED ' + mutation);
  });
  const code = readFileSync(new URL('../../ci/access_final_routes.mjs', import.meta.url), 'utf8');
  assert.equal(code.split(sites[mutation]).length - 1, 1, 'Exact composition mutation site');
  const target = path.join(scratch, 'composition.mjs');
  writeFileSync(target, code.replace(sites[mutation], 'false'));
  return import(pathToFileURL(target).href);
}
const {
  prepareFinalRoutes,
  verifyFinalRoutes,
  inspectSourceComposition,
  withSourceComposition,
  readSourceComposition,
} = await compositionUnderTest();

const faculty = {
  permission_id: 'read_material',
  exercise_or_grant: 'grant',
  scope_ref: 'inc02-material',
  support_ref: 'domain',
  permission_revision: 1,
  scope_revision: 1,
  support_revision: 1,
  expires_at: 10000,
};
test('initial faculties are exact declared selectors, never a master default or material exercise', () => {
  assert.deepEqual(initialFaculties([faculty]), [faculty]);
  for (const p of ['invite', 'read_people'])
    assert.equal(
      initialFaculties([
        { ...faculty, permission_id: p, exercise_or_grant: 'exercise' },
      ]).length,
      1,
    );
  for (const bad of [
    null,
    {},
    Array(17).fill(faculty),
    [faculty, faculty],
    [{ ...faculty, admin: true }],
    [{ ...faculty, exercise_or_grant: 'exercise' }],
    [{ ...faculty, permission_id: 'approve', exercise_or_grant: 'exercise' }],
    [{ ...faculty, permission_revision: 0 }],
    [{ ...faculty, expires_at: Infinity }],
    [{ ...faculty, scope_ref: '*' }],
  ])
    assert.throws(() => initialFaculties(bad), /BOOTSTRAP_/);
  assert.deepEqual(initialFaculties([]), []);
});
test('bounded composition is byte-exact and rejects altered route, layout, CSS and startup configuration', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'access-composition-'));
  const destination = path.join(scratch, 'ui');
  try {
    const root = path.resolve('.');
    const manifest = prepareFinalRoutes(root, destination);
    assert.ok(manifest.files.length > 10);
    for (const file of [
      'src/app/access/page.tsx',
      'src/app/access/material/page.tsx',
      'src/app/layout.tsx',
      'src/app/globals.css',
      'next.config.mjs',
      'postcss.config.mjs',
      'src/instrumentation.ts',
      'src/server/reading/config.ts',
    ]) {
      const target = path.join(destination, file),
        bytes = readFileSync(target);
      writeFileSync(
        target,
        Buffer.concat([bytes, Buffer.from('\n/* altered */')]),
      );
      assert.throws(
        () => verifyFinalRoutes(root, destination),
        /FINAL_ROUTES_BYTES/,
      );
      writeFileSync(target, bytes);
      verifyFinalRoutes(root, destination);
    }
    assert.throws(
      () => prepareFinalRoutes(root, destination),
      /ALREADY_EXISTS/,
    );
  } finally {
    assert.ok(scratch.startsWith(path.join(tmpdir(), 'access-composition-')));
    rmSync(scratch, { recursive: true, force: true });
  }
});

function sourceFixture(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'access-composition-'));
  t.after(() => {
    assert.ok(scratch.startsWith(path.join(tmpdir(), 'access-composition-')));
    rmSync(scratch, { recursive: true, force: true });
  });
  const root = path.join(scratch, 'source');
  const source = inspectSourceComposition(path.resolve('.'));
  for (const { directory, entries } of source.inventory) {
    mkdirSync(path.join(root, directory), { recursive: true });
    for (const e of entries)
      if (e.kind === 'directory') mkdirSync(path.join(root, directory, e.name), { recursive: true });
  }
  for (const { file } of [...source.files, ...source.excluded]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.resolve(file), target);
  }
  return { root, scratch, source };
}
test('source preflight derives included and excluded bytes before admitting the build', async (t) => {
  const { root, scratch, source } = sourceFixture(t);
  let calls = 0;
  await withSourceComposition(root, path.join(scratch, 'source.json'), ({ filename, sha256 }) => {
    calls++;
    assert.deepEqual(readSourceComposition(filename, sha256), source);
    assert.equal(source.files.some((e) => e.file === 'src/instrumentation.ts'), true);
    assert.equal(source.files.some((e) => e.file === 'src/server/reading/config.ts'), true);
    for (const e of source.excluded)
      assert.equal(e.sha256, createHash('sha256').update(readFileSync(path.join(root, e.file))).digest('hex'));
    assert.equal(source.excluded.some((e) => e.file === 'src/proxy.ts'), true);
  });
  assert.equal(calls, 1);
});
for (const file of ['src/app/template.tsx', 'src/app/access/loading.tsx', 'src/app/access/material/error.tsx', 'instrumentation.ts', 'src/instrumentation-client.ts', 'src/middleware.ts'])
  test('unclassified convention prevents the build callback: ' + file, async (t) => {
    const { root, scratch } = sourceFixture(t);
    writeFileSync(path.join(root, file), 'export default function Example() { return null; }');
    let calls = 0, failure = '';
    try {
      await withSourceComposition(root, path.join(scratch, 'source.json'), () => calls++);
    } catch (e) { failure = e.message; }
    assert.deepEqual({ rejected: failure.startsWith('FINAL_ROUTES_UNCLASSIFIED'), calls }, { rejected: true, calls: 0 });
  });
test('a widened excluded proxy cannot start the build, even with a matching comment', async (t) => {
  const { root, scratch } = sourceFixture(t);
  const proxy = path.join(root, 'src/proxy.ts');
  writeFileSync(proxy, readFileSync(proxy, 'utf8').replace("matcher: '/api/v1/material/:path*'", "matcher: ['/:path*']") + "\n// matcher: '/api/v1/material/:path*'\n");
  let calls = 0, failure = '';
  try {
    await withSourceComposition(root, path.join(scratch, 'source.json'), () => calls++);
  } catch (e) { failure = e.message; }
  assert.deepEqual({ failure, calls }, { failure: 'FINAL_ROUTES_PROXY_SCOPE', calls: 0 });
});
test('changing an excluded sibling during the build invalidates source evidence', async (t) => {
  const { root, scratch } = sourceFixture(t);
  let calls = 0;
  await assert.rejects(withSourceComposition(root, path.join(scratch, 'source.json'), () => {
    calls++;
    writeFileSync(path.join(root, 'src/app/page.tsx'), '// changed sibling');
  }), /FINAL_ROUTES_SOURCE_CHANGED_DURING_BUILD/);
  assert.equal(calls, 1);
});
test('the filtered copy is bound to the pre-filter source, not a self-generated exclusion claim', (t) => {
  const { root, scratch, source } = sourceFixture(t);
  const filtered = path.join(scratch, 'filtered');
  for (const { file } of source.files) {
    mkdirSync(path.dirname(path.join(filtered, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(filtered, file));
  }
  // This is what Docker sees: exclusions are gone. It cannot attest to the original checkout.
  assert.throws(() => inspectSourceComposition(filtered), /FINAL_ROUTES_UNCLASSIFIED/);
  const destination = path.join(scratch, 'ui');
  const manifest = prepareFinalRoutes(filtered, destination, source);
  assert.deepEqual(manifest.excluded, source.excluded);
  const input = path.join(destination, 'source-composition.json');
  assert.deepEqual(readSourceComposition(input, manifest.sourceSha256), source);
  assert.throws(() => readSourceComposition(input, '0'.repeat(64)), /SOURCE_DIGEST/);
  writeFileSync(input, JSON.stringify({ ...source, excluded: [] }));
  assert.throws(() => verifyFinalRoutes(filtered, destination, source), /SOURCE_DIGEST/);
  writeFileSync(path.join(filtered, 'src/instrumentation.ts'), '// changed after preflight');
  assert.throws(() => prepareFinalRoutes(filtered, path.join(scratch, 'changed'), source), /SOURCE_FILES/);
});
