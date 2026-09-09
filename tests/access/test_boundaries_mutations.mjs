import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { accessSourceViolations, checkAccessBoundaries } from '../../ci/access_boundary_check.mjs';
import { fileURLToPath } from 'node:url';

test('access foundation stays separate from framework, DB, legacy identity and operational routes', () => {
  assert.deepEqual(checkAccessBoundaries(fileURLToPath(new URL('../../', import.meta.url))).errors, []);
  for (const source of ["import x from 'next'", "import x from 'pg'", "import x from '../session'", "export * from '@/server/session'", 'import(name)', "const x = require('../session')"]) {
    assert.ok(accessSourceViolations('src/server/access/transport.ts', source).length > 0);
  }
  assert.ok(accessSourceViolations('src/contracts/access.ts', "import x from '../server/access/transport.ts'").length > 0);
  assert.ok(accessSourceViolations('src/app/page.tsx', "import x from '@/server/access/transport'").length > 0);
  assert.deepEqual(accessSourceViolations('src/contracts/access.ts', "// import x from 'next'\nconst value = 'pg';"), []);
});
async function moduleFrom(relative, before, after) {
  const url = new URL(`../../${relative}`, import.meta.url);
  let source = readFileSync(url, 'utf8');
  if (before) { assert.equal(source.split(before).length, 2); source = source.replace(before, after); }
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0);
  const js = result.outputText.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, specifier) => `from ${quote}${new URL(specifier, url).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const raw = { profile: 'session/1', uiOrigin: 'https://ui.inc02.test:8443', terminalOrigin: 'https://api.inc02.test:9443' };
const post = { method: 'POST', host: 'api.inc02.test:9443', origin: raw.uiOrigin, contentType: 'application/json', csrf: 'A'.repeat(43) };
const mutations = [
  ['M1 credential inclusion', 'src/contracts/access_transport.ts', "credentials: 'include'", "credentials: 'omit'", (m) => assert.equal(m.sessionRequest('GET').credentials, 'include')],
  ['M2 reject foreign Origin', 'src/server/access/transport.ts', 'request.origin !== config.uiOrigin', 'false', (m) => assert.equal(m.transportEnvelope(raw, { ...post, origin: 'https://evil.inc02.test:8443' }), false)],
  ['M3 independent CSRF', 'src/server/access/transport.ts', "request.method === 'POST' && tokenMatches(request.csrf, expected)", 'true', (m) => assert.equal(m.csrfMatches({ ...post, csrf: 'B'.repeat(43) }, 'A'.repeat(43)), false)],
  ['M4 no wildcard CORS', 'src/server/access/transport.ts', "'access-control-allow-origin': config.uiOrigin", "'access-control-allow-origin': '*'", (m) => assert.equal(m.corsHeaders(raw)['access-control-allow-origin'], raw.uiOrigin)],
  ['M5 no client-selected downgrade', 'src/contracts/access_transport.ts', 'value.profile !== SESSION_TRANSPORT ||', '', (m) => assert.throws(() => m.sessionTransport({ ...raw, profile: 'reading/1' }))],
  ['M6 duplicate cookie', 'src/server/access/transport.ts', 'found.length !== 1', 'found.length < 1', (m) => assert.equal(m.sessionToken(`__Host-ledgerdesk-session=${'A'.repeat(43)};__Host-ledgerdesk-session=${'A'.repeat(43)}`), null)],
  ['M7 exact preflight headers', 'src/server/access/transport.ts', "CSRF_HEADER, 'x-ledgerdesk-intent']", "CSRF_HEADER, 'x-ledgerdesk-intent', 'authorization']", (m) => assert.equal(m.preflightHeaders(raw)['access-control-allow-headers'], 'content-type, x-ledgerdesk-csrf, x-ledgerdesk-intent')],
  ['M8 exact preflight method', 'src/server/access/transport.ts', "const preflightMethods = 'POST'", "const preflightMethods = 'POST, DELETE'", (m) => assert.equal(m.preflightHeaders(raw)['access-control-allow-methods'], 'POST')],
  ['M9 bounded preflight cache', 'src/server/access/transport.ts', "'access-control-max-age': '60'", "'access-control-max-age': '86400'", (m) => assert.equal(m.preflightHeaders(raw)['access-control-max-age'], '60')],
];
for (const [name, file, before, after, oracle] of mutations) {
  test(`${name}: baseline passes and behavior mutation is caught`, async () => {
    oracle(await moduleFrom(file));
    const mutant = await moduleFrom(file, before, after);
    assert.throws(() => oracle(mutant), { code: 'ERR_ASSERTION' });
  });
}
