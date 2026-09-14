import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runId = 'intake-t02-preflight-' + randomUUID();
const directory = path.join(root, 'test-results', 'intake-t02', 'preflight', runId);
mkdirSync(directory, { recursive: true });
const records = [];
for (const [program, args] of [
  ['git', ['rev-parse', 'HEAD']], ['git', ['status', '--porcelain=v1']],
  ['node', ['--version']], ['docker', ['version', '--format', '{{json .}}']],
  ['docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}']],
  ['docker', ['volume', 'ls', '--format', '{{json .}}']],
  ['docker', ['image', 'ls', '--digests', '--no-trunc', '--format', '{{json .}}']],
  ['docker', ['network', 'ls', '--no-trunc', '--format', '{{json .}}']],
]) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const record = { program, args, status: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  records.push(record);
}
const inputs = ['text.txt', 'bom.txt', 'inert.md', 'table.csv', 'bom.csv', 'unicode-records.csv',
  'at-byte-limit.txt', 'over-byte-limit.txt', 'short.txt', 'baseline.xlsx', 'cache-discrepant.xlsx',
  'cache-missing.xlsx', 'cache-zero.xlsx', 'unsupported-part.xlsx', 'broken-quotes.csv', 'invalid-utf8.txt']
  .map(name => { const bytes = readFileSync(path.join(root, 'tests/intake/t01/fixtures', name));
    return { path: 'tests/intake/t01/fixtures/' + name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; });
const report = { profile: 'intake-preflight/1', runId, at: new Date().toISOString(),
  scope: 'read-only host inventory; no test infrastructure started', node: process.version, records, inputs };
writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
const passed = records.every(r => r.status === 0);
console.log(JSON.stringify({ directory, inventoryComplete: passed, commands: records.length, fixtures: inputs.length }));
if (!passed) process.exitCode = 1;
