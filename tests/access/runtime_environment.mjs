import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import assert from 'node:assert/strict';

export async function runtimeEnvironment({ invitations = true } = {}) {
  assert.equal(process.env.LEDGERDESK_ACCESS_CONTAINER, '1');
  assert.equal(process.platform, 'linux');
  assert.equal(homedir(), '/home/pwuser');
  const scratch = mkdtempSync(path.join(tmpdir(), 'access-runtime-'));
  let started = false;
  const nss = '/home/pwuser/.pki/nssdb';
  const certificateName = path.basename(scratch);
  let trusted = false;
  let admin;
  const clients = [];
  const run = (program, args) =>
    execFileSync(program, args, {
      cwd: scratch,
      stdio: 'pipe',
      timeout: 15000,
    });
  async function close() {
    try {
      for (const c of clients) await c.end();
      await admin?.end();
    } finally {
      if (started)
        run('/usr/lib/postgresql/16/bin/pg_ctl', [
          '-D',
          path.join(scratch, 'pg'),
          '-m',
          'immediate',
          '-w',
          'stop',
        ]);
      try {
        if (trusted) {
          run('certutil', ['-D', '-d', `sql:${nss}`, '-n', certificateName]);
          trusted = false;
        }
      } finally {
        assert.ok(scratch.startsWith(path.join(tmpdir(), 'access-runtime-')));
        rmSync(scratch, { recursive: true, force: true });
        console.log('ACCESS_PG_CLEANED');
      }
    }
  }
  try {
    run('/usr/lib/postgresql/16/bin/initdb', [
      '-D',
      path.join(scratch, 'pg'),
      '--username=trial_bootstrap',
      '--auth-local=trust',
      '--auth-host=scram-sha-256',
    ]);
    run('/usr/lib/postgresql/16/bin/pg_ctl', [
      '-D',
      path.join(scratch, 'pg'),
      '-l',
      path.join(scratch, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p 55432 -k ${scratch}`,
      '-w',
      'start',
    ]);
    started = true;
    admin = new Client({
      host: scratch,
      port: 55432,
      user: 'trial_bootstrap',
      database: 'postgres',
    });
    await admin.connect();
    await admin.query('CREATE DATABASE inc02_synthetic');
    await admin.end();
    admin = new Client({
      host: scratch,
      port: 55432,
      user: 'trial_bootstrap',
      database: 'inc02_synthetic',
    });
    await admin.connect();
    await admin.query(
      readFileSync(
        new URL(
          '../../src/server/access/postgres/001_identity.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const password = randomBytes(24).toString('hex'),
      controlPassword = randomBytes(24).toString('hex');
    if (invitations) await admin.query(readFileSync(new URL('../../src/server/access/postgres/002_invitations.sql',import.meta.url),'utf8'));
    await admin.query(`ALTER ROLE inc02_runtime LOGIN PASSWORD '${password}'`);
    await admin.query(
      `ALTER ROLE inc02_control LOGIN PASSWORD '${controlPassword}'`,
    );
    const runtimeConfig = {
      connectionString: `postgresql://inc02_runtime:${password}@127.0.0.1:55432/inc02_synthetic`,
      connectionTimeoutMillis: 3000,
    };
    const control = new Client({
      connectionString: `postgresql://inc02_control:${controlPassword}@127.0.0.1:55432/inc02_synthetic`,
    });
    await control.connect();
    clients.push(control);
    const runtime = new Client(runtimeConfig);
    await runtime.connect();
    clients.push(runtime);
    await admin.query(
      `CREATE ROLE retained_legacy NOLOGIN; CREATE SCHEMA retained_legacy; CREATE TABLE retained_legacy.private_data(id text);`,
    );
    const now = Date.now();
    const root = {
      issuerPersonRef: 'synthetic-issuer',
      issuerCapacityRef: 'synthetic-mandate',
      holderPersonRef: 'synthetic-custodian',
      functionRef: 'startup-control',
      scope: {
        matters: [],
        partitions: [],
        risks: [],
        populationRef: 'synthetic-preparation',
      },
      purposeRef: 'prepare-deployment',
      startsAt: now - 1000,
      continuousObligationAcceptanceRef: 'synthetic-acceptance',
      termination: { kind: 'expires', at: now + 3600000 },
      maximumGradeRef: 'NONE',
      independenceDeclarationRef: 'synthetic-independence',
      replacementOrChallengeProcedureRef: 'synthetic-replacement',
      revision: 1,
    };
    const reception = {
      purposeRef: 'synthetic-authentication',
      custodianRef: 'synthetic-operator',
      readerRef: 'synthetic-recipient',
      disposalRef: 'destroy-owned-trial',
      retentionSeconds: 3600,
      destination: 'local-test-mailbox',
      synthetic: true,
      capture: true,
      processing: true,
      conservation: true,
      evidence: true,
    };
    await admin.query(
      'INSERT INTO access_trial.deployment VALUES(true,$1,$2,$3,$4,true,1,0)',
      ['inc02-synthetic', 'master@example.test', root, reception],
    );
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-subj',
      '/CN=Access-runtime-test',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    run('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=api.inc02.test',
    ]);
    writeFileSync(
      path.join(scratch, 'leaf.ext'),
      'subjectAltName=DNS:api.inc02.test,DNS:ui.inc02.test\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n',
    );
    run('openssl', [
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'leaf.crt',
      '-days',
      '1',
      '-extfile',
      'leaf.ext',
    ]);
    mkdirSync(nss, { recursive: true });
    if (!existsSync(path.join(nss, 'cert9.db')))
      run('certutil', ['-N', '--empty-password', '-d', `sql:${nss}`]);
    run('certutil', [
      '-A',
      '-d',
      `sql:${nss}`,
      '-n',
      certificateName,
      '-t',
      'C,,',
      '-i',
      path.join(scratch, 'ca.crt'),
    ]);
    trusted = true;
    return {
      admin,
      runtime,
      control,
      runtimeConfig,
      root,
      reception,
      close,
      ca: readFileSync(path.join(scratch, 'ca.crt')),
      tls: {
        key: readFileSync(path.join(scratch, 'leaf.key')),
        cert: readFileSync(path.join(scratch, 'leaf.crt')),
      },
      postgresLog: () =>
        readFileSync(path.join(scratch, 'postgres.log'), 'utf8'),
    };
  } catch (e) {
    await close();
    throw e;
  }
}
