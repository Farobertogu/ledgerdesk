import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runtimeEnvironment } from './runtime_environment.mjs';
import { startAccessTerminal } from '../../src/server/access/terminal.ts';
import { PasswordVerifier } from '../../src/server/access/password.ts';
import { AccessStore } from '../../src/server/access/postgres/store.ts';
import next from 'next';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { observeBrowser } from '../reading/browser_diagnostics.mjs';
import {
  compareTiming,
  TIMING_PROTOCOL,
} from '../reading/timing_comparison.mjs';

const origin = 'https://ui.inc02.test:8443';
test(
  'T03 persistent invitation lifecycle and discriminating races',
  { timeout: 240000 },
  async (t) => {
    const env = await runtimeEnvironment({ invitations: false });
    t.afterEach(async () => {
      await env.admin.query('ROLLBACK');
      delete hooks.beforeCommit;
      delete hooks.afterCommit;
    });
    let terminal, mutantRoot, browser, app, uiServer;
    const hooks = {
      failure: (e) =>
        console.error('INVITATION_FAILURE', e.message, e.code ?? ''),
    };
    t.after(async () => {
      try {
        await env.admin.query('ROLLBACK');
        await browser?.close();
        uiServer?.closeAllConnections();
        if (uiServer) await new Promise((r) => uiServer.close(r));
        await app?.close();
        await terminal?.close();
      } finally {
        await env.close();
        if (mutantRoot) {
          assert.ok(mutantRoot.startsWith('/work/output/invitation-mutant-'));
          rmSync(mutantRoot, { recursive: true, force: true });
        }
      }
    });
    const passwords = new PasswordVerifier();
    await passwords.initialize();
    const masterId = randomUUID(),
      password = 'Synthetic master password';
    const verifier = await passwords.create(password);
    await env.admin.query(
      'INSERT INTO access_trial.account(id,email,person_ref,office,verifier) VALUES($1,$2,$3,$4,$5)',
      [
        masterId,
        'master@example.test',
        'synthetic-custodian',
        'master',
        verifier,
      ],
    );
    const before = (await env.admin.query('SELECT * FROM access_trial.account'))
      .rows;
    await env.admin.query(
      readFileSync(
        new URL(
          '../../src/server/access/postgres/002_invitations.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const security = {
      profile: 'access-trial/1',
      sessionSeconds: 1800,
      proofSeconds: 300,
      invitationSeconds: 86400,
      proofAttempts: 5,
      loginAttempts: 5,
      attemptWindowSeconds: 300,
      bodyBytes: 16384,
      resendSeconds: 1,
      resendLimit: 3,
      retryLimit: 2,
    };
    const config = {
      profile: 'access-runtime/1',
      synthetic: true,
      transport: {
        profile: 'session/1',
        uiOrigin: origin,
        terminalOrigin: 'https://api.inc02.test:9443',
      },
      security,
      connectionString: env.runtimeConfig.connectionString,
      expectedPort: 55432,
      digestKey: randomBytes(32).toString('hex'),
    };
    const digest = (s) =>
      createHmac('sha256', Buffer.from(config.digestKey, 'hex'))
        .update(s)
        .digest('hex');
    const messages = [],
      outcomes = [];
    let mailFailure = false;
    const mailbox = {
      async send(m) {
        outcomes.push(mailFailure ? 'failed' : 'delivered');
        if (mailFailure) throw Error('Controlled delivery failure');
        messages.push(m);
      },
    };
    let start = startAccessTerminal;
    const mutation = process.env.ACCESS_RUNTIME_MUTATION;
    if (mutation && mutation !== 'early-failure') {
      const changes = {
        'drop-invitation-revision': [
          'invitations.ts',
          'if (inv.revision !== body.expected_revision)',
          'if (false)',
          1,
        ],
        'drop-invitation-support': [
          'invitation_authority.ts',
          '!s?.active ||',
          '!s ||',
          1,
        ],
        'drop-invitation-incompatibility': [
          'invitations.ts',
          'if (authority.incompatible(personRef, current.grants))',
          'if (false)',
          1,
        ],
        'drop-invitation-proof': [
          'invitations.ts',
          'proof.id !== body.proof_id',
          'false',
          1,
        ],
        'drop-canonical-target': [
          '../../contracts/access_canonical.ts',
          'path: { template: ACCESS_ROUTES[route].path, parameters }',
          'path: { template: ACCESS_ROUTES[route].path, parameters: {} }',
          1,
        ],
        'drop-flow-coordination': [
          'service.ts',
          "['flow:' + this.digest(input.flow)]",
          '[]',
          1,
        ],
      };
      if (changes[mutation]) {
        mutantRoot = '/work/output/invitation-mutant-' + randomUUID();
        mkdirSync(mutantRoot, { recursive: true });
        cpSync('/work/src', mutantRoot + '/src', { recursive: true });
        const [file, from, to, count] = changes[mutation],
          target = mutantRoot + '/src/server/access/' + file,
          source = readFileSync(target, 'utf8');
        assert.equal(source.split(from).length - 1, count);
        let changed = source.replaceAll(from, to);
        if (mutation === 'drop-invitation-revision') {
          const shared = 'if (expected && inv.revision !== expected.revision)';
          assert.equal(changed.split(shared).length - 1, 1);
          changed = changed.replace(shared, 'if (false)');
        }
        if (mutation === 'drop-invitation-proof') {
          const shared = '(expected && proof.id !== expected.proofId)';
          assert.equal(changed.split(shared).length - 1, 1);
          changed = changed.replace(shared, 'false');
          const predicate = 'AND ($4::uuid IS NULL OR p.id=$4)';
          assert.equal(changed.split(predicate).length - 1, 1);
          changed = changed.replace(
            predicate,
            'AND ($4::uuid IS NULL OR TRUE)',
          );
        }
        writeFileSync(target, changed);
        start = (
          await import(
            pathToFileURL(mutantRoot + '/src/server/access/terminal.ts').href
          )
        ).startAccessTerminal;
      }
    }
    terminal = await start({ config, tls: env.tls, mailbox, hooks });
    if (mutation === 'early-failure') throw Error('Injected early failure');
    const request = (
      suffix,
      {
        method = 'GET',
        body,
        headers = {},
        client,
        origin: sentOrigin = origin,
      } = {},
    ) =>
      new Promise((resolve, reject) => {
        const bytes =
          body === undefined
            ? null
            : Buffer.from(
                typeof body === 'string' ? body : JSON.stringify(body),
              );
        const req = https.request(
          {
            host: '127.0.0.1',
            port: 9443,
            servername: 'api.inc02.test',
            ca: env.ca,
            path: '/api/access/v1' + suffix,
            method,
            headers: {
              Host: 'api.inc02.test:9443',
              Origin: sentOrigin,
              ...(client?.cookie ? { cookie: client.cookie } : {}),
              ...(bytes
                ? {
                    'content-type': 'application/json',
                    'content-length': bytes.length,
                  }
                : {}),
              ...headers,
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString();
              resolve({
                status: res.statusCode,
                body: raw ? JSON.parse(raw) : null,
                headers: res.headers,
              });
            });
          },
        );
        req.setTimeout(10000, () =>
          req.destroy(Error('HTTPS request timed out')),
        );
        req.on('error', reject);
        req.end(bytes);
      });
    const post = (suffix, body, client, key = randomUUID()) =>
      request(suffix, {
        method: 'POST',
        body,
        client,
        headers: {
          'x-ledgerdesk-csrf': client.csrf,
          'x-ledgerdesk-intent': key,
        },
      });
    const reception = async () => {
      const r = await request('/reception');
      assert.equal(r.status, 200);
      return {
        cookie: r.headers['set-cookie'][0].split(';')[0],
        csrf: r.body.csrf_token,
      };
    };
    const login = async (email, pw) => {
      const f = await reception(),
        r = await post('/sessions', { email, password: pw }, f);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return {
        cookie: r.headers['set-cookie'][0].split(';')[0],
        csrf: r.body.csrf_token,
      };
    };
    const master = await login('master@example.test', password);
    const now = Date.now(),
      until = now + 3600000;
    await env.admin.query(`INSERT INTO access_trial.permission_definition VALUES
    ('invite','Invite people','application',1,true,false),('ask','Ask questions','application',1,true,false),
    ('review','Review material','material_governance',1,true,false),('decide','Decide material','material_governance',1,true,true);
    INSERT INTO access_trial.scope_definition VALUES('organisation',NULL,'Organisation','operate-trial',1,true),
    ('team','organisation','Operations team','operate-trial',1,true),('other',NULL,'Unrelated domain','unrelated-trial',1,true);`);
    await env.admin.query(
      "INSERT INTO access_trial.support_definition VALUES('domain','domain',NULL,'Domain adoption','declared-adoption',$1,true,1)",
      [until],
    );
    const rootGrants = {};
    for (const [permission, faculty] of [
      ['invite', 'exercise'],
      ['invite', 'grant'],
      ['ask', 'grant'],
      ['review', 'grant'],
      ['decide', 'grant'],
    ]) {
      const id = randomUUID();
      rootGrants[permission + faculty] = id;
      await env.admin.query(
        'INSERT INTO access_trial.grant_record VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,false,1)',
        [
          id,
          masterId,
          permission,
          faculty,
          'organisation',
          'domain',
          'declared-trial-grant',
          until,
        ],
      );
    }
    await env.admin.query(
      "INSERT INTO access_trial.support_definition VALUES('delegated','delegated',$1,'Issuer-dependent delegation','declared-delegation',$2,true,1)",
      [rootGrants.askgrant, until],
    );
    const selector = (
      permission = 'ask',
      support = 'domain',
      scope = 'team',
      faculty = 'exercise',
    ) => ({
      permission_id: permission,
      exercise_or_grant: faculty,
      scope_ref: scope,
      support_ref: support,
    });
    const issue = async (
      email,
      grants = [selector()],
      family = 'application',
    ) => {
      const r = await post(
        '/invitations',
        { email, family, grants, expires_at: Date.now() + 360000 },
        master,
      );
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const verify = async (inv, flow) => {
      const r = await post(
        `/invitations/${inv.invitation_id}/challenges`,
        {},
        flow,
      );
      assert.equal(r.status, 200);
      const message = messages.at(-1);
      assert.equal(message.purpose, 'invitation');
      const proof = await post(
        `/invitation-proofs/${message.challenge_id}/verify`,
        { code: message.code },
        flow,
      );
      assert.equal(proof.status, 200, JSON.stringify(proof.body));
      return proof.body.proof_id;
    };
    const accept = (inv, flow, proof, key) =>
      post(
        `/invitations/${inv.invitation_id}/accept`,
        { expected_revision: inv.revision, proof_id: proof },
        flow,
        key,
      );
    let accepted, recipientFlow, recipientProof, recipientAccount, grantId;
    await t.test(
      'J01 additive migration retains master data and effective role limits',
      async () => {
        const after = (
          await env.admin.query(
            'SELECT * FROM access_trial.account WHERE id=$1',
            [masterId],
          )
        ).rows[0];
        for (const [k, v] of Object.entries(before[0]))
          assert.deepEqual(after[k], v);
        for (const sql of [
          "UPDATE access_trial.account SET office='master'",
          'DELETE FROM access_trial.evidence',
          'UPDATE access_trial.support_definition SET active=false',
          'SET ROLE inc02_owner',
          'SELECT * FROM retained_legacy.private_data',
        ])
          await assert.rejects(
            env.runtime.query(sql),
            (e) => e.code === '42501',
          );
        await assert.rejects(
          env.runtime.query(
            "INSERT INTO access_trial.account(id,email,person_ref,office,verifier) VALUES(gen_random_uuid(),'x@example.test','x','master','bad')",
          ),
        );
      },
    );
    await t.test(
      'J02 retained T02 intent uses its original comparator and is not executed again',
      async () => {
        const f = await reception(),
          key = randomUUID(),
          body = { email: 'master@example.test' },
          flow = f.cookie.split('=')[1];
        const old = digest(
          JSON.stringify([
            'recovery_challenge',
            Object.keys(body)
              .sort()
              .map((k) => [k, body[k]]),
          ]),
        );
        await env.admin.query(
          'INSERT INTO access_trial.intent(binding,intention,payload_digest,receipt) VALUES($1,$2,$3,$4)',
          [
            'recovery_challenge:' + digest(flow),
            key,
            old,
            { status: 'accepted' },
          ],
        );
        const count = messages.length;
        assert.equal(
          (await post('/recovery/challenges', body, f, key)).status,
          200,
        );
        assert.equal(messages.length, count);
        assert.equal(
          (
            await post(
              '/recovery/challenges',
              { email: 'other@example.test' },
              f,
              key,
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      'J03 granting authority and family are not role, exercise or scope guesses',
      async () => {
        for (const [grants, family] of [
          [[selector('ask', 'domain', 'other')], 'application'],
          [[selector('unknown')], 'application'],
          [[selector('review')], 'application'],
          [[selector('decide')], 'material_governance'],
          [[selector(), selector()], 'application'],
        ])
          assert.equal(
            (
              await post(
                '/invitations',
                {
                  email: 'denied@example.test',
                  family,
                  grants,
                  expires_at: Date.now() + 360000,
                },
                master,
              )
            ).status,
            403,
          );
        const valid = await issue(
          'govern@example.test',
          [selector('review')],
          'material_governance',
        );
        assert.ok(valid.invitation_id);
      },
    );
    await t.test(
      'J04 locator alone is private; code is bound to the actual flow and single invitation',
      async () => {
        accepted = await issue('recipient@example.test');
        recipientFlow = await reception();
        assert.equal(
          (
            await request('/invitations/' + accepted.invitation_id, {
              client: recipientFlow,
            })
          ).status,
          404,
        );
        await post(
          `/invitations/${accepted.invitation_id}/challenges`,
          {},
          recipientFlow,
        );
        const m = messages.at(-1),
          foreign = await reception();
        assert.equal(
          (
            await post(
              `/invitation-proofs/${m.challenge_id}/verify`,
              { code: m.code },
              foreign,
            )
          ).status,
          403,
        );
        const r = await post(
          `/invitation-proofs/${m.challenge_id}/verify`,
          { code: m.code },
          recipientFlow,
        );
        assert.equal(r.status, 200);
        recipientProof = r.body.proof_id;
        const view = await request('/invitations/' + accepted.invitation_id, {
          client: recipientFlow,
        });
        assert.equal(view.status, 200);
        assert.equal(view.body.terms[0].permission_label, 'Ask questions');
        assert.equal(
          (await accept(accepted, recipientFlow, randomUUID())).status,
          403,
        );
      },
    );
    await t.test(
      'J05 same invitation revision changes; stale acceptance fails for revision alone',
      async () => {
        const changed = await post(
          `/invitations/${accepted.invitation_id}/amend`,
          {
            expected_revision: 1,
            grants: [selector('ask', 'domain', 'organisation')],
          },
          master,
        );
        assert.equal(changed.status, 200);
        assert.equal(changed.body.revision, 2);
        const stale = await accept(accepted, recipientFlow, recipientProof);
        assert.equal(stale.status, 409);
        assert.equal(stale.body.code, 'revision_conflict');
        assert.equal(
          (
            await env.admin.query(
              'SELECT used FROM access_trial.email_proof WHERE id=$1',
              [recipientProof],
            )
          ).rows[0].used,
          false,
        );
        accepted.revision = 2;
        const key = randomUUID();
        const replies = await Promise.all([
          accept(accepted, recipientFlow, recipientProof, key),
          accept(accepted, recipientFlow, recipientProof, key),
        ]);
        assert.deepEqual(
          replies.map((r) => r.status),
          [200, 200],
        );
        assert.equal(
          replies[0].body.operation_id,
          replies[1].body.operation_id,
        );
        recipientAccount = (
          await env.admin.query(
            "SELECT * FROM access_trial.account WHERE email='recipient@example.test'",
          )
        ).rows[0];
        assert.equal(recipientAccount.verifier, null);
        assert.equal(recipientAccount.office, null);
        assert.equal(
          (
            await env.admin.query(
              'SELECT count(*)::int AS n FROM access_trial.acceptance WHERE invitation_id=$1',
              [accepted.invitation_id],
            )
          ).rows[0].n,
          1,
        );
        grantId = (
          await env.admin.query(
            'SELECT id FROM access_trial.grant_record WHERE account_id=$1',
            [recipientAccount.id],
          )
        ).rows[0].id;
      },
    );
    await t.test(
      'J06 lost initial flow recovers the same account; stale flow cannot overwrite the password',
      async () => {
        const fresh = await reception();
        await post(
          '/recovery/challenges',
          { email: 'recipient@example.test' },
          fresh,
        );
        const m = messages.at(-1);
        assert.equal(m.email, 'recipient@example.test');
        assert.equal(
          (
            await post(
              '/recovery/complete',
              {
                challenge_id: m.challenge_id,
                code: m.code,
                password: 'Recovered ordinary password',
              },
              fresh,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await post(
              '/account/initial-credential',
              { password: 'Stale overwrite' },
              recipientFlow,
            )
          ).status,
          403,
        );
        const session = await login(
          'recipient@example.test',
          'Recovered ordinary password',
        );
        assert.equal(
          (
            await post(
              '/invitations',
              {
                email: 'forbidden@example.test',
                family: 'application',
                grants: [selector()],
                expires_at: Date.now() + 300000,
              },
              session,
            )
          ).status,
          403,
        );
        assert.equal(
          (await request('/session', { client: session })).status,
          200,
        );
        assert.equal(
          (
            await env.admin.query(
              "SELECT id FROM access_trial.account WHERE email='recipient@example.test'",
            )
          ).rows[0].id,
          recipientAccount.id,
        );
      },
    );
    await t.test(
      'J07 expanded existing account is reused, and object changes conflict in one intent namespace',
      async () => {
        const one = await issue('recipient@example.test'),
          two = await issue('recipient@example.test');
        const f = await reception(),
          p = await verify(one, f),
          key = randomUUID();
        await verify(two, f);
        assert.equal((await accept(one, f, p, key)).status, 200);
        const repeated = await accept(two, f, p, key);
        const effects = (
          await env.admin.query(
            `SELECT
              (SELECT count(*)::int FROM access_trial.account WHERE email=$1) AS accounts,
              (SELECT count(*)::int FROM access_trial.acceptance WHERE invitation_id=ANY($2::uuid[])) AS acceptances`,
            ['recipient@example.test', [one.invitation_id, two.invitation_id]],
          )
        ).rows[0];
        assert.deepEqual(
          { status: repeated.status, ...effects },
          { status: 409, accounts: 1, acceptances: 1 },
        );
      },
    );
    await t.test(
      'J08 an issuer loses support; assumed grants remain while dependent support becomes invalid',
      async () => {
        const pending = await issue('support@example.test', [
            selector('ask', 'delegated'),
          ]),
          f = await reception(),
          p = await verify(pending, f);
        await env.control.query(
          "SELECT access_trial.set_support('delegated',false,'Directed support withdrawal')",
        );
        assert.equal((await accept(pending, f, p)).status, 403);
        assert.equal(
          (
            await env.admin.query(
              'SELECT withdrawn FROM access_trial.grant_record WHERE id=$1',
              [grantId],
            )
          ).rows[0].withdrawn,
          false,
        );
      },
    );
    await t.test(
      'J09 person-level incompatibility sees a different account and does not consume proof',
      async () => {
        const pending = await issue(
            'second-account@example.test',
            [selector('review')],
            'material_governance',
          ),
          f = await reception(),
          p = await verify(pending, f);
        await env.admin.query('BEGIN');
        await env.admin.query('SELECT pg_advisory_xact_lock(20202,1)');
        await env.admin.query(
          'INSERT INTO access_trial.person_determination VALUES($1,$2,$3)',
          [
            'second-account@example.test',
            recipientAccount.person_ref,
            'explicit-synthetic-person-link',
          ],
        );
        await env.admin.query(
          "INSERT INTO access_trial.incompatibility VALUES('separation','ask','review','organisation',true,1,'explicit-local-policy')",
        );
        await env.admin.query('COMMIT');
        assert.equal((await accept(pending, f, p)).status, 403);
        assert.equal(
          (
            await env.admin.query(
              'SELECT used FROM access_trial.email_proof WHERE id=$1',
              [p],
            )
          ).rows[0].used,
          false,
        );
      },
    );
    await t.test(
      'J10 withdrawal is effective without recipient consent and does not erase acceptance',
      async () => {
        assert.equal(
          (
            await post(
              '/grants/' + grantId + '/withdraw',
              { expected_revision: 1, reason: 'Scope ended' },
              master,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await env.admin.query(
              'SELECT withdrawn FROM access_trial.grant_record WHERE id=$1',
              [grantId],
            )
          ).rows[0].withdrawn,
          true,
        );
        assert.equal(
          (
            await post(
              '/invitations/' + accepted.invitation_id + '/withdraw',
              { expected_revision: 2, reason: 'Cannot undo history' },
              master,
            )
          ).status,
          403,
        );
        const pending = await issue('cancel@example.test'),
          f = await reception(),
          p = await verify(pending, f);
        assert.equal(
          (
            await post(
              '/invitations/' + pending.invitation_id + '/withdraw',
              { expected_revision: 1, reason: 'Cancelled' },
              master,
            )
          ).status,
          200,
        );
        assert.equal((await accept(pending, f, p)).status, 403);
      },
    );
    await t.test(
      'J11 effect committed but response lost: reauthorize receipt, never duplicate the effect',
      async () => {
        const pending = await issue('lost-response@example.test'),
          f = await reception(),
          p = await verify(pending, f),
          key = randomUUID();
        let once = true;
        hooks.afterCommit = async (route) => {
          if (route === 'accept_invitation' && once) {
            once = false;
            throw Error('Injected response loss');
          }
        };
        assert.equal((await accept(pending, f, p, key)).status, 503);
        delete hooks.afterCommit;
        const reconciled = await accept(pending, f, p, key);
        assert.equal(reconciled.status, 200);
        assert.equal(
          (
            await request('/operations/' + reconciled.body.operation_id, {
              client: f,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request('/operations/' + reconciled.body.operation_id, {
              client: await reception(),
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await env.admin.query(
              'SELECT count(*)::int AS n FROM access_trial.acceptance WHERE invitation_id=$1',
              [pending.invitation_id],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'J12 failure before commit leaves no account, acceptance, grant or consumed proof',
      async () => {
        const pending = await issue('rollback@example.test'),
          f = await reception(),
          p = await verify(pending, f);
        hooks.beforeCommit = async (route) => {
          if (route === 'accept_invitation')
            throw Error('Injected precommit failure');
        };
        assert.equal((await accept(pending, f, p)).status, 503);
        delete hooks.beforeCommit;
        assert.equal(
          (
            await env.admin.query(
              "SELECT count(*)::int AS n FROM access_trial.account WHERE email='rollback@example.test'",
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await env.admin.query(
              'SELECT used FROM access_trial.email_proof WHERE id=$1',
              [p],
            )
          ).rows[0].used,
          false,
        );
        assert.equal((await accept(pending, f, p)).status, 200);
      },
    );
    await t.test(
      'J13 lock sets requested in reverse order use identical effective ordering without the deployment guard',
      async () => {
        const a = new AccessStore(config, () => {}),
          b = new AccessStore(config, () => {});
        await a.client.connect();
        await b.client.connect();
        t.after(async () => {
          await a.close();
          await b.close();
        });
        const observed = [[], []];
        for (const [i, store] of [a, b].entries()) {
          const query = store.client.query.bind(store.client);
          store.client.query = async (sql, args) => {
            if (sql === 'SELECT pg_advisory_lock(20203,$1)')
              observed[i].push(args[0]);
            return query(sql, args);
          };
        }
        await Promise.all([
          a
            .lockObjects(['invitation:a', 'person:b'])
            .then(() => a.client.query('SELECT pg_advisory_unlock_all()')),
          b
            .lockObjects(['person:b', 'invitation:a'])
            .then(() => b.client.query('SELECT pg_advisory_unlock_all()')),
        ]);
        assert.equal(observed[0].length, 2);
        assert.deepEqual(observed[0], observed[1]);
        await a.close();
        await b.close();
      },
    );
    await t.test(
      'J14 exact server Origin and parameters; no future or malformed route',
      async () => {
        for (const suffix of [
          '/people',
          '/invitations/%61',
          '/invitations/x?admin=true',
        ])
          assert.equal((await request(suffix, { client: master })).status, 404);
        const count = (
          await env.admin.query(
            'SELECT count(*)::int AS n FROM access_trial.invitation',
          )
        ).rows[0].n;
        assert.equal(
          (
            await request('/invitations', {
              method: 'POST',
              origin: 'https://foreign.inc02.test',
              client: master,
              body: {},
              headers: { 'x-ledgerdesk-csrf': master.csrf },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await env.admin.query(
              'SELECT count(*)::int AS n FROM access_trial.invitation',
            )
          ).rows[0].n,
          count,
        );
      },
    );
    await t.test(
      'J15 mail delivery failure is not acceptance or public delivery confirmation',
      async () => {
        const pending = await issue('mail-failure@example.test'),
          f = await reception(),
          count = messages.length;
        mailFailure = true;
        assert.deepEqual(
          (
            await post(
              '/invitations/' + pending.invitation_id + '/challenges',
              {},
              f,
            )
          ).body,
          { status: 'accepted' },
        );
        mailFailure = false;
        assert.equal(messages.length, count);
        assert.equal(outcomes.at(-1), 'failed');
        assert.equal(
          (
            await env.admin.query(
              'SELECT state FROM access_trial.invitation WHERE id=$1',
              [pending.invitation_id],
            )
          ).rows[0].state,
          'pending',
        );
      },
    );
    await t.test(
      'J16 queued invalidator cannot pass an admitted acceptance; reversed order rejects',
      async () => {
        const pending = await issue('ordered@example.test'),
          f = await reception(),
          p = await verify(pending, f);
        let arrived, release;
        const atCommit = new Promise((r) => (arrived = r)),
          gate = new Promise((r) => (release = r));
        const timeout = setTimeout(() => release(), 3000);
        t.after(() => {
          clearTimeout(timeout);
          release();
          delete hooks.beforeCommit;
        });
        hooks.beforeCommit = async (route) => {
          if (route === 'accept_invitation') {
            arrived();
            await gate;
          }
        };
        const accepting = accept(pending, f, p);
        await Promise.race([
          atCommit,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(Error('Acceptance gate not reached')),
              4000,
            ),
          ),
        ]);
        let finished = false;
        const withdrawing = post(
          '/invitations/' + pending.invitation_id + '/withdraw',
          { expected_revision: 1, reason: 'Concurrent withdrawal' },
          master,
        ).then((r) => {
          finished = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(finished, false);
        release();
        assert.equal((await accepting).status, 200);
        assert.equal((await withdrawing).status, 403);
        delete hooks.beforeCommit;
        clearTimeout(timeout);
      },
    );
    await t.test(
      'J17 initial credential cannot be overwritten with an older recovery authorization',
      async () => {
        const pending = await issue('initial@example.test'),
          f = await reception(),
          p = await verify(pending, f);
        assert.equal((await accept(pending, f, p)).status, 200);
        const recovery = await reception();
        await post(
          '/recovery/challenges',
          { email: 'initial@example.test' },
          recovery,
        );
        const code = messages.at(-1);
        const initial = await post(
          '/account/initial-credential',
          { password: 'First ordinary password' },
          f,
        );
        assert.equal(initial.status, 200);
        assert.equal(
          (
            await request('/operations/' + initial.body.operation_id, {
              client: f,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await request('/operations/' + initial.body.operation_id, {
              client: recovery,
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await post(
              '/recovery/complete',
              {
                challenge_id: code.challenge_id,
                code: code.code,
                password: 'Obsolete recovery',
              },
              recovery,
            )
          ).status,
          403,
        );
        assert.ok(
          (await login('initial@example.test', 'First ordinary password'))
            .cookie,
        );
      },
    );
    await t.test(
      'J18 amendment cannot change recipient, family or lifetime; expiry is checked at the effect boundary',
      async () => {
        const pending = await issue('expiry@example.test'),
          f = await reception(),
          p = await verify(pending, f);
        for (const extra of [
          { email: 'other@example.test' },
          { family: 'material_governance' },
          { expires_at: Date.now() + 86400000 },
        ])
          assert.equal(
            (
              await post(
                '/invitations/' + pending.invitation_id + '/amend',
                { expected_revision: 1, grants: [selector()], ...extra },
                master,
              )
            ).status,
            400,
          );
        // A short proof drives the actual deadline without editing the invitation or changing its terms.
        await env.admin.query(
          'UPDATE access_trial.email_proof SET expires_at=$2 WHERE id=$1',
          [p, Date.now() + 180],
        );
        hooks.beforeCommit = async (route) => {
          if (route === 'accept_invitation')
            await new Promise((r) => setTimeout(r, 250));
        };
        assert.equal((await accept(pending, f, p)).status, 503);
        delete hooks.beforeCommit;
        assert.equal(
          (
            await env.admin.query(
              'SELECT used FROM access_trial.email_proof WHERE id=$1',
              [p],
            )
          ).rows[0].used,
          false,
        );
        t.diagnostic(
          'Directed elapsed deadline rejected; fullTemporalConformity: false',
        );
      },
    );
    await t.test(
      'J19 actual browser accepts visible terms, sets first credential and survives narrow layout',
      async () => {
        app = next({
          dev: false,
          dir: path.resolve('tests/access/runtime-ui'),
          hostname: 'ui.inc02.test',
          port: 8443,
        });
        await app.prepare();
        const handler = app.getRequestHandler();
        let uiCookieLeaks = 0;
        uiServer = https.createServer(env.tls, (req, res) => {
          if ((req.headers.cookie ?? '').includes('__Host-ledgerdesk'))
            uiCookieLeaks++;
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
            viewport: { width: 1100, height: 850 },
          }),
          page = await context.newPage();
        const diagnostic = observeBrowser(
          page,
          '/work/output/browser-diagnostics',
        );
        try {
          await diagnostic.run('J19', async () => {
            diagnostic.mark('initial-reception');
            const pending = await issue('browser-invite@example.test');
            let releaseReception, seenReception;
            const receptionGate = new Promise((r) => (releaseReception = r)),
              receptionSeen = new Promise((r) => (seenReception = r));
            let held = false;
            const receptionTimeout = setTimeout(() => releaseReception(), 5000);
            await page.route('**/api/access/v1/reception', async (route) => {
              if (!held) {
                held = true;
                seenReception();
                await receptionGate;
              }
              await route.continue();
            });
            await page.goto(origin);
            try {
              await Promise.race([
                receptionSeen,
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(Error('Initial reception not reached')),
                    3000,
                  ),
                ),
              ]);
              assert.equal(
                await page
                  .getByRole('button', {
                    name: 'Open invitation workspace',
                    exact: true,
                  })
                  .isDisabled(),
                true,
                'Invitation reception must not race the initial account flow',
              );
            } finally {
              releaseReception();
              clearTimeout(receptionTimeout);
            }
            await page
              .getByRole('button', {
                name: 'Open invitation workspace',
                exact: true,
              })
              .click();
            await page
              .getByLabel('Invitation identifier', { exact: true })
              .fill(pending.invitation_id);
            await page
              .getByRole('button', {
                name: 'Request invitation code',
                exact: true,
              })
              .click();
            await page
              .getByText(
                'Request received. If eligible, verification details will be delivered through the controlled mailbox.',
                { exact: true },
              )
              .waitFor();
            const message = messages.at(-1);
            diagnostic.mark('verify-and-accept');
            assert.equal(message.email, 'browser-invite@example.test');
            await page
              .getByLabel('Invitation challenge identifier', { exact: true })
              .fill(message.challenge_id);
            await page
              .getByLabel('Invitation verification code', { exact: true })
              .fill(message.code);
            await page
              .getByRole('button', {
                name: 'Verify invitation email',
                exact: true,
              })
              .click();
            await page
              .getByText(
                'Email verified. This has not accepted the invitation.',
                {
                  exact: true,
                },
              )
              .waitFor();
            await page
              .getByRole('heading', {
                name: 'Review before accepting',
                exact: true,
              })
              .waitFor();
            assert.equal(
              (
                await env.admin.query(
                  "SELECT count(*)::int AS n FROM access_trial.account WHERE email='browser-invite@example.test'",
                )
              ).rows[0].n,
              0,
            );
            await page.screenshot({
              path: '/work/output/invitation-terms-desktop.png',
              fullPage: true,
            });
            await page
              .getByRole('button', {
                name: 'Accept displayed revision',
                exact: true,
              })
              .click();
            await page
              .getByText('Acceptance completed.', { exact: false })
              .waitFor();
            await page
              .getByLabel('First password after acceptance', { exact: true })
              .fill('Browser invited password');
            await page
              .getByRole('button', { name: 'Set first password', exact: true })
              .click();
            await page
              .getByText(
                'First password established. Use Sign in to start a session.',
                { exact: true },
              )
              .waitFor();
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({
              path: '/work/output/invitation-accepted-narrow.png',
              fullPage: true,
            });
            assert.ok(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            );
            assert.equal(await page.evaluate(() => document.cookie), '');
            assert.equal(uiCookieLeaks, 0);
            const raw = await page.evaluate(
              async () => await (await fetch('/')).text(),
            );
            for (const value of [
              message.code,
              'Browser invited password',
              'browser-invite@example.test',
              ...(await context.cookies()).map((c) => c.value),
            ])
              assert.equal(raw.includes(value), false);
            assert.equal(
              await page.evaluate(
                () => localStorage.length + sessionStorage.length,
              ),
              0,
            );
            diagnostic.mark('sign-in');
            await page
              .getByLabel('Email address', { exact: true })
              .fill('browser-invite@example.test');
            await page
              .getByLabel('Password', { exact: true })
              .fill('Browser invited password');
            const browserLogin = page.waitForResponse(
              (r) =>
                r.url().endsWith('/api/access/v1/sessions') &&
                r.request().method() === 'POST',
            );
            await page
              .getByRole('button', { name: 'Sign in', exact: true })
              .last()
              .click();
            const loginReply = await browserLogin;
            assert.equal(loginReply.status(), 200, await loginReply.text());
            diagnostic.mark('session-confirmation');
            await page
              .getByRole('heading', { name: 'Session active' })
              .waitFor();
          });
        } finally {
          diagnostic.close();
          await context.close();
        }
      },
    );
    await t.test(
      'J20 private invitation reception and view compare bodies, headers and timing with a shifted control',
      async () => {
        const a = await issue('timing@example.test'),
          withdrawn = await issue('withdrawn-timing@example.test'),
          f = await reception();
        await post(
          '/invitations/' + withdrawn.invitation_id + '/withdraw',
          { expected_revision: 1, reason: 'Timing control' },
          master,
        );
        const targets = {
          pending: a.invitation_id,
          absent: randomUUID(),
          withdrawn: withdrawn.invitation_id,
        };
        for (const mode of ['view', 'challenge']) {
          const groups = { pending: [], absent: [], withdrawn: [] };
          let reference;
          for (
            let round = -TIMING_PROTOCOL.warmupRounds;
            round < TIMING_PROTOCOL.rounds;
            round++
          ) {
            const names = Object.keys(targets);
            if (round % 2 === 0) names.reverse();
            for (const name of names) {
              await env.admin.query(
                "DELETE FROM access_trial.throttle WHERE key LIKE 'invitation-mail:%'",
              );
              const target = targets[name],
                before = performance.now();
              const r =
                mode === 'view'
                  ? await request('/invitations/' + target, { client: f })
                  : await post('/invitations/' + target + '/challenges', {}, f);
              const elapsed = performance.now() - before;
              const publicResult = {
                status: r.status,
                body: r.body,
                headers: r.headers,
              };
              if (!reference) reference = publicResult;
              else assert.deepEqual(publicResult, reference);
              if (round >= 0) groups[name].push(elapsed);
            }
          }
          const measured = compareTiming(groups),
            shifted = compareTiming({
              baseline: groups.pending,
              shifted: groups.pending.map((x) => x + 100),
            });
          mkdirSync('/work/output', { recursive: true });
          writeFileSync(
            '/work/output/invitation-' + mode + '-timing.json',
            JSON.stringify({ measured, shifted }, null, 2),
          );
          assert.equal(shifted.signalDetected, true);
          assert.equal(
            measured.signalDetected,
            false,
            JSON.stringify(measured),
          );
          t.diagnostic(JSON.stringify({ surface: mode, ...measured }));
        }
      },
    );
    await t.test(
      'J21 declared function is marked, and cross-plane incompatibility blocks account expansion',
      async () => {
        const declaration = (person) => ({
          issuerPersonRef: 'synthetic-custodian',
          issuerCapacityRef: 'declared-root',
          holderPersonRef: person,
          functionRef: 'material-decision',
          scope: {
            matters: ['trial'],
            partitions: ['organisation'],
            risks: ['R1'],
            populationRef: 'synthetic',
          },
          purposeRef: 'operate-trial',
          startsAt: now,
          continuousObligationAcceptanceRef: null,
          termination: { kind: 'expires', at: until },
          maximumGradeRef: 'trial-grade',
          independenceDeclarationRef: 'local-independence',
          replacementOrChallengeProcedureRef: 'trial-review',
          revision: 1,
        });
        const add = async (id, person) =>
          env.admin.query(
            'INSERT INTO access_trial.investiture VALUES($1,$2,$3,$4,$5,$6,true,1)',
            [id, person, 'decide', 'organisation', declaration(person), until],
          );
        await add('master-declaration', 'synthetic-custodian');
        const inv = await issue(
          'declared-function@example.test',
          [selector('decide')],
          'material_governance',
        );
        const view = await request('/invitations/' + inv.invitation_id, {
          client: master,
        });
        assert.deepEqual(view.body.terms[0].authority_declarations, [
          {
            declaration_ref: 'master-declaration',
            revision: 1,
            accreditation: 'not_externally_accredited',
          },
        ]);
        const pending = await issue('function-holder@example.test', [
            selector('ask', 'domain', 'organisation'),
          ]),
          f = await reception(),
          p = await verify(pending, f);
        await env.admin.query('BEGIN');
        await env.admin.query('SELECT pg_advisory_xact_lock(20202,1)');
        await env.admin.query(
          "INSERT INTO access_trial.person_determination VALUES('function-holder@example.test','function-person','declared-person-link')",
        );
        await add('holder-declaration', 'function-person');
        await env.admin.query(
          "INSERT INTO access_trial.incompatibility VALUES('function-separation','ask','decide','team',true,1,'declared-cross-plane-rule')",
        );
        await env.admin.query('COMMIT');
        assert.equal((await accept(pending, f, p)).status, 403);
        assert.equal(
          (
            await env.admin.query(
              'SELECT used FROM access_trial.email_proof WHERE id=$1',
              [p],
            )
          ).rows[0].used,
          false,
        );
      },
    );
    await t.test(
      'J22 existing assumed and dependent grants react differently to actual issuer loss',
      async () => {
        await env.control.query(
          "SELECT access_trial.set_support('delegated',true,'Restore directed fixture')",
        );
        const holders = [];
        for (const [label, support] of [
          ['dependent', 'delegated'],
          ['assumed', 'domain'],
        ]) {
          const inv = await issue(label + '@example.test', [
              selector('invite'),
              selector('ask', support, 'team', 'grant'),
            ]),
            f = await reception(),
            p = await verify(inv, f);
          assert.equal((await accept(inv, f, p)).status, 200);
          assert.equal(
            (
              await post(
                '/account/initial-credential',
                { password: 'Synthetic grant holder password' },
                f,
              )
            ).status,
            200,
          );
          holders.push(
            await login(
              label + '@example.test',
              'Synthetic grant holder password',
            ),
          );
        }
        await env.admin.query('BEGIN');
        await env.admin.query('SELECT pg_advisory_xact_lock(20202,1)');
        await env.admin.query(
          'UPDATE access_trial.grant_record SET withdrawn=true,revision=revision+1 WHERE id=$1',
          [rootGrants.askgrant],
        );
        await env.admin.query('COMMIT');
        try {
          const body = {
            email: 'continuity@example.test',
            family: 'application',
            grants: [selector()],
            expires_at: Date.now() + 300000,
          };
          assert.equal(
            (await post('/invitations', body, holders[0])).status,
            403,
          );
          assert.equal(
            (await post('/invitations', body, holders[1])).status,
            200,
          );
        } finally {
          await env.admin.query('BEGIN');
          await env.admin.query('SELECT pg_advisory_xact_lock(20202,1)');
          await env.admin.query(
            'UPDATE access_trial.grant_record SET withdrawn=false,revision=revision+1 WHERE id=$1',
            [rootGrants.askgrant],
          );
          await env.admin.query('COMMIT');
        }
      },
    );
    await t.test(
      'J23 login invalidates its provisional flow in the same object-lock domain',
      async () => {
        const pending = await issue('flow-coordination@example.test'),
          f = await reception(),
          p = await verify(pending, f);
        let release, arrive;
        const gate = new Promise((r) => (release = r)),
          ready = new Promise((r) => (arrive = r));
        const timer = setTimeout(() => release(), 5000);
        hooks.beforeCommit = async (route) => {
          if (route === 'accept_invitation') {
            arrive();
            await gate;
          }
        };
        const accepting = accept(pending, f, p);
        let signingIn;
        try {
          await Promise.race([
            ready,
            new Promise((_, reject) =>
              setTimeout(() => reject(Error('Flow gate not reached')), 3000),
            ),
          ]);
          // Different account/email: only the common flow lock can serialize these operations.
          signingIn = post(
            '/sessions',
            { email: 'master@example.test', password },
            f,
          );
          const deadline = Date.now() + 2000;
          let waiting = false;
          while (Date.now() < deadline && !waiting) {
            waiting = (
              await env.admin.query(
                `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=20203
            AND objid::bigint=(hashtext($1)::bigint & 4294967295) AND NOT granted) AS waiting`,
                ['flow:' + digest(f.cookie.split('=')[1])],
              )
            ).rows[0].waiting;
            if (!waiting) await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(
            waiting,
            true,
            'Login must wait on the actual shared flow key',
          );
          release();
          assert.equal((await accepting).status, 200);
          assert.equal((await signingIn).status, 200);
        } finally {
          clearTimeout(timer);
          release();
          delete hooks.beforeCommit;
          await Promise.allSettled([
            accepting,
            ...(signingIn ? [signingIn] : []),
          ]);
        }
        const second = await issue('flow-expired@example.test'),
          g = await reception(),
          proof = await verify(second, g);
        assert.equal(
          (
            await post(
              '/sessions',
              { email: 'master@example.test', password },
              g,
            )
          ).status,
          200,
        );
        const denied = await accept(second, g, proof);
        assert.equal(denied.status, 403);
        assert.equal(denied.body.code, 'unauthenticated');
      },
    );
    await t.test(
      'J24 logout discards a delayed real invitation response and clears its workspace',
      async () => {
        const context = await browser.newContext(),
          page = await context.newPage();
        try {
          await page.goto(origin);
          await page
            .getByLabel('Email address', { exact: true })
            .fill('master@example.test');
          await page.getByLabel('Password', { exact: true }).fill(password);
          await page
            .getByRole('button', { name: 'Sign in', exact: true })
            .last()
            .click();
          await page.getByRole('heading', { name: 'Session active' }).waitFor();
          await page
            .getByRole('button', {
              name: 'Open invitation workspace',
              exact: true,
            })
            .click();
          const inv = await issue('delayed-view@example.test');
          await page
            .getByLabel('Invitation identifier', { exact: true })
            .fill(inv.invitation_id);
          await page.evaluate((id) => {
            const realFetch = window.fetch.bind(window);
            let release;
            const gate = new Promise((r) => (release = r));
            window.__releaseInvitation = release;
            window.fetch = async (...args) => {
              const response = await realFetch(...args);
              if (String(args[0]).endsWith('/invitations/' + id)) {
                const realText = response.text.bind(response);
                response.text = async () => {
                  const text = await realText();
                  window.__invitationHeld = true;
                  await gate;
                  window.__invitationReleased = true;
                  return text;
                };
              }
              return response;
            };
          }, inv.invitation_id);
          await page
            .getByRole('button', { name: 'Load invitation', exact: true })
            .click();
          await page.waitForFunction(() => window.__invitationHeld === true);
          await page
            .getByRole('button', { name: 'Sign out', exact: true })
            .click();
          await page
            .getByText('Signed out. The previous session is invalid.', {
              exact: true,
            })
            .waitFor();
          await page.evaluate(() => window.__releaseInvitation());
          await page.waitForFunction(
            () => window.__invitationReleased === true,
          );
          await page.evaluate(
            () =>
              new Promise((r) =>
                requestAnimationFrame(() => requestAnimationFrame(r)),
              ),
          );
          assert.equal(
            await page
              .getByRole('heading', { name: 'Review before accepting' })
              .count(),
            0,
          );
          assert.equal(
            await page
              .getByText('delayed-view@example.test', { exact: true })
              .count(),
            0,
          );
          await page
            .getByRole('button', {
              name: 'Open invitation workspace',
              exact: true,
            })
            .waitFor();
        } finally {
          await page
            .evaluate(() => window.__releaseInvitation?.())
            .catch(() => {});
          await context.close();
        }
      },
    );
  },
);
