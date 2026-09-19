import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {collectProcessOutput} from '../tests/intake/t01/reviewed/process-output.mjs';
import {summarizeNodeTests} from './intake_test_summary.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const group = process.argv[process.argv.indexOf('--group') + 1];
if (!['contracts', 'schema'].includes(group)) throw Error('PREPARATION_GROUP_REQUIRED');
const runId = 'intake-preparation-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const directory = path.join(root, 'test-results/intake-preparation', runId);
await fs.mkdir(directory, {recursive: true});
const save = (name, value) => fs.writeFile(path.join(directory, name),
  typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = [], commands = [], resources = [];
let outcome = 'failed', failure;
async function snapshot(relative) {
  const filename = path.join(root, relative), stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw Error('PREPARATION_SOURCE_LINK');
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(filename)).sort()) await snapshot(path.posix.join(relative, name));
  } else {
    const bytes = await fs.readFile(filename), destination = path.join(directory, 'source', relative);
    await fs.mkdir(path.dirname(destination), {recursive: true}); await fs.writeFile(destination, bytes, {flag: 'wx'});
    sources.push({path: relative, bytes: bytes.length, sha256: hash(bytes)});
  }
}
async function run(args, {timeout = 60000, tap = false} = {}) {
  const started = Date.now(), file = String(commands.length + 1).padStart(4, '0') + '.json';
  const child = spawn(process.execPath, args, {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const collector = collectProcessOutput(child.stdout, child.stderr,
    {outputBytes: 1048576, diagnosticBytes: 65536, stop: () => child.kill()});
  const timer = setTimeout(() => collector.terminate('worker_timeout'), timeout);
  let code, processError;
  try {code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});}
  catch (error) {processError = error.message;}
  finally {clearTimeout(timer);}
  const result = {code, ...collector.finish()};
  const report = tap ? summarizeNodeTests(result, file) : null;
  await save(file, {program: process.execPath, args, milliseconds: Date.now() - started, ...result, processError, report});
  commands.push({file, code, reason: result.reason, report});
  if (processError || code !== 0 || result.reason || result.stdoutEncodingError || result.stderrEncodingError ||
    result.stdoutRetainedBytes !== result.stdoutBytes || (report && report.status !== 'passed')) {
    process.stderr.write(result.stdout + result.stderr); throw Error('PREPARATION_CHECK_FAILED:' + file);
  }
}
async function schema() {
  const {dockerCommand} = await import('./intake/extraction/launcher.mjs');
  const {schemaSql, schemaDatabase, schemaPassword, waitForSchemaDatabase} = await import('./intake/extraction/schema_readiness.mjs');
  const {preparationSchemaCases} = await import('../tests/intake/preparation/schema.mjs');
  async function docker(args, options = {}) {
    const file = String(commands.length + 1).padStart(4, '0') + '.json';
    let result;
    try {result = await dockerCommand(args, options); return result.stdout.trim();}
    catch (error) {result = error.observed ?? {error: error.message}; throw error;}
    finally {
      await save(file, {program: 'docker', args, inputBytes: options.input ? Buffer.byteLength(options.input) : 0,
        inputSha256: options.input ? hash(options.input) : null, ...result});
      commands.push({file, code: result?.code, reason: result?.reason});
    }
  }
  const os = await docker(['info', '--format', '{{.OSType}}']);
  if (os !== 'linux') throw Error('PREPARATION_LINUX_REQUIRED');
  const before = await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']); await save('containers-before.ndjson', before);
  const image = JSON.parse(await docker(['image', 'inspect', 'postgres:16']))[0];
  const resource = {kind: 'container', name: 'ld-i03-t04-schema-' + randomUUID().slice(0, 8), image: image.Id, id: null, cleaned: false};
  resources.push(resource); await save('resource-intent.json', {runId, ...resource});
  try {
    resource.id = await docker(['create', '--name', resource.name, '--label', 'intake.t04.run=' + runId,
      '--network=none', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=128', '--security-opt=no-new-privileges',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=268435456', '-e', 'POSTGRES_DB=' + schemaDatabase,
      '-e', 'POSTGRES_PASSWORD=' + schemaPassword, image.Id], {timeout: 60000});
    await docker(['start', resource.id]);
    const effective = JSON.parse(await docker(['inspect', resource.id]))[0];
    await save('effective-container.json', effective);
    if (effective.Image !== image.Id || effective.Config.Labels?.['intake.t04.run'] !== runId ||
      effective.HostConfig.NetworkMode !== 'none' || effective.HostConfig.Memory !== 536870912 ||
      effective.HostConfig.MemorySwap !== 536870912 || effective.HostConfig.NanoCpus !== 1000000000 ||
      effective.HostConfig.PidsLimit !== 128 || !effective.HostConfig.SecurityOpt.includes('no-new-privileges'))
      throw Error('PREPARATION_EFFECTIVE_CONTROLS');
    const sql = schemaSql(docker, resource.id), version = await waitForSchemaDatabase(sql);
    const result = await preparationSchemaCases({sql, sourceRoot: path.join(directory, 'source')});
    await save('schema-result.json', {version, ...result});
  } finally {
    const matches = await docker(['ps', '-aq', '--no-trunc', '--filter', 'name=^/' + resource.name + '$', '--filter', 'label=intake.t04.run=' + runId]);
    if (matches) {
      const current = JSON.parse(await docker(['inspect', matches]))[0];
      if (current.Image !== resource.image || current.Config.Labels?.['intake.t04.run'] !== runId ||
        resource.id && current.Id !== resource.id) throw Error('PREPARATION_RESOURCE_OWNER');
      resource.id = current.Id;
      if (current.State.Running) await docker(['stop', '--time', '5', resource.id]);
      await save('schema-container.log', await docker(['logs', resource.id]));
      await docker(['rm', resource.id]);
    }
    const remaining = await docker(['ps', '-aq', '--filter', 'label=intake.t04.run=' + runId]);
    if (remaining) throw Error('PREPARATION_RESOURCE_REMAINS');
    resource.cleaned = true;
    await save('containers-after.ndjson', await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']));
  }
}
try {
  // The independently reserved reference files are deliberately not read by P0.
  for (const relative of ['src/contracts', 'src/server/intake/preparation', 'tests/intake/preparation/test_contracts.mjs', 'tests/intake/preparation/test_producer.mjs',
    'tests/intake/t01/fixtures.mjs', 'tests/intake/t01/reviewed/process-output.mjs', 'ci/intake_preparation_check.mjs',
    'ci/intake_test_summary.mjs', 'ci/intake_boundary_check.mjs', 'ci/access_boundary_check.mjs', 'ci/reading_boundary_check.mjs',
    'tsconfig.app.json', 'package.json', 'package-lock.json']) await snapshot(relative);
  if (group === 'contracts') {
    // The import smoke test and application typecheck consume the live terminal's
    // dependencies as well as the new preparation modules.
    for (const relative of ['src/server/access', 'src/server/reading']) await snapshot(relative);
    for (const entry of await fs.readdir(path.join(root, 'src/server/intake'), {withFileTypes: true}))
      if (entry.name !== 'preparation') await snapshot('src/server/intake/' + entry.name);
    await run(['--experimental-strip-types', '--test', 'tests/intake/preparation/test_contracts.mjs', 'tests/intake/preparation/test_producer.mjs'], {tap: true});
    await run(['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false', '-p', 'tsconfig.app.json']);
  } else {
    for (const relative of ['src/server/intake/postgres', 'src/server/access/postgres', 'src/server/reading/postgres',
      'ci/access_material_schema.mjs', 'ci/intake/extraction/launcher.mjs', 'ci/intake/extraction/collector.mjs',
      'ci/intake/extraction/schema_readiness.mjs', 'tests/intake/preparation/schema.mjs']) await snapshot(relative);
    await schema();
  }
  for (const entry of sources) if (hash(await fs.readFile(path.join(root, entry.path))) !== entry.sha256) throw Error('PREPARATION_SOURCE_CHANGED');
  outcome = 'passed';
} catch (error) {failure = error.stack ?? error.message; process.exitCode = 1;}
finally {
  await save('manifest.json', {runId, group, node: process.version, platform: process.platform, outcome, failure,
    sources, commands, resources, scope: group === 'contracts' ? 'Local contract/type checks. No SQL, HTTP, Docker, source admission or operational route evidence.' :
      'Isolated Linux PostgreSQL DDL and effective privileges. No end-to-end journey or runtime authority evidence.'});
  console.log(JSON.stringify({runId, group, outcome, directory, failure}));
}
