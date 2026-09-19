import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {collectProcessOutput} from './intake/extraction/collector.mjs';
import {dockerCommand} from './intake/extraction/launcher.mjs';
import {schemaCases} from '../tests/intake/extraction/schema.mjs';
import {extractionArguments,requireMemoryProof} from './intake/extraction/memory_qualification.mjs';
import {schemaSql, schemaDatabase, schemaPassword, waitForSchemaDatabase} from './intake/extraction/schema_readiness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const {group,required:qualifiedMemory}=extractionArguments(process.argv.slice(2));
const runId = 'intake-extraction-' + new Date().toISOString().replace(/[:.]/g, '-').toLowerCase() + '-' + randomUUID().slice(0, 8);
const directory = path.join(root, 'test-results/intake-extraction', runId);
await fs.mkdir(directory, {recursive: true});
const commands = [], resources = [], cases = [], sources = [], savedSources=new Set();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let ordinal = 0, outcome = 'failed', failure;
let memory={required:qualifiedMemory,qualified:false},memoryImage,memoryProof;
const save = (name, value) => fs.writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
async function command(args, options = {}) {
  const started = Date.now(), file = String(++ordinal).padStart(3, '0') + '-command.json';
  let observed;
  try {observed = await dockerCommand(args, options);}
  catch (error) {observed = error.observed ?? {error: error.message}; throw error;}
  finally {
    await save(file, {program: 'docker', args, inputBytes: options.input ? Buffer.byteLength(options.input) : 0,
      inputSha256: options.input ? hash(options.input) : null, ...observed, milliseconds: Date.now() - started});
    commands.push({file, code: observed?.code ?? null, reason: observed?.reason ?? null});
  }
  return options.preserveOutput ? observed.stdout : observed.stdout.trim();
}
async function source(relative) {
  if(savedSources.has(relative))return;
  const item = path.join(root, relative), stat = await fs.lstat(item);
  if (stat.isSymbolicLink()) throw Error('EXTRACTION_SOURCE_LINK');
  if (stat.isDirectory()) {for (const name of (await fs.readdir(item)).sort()) if (name !== 'node_modules') await source(path.posix.join(relative, name));}
  else {
    const bytes = await fs.readFile(item), target = path.join(directory, 'source', relative);
    await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, bytes, {flag: 'wx'});
    sources.push({path: relative, bytes: bytes.length, sha256: hash(bytes)});savedSources.add(relative);
  }
}
async function schema() {
  const image = JSON.parse(await command(['image', 'inspect', 'postgres:16']))[0];
  const name = 'ld-i03-t03-schema-' + randomUUID().slice(0, 8);
  const resource = {kind: 'container', id: null, name, image: image.Id, cleaned: false};
  resources.push(resource); // Preserve the exact target even if CREATE loses its reply.
  await save('resource-intent.json', {runId, ...resource});
  const id = await command(['create', '--name', name, '--label', 'intake.t03.run=' + runId, '--network=none',
    '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=128', '--security-opt=no-new-privileges',
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=268435456', '-e', 'POSTGRES_DB=' + schemaDatabase,
    '-e', 'POSTGRES_PASSWORD=' + schemaPassword, image.Id], {timeout: 60000});
  resource.id = id;
  await command(['start', id]);
  const sql = schemaSql(command, id);
  const version = await waitForSchemaDatabase(sql);
  const result = await schemaCases({sql, observe: async item => {cases.push(item); console.log(JSON.stringify(item));}});
  await save('schema-result.json', {version, ...result});
}
async function units() {
  const args = ['--experimental-strip-types', '--test', 'tests/intake/extraction/collector.mjs',
    'tests/intake/extraction/interface.mjs', 'tests/intake/extraction/representations.mjs','tests/intake/extraction/output.mjs','tests/intake/extraction/private_contract.mjs','tests/intake/extraction/source_classification.mjs',
    'tests/intake/extraction/memory_qualification.mjs', 'tests/intake/extraction/setup.mjs'];
  const child = spawn(process.execPath, args, {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const output = collectProcessOutput(child.stdout, child.stderr, {outputBytes: 1048576, stop: () => child.kill()});
  const timer = setTimeout(() => output.terminate('unit_timeout'), 60000);
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);}).finally(() => clearTimeout(timer));
  const observed = {code, ...output.finish()}; await save('unit-result.json', {program: process.execPath, args, ...observed});
  if (code !== 0 || observed.reason) throw Error('EXTRACTION_UNITS_FAILED');
}
async function worker() {
  for (const item of ['workers/intake/extraction', 'ci/intake/T03.Dockerfile', 'tests/intake/extraction/references',
    'tests/intake/extraction/fixed_entry_driver.mjs', 'tests/intake/t01/fixtures', 'tests/intake/t01/boundaries']) await source(item);
  const tag = 'ledgerdesk-intake-t03:' + runId;
  await command(['build', '-f', path.join(directory, 'source/ci/intake/T03.Dockerfile'), '--target', 'extraction',
    '--label', 'intake.t03.run=' + runId, '-t', tag, path.join(directory, 'source')], {timeout: 240000, limit: 2097152});
  const image = JSON.parse(await command(['image', 'inspect', tag]))[0];
  resources.push({kind: 'image', id: image.Id, name: tag, cleaned: false});
  await save('image.json', image);
  // Import the preserved reference and driver snapshot, not concurrently edited tests.
  const {fixedEntryCases} = await import(pathToFileURL(path.join(directory, 'source/tests/intake/extraction/fixed_entry_driver.mjs')));
  const result = await fixedEntryCases({image: image.Id, runId, command: (args, options) => command(args, {...options, preserveOutput: args[0] === 'start'}), save, resources});
  memoryImage=image.Id;
  if(qualifiedMemory){
    const module=await import(pathToFileURL(path.join(directory,'source/ci/intake/extraction/memory_qualification.mjs')));
    try{
      memoryProof=await module.runMemoryQualification({image:image.Id,sourceRoot:path.join(directory,'source'),save,
        recordCommand:async observation=>{
          const file=String(++ordinal).padStart(3,'0')+'-command.json';
          await save(file,observation);commands.push({file,code:observation.code,reason:observation.reason??null});return file;
        }});
      memory={required:true,qualified:true,image:image.Id,proofFile:'memory-proof.json'};
    }catch(error){memory={required:true,qualified:false,image:image.Id,status:module.memoryFailure(error)?.status};throw error;}
  }
  console.log(JSON.stringify({fixedEntryCases: result.length, outcome: 'passed'}));
}
async function composition(){
  for(const relative of ['ci','src','tests','workers','quality','agents','adr','docs','.github','package.json','package-lock.json',
    'tsconfig.json','tsconfig.app.json','next-env.d.ts','BOARD.md'])await source(relative);
  const tag='ledgerdesk-intake-t03-verify:'+runId;
  await command(['build','-f',path.join(directory,'source/ci/intake/T03.Dockerfile'),'--target','verification',
    '--label','intake.t03.run='+runId,'-t',tag,path.join(directory,'source')],{timeout:240000,limit:2097152});
  const image=JSON.parse(await command(['image','inspect',tag]))[0];resources.push({kind:'image',id:image.Id,name:tag,cleaned:false});
  const name='ld-i03-t03-verify-'+randomUUID().slice(0,8),resource={kind:'container',id:null,name,cleaned:false};resources.push(resource);
  await save('resource-intent.json',{runId,...resource});
  resource.id=await command(['create','--name',name,'--label','intake.t03.run='+runId,'--network=none','--memory=2g',
    '--memory-swap=2g','--pids-limit=128','--cap-drop=ALL','--security-opt=no-new-privileges',image.Id],{timeout:60000});
  try{await command(['start','-a',resource.id],{timeout:240000,limit:4194304});}
  finally{await command(['cp',resource.id+':/work/test-results',path.join(directory,'verification')]);}
}
try {
  if(qualifiedMemory&&process.platform!=='linux')throw Error('LINUX_REFERENCE_REQUIRED');
  for (const item of ['src/contracts', 'src/server/intake', 'src/server/access/postgres', 'src/server/reading/postgres',
    'ci/access_material_schema.mjs', 'ci/intake/extraction', 'ci/intake_extraction_check.mjs',
    'tests/intake/extraction/collector.mjs', 'tests/intake/extraction/interface.mjs', 'tests/intake/extraction/interface_fixtures.mjs',
    'tests/intake/extraction/representations.mjs', 'tests/intake/extraction/schema.mjs','tests/intake/extraction/output.mjs',
    'tests/intake/extraction/private_contract.mjs','tests/intake/extraction/source_classification.mjs',
    'ci/seam_check.mjs','src/alg/channels.ts','src/alg/escalation.ts','agents/triage/schema.ts','agents/gateway.ts',
    'ci/intake_l03_linux.mjs','ci/intake_l03_reference.mjs','ci/intake_l03_observer.mjs','ci/intake_kernel_origin.mjs','ci/l03_profile_hierarchy.mjs',
    'tests/intake/t01/reviewed/process-output.mjs','tests/intake/t01/probe.mjs','tests/intake/t01/l03_gate.mjs',
    'tests/intake/extraction/memory_qualification.mjs', 'tests/intake/extraction/setup.mjs']) await source(item);
  if (group === 'schema') await schema(); else if (group === 'worker') await worker(); else if(group==='composition')await composition();else await units();
  requireMemoryProof(qualifiedMemory,memoryImage,memoryProof);
  outcome = 'passed';
} catch (error) {failure = {message: error.message}; process.exitCode = 1;}
finally {
  for (const resource of resources.toReversed()) {
    if (resource.cleaned) continue;
    try {
      if (resource.kind === 'image') {
        const actual = JSON.parse(await command(['image', 'inspect', resource.name]))[0];
        if (actual.Id !== resource.id || actual.Config.Labels?.['intake.t03.run'] !== runId) throw Error('EXTRACTION_IMAGE_OWNERSHIP');
        await command(['image', 'rm', resource.name]); resource.cleaned = true; continue;
      }
      let actual;
      try {actual = JSON.parse(await command(['inspect', resource.id ?? resource.name]))[0];}
      catch (error) {
        if (resource.id === null && error.observed?.code === 1 && /no such (object|container)/i.test(error.observed.stderr)) {
          resource.currentObservation = 'not-present-after-unconfirmed-create';
          // Current absence does not turn an unconfirmed CREATE into a successful test.
          resource.cleaned = true; continue;
        }
        throw error;
      }
      if ((resource.id !== null && actual.Id !== resource.id) || actual.Config.Labels?.['intake.t03.run'] !== runId) throw Error('EXTRACTION_RESOURCE_OWNERSHIP');
      resource.id = actual.Id;
      await save(resource.name + '-logs.json', {output: await command(['logs', resource.id])});
      if (actual.State.Running) await command(['stop', '--time=3', resource.id]);
      if (JSON.parse(await command(['inspect', resource.id]))[0].State.Running) throw Error('EXTRACTION_RESOURCE_STILL_RUNNING');
      await command(['rm', resource.id]); resource.cleaned = true;
    } catch (error) {resource.cleanupError = error.message; outcome = 'failed'; process.exitCode = 1;}
  }
  await save('manifest.json', {runId, group, outcome, failure, node: process.version, commands, cases, resources, sources,memory});
  console.log(JSON.stringify({runId, group, outcome, failure, directory, resourcesCleaned: resources.every(r => r.cleaned)}));
}
