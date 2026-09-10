import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  journeyEnvironment,
  uiOrigin,
  password,
} from './journey_environment.mjs';
import { journeyTerminal } from './journey_mutation.mjs';

test(
  'T06 bootstrap admission and atomicity on fresh isolated deployments',
  { timeout: 120000 },
  async (t) => {
    for (const [name, options, kind] of [
      [
        'P01 valid initial declaration is materialized once; replay and recovery do not regrant',
        {},
        'valid',
      ],
      [
        'P02 bootstrap cannot grant master material exercise',
        {
          facultiesTransform: (f) => [
            ...f,
            { ...f[1], exercise_or_grant: 'exercise' },
          ],
        },
        'invalid',
      ],
      [
        'P03 stale declared permission revision is not current authority',
        {
          facultiesTransform: (f) =>
            f.map((x) => ({ ...x, permission_revision: 2 })),
        },
        'invalid',
      ],
      [
        'P04 expired initial faculty prevents partial account and grant creation',
        { facultiesTransform: (f) => f.map((x) => ({ ...x, expires_at: 1 })) },
        'invalid',
      ],
      [
        'P05 missing initial declaration does not silently fall back',
        { omitDeclaration: true },
        'invalid',
      ],
      [
        'P06 evidence failure rolls back initial account, faculties, person link and proof consumption',
        {},
        'evidence',
      ],
      [
        'P07 populated schema upgrade preserves prior facts and cannot install retroactive faculties',
        { installBootstrap: false },
        'upgrade',
      ],
      [
        'P08 changed preparation root rejects a fresh activation proof without partial effects',
        {},
        'root',
      ],
    ])
      await t.test(name, async () => {
        const env = await journeyEnvironment(options);
        let terminal, modified;
        const mail = [];
        const failures = [];
        const hooks = { failure: (e) => failures.push(e.message) };
        try {
          if (kind === 'root') {
            // Change the current root after declaration, before issuing the new proof.
            // Keep all other authority/expiry conditions valid and email/holder unchanged.
            await env.admin.query(
              'UPDATE access_trial.deployment SET root=$1, revision=revision+1',
              [{ ...env.root, revision: env.root.revision + 1 }],
            );
          }
          const mutation = process.env.ACCESS_RUNTIME_MUTATION ?? '';
          modified = await journeyTerminal(
            mutation.startsWith('drop-bootstrap-') ? mutation : '',
          );
          terminal = await modified.start({
            config: env.config,
            tls: env.tls,
            mailbox: {
              async send(m) {
                mail.push(m);
              },
            },
            hooks,
            reading: env.reading,
          });
          const call = (url, body, f, key = randomUUID()) =>
            new Promise((resolve, reject) => {
              const bytes =
                body === undefined ? null : Buffer.from(JSON.stringify(body));
              const req = https.request(
                {
                  host: '127.0.0.1',
                  port: 9443,
                  servername: 'api.inc02.test',
                  ca: env.ca,
                  path: '/api/access/v1' + url,
                  method: bytes ? 'POST' : 'GET',
                  headers: {
                    host: 'api.inc02.test:9443',
                    origin: uiOrigin,
                    ...(f ? { cookie: f.cookie } : {}),
                    ...(bytes
                      ? {
                          'content-type': 'application/json',
                          'content-length': bytes.length,
                          'x-ledgerdesk-csrf': f.csrf,
                          'x-ledgerdesk-intent': key,
                        }
                      : {}),
                  },
                },
                (res) => {
                  const chunks = [];
                  res.on('data', (c) => chunks.push(c));
                  res.on('end', () =>
                    resolve({
                      status: res.statusCode,
                      headers: res.headers,
                      body: JSON.parse(Buffer.concat(chunks).toString()),
                    }),
                  );
                  res.on('error', reject);
                },
              );
              req.setTimeout(10000, () =>
                req.destroy(Error('Bootstrap HTTPS timeout')),
              );
              req.on('error', reject);
              req.end(bytes);
            });
          const reception = await call('/reception'),
            f = {
              cookie: reception.headers['set-cookie'][0].split(';')[0],
              csrf: reception.body.csrf_token,
            };
          assert.equal(
            (
              await call(
                '/activation/challenges',
                { email: 'master@example.test' },
                f,
              )
            ).status,
            200,
          );
          assert.equal(mail.length, 1);
          const proof = mail[0],
            body = {
              challenge_id: proof.challenge_id,
              code: proof.code,
              password,
            },
            key = randomUUID();
          if (kind === 'root') {
            const binding = (await env.admin.query(
              `SELECT p.deployment_revision, d.revision,
                b.root <> d.root AS changed_root,
                b.master_email = d.master_email AS same_email,
                b.holder_person_ref = d.root->>'holderPersonRef' AS same_holder
               FROM access_trial.proof p CROSS JOIN access_trial.deployment d
               CROSS JOIN access_trial.bootstrap_declaration b WHERE p.id=$1`,
              [proof.challenge_id],
            )).rows[0];
            assert.deepEqual(binding, {
              deployment_revision: 2, revision: 2, changed_root: true,
              same_email: true, same_holder: true,
            });
          }
          // Deny the actual required evidence INSERT, rather than throwing in a test hook.
          if (kind === 'evidence')
            await env.admin.query(
              'REVOKE INSERT ON access_trial.evidence FROM inc02_runtime',
            );
          const r = await call('/activation/complete', body, f, key);
          if (kind === 'upgrade') {
            assert.equal(r.status, 200);
            const snapshot = async () => {
              const result = {};
              for (const table of [
                'account',
                'proof',
                'intent',
                'evidence',
                'person_account',
                'grant_record',
              ])
                result[table] = (
                  await env.admin.query(
                    'SELECT row_to_json(t) AS row FROM access_trial.' +
                      table +
                      ' t ORDER BY row_to_json(t)::text',
                  )
                ).rows;
              return result;
            };
            const before = await snapshot();
            await env.admin.query(
              readFileSync(
                new URL(
                  '../../src/server/access/postgres/004_bootstrap.sql',
                  import.meta.url,
                ),
                'utf8',
              ),
            );
            assert.deepEqual(await snapshot(), before);
            assert.equal(
              (await env.admin.query('SELECT * FROM access_trial.grant_record'))
                .rowCount,
              0,
            );
            await assert.rejects(
              env.admin.query(
                'INSERT INTO access_trial.bootstrap_declaration VALUES(true,$1,$2,$3,$4,$5)',
                [
                  'retroactive',
                  'master@example.test',
                  env.root.holderPersonRef,
                  env.root,
                  JSON.stringify(env.faculties),
                ],
              ),
              (e) => e.code === '42501',
            );
            assert.equal(
              (
                await env.admin.query(
                  'SELECT * FROM access_trial.bootstrap_activation',
                )
              ).rowCount,
              0,
            );
            return;
          }
          const counts = async () => {
            const result = {};
            for (const table of [
              'account',
              'grant_record',
              'bootstrap_activation',
              'person_account',
            ])
              result[table] = Number(
                (
                  await env.admin.query(
                    'SELECT count(*) AS n FROM access_trial.' + table,
                  )
                ).rows[0].n,
              );
            return result;
          };
          if (kind !== 'valid') {
            assert.deepEqual(
              {
                status: r.status,
                code: r.body.code,
                counts: await counts(),
                used: (
                  await env.admin.query(
                    'SELECT used FROM access_trial.proof WHERE id=$1',
                    [proof.challenge_id],
                  )
                ).rows[0].used,
                ...(kind === 'root' ? { failures } : {}),
              },
              {
                status: 503,
                code: 'technical_failure',
                counts: {
                  account: 0,
                  grant_record: 0,
                  bootstrap_activation: 0,
                  person_account: 0,
                },
                used: false,
                ...(kind === 'root' ? { failures: ['BOOTSTRAP_DECLARATION'] } : {}),
              },
            );
          } else {
            const first = (
              await env.admin.query(
                'SELECT id,withdrawn,revision FROM access_trial.grant_record ORDER BY id',
              )
            ).rows;
            assert.deepEqual(
              { status: r.status, counts: await counts() },
              {
                status: 200,
                counts: {
                  account: 1,
                  grant_record: 3,
                  bootstrap_activation: 1,
                  person_account: 1,
                },
              },
            );
            const replay = await call('/activation/complete', body, f, key);
            assert.deepEqual(
              { status: replay.status, body: replay.body },
              { status: 200, body: r.body },
            );
            const conflict = await call(
              '/activation/complete',
              { ...body, password: 'different' },
              f,
              key,
            );
            assert.equal(conflict.body.code, 'revision_conflict');
            const master = (
              await env.admin.query(
                "SELECT id FROM access_trial.account WHERE office='master'",
              )
            ).rows[0].id;
            await env.control.query(
              'SELECT access_trial.set_control(true,$1,$2)',
              [
                Date.now() + 60000,
                'Synthetic technical recovery authorization',
              ],
            );
            // Activation and recovery share the address's resend interval. Let it elapse;
            // do not reset the budget or disable the production throttle for this test.
            await new Promise((resolve) =>
              setTimeout(resolve, env.config.security.resendSeconds * 1000),
            );
            assert.equal(
              (
                await call(
                  '/recovery/challenges',
                  { email: 'master@example.test' },
                  f,
                )
              ).status,
              200,
            );
            const recovery = mail.at(-1);
            assert.equal(recovery.purpose, 'recovery');
            assert.equal(
              (
                await call(
                  '/recovery/complete',
                  {
                    challenge_id: recovery.challenge_id,
                    code: recovery.code,
                    password,
                  },
                  f,
                )
              ).status,
              200,
            );
            assert.deepEqual(
              (
                await env.admin.query(
                  'SELECT id,withdrawn,revision FROM access_trial.grant_record ORDER BY id',
                )
              ).rows,
              first,
            );
            assert.equal(
              (
                await env.admin.query(
                  'SELECT account_id FROM access_trial.bootstrap_activation',
                )
              ).rows[0].account_id,
              master,
            );
          }
        } finally {
          await terminal?.close();
          await env.close();
          modified?.clean();
        }
      });
  },
);
