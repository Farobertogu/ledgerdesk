import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const files = [
  'src/app/access/page.tsx',
  'src/app/access/material/page.tsx',
  'src/app/layout.tsx',
  'src/app/globals.css',
  'src/instrumentation.ts',
  'next.config.mjs',
  'postcss.config.mjs',
  'tsconfig.app.json',
  'package.json',
  'src/server/reading/config.mjs',
  'src/server/reading/config.ts',
];
const directories = [
  'src/components/access',
  'src/components/reading',
  'src/contracts',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value) => JSON.stringify(value, null, 2);
const legacyRoutes = ['api', 'material', 'portal', 'promotion', 'queue', 'session', 'supervisor', 'tickets'];
// This is the reviewed exclusion, not a regex that accepts arbitrary proxy code.
// A change requires classifying its applicability again; CRLF is not a semantic change.
const proxySourceHash = 'a75d7e5478a35fcb5d4f90e6ea4e23ee9f904fea933152635c2495d62adf8525';
function children(root, relative) {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).map((e) => {
    if (e.isSymbolicLink()) throw Error('FINAL_ROUTES_SYMLINK ' + relative + '/' + e.name);
    return { name: e.name, kind: e.isDirectory() ? 'directory' : 'file' };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function exactChildren(root, relative, expected) {
  const entries = children(root, relative);
  const wanted = expected.map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (JSON.stringify(entries) !== JSON.stringify(wanted))
    throw Error('FINAL_ROUTES_UNCLASSIFIED ' + relative);
  return { directory: relative, entries };
}
function fingerprint(root, file) {
  if (!lstatSync(path.join(root, file)).isFile()) throw Error('FINAL_ROUTES_FILE ' + file);
  return { file, sha256: hash(readFileSync(path.join(root, file))) };
}
function included(root) {
  return [...files, ...directories.flatMap((d) => list(root, d))].sort();
}
function list(root, relative) {
  return readdirSync(path.join(root, relative), {
    withFileTypes: true,
  }).flatMap((e) => {
    const p = relative + '/' + e.name;
    if (e.isSymbolicLink()) throw Error('FINAL_ROUTES_SYMLINK ' + p);
    return e.isDirectory() ? list(root, p) : [p];
  });
}
/** Inspect the original checkout, before Docker can remove any applicable convention. */
export function inspectSourceComposition(root) {
  const inventory = [
    exactChildren(root, 'src/app', [
      ...['access', ...legacyRoutes].map((name) => [name, 'directory']),
      ...['layout.tsx', 'globals.css', 'page.tsx'].map((name) => [name, 'file']),
    ]),
    exactChildren(root, 'src/app/access', [['material', 'directory'], ['page.tsx', 'file']]),
    exactChildren(root, 'src/app/access/material', [['page.tsx', 'file']]),
  ];
  const conventions = [];
  for (const directory of ['', 'src']) {
    for (const e of children(root, directory)) {
      if (/^(instrumentation(?:-client)?|middleware|proxy)\./.test(e.name) ||
          ['app', 'pages'].includes(e.name) ||
          /^(next|postcss)\.config\./.test(e.name))
        conventions.push((directory ? directory + '/' : '') + e.name);
    }
  }
  const known = ['next.config.mjs', 'postcss.config.mjs', 'src/app', 'src/instrumentation.ts', 'src/proxy.ts'];
  if (JSON.stringify(conventions.sort()) !== JSON.stringify(known.sort()))
    throw Error('FINAL_ROUTES_UNCLASSIFIED_CONVENTION');
  const proxy = readFileSync(path.join(root, 'src/proxy.ts'), 'utf8');
  if (hash(proxy.replace(/\r\n/g, '\n')) !== proxySourceHash)
    throw Error('FINAL_ROUTES_PROXY_SCOPE');
  const excluded = ['src/app/page.tsx', ...legacyRoutes.flatMap((name) => list(root, 'src/app/' + name))]
    .sort().map((file) => ({ ...fingerprint(root, file), reason: 'Unrelated sibling route; not an ancestor of /access' }));
  excluded.push({ ...fingerprint(root, 'src/proxy.ts'), reason: 'Reviewed proxy matches only /api/v1/material/:path*; not /access or its direct terminal' });
  return {
    profile: 'access-source-composition/1',
    inventory, conventions: conventions.sort(),
    files: included(root).map((file) => fingerprint(root, file)),
    excluded,
  };
}
/** The build callback cannot start until source classification has passed. */
export async function withSourceComposition(root, filename, build) {
  const source = inspectSourceComposition(root);
  const bytes = encoded(source);
  writeFileSync(filename, bytes, { flag: 'wx' });
  const result = await build({ filename, sha256: hash(bytes) });
  if (encoded(inspectSourceComposition(root)) !== bytes)
    throw Error('FINAL_ROUTES_SOURCE_CHANGED_DURING_BUILD');
  return result;
}
/** The digest is passed independently as a build argument and kept in the image. */
export function readSourceComposition(filename, expectedHash) {
  const bytes = readFileSync(filename);
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '') || hash(bytes) !== expectedHash)
    throw Error('FINAL_ROUTES_SOURCE_DIGEST');
  const source = JSON.parse(bytes.toString('utf8'));
  if (source.profile !== 'access-source-composition/1') throw Error('FINAL_ROUTES_SOURCE_PROFILE');
  return source;
}
export function prepareFinalRoutes(root, destination, source = inspectSourceComposition(root)) {
  if (existsSync(destination)) throw Error('FINAL_ROUTES_ALREADY_EXISTS');
  const entries = included(root);
  if (JSON.stringify(entries.map((file) => fingerprint(root, file))) !== JSON.stringify(source.files))
    throw Error('FINAL_ROUTES_SOURCE_FILES');
  for (const entry of entries) {
    const to = path.join(destination, entry);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(root, entry), to);
  }
  const manifest = {
    profile: 'access-final-routes/1',
    files: source.files,
    excluded: source.excluded,
    sourceSha256: hash(encoded(source)),
    claim:
      'Final routes and applicable root composition in a bounded build; not whole-application deployment',
  };
  writeFileSync(path.join(destination, 'source-composition.json'), encoded(source));
  writeFileSync(
    path.join(destination, 'composition.json'),
    JSON.stringify(manifest, null, 2),
  );
  return verifyFinalRoutes(root, destination, source);
}
export function verifyFinalRoutes(root, destination, source = inspectSourceComposition(root)) {
  const manifest = JSON.parse(
    readFileSync(path.join(destination, 'composition.json'), 'utf8'),
  );
  const expected = included(root);
  if (manifest.sourceSha256 !== hash(encoded(source)) ||
      JSON.stringify(manifest.files) !== JSON.stringify(source.files) ||
      JSON.stringify(manifest.excluded) !== JSON.stringify(source.excluded))
    throw Error('FINAL_ROUTES_SOURCE_MANIFEST');
  readSourceComposition(path.join(destination, 'source-composition.json'), manifest.sourceSha256);
  if (
    JSON.stringify(manifest.files.map((e) => e.file)) !==
    JSON.stringify(expected)
  )
    throw Error('FINAL_ROUTES_INVENTORY');
  for (const e of manifest.files)
    if (
      hash(readFileSync(path.join(root, e.file))) !== e.sha256 ||
      hash(readFileSync(path.join(destination, e.file))) !== e.sha256
    )
      throw Error('FINAL_ROUTES_BYTES ' + e.file);
  return manifest;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = readSourceComposition('/run/secrets/access_composition', process.env.ACCESS_COMPOSITION_SHA256);
  prepareFinalRoutes(root, path.join(root, 'tests/access/final-ui'), source);
}
