import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EXTRACTION_BOUNDS, readWorkerReply } from '../../../../src/contracts/intake_extraction.ts';
import { requestFixture } from '../interface_fixtures.mjs';
import { CSV_REFERENCES, assertCsvReference } from './csv.mjs';

// Expectations were fixed in the retained original-file manifests, not by this worker.
const fixtures = new URL('../../t01/fixtures/', import.meta.url);
const boundaries = new URL('../../t01/boundaries/', import.meta.url);
const originalManifest = JSON.parse(await fs.readFile(new URL('manifest.json', fixtures), 'utf8'));
const securityFixtures = new URL('security/', import.meta.url);
const securityManifest = JSON.parse(await fs.readFile(new URL('manifest.json', securityFixtures), 'utf8'));
export const BOUNDARIES = JSON.parse(await fs.readFile(new URL('expected.json', boundaries), 'utf8')).cases;
export const TEXT = 'AZ-17\r\nFor procedure AZ-17, receipt Q is required.\r\nUnder condition Z, receipt R replaces receipt Q.\r\nAZ-18\r\nUnder condition Z, receipt S replaces receipt Q.\r\nEspañol: información. Cafe\u0301. 😀\r\n';
export const MARKDOWN = '# Procedure\n<script>doNotExecute()</script>\n![remote](https://example.invalid/image.png)\nShort substantive rule.\n';

export async function original(name) {
  const boundary = BOUNDARIES.find(row => row.file === name);
  const security = securityManifest.files.find(row => row.name === name);
  const reference = boundary ?? security ?? originalManifest.files.find(row => row.name === name);
  assert.ok(reference, `No fixed reference for ${name}`);
  const location = new URL(name, boundary ? boundaries : security ? securityFixtures : fixtures);
  const bytes = await fs.readFile(location);
  assert.deepEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    { bytes: reference.bytes, sha256: reference.sha256 }, 'Original identity changed');
  return { bytes, path: fileURLToPath(location), reference };
}

export async function requestFor(name, format) {
  const input = await original(name);
  const request = requestFixture();
  request.binding.original.bytes = input.reference.bytes;
  request.binding.original.sha256 = input.reference.sha256;
  request.binding.format_profile = format;
  return { ...input, request };
}

export function assertBoundary(observation, reference) {
  const extraction = observation.extraction;
  assert.equal(extraction.outcome, 'completed');
  assert.deepEqual(extraction.elements.map(sheet => sheet.cells.length), reference.counts);
  assert.equal(extraction.inventory.cells, reference.counts.reduce((sum, count) => sum + count, 0));
  for (const [sheetIndex, sheet] of extraction.elements.entries()) {
    assert.equal(sheet.name, `Part${sheetIndex + 1}`);
    for (const [index, cell] of sheet.cells.entries()) {
      const row = index + 1;
      const expectedValue = sheetIndex * 100000 + row;
      assert.deepEqual({ address: cell.address, value: cell.value, lexical: cell.storedLexical, locator: cell.locator },
        { address: `A${row}`, value: expectedValue, lexical: String(expectedValue), locator: {
          original: reference.sha256, part: `xl/worksheets/sheet${sheetIndex + 1}.xml`, sheetId: String(sheetIndex + 1), cell: `A${row}`,
        } });
    }
  }
  assert.ok(extraction.inventory.observedExpandedBytes < EXTRACTION_BOUNDS.expandedBytes);
  assert.ok(extraction.inventory.members < EXTRACTION_BOUNDS.members);
}

export function assertLiteralObservation(name, observation, bytes) {
  assert.equal(observation.runtime.sheetjs, '0.20.3');
  assert.equal(observation.runtime.node, 'v22.16.0');
  assert.deepEqual(observation.extraction.relations, []);
  assert.deepEqual(observation.extraction.resources, []);
  if (name === 'short.txt') assert.equal(observation.raw.text, 'No.');
  else if (name === 'text.txt') assert.equal(observation.raw.text, TEXT);
  else if (name === 'inert.md') assert.equal(observation.raw.text, MARKDOWN);
  else if (Object.hasOwn(CSV_REFERENCES, name)) assertCsvReference(observation.extraction, bytes, CSV_REFERENCES[name]);
  else {
    const boundary = BOUNDARIES.find(row => row.file === name);
    if (boundary) assertBoundary(observation, boundary);
    else if (['baseline.xlsx', 'repacked.xlsx', 'cache-discrepant.xlsx', 'cache-missing.xlsx', 'cache-zero.xlsx'].includes(name)) {
      const d2 = observation.extraction.elements[0].cells.find(cell => cell.address === 'D2');
      const lexical = { 'baseline.xlsx': '25.00', 'repacked.xlsx': '25.00', 'cache-discrepant.xlsx': '24.00', 'cache-zero.xlsx': '0' }[name];
      assert.equal(d2.formula.storedExpression, 'B2*C2');
      assert.deepEqual(d2.formula.cached, lexical === undefined ? { availability: 'not_available' } :
        { availability: 'observed', lexical, sourceType: 'n' });
    } else throw Error(`No independent assertion for ${name}`);
  }
}

// The integration harness supplies the clean Linux launcher. No expected answers enter the worker.
// The callback mounts only inputPath at /input/original and passes requestBytes through stdin.
// It returns { stdout: Buffer, code, signal }; argv is empty unless a rejection case specifies it.
export async function runFixedEntryCases(invoke) {
  const results = [];
  const positive = [
    ['short.txt', 'text-utf8/1'], ['text.txt', 'text-utf8/1'], ['inert.md', 'markdown-inert/1'],
    ['table.csv', 'csv-utf8/1'], ['unicode-records.csv', 'csv-utf8/1'],
    ...['baseline.xlsx', 'repacked.xlsx', 'cache-discrepant.xlsx', 'cache-missing.xlsx', 'cache-zero.xlsx'].map(name => [name, 'xlsx-cells/1']),
    ...BOUNDARIES.filter(row => row.expected === 'completed').map(row => [row.file, 'xlsx-cells/1']),
  ];
  for (const [name, format] of positive) {
    const input = await requestFor(name, format);
    const actual = await invoke({ inputPath: input.path, requestBytes: Buffer.from(JSON.stringify(input.request)), argv: [] });
    assert.equal(actual.code, 0); assert.equal(actual.signal ?? null, null);
    assert.ok(Buffer.isBuffer(actual.stdout)); assert.ok(actual.stdout.length <= EXTRACTION_BOUNDS.stdoutBytes);
    const reply = readWorkerReply(actual.stdout);
    assert.deepEqual(reply.binding, input.request.binding);
    assert.equal(reply.outcome.kind, 'produced');
    const observation = reply.outcome.observation;
    assertLiteralObservation(name, observation, input.bytes);
    results.push({ name, kind: 'produced', observationBytes: Buffer.byteLength(JSON.stringify(observation)), envelopeBytes: actual.stdout.length });
  }
  for (const [name, format, code] of [
    ['invalid-utf8.txt', 'text-utf8/1', 'invalid_utf8'], ['invalid-utf8.csv', 'csv-utf8/1', 'invalid_utf8'],
    ['utf16.csv', 'csv-utf8/1', 'unsupported_encoding'],
    ['macro-declared.xlsx', 'xlsx-cells/1', 'unsupported_workbook_type'],
    ['entity-declared.xlsx', 'xlsx-cells/1', 'xml_declaration_forbidden'],
    ...BOUNDARIES.filter(row => row.expected !== 'completed').map(row => [row.file, 'xlsx-cells/1', row.expected]),
  ]) {
    const input = await requestFor(name, format);
    const actual = await invoke({ inputPath: input.path, requestBytes: Buffer.from(JSON.stringify(input.request)), argv: [] });
    assert.equal(actual.code, 0); const reply = readWorkerReply(actual.stdout);
    assert.deepEqual(reply, { profile: 'intake-worker/3', kind: 'result', binding: input.request.binding,
      outcome: { kind: 'failed', producer_code: code } });
    results.push({ name, kind: 'failed', code });
  }
  const input = await requestFor('short.txt', 'text-utf8/1');
  for (const field of ['bytes', 'sha256']) {
    const request = structuredClone(input.request);
    request.binding.original[field] = field === 'bytes' ? 2 : '0'.repeat(64);
    const actual = await invoke({ inputPath: input.path, requestBytes: Buffer.from(JSON.stringify(request)), argv: [] });
    assert.equal(actual.code, 0);
    assert.deepEqual(readWorkerReply(actual.stdout).outcome, { kind: 'failed', producer_code: 'input_identity_mismatch' });
    results.push({ name: `wrong-${field}`, kind: 'failed', code: 'input_identity_mismatch' });
  }
  const invalid = [
    ['extra-field', { ...input.request, mutation: 'replace-invalid-utf8' }, []],
    ['path-override', { ...input.request, input_path: '/tmp/other' }, []],
    ['foreign-format', { ...input.request, binding: { ...input.request.binding, format_profile: 'pdf/1' } }, []],
    ['positional-argument', input.request, ['replace-invalid-utf8']],
  ];
  for (const [name, request, argv] of invalid) {
    const actual = await invoke({ inputPath: input.path, requestBytes: Buffer.from(JSON.stringify(request)), argv });
    assert.equal(actual.code, 2); assert.equal(actual.stdout.length, 0);
    results.push({ name, kind: 'rejected' });
  }
  return results;
}
