import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import next from 'next';
import { chromium } from '@playwright/test';
import { runtimeEnvironment } from './runtime_environment.mjs';
import {
  startAccessTerminal,
  accessCookieHeaders,
} from '../../src/server/access/terminal.ts';
import {
  compareTiming,
  TIMING_PROTOCOL,
} from '../reading/timing_comparison.mjs';

const ui = 'https://ui.inc02.test:8443',
  api = 'https://api.inc02.test:9443';
const token = () => randomBytes(32).toString('base64url');
test(
  'T02 actual identity, isolated PG16, HTTPS and minimal Next UI',
  { timeout: 240000 },
  async (t) => {
    const env = await runtimeEnvironment();
    let terminal, browser, app, uiServer, mutantRoot;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        try {
          uiServer?.closeAllConnections();
          if (uiServer) await new Promise((r) => uiServer.close(r));
          await app?.close();
          await terminal?.close();
        } finally {
          await env.close();
          if (mutantRoot) {
            assert.ok(mutantRoot.startsWith('/work/output/access-mutant-'));
            rmSync(mutantRoot, { recursive: true, force: true });
          }
        }
      }
    });
    const mutation = process.env.ACCESS_RUNTIME_MUTATION ?? '';
    if (mutation === 'early-failure')
      throw new Error('Injected early failure after cleanup registration');
    let start = startAccessTerminal;
    let cookieHeaders = accessCookieHeaders;
    if (mutation) {
      const changes = {
        'drop-decoy': [
          'password.ts',
          'const matched = await this.work',
          'if(encoded===null) return false; const matched = await this.work',
        ],
        'drop-csrf': [
          'service.ts',
          '!tokenMatches(input.csrf, (sessionRoute ? session : flow).csrf)',
          'false',
        ],
        'drop-origin': [
          'transport.ts',
          'request.origin !== config.uiOrigin',
          'false',
        ],
        'drop-intent': ['service.ts', 'if (prior) {', 'if (false && prior) {'],
        'drop-proof-consumption': ['service.ts', 'proof.used ||', 'false ||'],
        'drop-login-peer': [
          'service.ts',
          'JSON.stringify([email, input.peer])',
          'JSON.stringify([email])',
        ],
        'drop-login-account-limit': [
          'service.ts',
          's.loginAttempts * LOGIN_ACCOUNT_ATTEMPT_FACTOR,',
          'Number.MAX_SAFE_INTEGER,',
        ],
        'drop-session-cookie': [
          'terminal.ts',
          'return cookies;',
          'return cookies.slice(-1);',
        ],
      };
      assert.ok(changes[mutation]);
      mutantRoot = `/work/output/access-mutant-${randomUUID()}`;
      mkdirSync(mutantRoot, { recursive: true });
      cpSync('/work/src', path.join(mutantRoot, 'src'), { recursive: true });
      const [file, before, after] = changes[mutation],
        target = path.join(mutantRoot, 'src/server/access', file);
      const source = readFileSync(target, 'utf8');
      assert.equal(source.split(before).length, 2);
      writeFileSync(target, source.replace(before, after));
      const modified = await import(
        pathToFileURL(path.join(mutantRoot, 'src/server/access/terminal.ts'))
          .href
      );
      start = modified.startAccessTerminal;
      cookieHeaders = modified.accessCookieHeaders;
      t.diagnostic(`Behavior mutation: ${mutation}`);
    }
    const security = {
      profile: 'access-trial/1',
      sessionSeconds: 1800,
      proofSeconds: 300,
      invitationSeconds: 86400,
      proofAttempts: 5,
      loginAttempts: 5,
      attemptWindowSeconds: 300,
      bodyBytes: 16384,
      resendSeconds: 30,
      resendLimit: 3,
      retryLimit: 2,
    };
    const config = {
      profile: 'access-runtime/1',
      synthetic: true,
      transport: { profile: 'session/1', uiOrigin: ui, terminalOrigin: api },
      security,
      connectionString: env.runtimeConfig.connectionString,
      expectedPort: 55432,
      digestKey: randomBytes(32).toString('hex'),
    };
    const messages = [],
      mailOutcomes = [],
      failures = [];
    let mailFail = false;
    const mailbox = {
      async send(message) {
        mailOutcomes.push(mailFail ? 'failed' : 'delivered');
        if (mailFail) throw new Error('Controlled mailbox failure');
        messages.push(message);
      },
    };
    const hooks = { failure: (e) => failures.push(e) };
    const launch = async () => {
      await terminal?.close();
      terminal = await start({ config, tls: env.tls, mailbox, hooks });
    };
    await launch();
    const request = (
      suffix,
      { method = 'GET', body, headers = {}, origin = ui, localAddress } = {},
    ) =>
      new Promise((resolve, reject) => {
        const bytes =
          body === undefined
            ? undefined
            : Buffer.from(
                typeof body === 'string' ? body : JSON.stringify(body),
              );
        const req = https.request(
          {
            host: '127.0.0.1',
            port: 9443,
            servername: 'api.inc02.test',
            ca: env.ca,
            ...(localAddress ? { localAddress, agent: false } : {}),
            path: `/api/access/v1${suffix}`,
            method,
            headers: {
              host: 'api.inc02.test:9443',
              ...(origin === undefined ? {} : { origin }),
              ...(bytes
                ? {
                    'content-type': 'application/json',
                    'content-length': bytes.length,
                  }
                : {}),
              ...headers,
            },
            timeout: 10000,
          },
          (res) => {
            let text = '';
            res.on('data', (b) => (text += b));
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text,
                body: text ? JSON.parse(text) : null,
              });
            });
          },
        );
        req.on('timeout', () =>
          req.destroy(new Error('HTTPS request timeout')),
        );
        req.on('error', reject);
        req.end(bytes);
      });
    const flow = async (localAddress) => {
      const r = await request('/reception', { localAddress });
      assert.equal(r.status, 200, failures.map((e) => e.message).join(';'));
      return {
        cookie: r.headers['set-cookie'][0].split(';')[0],
        csrf: r.body.csrf_token,
        localAddress,
      };
    };
    const post = (suffix, body, f, intent = randomUUID(), extra = {}) =>
      request(suffix, {
        method: 'POST',
        body,
        localAddress: f.localAddress,
        headers: {
          cookie: f.cookie,
          'x-ledgerdesk-csrf': f.csrf,
          'x-ledgerdesk-intent': intent,
          ...extra,
        },
      });
    const login = async (password = 'Synthetic initial password') => {
      await env.admin.query(
        "DELETE FROM access_trial.throttle WHERE key LIKE 'login:%'",
      );
      const f = await flow(),
        r = await post(
          '/sessions',
          { email: 'master@example.test', password },
          f,
        );
      assert.equal(r.status, 200, failures.map((e) => e.message).join(';'));
      const age = Number(/Max-Age=(\d+)/.exec(r.headers['set-cookie'][0])[1]);
      assert.ok(
        age >= security.sessionSeconds - 5 && age <= security.sessionSeconds,
        'Cookie lifetime must follow the persisted session, not the provisional flow',
      );
      return {
        cookie: r.headers['set-cookie'][0].split(';')[0],
        csrf: r.body.csrf_token,
        oldFlow: f,
      };
    };
    const count = async (table) =>
      Number(
        (
          await env.admin.query(
            `SELECT count(*) AS n FROM access_trial.${table}`,
          )
        ).rows[0].n,
      );
    const receptionTiming = async (suffix) => {
      const f = await flow(),
        groups = { declared: [], unknown: [] };
      let projection;
      for (
        let round = -TIMING_PROTOCOL.warmupRounds;
        round < TIMING_PROTOCOL.rounds;
        round++
      ) {
        for (let position = 0; position < 2; position++) {
          await env.admin.query(
            "DELETE FROM access_trial.throttle WHERE key LIKE 'mail:%'",
          );
          const known = (round + position) % 2 === 0;
          const start = performance.now(),
            r = await post(
              suffix,
              { email: known ? 'master@example.test' : 'unknown@example.test' },
              f,
            );
          const elapsed = performance.now() - start;
          assert.equal(r.status, 200);
          const visible = JSON.stringify({
            status: r.status,
            headers: r.headers,
            body: r.body,
          });
          projection ??= visible;
          assert.equal(visible, projection);
          if (round >= 0) groups[known ? 'declared' : 'unknown'].push(elapsed);
        }
      }
      const result = compareTiming(groups);
      writeFileSync(
        `/work/output/${suffix.includes('activation') ? 'activation' : 'recovery'}-timing.json`,
        JSON.stringify(result, null, 2),
      );
      t.diagnostic(JSON.stringify({ route: suffix, ...result }));
      assert.equal(
        result.signalDetected,
        false,
        'Reception timing signal; do not retune thresholds',
      );
    };
    let masterProof;
    await t.test(
      'A00 activation reception timing compares an eligible master against an unknown address',
      async () => {
        await receptionTiming('/activation/challenges');
        assert.ok(messages.length > 0);
        messages.length = 0;
        mailOutcomes.length = 0;
        await env.admin.query('DELETE FROM access_trial.throttle');
      },
    );
    await t.test(
      'A01 wrong first visitor, exact master activation and retry-safe single effect',
      async () => {
        const f = await flow();
        assert.equal(
          (
            await post(
              '/activation/challenges',
              { email: 'stranger@example.test' },
              f,
            )
          ).status,
          200,
        );
        assert.equal(messages.length, 0);
        assert.equal(await count('account'), 0);
        const r = await post(
          '/activation/challenges',
          { email: 'master@example.test' },
          f,
        );
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { status: 'accepted' });
        assert.equal(messages.length, 1);
        masterProof = messages.at(-1);
        const body = {
            challenge_id: masterProof.challenge_id,
            code: masterProof.code,
            password: 'Synthetic initial password',
          },
          key = randomUUID();
        const a = await post('/activation/complete', body, f, key);
        assert.equal(a.status, 200, failures.map((e) => e.message).join(';'));
        assert.equal(await count('account'), 1);
        assert.deepEqual(
          (await post('/activation/complete', body, f, key)).body,
          a.body,
        );
        assert.equal(
          (
            await post(
              '/activation/complete',
              { ...body, password: 'Changed payload' },
              f,
              key,
            )
          ).status,
          409,
        );
        assert.equal((await post('/activation/complete', body, f)).status, 403);
        const competing = await Promise.all([
          post('/activation/complete', body, f, key),
          post('/activation/complete', body, f, key),
        ]);
        assert.ok(
          competing.every(
            (r) =>
              r.status === 200 && r.body.operation_id === a.body.operation_id,
          ),
        );
        assert.equal(
          (
            await env.admin.query(
              'SELECT office,person_ref FROM access_trial.account',
            )
          ).rows[0].office,
          'master',
        );
      },
    );
    await t.test(
      'A02 root and reception are required; preparation does not invent a substantive frontier',
      async () => {
        await env.admin.query(
          "UPDATE access_trial.deployment SET reception='{}'",
        );
        assert.equal((await request('/reception')).status, 503);
        await env.admin.query(
          'UPDATE access_trial.deployment SET reception=$1',
          [env.reception],
        );
        await env.admin.query("UPDATE access_trial.deployment SET root='{}'");
        assert.equal((await request('/reception')).status, 503);
        await env.admin.query('UPDATE access_trial.deployment SET root=$1', [
          env.root,
        ]);
        const s = await login();
        const r = await request('/capabilities', {
          headers: { cookie: s.cookie },
        });
        assert.equal(r.status, 200);
        assert.deepEqual(
          r.body.capabilities.map((x) => x.capability_id),
          ['session_status', 'logout'],
        );
        assert.equal(
          (await request('/people', { headers: { cookie: s.cookie } })).status,
          404,
        );
      },
    );
    await t.test(
      'A03 cookie and CSRF rotate; cross-session and provisional tokens fail independently',
      async () => {
        const a = await login(),
          b = await login();
        assert.notEqual(a.csrf, a.oldFlow.csrf);
        assert.notEqual(a.csrf, b.csrf);
        for (const csrf of [a.oldFlow.csrf, b.csrf, token()])
          assert.equal(
            (
              await post('/sessions/logout', {}, a, randomUUID(), {
                'x-ledgerdesk-csrf': csrf,
              })
            ).status,
            403,
          );
        assert.equal(
          (await request('/session', { headers: { cookie: a.cookie } })).status,
          200,
        );
        assert.equal((await post('/sessions/logout', {}, a)).status, 200);
        assert.equal(
          (await request('/session', { headers: { cookie: a.cookie } })).status,
          403,
        );
        assert.equal((await post('/sessions/logout', {}, a)).status, 403);
        assert.equal(
          (await request('/session', { headers: { cookie: b.cookie } })).status,
          200,
        );
        assert.equal(
          (
            await post(
              '/sessions',
              {
                email: 'master@example.test',
                password: 'Synthetic initial password',
              },
              a.oldFlow,
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      'A04 Node HTTPS attacks isolate server Origin, CSRF and legacy-cookie admission',
      async () => {
        const s = await login(),
          before = await count('evidence');
        for (const origin of ['https://evil.inc02.test:8443', 'null']) {
          const r = await request('/sessions/logout', {
            method: 'POST',
            body: {},
            origin,
            headers: {
              cookie: s.cookie,
              'x-ledgerdesk-csrf': s.csrf,
              'x-ledgerdesk-intent': randomUUID(),
            },
          });
          assert.equal(r.status, 403);
          assert.equal(await count('evidence'), before);
        }
        assert.equal(
          (
            await request('/session', {
              headers: { cookie: 'ld_dev_user=master' },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request('/session', {
              headers: { cookie: `${s.cookie}; ${s.cookie}` },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request('/session?account=master', {
              headers: { cookie: s.cookie },
            })
          ).status,
          404,
        );
        assert.equal(
          (await request('/session', { method: 'HEAD' })).status,
          403,
        );
        assert.equal(
          (
            await request('/sessions', {
              method: 'POST',
              body: '{"email":"a@b.test","email":"b@b.test","password":"x"}',
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request('/sessions', {
              method: 'POST',
              body: 'x'.repeat(16385),
            })
          ).status,
          413,
        );
      },
    );
    await t.test(
      'A05 real persistence survives service restart; authority restriction is current',
      async () => {
        const s = await login();
        await launch();
        assert.equal(
          (await request('/session', { headers: { cookie: s.cookie } })).status,
          200,
        );
        const id = (
          await env.admin.query('SELECT id FROM access_trial.account')
        ).rows[0].id;
        await env.control.query(
          'SELECT access_trial.restrict_account($1,true)',
          [id],
        );
        assert.equal(
          (await request('/session', { headers: { cookie: s.cookie } })).status,
          403,
        );
        await env.control.query(
          'SELECT access_trial.restrict_account($1,false)',
          [id],
        );
        assert.equal(
          (await request('/session', { headers: { cookie: s.cookie } })).status,
          403,
        );
      },
    );
    await t.test(
      'A06 admission, evidence and effect commit before a paused handoff; SQL is idle',
      async () => {
        const s = await login();
        let release, entered;
        const gate = new Promise((r) => (release = r)),
          arrived = new Promise((r) => (entered = r));
        hooks.afterCommit = async (route) => {
          if (route === 'current_session') {
            entered();
            await Promise.race([
              gate,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('gate timeout')), 2000),
              ),
            ]);
          }
        };
        try {
          const pending = request('/session', {
            headers: { cookie: s.cookie },
          });
          await arrived;
          const prior = (
            await env.admin.query(
              "SELECT * FROM access_trial.evidence WHERE operation='current_session' AND result=200 ORDER BY recorded_at DESC LIMIT 1",
            )
          ).rows[0];
          assert.ok(prior);
          assert.equal(
            (
              await env.admin.query(
                'SELECT * FROM access_trial.transport_observation WHERE evidence_id=$1',
                [prior.id],
              )
            ).rows.length,
            0,
          );
          const states = (
            await env.admin.query(
              "SELECT state FROM pg_stat_activity WHERE application_name='inc02-access'",
            )
          ).rows;
          assert.ok(
            states.length > 0 && states.every((r) => r.state === 'idle'),
          );
          let done = false;
          const invalidator = env.control
            .query('SELECT access_trial.set_control(false,0,$1)', [
              'test revocation',
            ])
            .then(() => (done = true));
          await new Promise((r) => setTimeout(r, 25));
          assert.equal(done, false);
          release();
          assert.equal((await pending).status, 200);
          await invalidator;
          let observation;
          for (let attempt = 0; attempt < 20; attempt++) {
            observation = (
              await env.admin.query(
                'SELECT * FROM access_trial.transport_observation WHERE evidence_id=$1',
                [prior.id],
              )
            ).rows[0];
            if (observation) break;
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(observation?.outcome, 'handed_off');
          assert.ok(
            Number(observation.recorded_at) >= Number(prior.recorded_at),
          );
          assert.equal(
            (await request('/session', { headers: { cookie: s.cookie } }))
              .status,
            503,
          );
        } finally {
          release();
          delete hooks.afterCommit;
          await env.control.query(
            'SELECT access_trial.set_control(true,0,$1)',
            ['restore trial'],
          );
        }
      },
    );
    await t.test(
      'A07 evidence failure rolls back activation/session effects',
      async () => {
        const f = await flow(),
          before = await count('session');
        await env.admin.query(
          'REVOKE INSERT ON access_trial.evidence FROM inc02_runtime',
        );
        try {
          assert.equal(
            (
              await post(
                '/sessions',
                {
                  email: 'master@example.test',
                  password: 'Synthetic initial password',
                },
                f,
              )
            ).status,
            503,
          );
          assert.equal(await count('session'), before);
        } finally {
          await env.admin.query(
            'GRANT INSERT ON access_trial.evidence TO inc02_runtime',
          );
        }
      },
    );
    await t.test(
      'A08 technical recovery needs deployment authorization; exact proof, retry, old sessions',
      async () => {
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'mail:%'",
        );
        const s = await login(),
          f = await flow(),
          before = messages.length;
        await post('/recovery/challenges', { email: 'master@example.test' }, f);
        assert.equal(messages.length, before);
        await env.control.query('SELECT access_trial.set_control(true,$1,$2)', [
          Date.now() + 120000,
          'controlled credential recovery',
        ]);
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'mail:%'",
        );
        await post('/recovery/challenges', { email: 'master@example.test' }, f);
        const proof = messages.at(-1);
        assert.equal(proof.purpose, 'recovery');
        assert.equal(
          (
            await post(
              '/activation/complete',
              {
                challenge_id: proof.challenge_id,
                code: proof.code,
                password: 'wrong-purpose',
              },
              f,
            )
          ).status,
          403,
        );
        const body = {
            challenge_id: proof.challenge_id,
            code: proof.code,
            password: 'Synthetic recovered password',
          },
          key = randomUUID();
        // The effect commits but the response is lost. Retry must reconcile, not reapply.
        let once = true;
        hooks.afterCommit = async (route) => {
          if (route === 'recover_credential' && once) {
            once = false;
            throw new Error('Injected loss after effect commit');
          }
        };
        try {
          assert.equal(
            (await post('/recovery/complete', body, f, key)).status,
            503,
          );
        } finally {
          delete hooks.afterCommit;
        }
        const a = await post('/recovery/complete', body, f, key);
        assert.equal(a.status, 200, failures.map((e) => e.message).join(';'));
        const version = (
          await env.admin.query('SELECT revision FROM access_trial.account')
        ).rows[0].revision;
        assert.deepEqual(
          (await post('/recovery/complete', body, f, key)).body,
          a.body,
        );
        assert.equal(
          (await env.admin.query('SELECT revision FROM access_trial.account'))
            .rows[0].revision,
          version,
        );
        assert.equal((await post('/recovery/complete', body, f)).status, 403);
        assert.equal(
          (await request('/session', { headers: { cookie: s.cookie } })).status,
          403,
        );
        assert.equal(await count('account'), 1);
        assert.equal(
          (
            await env.admin.query(
              'SELECT person_ref,office FROM access_trial.account',
            )
          ).rows[0].person_ref,
          env.root.holderPersonRef,
        );
        await login('Synthetic recovered password');
      },
    );
    await t.test(
      'A15 concurrent proof consumption creates exactly one credential replacement',
      async () => {
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'mail:%'",
        );
        const a = await flow(),
          b = await flow();
        await post('/recovery/challenges', { email: 'master@example.test' }, a);
        const proof = messages.at(-1),
          before = (
            await env.admin.query('SELECT revision FROM access_trial.account')
          ).rows[0].revision;
        const body = {
          challenge_id: proof.challenge_id,
          code: proof.code,
          password: 'Synthetic recovered password',
        };
        const results = await Promise.all([
          post('/recovery/complete', body, a),
          post('/recovery/complete', body, b),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
        assert.equal(
          (await env.admin.query('SELECT revision FROM access_trial.account'))
            .rows[0].revision,
          before + 1,
        );
      },
    );
    await t.test(
      'A09 invalid proof attempts persist, bounded resends and failed mailbox do not claim delivery',
      async () => {
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'mail:%'",
        );
        const f = await flow();
        await post('/recovery/challenges', { email: 'master@example.test' }, f);
        const proof = messages.at(-1);
        for (let i = 0; i < 5; i++)
          assert.equal(
            (
              await post(
                '/recovery/complete',
                {
                  challenge_id: proof.challenge_id,
                  code: token(),
                  password: 'unused',
                },
                f,
              )
            ).status,
            403,
          );
        assert.equal(
          (
            await post(
              '/recovery/complete',
              {
                challenge_id: proof.challenge_id,
                code: proof.code,
                password: 'unused',
              },
              f,
            )
          ).status,
          403,
        );
        assert.equal(
          Number(
            (
              await env.admin.query(
                'SELECT attempts FROM access_trial.proof WHERE id=$1',
                [proof.challenge_id],
              )
            ).rows[0].attempts,
          ),
          5,
        );
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'mail:%'",
        );
        mailFail = true;
        const r = await post(
          '/recovery/challenges',
          { email: 'master@example.test' },
          f,
        );
        assert.deepEqual(r.body, { status: 'accepted' });
        assert.equal(mailOutcomes.at(-1), 'failed');
        mailFail = false;
        const sent = messages.length;
        await post('/recovery/challenges', { email: 'master@example.test' }, f);
        assert.equal(messages.length, sent);
      },
    );
    await t.test(
      'A10 physical privilege boundaries and append-only evidence',
      async () => {
        for (const sql of [
          'SELECT * FROM retained_legacy.private_data',
          'UPDATE access_trial.deployment SET active=true',
          'UPDATE access_trial.account SET restricted=false',
          'DELETE FROM access_trial.evidence',
          'UPDATE access_trial.evidence SET result=200',
          'SET ROLE inc02_owner',
          'CREATE TABLE public.escape(id int)',
          "SELECT access_trial.set_control(true,0,'runtime escalation')",
        ]) {
          await assert.rejects(
            env.runtime.query(sql),
            (e) => e.code === '42501',
            sql,
          );
        }
        await env.admin.query('SET ROLE retained_legacy');
        try {
          await assert.rejects(
            env.admin.query('SELECT * FROM access_trial.account'),
            (e) => e.code === '42501',
          );
        } finally {
          await env.admin.query('RESET ROLE');
        }
        const text = JSON.stringify(
          (await env.admin.query('SELECT * FROM access_trial.evidence')).rows,
        );
        assert.equal(text.includes('Synthetic recovered password'), false);
        assert.equal(text.includes(masterProof.code), false);
      },
    );
    await t.test(
      'A11 account non-enumeration: declared HTTP timing comparison and shifted control',
      async () => {
        const f = await flow(),
          groups = { unknown: [], wrongPassword: [] };
        let projection;
        for (
          let round = -TIMING_PROTOCOL.warmupRounds;
          round < TIMING_PROTOCOL.rounds;
          round++
        ) {
          for (let position = 0; position < 2; position++) {
            const known = (round + position) % 2 === 0;
            // Reset both targets equally: the measurement is of admitted attempts, not rate-limit speed.
            await env.admin.query(
              "DELETE FROM access_trial.throttle WHERE key LIKE 'login:%'",
            );
            const start = performance.now();
            const r = await post(
              '/sessions',
              {
                email: known ? 'master@example.test' : 'unknown@example.test',
                password: 'Incorrect synthetic password',
              },
              f,
            );
            const elapsed = performance.now() - start;
            assert.equal(r.status, 403);
            assert.equal(r.body.code, 'unauthenticated');
            const visible = JSON.stringify({
              status: r.status,
              headers: r.headers,
              body: r.body,
            });
            projection ??= visible;
            assert.equal(visible, projection);
            assert.equal(r.headers['set-cookie'], undefined);
            assert.equal(r.headers['cache-control'], 'no-store');
            if (round >= 0)
              groups[known ? 'wrongPassword' : 'unknown'].push(elapsed);
          }
        }
        const result = compareTiming(groups);
        writeFileSync(
          '/work/output/login-timing.json',
          JSON.stringify(
            { ...result, universalNoninterference: false },
            null,
            2,
          ),
        );
        t.diagnostic(JSON.stringify(result));
        assert.equal(
          result.signalDetected,
          false,
          'Account existence timing signal detected; do not retune thresholds',
        );
        assert.equal(
          compareTiming({
            a: Array.from({ length: 128 }, (_, i) => i % 3),
            b: Array.from({ length: 128 }, (_, i) => 20 + (i % 3)),
          }).signalDetected,
          true,
        );
        for (const email of ['master@example.test', 'unknown@example.test']) {
          await env.admin.query(
            "DELETE FROM access_trial.throttle WHERE key LIKE 'login:%'",
          );
          for (let i = 0; i < 5; i++)
            assert.equal(
              (await post('/sessions', { email, password: 'wrong' }, f)).status,
              403,
            );
          assert.equal(
            (await post('/sessions', { email, password: 'wrong' }, f)).status,
            429,
          );
        }
      },
    );
    await t.test(
      'A16 peer isolation, fresh cookies, forged forwarding and shared-address expiry',
      async () => {
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'login:%'",
        );
        const before = (
          await env.admin.query('SELECT * FROM access_trial.account')
        ).rows;
        const email = 'master@example.test',
          password = 'Synthetic recovered password';
        const attacker = await flow('127.0.0.2');
        for (let i = 0; i < 5; i++)
          assert.equal(
            (await post('/sessions', { email, password: 'wrong' }, attacker))
              .status,
            403,
          );
        const budgetBefore = (
          await env.admin.query(
            "SELECT * FROM access_trial.throttle WHERE key LIKE 'login:%' ORDER BY key",
          )
        ).rows;
        assert.deepEqual(
          budgetBefore.map((r) => r.count),
          [5, 5],
        );
        const replacement = await flow('127.0.0.2');
        assert.notEqual(replacement.cookie, attacker.cookie);
        for (const f of [attacker, replacement]) {
          const refused = await post(
            '/sessions',
            { email, password },
            f,
            randomUUID(),
            {
              'x-forwarded-for': '127.0.0.3',
              'x-real-ip': '127.0.0.3',
              forwarded: 'for=127.0.0.3',
            },
          );
          assert.equal(refused.status, 429);
          assert.equal(refused.body.code, 'rate_limited');
          assert.equal(refused.headers['set-cookie'], undefined);
        }
        assert.deepEqual(
          (
            await env.admin.query(
              "SELECT * FROM access_trial.throttle WHERE key LIKE 'login:%' ORDER BY key",
            )
          ).rows,
          budgetBefore,
          'Refused peer requests must neither spend the aggregate nor extend the window',
        );
        // A service restart must not discard the exhausted peer budget.
        await launch();
        assert.equal(
          (await post('/sessions', { email, password }, replacement)).status,
          429,
        );
        const holder = await flow('127.0.0.3');
        assert.equal(
          (await post('/sessions', { email, password }, holder)).status,
          200,
          'A different socket peer must retain its login budget after one peer exhausts five attempts',
        );
        assert.deepEqual(
          (await env.admin.query('SELECT * FROM access_trial.account')).rows,
          before,
        );
        // Directed expiry: age only the persisted attempt window, never the identity or production clock.
        await env.admin.query(
          `UPDATE access_trial.throttle
        SET window_start=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-$1
        WHERE key LIKE 'login:%'`,
          [security.attemptWindowSeconds * 1000 + 1],
        );
        assert.equal(
          (await post('/sessions', { email, password }, replacement)).status,
          200,
        );
        assert.deepEqual(
          (await env.admin.query('SELECT * FROM access_trial.account')).rows,
          before,
        );
      },
    );
    await t.test(
      'A17 distributed guessing retains an aggregate ceiling and declares its temporary denial',
      async () => {
        const before = (
          await env.admin.query('SELECT * FROM access_trial.account')
        ).rows;
        const run = async (email) => {
          await env.admin.query(
            "DELETE FROM access_trial.throttle WHERE key LIKE 'login:%'",
          );
          for (let peer = 10; peer < 20; peer++) {
            const f = await flow(`127.0.0.${peer}`);
            for (let i = 0; i < 5; i++)
              assert.equal(
                (await post('/sessions', { email, password: 'wrong' }, f))
                  .status,
                403,
              );
          }
          const f = await flow('127.0.0.20');
          const r = await post(
            '/sessions',
            { email, password: 'Synthetic recovered password' },
            f,
          );
          assert.equal(r.status, 429);
          assert.equal(r.body.code, 'rate_limited');
          assert.equal(
            Number(
              (
                await env.admin.query(
                  "SELECT count FROM access_trial.throttle WHERE key LIKE 'login:account:%'",
                )
              ).rows[0].count,
            ),
            50,
          );
          return { f, r };
        };
        const known = await run('master@example.test');
        await env.admin.query(
          `UPDATE access_trial.throttle
        SET window_start=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-$1
        WHERE key LIKE 'login:%'`,
          [security.attemptWindowSeconds * 1000 + 1],
        );
        assert.equal(
          (
            await post(
              '/sessions',
              {
                email: 'master@example.test',
                password: 'Synthetic recovered password',
              },
              known.f,
            )
          ).status,
          200,
        );
        const unknown = await run('unknown@example.test');
        assert.deepEqual(
          { body: known.r.body, headers: known.r.headers },
          { body: unknown.r.body, headers: unknown.r.headers },
        );
        assert.deepEqual(
          (await env.admin.query('SELECT * FROM access_trial.account')).rows,
          before,
        );
      },
    );
    await t.test(
      'A19 simultaneous attempts cannot exceed the last peer allowance',
      async () => {
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'login:%'",
        );
        const f = await flow('127.0.0.30');
        const body = { email: 'master@example.test', password: 'wrong' };
        for (let i = 0; i < 4; i++)
          assert.equal((await post('/sessions', body, f)).status, 403);
        const results = await Promise.all([
          post('/sessions', body, f),
          post('/sessions', body, f),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [403, 429]);
        assert.deepEqual(
          (
            await env.admin.query(
              "SELECT count FROM access_trial.throttle WHERE key LIKE 'login:%' ORDER BY key",
            )
          ).rows.map((r) => r.count),
          [5, 5],
        );
      },
    );
    await t.test(
      'A18 distinct cookies survive real HTTPS serialization without overwriting',
      async () => {
        const now = Date.now(),
          session = token(),
          provisional = token();
        let clear = false;
        const server = https.createServer(env.tls, (_req, res) => {
          res.writeHead(200, {
            'set-cookie': cookieHeaders(
              {
                status: 200,
                body: {},
                sessionCookie: clear ? '' : session,
                flowCookie: provisional,
                credentialExpiresAt: now + 1800000,
                expiresAt: now + 300000,
              },
              now,
            ),
          });
          res.end();
        });
        try {
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          const read = () =>
            new Promise((resolve, reject) => {
              const req = https.get(
                {
                  host: '127.0.0.1',
                  port: server.address().port,
                  servername: 'api.inc02.test',
                  ca: env.ca,
                  agent: false,
                  timeout: 5000,
                },
                (res) => {
                  res.resume();
                  res.on('end', () => resolve(res.headers['set-cookie']));
                },
              );
              req.on('error', reject);
              req.on('timeout', () =>
                req.destroy(new Error('Cookie probe timeout')),
              );
            });
          const attributes =
            '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=';
          assert.deepEqual(await read(), [
            `__Host-ledgerdesk-session=${session}${attributes}1800`,
            `__Host-ledgerdesk-flow=${provisional}${attributes}300`,
          ]);
          clear = true;
          assert.deepEqual(await read(), [
            `__Host-ledgerdesk-session=${attributes}0`,
            `__Host-ledgerdesk-flow=${provisional}${attributes}300`,
          ]);
        } finally {
          server.closeAllConnections();
          await new Promise((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve())),
          );
        }
      },
    );
    await t.test(
      'A14 challenge reception hides eligibility across body, status, headers and timing',
      async () => {
        const before = messages.length;
        await receptionTiming('/recovery/challenges');
        assert.ok(messages.length > before);
      },
    );
    await t.test(
      'A12 writer-free expiry before handoff is tested, without claiming universal conformity',
      async () => {
        const s = await login('Synthetic recovered password');
        await env.admin.query(
          'UPDATE access_trial.session SET expires_at=$1 WHERE digest=$2',
          [Date.now() + 150, terminal.service.digest(s.cookie.split('=')[1])],
        );
        hooks.afterCommit = async (route) => {
          if (route === 'current_session')
            await new Promise((r) => setTimeout(r, 200));
        };
        try {
          assert.equal(
            (await request('/session', { headers: { cookie: s.cookie } }))
              .status,
            503,
          );
        } finally {
          delete hooks.afterCommit;
        }
        t.diagnostic(
          'Directed elapsed-deadline case rejected; fullTemporalConformity: false',
        );
      },
    );
    await t.test(
      'A13 actual Next UI signs in and out with persistent account; no SSR or UI-host secret',
      async () => {
        await env.admin.query(
          // Owned synthetic fixture only: the additive invitation foreign keys now reference accounts.
          'TRUNCATE access_trial.session,access_trial.account CASCADE',
        );
        await env.admin.query('DELETE FROM access_trial.throttle');
        app = next({
          dev: false,
          dir: path.resolve('tests/access/runtime-ui'),
          hostname: 'ui.inc02.test',
          port: 8443,
        });
        await app.prepare();
        const handler = app.getRequestHandler();
        let leakedCookies = 0;
        uiServer = https.createServer(env.tls, (req, res) => {
          if ((req.headers.cookie ?? '').includes('__Host-ledgerdesk'))
            leakedCookies++;
          handler(req, res);
        });
        await new Promise((r) => uiServer.listen(8443, '127.0.0.1', r));
        browser = await chromium.launch({
          args: [
            '--host-resolver-rules=MAP *.inc02.test 127.0.0.1',
            '--no-proxy-server',
          ],
        });
        const context = await browser.newContext({
            viewport: { width: 1100, height: 800 },
          }),
          page = await context.newPage();
        await page.goto(ui);
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .last()
          .waitFor();
        await page
          .getByRole('button', { name: 'Activate', exact: true })
          .click();
        await page
          .getByLabel('Email address', { exact: true })
          .fill('master@example.test');
        await page
          .getByRole('button', { name: 'Request activation code', exact: true })
          .click();
        await page.getByText('Request received.', { exact: false }).waitFor();
        const activation = messages.at(-1);
        assert.equal(activation.purpose, 'activation');
        await page
          .getByLabel('Challenge identifier')
          .fill(activation.challenge_id);
        await page.getByLabel('Verification code').fill(activation.code);
        await page
          .getByLabel('New password', { exact: true })
          .fill('Synthetic browser password');
        await page
          .getByRole('button', { name: 'Activate account', exact: true })
          .click();
        await page
          .getByText('Account activated. You can now sign in.')
          .waitFor();
        await page
          .getByLabel('Password', { exact: true })
          .fill('Synthetic browser password');
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .last()
          .click();
        await page.getByRole('heading', { name: 'Session active' }).waitFor();
        await page.reload();
        await page.getByRole('heading', { name: 'Session active' }).waitFor();
        assert.equal(leakedCookies, 0);
        assert.equal(await page.evaluate(() => document.cookie), '');
        assert.equal(
          await page.evaluate(
            () => localStorage.length + sessionStorage.length,
          ),
          0,
        );
        await page.screenshot({
          path: '/work/output/session-desktop.png',
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: '/work/output/session-narrow.png',
          fullPage: true,
        });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        const raw = await page.evaluate(
          async () => await (await fetch('/')).text(),
        );
        assert.equal(raw.includes('Synthetic browser password'), false);
        for (const c of await context.cookies())
          assert.equal(raw.includes(c.value), false);
        await page
          .getByRole('button', { name: 'Sign out', exact: true })
          .click();
        await page
          .getByText('Signed out. The previous session is invalid.')
          .waitFor();
        await page.screenshot({
          path: '/work/output/signed-out.png',
          fullPage: true,
        });
        await env.control.query('SELECT access_trial.set_control(true,$1,$2)', [
          Date.now() + 120000,
          'browser technical recovery',
        ]);
        await env.admin.query(
          "DELETE FROM access_trial.throttle WHERE key LIKE 'mail:%'",
        );
        await page
          .getByRole('button', { name: 'Recover', exact: true })
          .click();
        await page
          .getByLabel('Email address', { exact: true })
          .fill('master@example.test');
        await page
          .getByRole('button', { name: 'Request recovery code', exact: true })
          .click();
        await page.getByText('Request received.', { exact: false }).waitFor();
        const recovery = messages.at(-1);
        await page
          .getByLabel('Challenge identifier')
          .fill(recovery.challenge_id);
        await page.getByLabel('Verification code').fill(recovery.code);
        await page
          .getByLabel('New password', { exact: true })
          .fill('Synthetic final browser password');
        const previous = (
          await env.admin.query('SELECT revision FROM access_trial.account')
        ).rows[0].revision;
        let lost = true;
        hooks.afterCommit = async (route) => {
          if (route === 'recover_credential' && lost) {
            lost = false;
            throw new Error('Injected committed browser response loss');
          }
        };
        try {
          await page
            .getByRole('button', { name: 'Replace password', exact: true })
            .click();
          await page
            .getByText('The service could not confirm this operation.', {
              exact: true,
            })
            .waitFor();
          await page
            .getByRole('button', { name: 'Replace password', exact: true })
            .click();
          await page
            .getByText(
              'Credential replaced. Previous sessions are no longer valid. Sign in again.',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            (await env.admin.query('SELECT revision FROM access_trial.account'))
              .rows[0].revision,
            previous + 1,
          );
        } finally {
          delete hooks.afterCommit;
        }
        await context.close();
      },
    );
    assert.equal(/you don't own a lock/i.test(env.postgresLog()), false);
  },
);
