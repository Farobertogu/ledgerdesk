import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkReadingBoundaries, moduleReferences } from '../../ci/reading_boundary_check.mjs';

// Mutations below affect a fresh synthetic repository, never the product tree.
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ledgerdesk-reading-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, source) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  };
  const files = {
    'tsconfig.app.json': JSON.stringify({ compilerOptions: { paths: {
      '@/*': ['./src/*'], '@agents/*': ['./agents/*'], '#server/*': ['./src/server/*'],
    } } }),
    'src/app/layout.tsx': "import type { Metadata } from 'next';\nimport './globals.css';\nexport default function Root() { return null; }",
    'src/app/globals.css': 'body { margin: 0; }',
    'src/app/material/page.tsx': "import React from 'react';\nimport { config } from '@/server/reading/config';\nexport default function Material() { return config; }",
    'src/app/api/v1/material/route.ts': "export { handler as GET } from '@/server/reading/http';",
    'src/app/api/v1/material/[unit_id]/versions/[version_id]/route.ts': "import { handler } from '@/server/reading/http'; export const GET = handler;",
    'src/instrumentation.ts': "export async function register() { await import('./server/reading/config.ts'); }",
    'src/proxy.ts': "import type { NextRequest } from 'next/server'; export { handler as proxy } from '@/server/reading/http';",
    'src/server/reading/config.ts': "import { randomUUID } from 'node:crypto';\nimport { context } from './context';\nexport const config = { context, nonce: randomUUID };",
    'src/server/reading/context.ts': "import type { Projection } from '../../contracts/material_reading.ts';\nexport const context: Projection = 'none';",
    'src/server/reading/http.ts': "import type { Reader } from '../kb/reading.ts';\nexport { config as handler } from './config';",
    'src/server/kb/reading.ts': "import type { Projection } from '../../contracts/material_reading.ts';\nimport type { context } from '../reading/context.ts';\nexport type Reader = () => Projection;",
    'src/contracts/material_reading.ts': "export type Projection = 'full' | 'none';",
    'src/server/db.ts': 'export const oldDb = true;',
    'src/server/session.ts': "import { oldDb } from './db'; export const identity = oldDb;",
    'src/components/legacy/LegacyShell.tsx': "import { identity } from '@/server/session'; export const shell = identity;",
    'src/app/portal/page.tsx': "import { identity } from '@/server/session'; export default function Portal() { return identity; }",
    'agents/gateway.ts': 'export const gateway = true;',
    'agents/providers/fixture.ts': 'export const fixture = true;',
  };
  for (const [file, source] of Object.entries(files)) write(file, source);
  return { root, write, append(file, source) { write(file, readFileSync(path.join(root, file), 'utf8') + '\n' + source); } };
}

function rejected(result, expected) {
  assert.equal(result.ok, false, 'the forbidden mutation passed');
  assert.match(result.violations.join('\n'), expected);
}

test('a complete neutral-root graph and separate legacy graph pass, including framework imports first', (t) => {
  const f = fixture(t);
  const result = checkReadingBoundaries(f.root);
  assert.equal(result.ok, true, result.violations.join('\n'));
  assert.ok(result.inspected >= 13, 'the graph did not inspect its declared roots and dependencies');
});

test('empty or incomplete trees cannot pass vacuously', (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, 'src/app/material/page.tsx'));
  rejected(checkReadingBoundaries(f.root), /missing required reading root: src\/app\/material\/page.tsx/);
  const empty = path.join(f.root, 'empty');
  mkdirSync(empty);
  rejected(checkReadingBoundaries(empty), /missing required reading root/);
});

test('PostgreSQL is confined to the reviewed store adapter, not a directory-wide exception', (t) => {
  const f = fixture(t);
  f.write('src/server/reading/postgres/store.ts', "import { Client } from 'pg'; export const connect = () => new Client();");
  assert.equal(checkReadingBoundaries(f.root).ok, true);
  f.write('src/server/reading/postgres/other.ts', "import pg from 'pg'; export const other = pg;");
  rejected(checkReadingBoundaries(f.root), /unapproved external module pg/);
});

test('a component cannot import the PostgreSQL store transitively', (t) => {
  const f = fixture(t);
  f.write('src/server/reading/postgres/store.ts', "import { Client } from 'pg'; export const connect = () => new Client();");
  f.write('src/shared/reading_bridge.ts', "export { connect } from '../server/reading/postgres/store.ts';");
  f.write('src/components/reading/Leaking.tsx', "import { connect } from '../../shared/reading_bridge.ts'; export default function Leak() { return connect(); }");
  rejected(checkReadingBoundaries(f.root), /presentation reaches reading server/);
});

for (const [name, source, expected] of [
  ['direct alias after an innocent framework import', "import { cookies } from 'next/headers';\nimport { identity } from '@/server/session';", /src\/server\/session.ts/],
  ['relative import', "import { oldDb } from '../db.ts';", /src\/server\/db.ts/],
  ['second configured alias', "import { oldDb } from '#server/db';", /src\/server\/db.ts/],
  ['require', "const old = require('@/server/db');", /src\/server\/db.ts/],
  ['literal dynamic import', "export const old = () => import('../db.ts');", /src\/server\/db.ts/],
  ['literal template dynamic import', 'export const old = () => import(`../db.ts`);', /src\/server\/db.ts/],
  ['escaped module literal', String.raw`import '\u0040/server/db';`, /src\/server\/db.ts/],
  ['re-export', "export { oldDb } from '@/server/db';", /src\/server\/db.ts/],
  ['namespace re-export', "export * from '@/server/session';", /src\/server\/session.ts/],
  ['type import still couples the old model', "import type { Claims } from '@/server/db';", /src\/server\/db.ts/],
  ['gateway', "import { gateway } from '@agents/gateway.ts';", /agents\/gateway.ts/],
  ['provider fixture', "import { fixture } from '@agents/providers/fixture.ts';", /agents\/providers\/fixture.ts/],
  ['unapproved external DB client', "import pg from 'pg';", /unapproved external module pg/],
  ['computed import', 'export const load = (name) => import(name);', /needs a literal module path/],
  ['computed require', 'const load = (name) => require(name);', /needs a literal module path/],
  ['computed template import', 'export const load = (name) => import(`../${name}.ts`);', /needs a literal module path/],
  ['unresolved local target', "import './missing.ts';", /unresolved repository module/],
]) {
  test(`rejects ${name}`, (t) => {
    const f = fixture(t);
    f.append('src/server/reading/http.ts', source);
    rejected(checkReadingBoundaries(f.root), expected);
  });
}

test('follows alias to extensionless directory index to re-exported legacy module', (t) => {
  const f = fixture(t);
  f.append('src/server/reading/http.ts', "import { bridge } from '@/shared/bridge';");
  f.write('src/shared/bridge/index.ts', "export { oldDb as bridge } from '../../server/db.js';");
  rejected(checkReadingBoundaries(f.root), /src\/shared\/bridge\/index.ts -> src\/server\/db.ts/);
});

test('a cycle does not hide the legacy dependency or recurse forever', (t) => {
  const f = fixture(t);
  f.append('src/server/reading/http.ts', "import '@/shared/a';");
  f.write('src/shared/a.ts', "import './b';");
  f.write('src/shared/b.ts', "import './a'; import '@/server/db';");
  rejected(checkReadingBoundaries(f.root), /src\/server\/db.ts/);
});

test('neutral root cannot acquire the legacy shell', (t) => {
  const f = fixture(t);
  f.append('src/app/layout.tsx', "import { shell } from '@/components/legacy/LegacyShell';");
  rejected(checkReadingBoundaries(f.root), /reading reaches legacy dependency/);
});

test('contracts cannot import even an otherwise allowed framework type', (t) => {
  const f = fixture(t);
  f.append('src/contracts/material_reading.ts', "import type { Metadata } from 'next';");
  rejected(checkReadingBoundaries(f.root), /contract must be import-free/);
});

test('an orphan reading module is checked even before an endpoint imports it', (t) => {
  const f = fixture(t);
  f.write('src/server/reading/unwired.ts', "import '@/server/session';");
  rejected(checkReadingBoundaries(f.root), /reading reaches legacy dependency/);
});

test('legacy server cannot reach the new port through a shared intermediary', (t) => {
  const f = fixture(t);
  f.append('src/server/session.ts', "export * from '../shared/bridge';");
  f.write('src/shared/bridge.ts', "export type { Reader } from '../server/kb/reading';");
  rejected(checkReadingBoundaries(f.root), /legacy reaches reading dependency:.*src\/server\/kb\/reading.ts/);
});

test('legacy API cannot directly call the new handler', (t) => {
  const f = fixture(t);
  f.write('src/app/api/tickets/route.ts', "export { handler as GET } from '@/server/reading/http';");
  rejected(checkReadingBoundaries(f.root), /legacy reaches reading dependency/);
});

test('commented exemptions cannot permit a real forbidden import', (t) => {
  const f = fixture(t);
  f.append('src/server/reading/http.ts', "// reading-boundary-ignore: approved legacy exception\nimport /* approved exemption */ { oldDb } from '@/server/db';");
  rejected(checkReadingBoundaries(f.root), /reading reaches legacy dependency/);
});

test('comments, ordinary strings, literal templates and regex contents do not manufacture imports', () => {
  const source = [
    "// import old from '@/server/db';",
    "/* require('@/server/session'); */",
    `const prose = "import('@/server/db')";`,
    'const note = `require("@/server/db")`;',
    'const pattern = /import\\("@\\/server\\/db"\\)/;',
    "import /* allowed */ type { Metadata } from 'next';",
    "export const meta = import.meta;",
  ].join('\n');
  const result = moduleReferences(source);
  assert.deepEqual(result.references.map((item) => item.specifier), ['next']);
  assert.deepEqual(result.computed, []);
});

test('a template expression is executable and its nested require is inspected', (t) => {
  const f = fixture(t);
  f.append('src/server/reading/http.ts', 'const value = `prefix ${require("@/server/db")} suffix`;');
  rejected(checkReadingBoundaries(f.root), /src\/server\/db.ts/);
});

test('TSX content is inert while attribute and child expressions remain executable', (t) => {
  const f = fixture(t);
  const page = [
    "import { config } from '@/server/reading/config';",
    'export default function Material() {',
    '  return (<section title="the author\'s material / version">',
    '    This person\'s file / original. Text: import("@/server/db").',
    '    {/* require("@/server/db") is a comment, not a loader */}',
    '    <span>{config ? <b>ready / available</b> : <i>unavailable</i>}</span>',
    '  </section>);',
    '}',
  ].join('\n');
  f.write('src/app/material/page.tsx', page);
  const valid = checkReadingBoundaries(f.root);
  assert.equal(valid.ok, true, valid.violations.join('\n'));
  f.write('src/app/material/page.tsx', page.replace('<span>', '<span data-value={require("@/server/db")}>'));
  rejected(checkReadingBoundaries(f.root), /src\/server\/db.ts/);
  f.write('src/app/material/page.tsx', page.replace('{config ?', '{import("@/server/db") ?'));
  rejected(checkReadingBoundaries(f.root), /src\/server\/db.ts/);
});

test('a generic TSX arrow is not confused with an element', () => {
  const source = 'const identity = <T,>(x: T) => x; export const value = <span>{identity(require("./safe"))}</span>;';
  const result = moduleReferences(source, { jsx: true });
  assert.deepEqual(result.references.map((item) => item.specifier), ['./safe']);
});

test('TSX attributes with comments, mapped expressions and Pick types use TypeScript syntax', () => {
  const source = [
    'type Row = { id: string; label: string };',
    'const rows: Pick<Row, "id">[] = [];',
    'const view = <Table',
    '  // The user\'s choice stays available / visible.',
    '  transitions={rows.map((row: Pick<Row, "id">) => ({',
    '    label: `item ${row.id}`, value: require("./safe")',
    '  }))}',
    '/>;',
  ].join('\n');
  const result = moduleReferences(source, { jsx: true });
  assert.deepEqual(result.references.map((item) => item.specifier), ['./safe']);
});

test('syntax errors fail closed instead of yielding an incomplete import graph', (t) => {
  const f = fixture(t);
  f.write('src/server/reading/http.ts', 'export const broken = ;');
  rejected(checkReadingBoundaries(f.root), /cannot inspect module: syntax error/);
  f.write('src/app/material/page.tsx', 'export default function Material() { return <section>; }');
  rejected(checkReadingBoundaries(f.root), /src\/app\/material\/page.tsx: cannot inspect module: syntax error/);
});

test('AST loader forms include import types, import equals and module.require', (t) => {
  for (const source of [
    'export type Old = import("@/server/db").Old;',
    'import old = require("@/server/db");',
    'const old = module.require("@/server/db");',
  ]) {
    const f = fixture(t);
    f.append('src/server/reading/http.ts', source);
    rejected(checkReadingBoundaries(f.root), /src\/server\/db.ts/);
  }
});

test('proxy is required and cannot reach legacy state', (t) => {
  const f = fixture(t);
  f.append('src/proxy.ts', "import { identity } from '@/server/session';");
  rejected(checkReadingBoundaries(f.root), /reading reaches legacy dependency/);
  rmSync(path.join(f.root, 'src/proxy.ts'));
  rejected(checkReadingBoundaries(f.root), /missing required reading root: src\/proxy.ts/);
});

// Copy the actual legacy leaves, whose imports stay within React and Next.
// Missing targets or synthetic server imports would conceal this regression.
const legacyLeaves = [
  'src/alg/retrieval.ts',
  'src/components/DraftButton.tsx',
  'src/components/TriageButton.tsx',
  'src/components/GapControls.tsx',
];
const productSource = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const aliasFor = (relative) => `@/${relative.slice(4).replace(/\.[^.]+$/, '')}`;
function rejectsOnlyEdge(result, mode, from, to) {
  assert.equal(result.ok, false, 'the forbidden import passed');
  assert.equal(result.violations.length, 1, result.violations.join('\n'));
  const prefix = `${mode} reaches ${mode === 'reading' ? 'legacy' : 'reading'} dependency: `;
  const [violation] = result.violations;
  assert.ok(violation.startsWith(prefix), violation);
  // An API root may reach the handler first; assert the forbidden edge, not
  // which otherwise valid entry point the traversal happened to visit first.
  assert.deepEqual(violation.slice(prefix.length).split(' -> ').slice(-2), [from, to]);
}

for (const target of legacyLeaves) {
  for (const importer of ['src/app/material/page.tsx', 'src/server/reading/http.ts']) {
    test(`${importer} rejects the actual ${target} without relying on another forbidden dependency`, (t) => {
      const f = fixture(t);
      f.write(target, productSource(target));
      assert.deepEqual(checkReadingBoundaries(f.root).violations, [], 'the copied legacy module must resolve and parse before the import');
      f.append(importer, `import ${JSON.stringify(aliasFor(target))};`);
      rejectsOnlyEdge(checkReadingBoundaries(f.root), 'reading', importer, target);
    });
  }

  test(`orphan ${target} cannot import the new reading port`, (t) => {
    const f = fixture(t);
    f.write(target, productSource(target));
    assert.deepEqual(checkReadingBoundaries(f.root).violations, []);
    f.append(target, "export type { Reader } from '@/server/kb/reading';");
    rejectsOnlyEdge(checkReadingBoundaries(f.root), 'legacy', target, 'src/server/kb/reading.ts');
  });
}

test('the existing timezone formatter is not a shared presentation exception', (t) => {
  const f = fixture(t);
  f.write('src/components/format.ts', productSource('src/components/format.ts'));
  assert.deepEqual(checkReadingBoundaries(f.root).violations, []);
  f.append('src/app/material/page.tsx', "import '@/components/format';");
  rejectsOnlyEdge(checkReadingBoundaries(f.root), 'reading', 'src/app/material/page.tsx', 'src/components/format.ts');
});

test('new reading components can use the contract and exact shared Panel exception', (t) => {
  const f = fixture(t);
  f.write('src/components/Panel.tsx', productSource('src/components/Panel.tsx'));
  f.write('src/components/reading/Viewer.tsx', [
    "import { Panel } from '@/components/Panel';",
    "import type { Projection } from '@/contracts/material_reading';",
    "export const viewer: Projection = 'none';",
  ].join('\n'));
  f.append('src/app/material/page.tsx', "import '@/components/reading/Viewer';");
  f.append('src/app/portal/page.tsx', "import '@/components/Panel';");
  const result = checkReadingBoundaries(f.root);
  assert.equal(result.ok, true, result.violations.join('\n'));
});

test('orphan reading components cannot inherit legacy algorithms', (t) => {
  const f = fixture(t);
  f.write('src/alg/retrieval.ts', productSource('src/alg/retrieval.ts'));
  f.write('src/components/reading/Viewer.tsx', "import '@/alg/retrieval';");
  rejectsOnlyEdge(checkReadingBoundaries(f.root), 'reading', 'src/components/reading/Viewer.tsx', 'src/alg/retrieval.ts');
});

test('orphan legacy widgets cannot reach orphan reading components', (t) => {
  const f = fixture(t);
  f.write('src/components/reading/Viewer.tsx', 'export const viewer = true;');
  f.write('src/components/DraftButton.tsx', productSource('src/components/DraftButton.tsx'));
  f.append('src/components/DraftButton.tsx', "import '@/components/reading/Viewer';");
  rejectsOnlyEdge(checkReadingBoundaries(f.root), 'legacy', 'src/components/DraftButton.tsx', 'src/components/reading/Viewer.tsx');
});

test('unreviewed components outside the reading directory do not become shared by default', (t) => {
  const f = fixture(t);
  f.write('src/components/shared/Card.tsx', 'export const card = true;');
  f.append('src/app/material/page.tsx', "import '@/components/shared/Card';");
  rejectsOnlyEdge(checkReadingBoundaries(f.root), 'reading', 'src/app/material/page.tsx', 'src/components/shared/Card.tsx');
});

for (const [target, mode] of [
  ['src/alg/retrieval.ts', 'reading'],
  ['src/server/kb/reading.ts', 'legacy'],
]) {
  test(`the shared Panel remains neutral without consumers (${mode} direction)`, (t) => {
    const f = fixture(t);
    f.write('src/components/Panel.tsx', productSource('src/components/Panel.tsx'));
    if (target === 'src/alg/retrieval.ts') f.write(target, productSource(target));
    assert.deepEqual(checkReadingBoundaries(f.root).violations, []);
    f.append('src/components/Panel.tsx', `import ${JSON.stringify(aliasFor(target))};`);
    rejectsOnlyEdge(checkReadingBoundaries(f.root), mode, 'src/components/Panel.tsx', target);
  });
}
