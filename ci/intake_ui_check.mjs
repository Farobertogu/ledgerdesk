import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {collectProcessOutput} from '../tests/intake/t01/reviewed/process-output.mjs';
import {summarizeNodeTests} from './intake_test_summary.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const group = process.argv[process.argv.indexOf('--group') + 1];
if (group !== 'units') throw Error('INTAKE_UI_GROUP_REQUIRED');
const runId = 'intake-ui-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const directory = path.join(root, 'test-results/intake-ui', runId);
await fs.mkdir(directory, {recursive: true});
const sources = [], commands = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => fs.writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
async function snapshot(relative) {
  const file = path.join(root, relative), stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw Error('INTAKE_UI_SOURCE_LINK');
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(file)).sort()) await snapshot(path.posix.join(relative, name));
  } else {
    const bytes = await fs.readFile(file), target = path.join(directory, 'source', relative);
    await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, bytes, {flag: 'wx'});
    sources.push({path: relative, bytes: bytes.length, sha256: hash(bytes)});
  }
}
let outcome = 'failed', failure;
try {
  // The presentation owner may still be adapting views. These tests import no view code.
  for (const relative of ['src/contracts', 'src/server/intake/workspace',
    'src/server/intake/protocol.ts', 'src/server/intake/authority.ts', 'src/server/intake/preparation',
    'src/server/intake/service.ts', 'src/server/intake/config.ts', 'src/server/intake/ports.ts',
    'src/server/intake/postgres', 'src/server/access', 'src/components/access/view_lifecycle.ts',
    'src/components/intake/view_model.ts', 'src/components/intake/controller.ts', 'src/components/intake/client.ts', 'src/components/intake/journal.ts', 'src/components/intake/preparation.ts', 'src/components/intake/status.ts',
    'tests/intake/ui/test_workspace_contract.mjs', 'tests/intake/ui/test_journal_client.mjs', 'tests/intake/ui/test_controller_lifecycle.mjs', 'tests/intake/ui/test_preparation_draft.mjs', 'tests/intake/ui/test_boundaries.mjs', 'tests/intake/ui/test_status.mjs',
    'ci/intake_boundary_check.mjs', 'ci/access_boundary_check.mjs', 'ci/reading_boundary_check.mjs',
    'ci/intake_ui_check.mjs', 'ci/intake_test_summary.mjs', 'tests/intake/t01/reviewed/process-output.mjs']) await snapshot(relative);
  const args = ['--experimental-strip-types', '--test', 'tests/intake/ui/test_workspace_contract.mjs', 'tests/intake/ui/test_journal_client.mjs', 'tests/intake/ui/test_controller_lifecycle.mjs', 'tests/intake/ui/test_preparation_draft.mjs', 'tests/intake/ui/test_boundaries.mjs', 'tests/intake/ui/test_status.mjs'];
  const started = Date.now(), child = spawn(process.execPath, args, {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const collector = collectProcessOutput(child.stdout, child.stderr, {outputBytes: 1048576, diagnosticBytes: 65536, stop: () => child.kill()});
  const timer = setTimeout(() => collector.terminate('worker_timeout'), 60000);
  let code;
  try {code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});}
  finally {clearTimeout(timer);}
  const result = {code, ...collector.finish()}, report = summarizeNodeTests(result, '001.json');
  await save('001.json', {program: process.execPath, args, milliseconds: Date.now() - started, ...result, report});
  commands.push({file: '001.json', code, report});
  if (code !== 0 || result.reason || result.stdoutEncodingError || result.stderrEncodingError || report.status !== 'passed') {
    process.stderr.write(result.stdout + result.stderr); throw Error('INTAKE_UI_UNITS_FAILED');
  }
  for (const entry of sources) if (hash(await fs.readFile(path.join(root, entry.path))) !== entry.sha256) throw Error('INTAKE_UI_SOURCE_CHANGED');
  outcome = 'passed';
} catch (error) {failure = error.stack ?? error.message; process.exitCode = 1;}
finally {
  await save('manifest.json', {runId, group, node: process.version, platform: process.platform, outcome, failure, sources, commands,
    scope: 'Local contract, envelope, journal and client guard checks. No database, browser, runtime or general authorization proof.'});
  console.log(JSON.stringify({runId, directory, outcome, failure}));
}
