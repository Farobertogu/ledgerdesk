import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { trialEnv } from './T04_seed.mjs';
import { PROBLEMS } from '../../src/contracts/material_reading.ts';

const origin = 'http://127.0.0.1:3180';
// Mutated modules exist only in memory. No source, build, database or fixture is edited.
async function moduleFrom(relative, before, after) {
  const path = new URL(`../../${relative}`, import.meta.url);
  let source = readFileSync(path, 'utf8');
  if (before) {
    assert.equal(source.split(before).length, 2, 'The mutation must have exactly one target');
    source = source.replace(before, after);
  }
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0);
  const js = result.outputText.replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, specifier) => `from ${quote}${new URL(specifier, path).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}
const response = body => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
});
const ref = id => ({ unit_id: id, version_id: 'v1' });
const list = { contract: 'reading/1', existence_signal: false,
  items: ['A', 'B'].map(id => ({ kind: 'REFERENCE', reference: ref(id), metadata: {} })) };
const detail = id => ({ contract: 'reading/1', projection: { kind: 'CONTENT', reference: ref(id),
  metadata: {}, original_language: 'en', original_text: `Original ${id}` } });

async function readerTransport({ Reader }) {
  let sent;
  const reader = new Reader(async (url, init) => { sent = { url, init }; return response(list); }, origin);
  await reader.reload(); assert.equal(reader.snapshot().phase, 'ready');
  assert.equal(sent.url, origin + '/api/v1/material'); assert.equal(sent.init.credentials, 'omit');
}
async function readerSequence({ Reader }) {
  const pending = [];
  const reader = new Reader((url, init) => new Promise(resolve => pending.push({ url, init, resolve })), origin);
  const loading = reader.reload(); pending.shift().resolve(response(list)); await loading;
  const a = reader.select(ref('A')), b = reader.select(ref('B'));
  pending[1].resolve(response(detail('B'))); await b;
  pending[0].resolve(response(detail('A'))); await a;
  assert.equal(reader.snapshot().detail.reference.unit_id, 'B');
}
async function terminalOrigin({ startReadingTerminal }) {
  let reads = 0;
  const terminal = await startReadingTerminal({ env: { ...trialEnv, LEDGERDESK_READING_UI_ORIGIN: origin },
    createStore: () => ({ async connect() {}, async acquire() {}, async release() {}, async close() {},
      async observe() {}, available: () => true,
      async prepare() { reads++; return { receiptId: 'synthetic', revision: '1', earliestExpiry: null, response: PROBLEMS[404] }; },
    }),
  });
  try {
    const rejected = await fetch(terminal.url + '/api/v1/material', {
      headers: { origin: 'http://127.0.0.1:3181' }, signal: AbortSignal.timeout(2000),
    });
    await rejected.text(); assert.equal(rejected.status, 403); assert.equal(reads, 0);
    const allowed = await fetch(terminal.url + '/api/v1/material', { headers: { origin }, signal: AbortSignal.timeout(2000) });
    await allowed.text(); assert.equal(allowed.status, 404); assert.equal(reads, 1);
    assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  } finally { await terminal.close(); }
}

const mutations = [
  ['M1 port upper bound', 'src/contracts/reading_origin.ts', 'port > 65535', 'false',
    async ({ readLoopbackOrigin }) => assert.equal(readLoopbackOrigin('http://127.0.0.1:65536'), null)],
  ['M2 reject foreign Origin before preparing', 'src/server/reading/terminal.ts',
    'if (!uiOrigin || origin !== uiOrigin)', 'if (false)', terminalOrigin],
  ['M3 no wildcard response origin', 'src/server/reading/terminal.ts',
    "res.setHeader('Access-Control-Allow-Origin', uiOrigin)", "res.setHeader('Access-Control-Allow-Origin', '*')", terminalOrigin],
  ['M4 explicit terminal destination', 'src/components/reading/reader.ts', 'this.serviceOrigin + url', 'url', readerTransport],
  ['M5 omit browser credentials', 'src/components/reading/reader.ts', "credentials: 'omit'", "credentials: 'include'", readerTransport],
  ['M6 late selection guard', 'src/components/reading/reader.ts', ' || sequence !== this.detailSequence', '', readerSequence],
];
for (const [name, path, before, after, oracle] of mutations) {
  test(`T05 ${name}: baseline passes and the deliberate defect is caught`, { timeout: 5000 }, async () => {
    await oracle(await moduleFrom(path));
    const mutant = await moduleFrom(path, before, after);
    // Parse/import failures do not count as catching the intended behavior.
    await assert.rejects(() => oracle(mutant), error => error.code === 'ERR_ASSERTION');
  });
}
