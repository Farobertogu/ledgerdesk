import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extract } from '../../../workers/intake/extraction/adapter.mjs';
import { readCommand, encodeReply, producerCode } from '../../../workers/intake/extraction/entry.mjs';
import { EXTRACTION_BOUNDS, readWorkerReply, readWorkerRequest } from '../../../src/contracts/intake_extraction.ts';
import { BOUNDARIES, TEXT, MARKDOWN, original, requestFor, assertBoundary, assertLiteralObservation } from './references/cases.mjs';
import { CSV_REFERENCES, assertCsvReference } from './references/csv.mjs';

const requireWorker = createRequire(new URL('../../../workers/intake/extraction/package.json', import.meta.url));
async function produce(name, profile) {
  const input = await original(name);
  const before = { bytes: input.bytes.length, sha256: createHash('sha256').update(input.bytes).digest('hex') };
  const result = await extract(input.bytes, profile);
  // SheetJS attaches parser cursor helpers to the Buffer object. Identity concerns its bytes.
  assert.deepEqual({ bytes: input.bytes.length, sha256: createHash('sha256').update(input.bytes).digest('hex') }, before,
    'Extraction changed original bytes');
  return result;
}
async function record(name, value) {
  if (process.env.INTAKE_S2_EVIDENCE_DIR) await fs.writeFile(`${process.env.INTAKE_S2_EVIDENCE_DIR}/${name}.json`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

test('W01 package uses the exact declared runtime and four direct dependency versions', async () => {
  assert.equal(process.version, 'v22.16.0');
  const versions = {};
  for (const [name, expected] of Object.entries({ 'csv-parse': '7.0.2', 'fast-xml-parser': '5.11.1', yauzl: '3.4.0', xlsx: '0.20.3' })) {
    const packagePath = fileURLToPath(new URL(`../../../workers/intake/extraction/node_modules/${name}/package.json`, import.meta.url));
    versions[name] = JSON.parse(await fs.readFile(packagePath, 'utf8')).version;
    assert.equal(versions[name], expected);
    const resolved = requireWorker.resolve(name).replaceAll('\\', '/');
    assert.ok(resolved.includes('/workers/intake/extraction/node_modules/'), resolved);
  }
  assert.equal(requireWorker('xlsx').version, '0.20.3');
  const adoptedRoot = new URL('../../../workers/intake/extraction/', import.meta.url);
  const retainedRoot = new URL('../t01/reviewed/', import.meta.url);
  const retainedLock = JSON.parse(await fs.readFile(new URL('package-lock.json', retainedRoot), 'utf8'));
  const adoptedLock = JSON.parse(await fs.readFile(new URL('package-lock.json', adoptedRoot), 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(adoptedLock.packages).filter(([key]) => key !== '')),
    Object.fromEntries(Object.entries(retainedLock.packages).filter(([key]) => key !== '')), 'Dependency lock entries changed');
  for (const name of ['profile.mjs', 'vendor/xlsx-0.20.3.tgz', 'vendor/PROVENANCE.json']) {
    assert.deepEqual(await fs.readFile(new URL(name, adoptedRoot)), await fs.readFile(new URL(name, retainedRoot)));
  }
  const provenance = JSON.parse(await fs.readFile(new URL('PROVENANCE.json', adoptedRoot), 'utf8'));
  for (const row of provenance.sources) {
    for (const [filename, expected] of [[row.source, row.source_sha256], [row.destination, row.adopted_sha256]]) {
      const bytes = await fs.readFile(new URL('../../../' + filename, import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    }
  }
  await record('runtime', { node: process.version, platform: process.platform, architecture: process.arch, versions });
});

test('W02 text and inert Markdown retain literal source and independent byte/code-point coordinates', async () => {
  for (const [name, expected] of [['text.txt', TEXT], ['short.txt', 'No.'], ['inert.md', MARKDOWN]]) {
    const input = await original(name); assert.deepEqual(input.bytes, Buffer.from(expected));
    const observation = await extract(input.bytes, 'text');
    assert.equal(observation.raw.text, expected);
    assert.equal(observation.extraction.elements.map(element => element.text).join(''), expected);
    assert.deepEqual(observation.extraction.original, { name: 'original', bytes: input.reference.bytes, sha256: input.reference.sha256 });
    if (name === 'text.txt') {
      assert.deepEqual(observation.extraction.elements[2].locator.byteRange, [52, 102]);
      assert.deepEqual(observation.extraction.elements.at(-1).locator.codePointRange, [159, 191]);
    }
    assert.deepEqual(observation.extraction.resources, []);
    await record(name.replace('.', '-') + '-observation', observation);
  }
  const bom = await produce('bom.txt', 'text');
  assert.deepEqual(bom.raw, { text: 'Información\r\n', bomBytes: 3 });
  assert.deepEqual(bom.extraction.elements[0].locator.byteRange, [3, 17]);
});

test('W03 framing measures both real 10000-cell observations before accepting the full envelope', async () => {
  const measured = [];
  for (const name of ['cells-at.xlsx', 'cells-distributed-at.xlsx']) {
    const input = await requestFor(name, 'xlsx-cells/1');
    const observation = await extract(input.bytes, 'xlsx');
    assertBoundary(observation, input.reference);
    const text = JSON.stringify(observation);
    const intended = Buffer.from(JSON.stringify({ profile: 'intake-worker/3', kind: 'result', binding: input.request.binding,
      outcome: { kind: 'produced', observation } }) + '\n');
    const actual = encodeReply(input.request.binding, { kind: 'produced', observation });
    const size = { name, originalBytes: input.bytes.length, expandedBytes: observation.extraction.inventory.observedExpandedBytes,
      cells: observation.extraction.inventory.cells, observationBytes: Buffer.byteLength(text), envelopeBytes: intended.length,
      emittedBytes: actual.length, outcome: readWorkerReply(actual).outcome.kind };
    measured.push(size); await record(name + '-observation', observation); await record(name + '-sizes', size);
    assert.deepEqual(actual, intended, 'An admitted at-limit original did not fit its actual envelope');
    assert.ok(actual.length <= EXTRACTION_BOUNDS.stdoutBytes);
    assertBoundary(readWorkerReply(actual).outcome.observation, input.reference);
  }
  await record('boundary-measurements', measured);
});

test('W04 CSV positional fields and record ranges match parser-independent references', async () => {
  for (const [name, reference] of Object.entries(CSV_REFERENCES)) {
    const input = await original(name); const observation = await extract(input.bytes, 'csv');
    assertCsvReference(observation.extraction, input.bytes, reference);
    await record(name + '-observation', observation);
  }
  const input = await original('bom.csv');
  assertCsvReference((await extract(input.bytes, 'csv')).extraction, input.bytes, {
    bomBytes: 3, records: ['Code,Note\n', '001,Información\n'], fields: [['Code', 'Note'], ['001', 'Información']],
  });
});

test('W05 strict input UTF-8 has no text/CSV bypass and preserves a legitimate replacement character', async () => {
  for (const [extension, profile] of [['txt', 'text'], ['csv', 'csv']]) {
    for (const prefix of ['invalid-utf8', 'truncated-utf8']) await assert.rejects(produce(`${prefix}.${extension}`, profile), { code: 'invalid_utf8' });
    await assert.rejects(produce(`utf16.${extension}`, profile), { code: 'unsupported_encoding' });
  }
  assert.equal((await extract(Buffer.from('literal �'), 'text')).raw.text, 'literal �');
  assertCsvReference((await produce('unicode-records.csv', 'csv')).extraction, (await original('unicode-records.csv')).bytes, CSV_REFERENCES['unicode-records.csv']);
});

test('W06 CSV count and decoded-record limits discriminate the exact at/one-over boundary', async () => {
  for (const [at, over, code, check] of [
    ['records-at-limit.csv', 'records-over-limit.csv', 'record_limit', value => assert.equal(value.extraction.inventory.records, 1000)],
    ['columns-at-limit.csv', 'columns-over-limit.csv', 'column_limit', value => assert.equal(value.extraction.elements[0].rows[0].fields.length, 64)],
    ['record-at-limit.csv', 'record-over-limit.csv', 'csv_record_limit', value => assert.equal(Math.max(...value.extraction.elements[0].rows.map(row => row.fields.reduce((sum, v) => sum + v.length, 0))), 65536)],
    ['multibyte-at-limit.csv', 'multibyte-over-limit.csv', 'csv_record_limit', value => assert.equal(Math.max(...value.extraction.elements[0].rows.map(row => row.fields.reduce((sum, v) => sum + v.length, 0))), 65536)],
  ]) { check(await produce(at, 'csv')); await assert.rejects(produce(over, 'csv'), { code }); }
  // Neither individual field reaches the bound; their sum does. This detects a per-field substitution.
  const csv = count => Buffer.from('a,b\n' + 'x'.repeat(32768) + ',' + 'y'.repeat(count) + '\n');
  const valid = await extract(csv(32768), 'csv');
  assert.deepEqual(valid.extraction.elements[0].rows[1].fields.map(value => value.length), [32768, 32768]);
  await assert.rejects(extract(csv(32769), 'csv'), { code: 'csv_record_limit' });
  await assert.rejects(produce('uneven.csv', 'csv'), { code: 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH' });
  await assert.rejects(produce('broken-quotes.csv', 'csv'), { code: 'CSV_QUOTE_NOT_CLOSED' });
});

test('W07 XLSX lexical caches remain discrepant, missing or zero without recalculation', async () => {
  for (const name of ['baseline.xlsx', 'cache-discrepant.xlsx', 'cache-missing.xlsx', 'cache-zero.xlsx']) {
    const input = await original(name); const observation = await extract(input.bytes, 'xlsx');
    assertLiteralObservation(name, observation, input.bytes);
    const sheet = observation.extraction.elements[0]; const cell = address => sheet.cells.find(row => row.address === address);
    assert.equal(cell('A2').storedLexical, '001'); assert.equal(cell('A2').value, '001');
    assert.equal(cell('B3').availability, 'no_stored_value'); assert.equal(Object.hasOwn(cell('B3'), 'storedLexical'), false);
    assert.equal(cell('B4').storedLexical, '0'); assert.equal(cell('B4').value, 0);
    assert.equal(cell('B5').sourceType, 'e'); assert.equal(cell('B5').storedLexical, '#N/A');
    assert.equal(cell('C2').numberFormat, '0.00');
    assert.equal(cell('A7').value, 'Amounts are in USD and exclude tax.');
    assert.equal(cell('B8').formula.storedExpression, "'Conditions'!B2");
    assert.equal(cell('B8').formula.cached.lexical, 'Under condition Z, receipt R replaces receipt Q.');
    assert.deepEqual(sheet.hiddenRows, ['6']); assert.deepEqual(sheet.merged, ['A7:D7', 'B8:D8']);
    assert.equal(observation.extraction.elements[1].visibility, 'hidden');
    assert.deepEqual(sheet.columns[0], { '@_min': '1', '@_max': '1', '@_width': '19', '@_hidden': '0', '@_customWidth': '1' });
    await record(name + '-observation', observation);
  }
  const wrong = await produce('incorrect-dimension.xlsx', 'xlsx');
  assert.equal(wrong.extraction.elements[0].declaredDimension, 'A1:A1');
  assert.ok(wrong.extraction.elements[0].cells.some(cell => cell.address === 'B8'));
  const partial = await produce('unsupported-part.xlsx', 'xlsx');
  assert.equal(partial.extraction.outcome, 'partial');
  assert.ok(partial.extraction.coverage.unsupported.includes('xl/media/image1.svg'));
  assert.deepEqual(partial.extraction.resources, []); assert.deepEqual(partial.extraction.relations, []);
});

test('W08 physical XLSX sheet and cell negatives are not masked by original size or unrelated limits', async () => {
  const positive = BOUNDARIES.find(row => row.file === 'sheets-at.xlsx');
  assertBoundary(await produce(positive.file, 'xlsx'), positive);
  for (const reference of BOUNDARIES.filter(row => row.expected !== 'completed')) {
    const input = await original(reference.file); assert.ok(input.bytes.length < EXTRACTION_BOUNDS.originalBytes);
    await assert.rejects(extract(input.bytes, 'xlsx'), { code: reference.expected });
  }
});

test('W09 container format checks reject external links, invalid XML and ZIP expansion/member abuse', async () => {
  await produce('baseline.xlsx', 'xlsx');
  for (const [name, code] of [
    ['external-link.xlsx', 'external_relationship'], ['invalid-xml-utf8.xlsx', 'invalid_utf8'],
    ['zip-expansion-limit.xlsx', 'expanded_limit'], ['zip-member-limit.xlsx', 'member_limit'],
  ]) await assert.rejects(produce(name, 'xlsx'), { code });
  await assert.rejects(produce('zip-traversal.xlsx', 'xlsx'), /invalid relative path|unsafe_zip_entry/);
  await assert.rejects(extract(Buffer.from('No.'), 'pdf'), { code: 'unsupported_profile' });
});

test('W10 request rejects malformed UTF-8/JSON/closed fields before any original access', async () => {
  const { request } = await requestFor('short.txt', 'text-utf8/1');
  const bytes = Buffer.from(JSON.stringify(request));
  assert.deepEqual(await readCommand(Readable.from([bytes])), request);
  assert.deepEqual(await readCommand(Readable.from([...bytes].map(value => Buffer.from([value])))), request);
  // All admitted string values in this closed request are ASCII identifiers/constants.
  // Invalid multibyte input must fail identically with complete or fragmented transport.
  for (const bad of [Buffer.from([0xC3, 0x28]), Buffer.from('{}{}'), Buffer.from('{"profile":"a","profile":"b"}'),
    Buffer.from(JSON.stringify({ ...request, mutation: 'replace-invalid-utf8' })),
    Buffer.from(JSON.stringify({ ...request, profile: 'intake-worker/2' })),
    Buffer.from(JSON.stringify({ ...request, input_path: '/tmp/other' })),
    Buffer.from(JSON.stringify({ ...request, limits: { ...request.limits, cells: 1 } })),
    Buffer.from(JSON.stringify({ ...request, binding: { ...request.binding, format_profile: 'pdf/1' } })),
    Buffer.alloc(EXTRACTION_BOUNDS.commandBytes + 1, 32)]) {
    await assert.rejects(readCommand(Readable.from([bad])));
    await assert.rejects(readCommand(Readable.from([bad.subarray(0, 1), bad.subarray(1)])));
  }
  const textual = Buffer.from(JSON.stringify(request).replace('"job-17"', '"job-17😀"'));
  // Closed identifiers reject this value after strict collection, never silently replace its bytes.
  await assert.rejects(readCommand(Readable.from([...textual].map(value => Buffer.from([value])))));
  assert.throws(() => readWorkerRequest(textual));
});

test('W11 bounded replies preserve association, unknown structured codes and exact full-envelope output limits', async () => {
  const { request } = await requestFor('short.txt', 'text-utf8/1');
  const observation = await produce('short.txt', 'text');
  const result = encodeReply(request.binding, { kind: 'produced', observation });
  const reply = readWorkerReply(result);
  assert.deepEqual(reply.binding, request.binding); assert.equal(reply.binding.original.generation, 7); assert.equal(reply.binding.attempt_generation, 1);
  assert.equal(reply.outcome.observation.raw.text, 'No.');
  // Synthetic framing control only; this is not represented as an extraction observation.
  const escaped = encodeReply(request.binding, { kind: 'produced', observation: { raw: '\u0001'.repeat(Math.ceil(EXTRACTION_BOUNDS.stdoutBytes / 6)) } });
  assert.deepEqual(readWorkerReply(escaped).outcome, { kind: 'failed', producer_code: 'output_limit' });
  assert.equal(producerCode({ code: 'FUTURE_CODE_42', message: '/secret/file' }), 'FUTURE_CODE_42');
  for (const error of [new Error('/secret/file'), { code: '/secret/file' }, { code: 'bad\nvalue' }, { code: 'x'.repeat(65) }]) assert.equal(producerCode(error), 'unknown');
});

test('W13 original byte limit admits exactly 1 MiB and rejects the next byte', async () => {
  const at = await original('at-byte-limit.txt');
  const observation = await extract(at.bytes, 'text');
  assert.equal(observation.extraction.original.bytes, 1048576);
  assert.equal(Buffer.byteLength(observation.raw.text), 1048576);
  assert.deepEqual(Buffer.from(observation.raw.text), at.bytes);
  await assert.rejects(produce('over-byte-limit.txt', 'text'), { code: 'input_limit' });
});

async function assertDirectRoundTrip(name, input, format, verify) {
  const { request } = await requestFor('short.txt', 'text-utf8/1');
  const sha256 = createHash('sha256').update(input).digest('hex');
  Object.assign(request.binding.original, { bytes: input.length, sha256 });
  request.binding.format_profile = { text: 'text-utf8/1', csv: 'csv-utf8/1' }[format];
  const observation = await extract(input, format);
  verify(observation);
  const encoded = encodeReply(request.binding, { kind: 'produced', observation });
  const reply = readWorkerReply(encoded);
  assert.equal(reply.profile, 'intake-worker/3');
  assert.equal(reply.outcome.kind, 'produced', 'An admitted reference became a producer failure');
  assert.equal(Object.hasOwn(reply.outcome, 'observation_json'), false);
  assert.deepEqual(reply.binding, request.binding);
  assert.deepEqual(reply.outcome.observation, JSON.parse(JSON.stringify(observation)));
  verify(reply.outcome.observation);
  assert.equal(createHash('sha256').update(input).digest('hex'), sha256);
  const measured = { name, inputBytes: input.length, inputSha256: sha256, outputBytes: encoded.length,
    observationBytes: Buffer.byteLength(JSON.stringify(observation)), outcome: reply.outcome.kind,
    stdoutBound: EXTRACTION_BOUNDS.stdoutBytes, scope: 'Actual host extractor and encoder, not storage or protected query' };
  if (process.env.INTAKE_S2_EVIDENCE_DIR) {
    await fs.writeFile(`${process.env.INTAKE_S2_EVIDENCE_DIR}/${name}.original`, input, { flag: 'wx' });
    await fs.writeFile(`${process.env.INTAKE_S2_EVIDENCE_DIR}/${name}.reply`, encoded, { flag: 'wx' });
  }
  await record(`${name}-measurement`, measured);
}

test('W14 direct observation preserves small and at-limit control characters and ordinary text', async () => {
  for (const [name, size, byte] of [['control-small', 131072, 1], ['control-at', 1048576, 1], ['plain-at', 1048576, 120]]) {
    await assertDirectRoundTrip(name, Buffer.alloc(size, byte), 'text', value => {
      assert.equal(value.raw.text, String.fromCharCode(byte).repeat(size));
      assert.equal(value.extraction.elements.length, 1);
      assert.equal(value.extraction.elements[0].text, String.fromCharCode(byte).repeat(size));
      assert.deepEqual(value.extraction.elements[0].locator.byteRange, [0, size]);
      assert.deepEqual(value.extraction.elements[0].locator.codePointRange, [0, size]);
    });
  }
});

test('W15 CSV escaped content remains positional at the combined byte, record and field limits', async () => {
  const field = '\u0001'.repeat(65535), line = field + '\n';
  await assertDirectRoundTrip('csv-escaped-at', Buffer.from(line.repeat(16)), 'csv', value => {
    assert.equal(value.extraction.inventory.records, 16);
    value.extraction.elements[0].rows.forEach((row, index) => {
      assert.deepEqual(row.fields, [field]); assert.equal(row.raw, line);
      assert.deepEqual(row.originalByteRange, [index * 65536, (index + 1) * 65536]);
    });
  });
  const totalFields = 64000, contentBytes = 1048576 - totalFields;
  const fields = Array.from({ length: totalFields }, (_, i) => '\u0001'.repeat(Math.floor(contentBytes / totalFields) + (i < contentBytes % totalFields ? 1 : 0)));
  const rows = Array.from({ length: 1000 }, (_, i) => fields.slice(i * 64, (i + 1) * 64).join(',') + '\n');
  const input = Buffer.from(rows.join('')); assert.equal(input.length, 1048576);
  await assertDirectRoundTrip('csv-escaped-cardinality-at', input, 'csv', value => {
    assert.equal(value.extraction.inventory.records, 1000);
    assert.deepEqual(value.extraction.elements[0].headers, fields.slice(0, 64));
    let offset = 0;
    value.extraction.elements[0].rows.forEach((row, index) => {
      assert.deepEqual(row.fields, fields.slice(index * 64, (index + 1) * 64));
      assert.equal(row.raw, rows[index]);
      assert.deepEqual(row.originalByteRange, [offset, offset + rows[index].length]);
      offset += rows[index].length;
    });
    assert.equal(offset, input.length);
  });
});

test('W16 full reply at its byte cap fits even with maximum bindings; the next byte fails explicitly', async () => {
  const { request } = await requestFor('short.txt', 'text-utf8/1');
  for (const [key, value] of Object.entries(request.binding)) {
    if (value && typeof value === 'object') {
      value.id = 'i'.repeat(128);
      if ('revision' in value) value.revision = Number.MAX_SAFE_INTEGER;
      if ('generation' in value) value.generation = Number.MAX_SAFE_INTEGER;
    } else if (['deployment', 'claim_id', 'channel_id'].includes(key)) request.binding[key] = 'i'.repeat(128);
  }
  request.binding.attempt_generation = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(readWorkerRequest(Buffer.from(JSON.stringify(request))), request);
  // Synthetic wire boundary, deliberately not an original-file extraction.
  const prefix = Buffer.byteLength(JSON.stringify({ profile: 'intake-worker/3', kind: 'result', binding: request.binding,
    outcome: { kind: 'produced', observation: { padding: '' } } }) + '\n');
  const available = EXTRACTION_BOUNDS.stdoutBytes - prefix;
  const padding = '\u0001'.repeat(Math.floor(available / 6)) + 'x'.repeat(available % 6);
  const at = encodeReply(request.binding, { kind: 'produced', observation: { padding } });
  assert.equal(at.length, EXTRACTION_BOUNDS.stdoutBytes);
  assert.equal(readWorkerReply(at).outcome.observation.padding, padding);
  const over = encodeReply(request.binding, { kind: 'produced', observation: { padding: padding + 'x' } });
  assert.deepEqual(readWorkerReply(over).outcome, { kind: 'failed', producer_code: 'output_limit' });
  assert.ok(over.length <= EXTRACTION_BOUNDS.failureBytes);
  await record('full-envelope-boundary', { kind: 'Synthetic wire control, not a physical producer run', at: at.length,
    oneOverIntended: at.length + 1, fallbackBytes: over.length, bindingBytes: Buffer.byteLength(JSON.stringify(request.binding)) });
});

test('W17 revised replies reject old, nested, ambiguous and invalid scalar forms', async () => {
  const { request } = await requestFor('short.txt', 'text-utf8/1');
  const observation = await produce('short.txt', 'text');
  const reply = { profile: 'intake-worker/3', kind: 'result', binding: request.binding, outcome: { kind: 'produced', observation } };
  assert.equal(readWorkerReply(Buffer.from(JSON.stringify(reply))).outcome.observation.raw.text, 'No.');
  for (const value of [ { ...reply, profile: 'intake-worker/2' },
    { ...reply, outcome: { kind: 'produced', observation_json: JSON.stringify(observation) } },
    { ...reply, outcome: { ...reply.outcome, observation_json: '{}' } },
    { ...reply, outcome: { kind: 'produced', observation: 'not an object' } },
    { ...reply, binding: { ...request.binding, attempt_generation: 1.5 } },
  ]) assert.throws(() => readWorkerReply(Buffer.from(JSON.stringify(value))));
  const frame = JSON.stringify(reply);
  for (const bytes of [Buffer.from(frame.replace('"attempt_generation":1', '"attempt_generation":1.0')),
    Buffer.from(frame.replace('"revision":1', '"revision":1e0')),
    Buffer.from(frame.replace('"bytes":3', '"bytes":3.0')),
    Buffer.from(frame.replace('"No."', '"\\ud800"')),
    Buffer.from(frame.replace('"raw":', '"raw":{},"raw":')),
    Buffer.concat([Buffer.from(frame.slice(0, -1)), Buffer.from([0xc3, 0x28]), Buffer.from('}')])])
    assert.throws(() => readWorkerReply(bytes));
  const decimal = encodeReply(request.binding, { kind: 'produced', observation: { measured: 0.125, text: 'literal �' } });
  assert.deepEqual(readWorkerReply(decimal).outcome.observation, { measured: 0.125, text: 'literal �' });
});

test('W18 more than 10000 lines remain exact in the real producer and revised wire representation', async () => {
  for (const size of [10000, 10001]) await assertDirectRoundTrip(`lines-${size}`, Buffer.alloc(size, 10), 'text', value => {
    assert.equal(value.extraction.elements.length, size);
    value.extraction.elements.forEach((row, i) => {
      assert.equal(row.id, `line-${i + 1}`); assert.equal(row.text, '\n');
      assert.deepEqual(row.locator.byteRange, [i, i + 1]); assert.deepEqual(row.locator.codePointRange, [i, i + 1]);
    });
  });
});

test('W12 actual host entry rejects options and malformed frames with no stdout result', async () => {
  const entry = fileURLToPath(new URL('../../../workers/intake/extraction/entry.mjs', import.meta.url));
  const run = (body, argv) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', entry, ...argv], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => { child.kill(); reject(Error('Host entry did not terminate')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }); });
    child.stdin.end(body);
  });
  const { request } = await requestFor('short.txt', 'text-utf8/1');
  for (const [body, argv] of [[Buffer.from(JSON.stringify(request)), ['replace-invalid-utf8']], [Buffer.from('{}'), []], [Buffer.from([0xC3, 0x28]), []]]) {
    const actual = await run(body, argv);
    assert.deepEqual({ code: actual.code, signal: actual.signal, stdout: actual.stdout.length }, { code: 2, signal: null, stdout: 0 });
    assert.match(actual.stderr, /worker_(?:invocation|request)_rejected/);
  }
});
