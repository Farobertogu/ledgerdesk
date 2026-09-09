// Owns only a freshly named Docker Compose project. Never connects to the host's historical DB.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Client } from 'pg';
import assert from 'node:assert/strict';
import { cleanupSteps } from './lifecycle.mjs';

const composeFile = new URL('../../ci/reading-compose.yml', import.meta.url);
const schemaFile = new URL('../../src/server/reading/postgres/001_trial.sql', import.meta.url);
const safeId = /^ld-reading-t04-[a-f0-9]{16}$/;
const docker = (args, env = process.env, timeout = 120000) => execFileSync('docker', args, {
  encoding: 'utf8', env, timeout, stdio: ['ignore', 'pipe', 'pipe'],
});
async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject); socket.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve)); return port;
}

export async function createPgTrial() {
  const project = `ld-reading-t04-${randomBytes(8).toString('hex')}`;
  assert.match(project, safeId);
  const port = await freePort();
  const ownerPassword = randomBytes(24).toString('hex');
  const readerPassword = randomBytes(24).toString('hex');
  const writerPassword = randomBytes(24).toString('hex');
  const env = { ...process.env, LEDGERDESK_READING_PG_PASSWORD: ownerPassword, LEDGERDESK_READING_PG_PORT: String(port) };
  const compose = (...args) => docker(['compose', '-f', fileURLToPath(composeFile), '-p', project, ...args], env);
  assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).trim(), '');
  const credentials = (role, password) => `postgresql://${role}:${password}@127.0.0.1:${port}/inc01_synthetic`;
  let admin;
  let started = false;
  const projectFilter = `label=com.docker.compose.project=${project}`;
  const resources = (kind) => docker(kind === 'container'
    ? ['ps', '-aq', '--filter', projectFilter]
    : [kind, 'ls', '-q', '--filter', projectFilter], env, 10000).trim().split(/\s+/).filter(Boolean);
  async function close() {
    await cleanupSteps([
      { label: 'administrative connection close', close: () => admin?.end(), timeoutMs: 5000 },
      { label: 'owned Docker resources', timeoutMs: 80000, close: () => {
        if (!started) return;
        for (const id of resources('container')) {
          const info = JSON.parse(docker(['inspect', id], env, 10000))[0];
          assert.equal(info.Config.Labels['com.docker.compose.project'], project);
          assert.ok(info.Mounts.every((mount) => mount.Type === 'volume' && mount.Name === `${project}_reading_pgdata`));
        }
        for (const volume of resources('volume')) assert.equal(volume, `${project}_reading_pgdata`);
        for (const id of resources('network')) {
          const network = JSON.parse(docker(['network', 'inspect', id], env, 10000))[0];
          assert.equal(network.Name, `${project}_default`);
        }
        docker(['compose', '-f', fileURLToPath(composeFile), '-p', project,
          'down', '--volumes', '--timeout', '5'], env, 30000);
        for (const kind of ['container', 'volume', 'network']) assert.deepEqual(resources(kind), [], `${kind} remains for ${project}`);
        started = false;
        console.log(`PG_TRIAL_CLEANED ${project}`);
      } },
    ]);
  }
  try {
    started = true;
    console.log(`PG_TRIAL_PROJECT ${project}`);
    compose('up', '-d', '--wait', '--wait-timeout', '60');
    const id = compose('ps', '-q', 'postgres').trim();
    const info = JSON.parse(docker(['inspect', id]))[0];
    assert.equal(info.Config.Labels['com.docker.compose.project'], project);
    assert.equal(info.Config.Image, 'postgres:16');
    assert.notEqual(info.HostConfig.NetworkMode, 'host');
    assert.ok(info.Mounts.length === 1 && info.Mounts.every((mount) =>
      mount.Type === 'volume' && mount.Name === `${project}_reading_pgdata`));
    const binding = info.NetworkSettings.Ports['5432/tcp'];
    assert.deepEqual(binding, [{ HostIp: '127.0.0.1', HostPort: String(port) }]);
    assert.ok(Object.keys(info.NetworkSettings.Networks).every((name) => name === `${project}_default`));
    admin = new Client({ connectionString: credentials('inc01_owner', ownerPassword), connectionTimeoutMillis: 3000 });
    await admin.connect();
    const { rows: [identity] } = await admin.query(`SELECT current_database() AS database, current_user AS role,
      current_setting('server_version_num')::int AS version, (SELECT system_identifier::text FROM pg_control_system()) AS system_id`);
    assert.equal(identity.database, 'inc01_synthetic'); assert.equal(identity.role, 'inc01_owner');
    assert.ok(identity.version >= 160000 && identity.version < 170000);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'reading_trial'")).rows[0].n, 0);
    await admin.query(readFileSync(schemaFile, 'utf8'));
    await admin.query(`ALTER ROLE inc01_reader LOGIN PASSWORD '${readerPassword}'`);
    await admin.query(`ALTER ROLE inc01_writer LOGIN PASSWORD '${writerPassword}'`);
    return {
      admin, project, port, identity,
      store: { connectionString: credentials('inc01_reader', readerPassword), expectedPort: port },
      writerConfig: { connectionString: credentials('inc01_writer', writerPassword), connectionTimeoutMillis: 3000 },
      async restart() {
        await admin.end(); compose('restart', 'postgres');
        compose('up', '-d', '--wait', '--wait-timeout', '60');
        admin = new Client({ connectionString: credentials('inc01_owner', ownerPassword), connectionTimeoutMillis: 3000 });
        await admin.connect(); return admin;
      },
      close,
    };
  } catch (error) {
    const diagnostic = String(error.stderr ?? error.message ?? error.name)
      .replaceAll(ownerPassword, '[redacted]').replaceAll(readerPassword, '[redacted]')
      .replaceAll(writerPassword, '[redacted]').replace(/postgresql:\/\/[^\s]+/g, '[redacted connection]');
    const failure = new Error(`Isolated PG16 setup failed (${error.code ?? error.status ?? error.name}): ${diagnostic.slice(-2000)}`);
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([failure, cleanupError], 'PG16 setup and cleanup both failed'); }
    throw failure;
  }
}
