import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import next from 'next';
import { chromium } from '@playwright/test';
import { runtimeEnvironment } from './runtime_environment.mjs';
import { PasswordVerifier } from '../../src/server/access/password.ts';
import { startAccessTerminal } from '../../src/server/access/terminal.ts';
import { authorizedReadingMigration } from '../../ci/access_material_schema.mjs';
import {
  TIMING_PROTOCOL,
  compareTiming,
} from '../reading/timing_comparison.mjs';
import { observeBrowser } from '../reading/browser_diagnostics.mjs';
import { UI_MUTATIONS } from './ui_mutation.mjs';

const uiOrigin = 'https://ui.inc02.test:8443',
  apiOrigin = 'https://api.inc02.test:9443';
const loginNotice =
  'The earlier sign-in result remains unconfirmed. Current access was checked separately; refreshing did not recover that result.';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  'T05 effective administration without disclosure expansion',
  { timeout: 240000 },
  async (t) => {
    const env = await runtimeEnvironment();
    let terminal, browser, app, uiServer, mutantRoot;
    const messages = [],
      hooks = {
        failure: (e) => console.error('ADMINISTRATION_FAILURE', e.message),
      };
    t.afterEach(async () => {
      await env.admin.query('ROLLBACK');
      delete hooks.afterCommit;
    });
    t.after(async () => {
      try {
        await browser?.close();
        uiServer?.closeAllConnections();
        if (uiServer) await new Promise((r) => uiServer.close(r));
        await app?.close();
        await terminal?.close();
      } finally {
        await env.close();
        if (mutantRoot) {
          assert.ok(
            mutantRoot.startsWith('/work/output/administration-mutant-'),
          );
          rmSync(mutantRoot, { recursive: true, force: true });
        }
      }
    });
    const passwords = new PasswordVerifier();
    await passwords.initialize();
    const password = 'Synthetic administration password',
      verifier = await passwords.create(password);
    const masterId = randomUUID(),
      until = Date.now() + 3600000;
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
    await env.admin.query(`INSERT INTO access_trial.permission_definition VALUES
    ('invite','Invite','application',1,true,false),('read_material','Read material','application',1,true,false),
    ('read_people','Read scoped people','application',1,true,false),('conditional','Conditional reading','application',1,true,false);
    INSERT INTO access_trial.scope_definition VALUES('organisation',NULL,'Organisation','synthetic-administration',1,true),
    ('inc02-material','organisation','Material scope','synthetic-administration',1,true),('foreign',NULL,'Private scope','other-purpose',1,true)`);
    await env.admin.query(
      "INSERT INTO access_trial.support_definition VALUES('domain','domain',NULL,'Domain adoption','synthetic-adoption',$1,true,1)",
      [until],
    );
    for (const [account, permission, faculty] of [
      [masterId, 'invite', 'exercise'],
      [masterId, 'read_material', 'grant'],
      [masterId, 'read_people', 'exercise'],
      [masterId, 'conditional', 'grant'],
    ])
      await env.admin.query(
        'INSERT INTO access_trial.grant_record VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,false,1)',
        [
          randomUUID(),
          account,
          permission,
          faculty,
          'organisation',
          'domain',
          'synthetic-seed',
          until,
        ],
      );
    await env.admin.query(authorizedReadingMigration());
    const readerPassword = randomBytes(24).toString('hex');
    await env.admin.query(
      `ALTER ROLE inc02_reader LOGIN PASSWORD '${readerPassword}'`,
    );
    const reading = {
      connectionString: `postgresql://inc02_reader:${readerPassword}@127.0.0.1:55432/inc02_synthetic`,
      expectedPort: 55432,
      generation: 'administration-reading-generation',
      cursorSeconds: 120,
      cursorLimit: 50,
      pageSize: 1,
    };
    await env.admin.query(
      'INSERT INTO material_trial.control VALUES(true,$1,1,true,true,true,true,true,true)',
      [reading.generation],
    );
    for (const [id, permission, enabled, revealable] of [
      ['material-list', 'read_material', true, true],
      ['material-exact', 'read_material', false, true],
      ['people', 'read_people', true, true],
    ])
      await env.admin.query(
        'INSERT INTO material_trial.surface VALUES($1,$2,$3,$4,$5,$6,true,1)',
        [
          id,
          permission,
          'inc02-material',
          'synthetic-administration',
          enabled,
          revealable,
        ],
      );
    const config = {
      profile: 'access-runtime/1',
      synthetic: true,
      transport: { profile: 'session/1', uiOrigin, terminalOrigin: apiOrigin },
      security: {
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
      },
      connectionString: env.runtimeConfig.connectionString,
      expectedPort: 55432,
      digestKey: randomBytes(32).toString('hex'),
    };
    let start = startAccessTerminal;
    const mutation = process.env.ACCESS_RUNTIME_MUTATION;
    const uiMutation = Object.hasOwn(UI_MUTATIONS, mutation ?? '');
    assert.equal(
      JSON.parse(
        readFileSync('/work/tests/access/runtime-ui/mutation.json', 'utf8'),
      ).name,
      uiMutation ? mutation : '',
      'The compiled UI must match this run',
    );
    if (mutation && mutation !== 'early-failure' && !uiMutation) {
      const changes = {
        'disclose-hidden-capability': [
          'service.ts',
          'if (!surface.revealable) continue;',
          'if (false) continue;',
        ],
        'disclose-private-reason': [
          'service.ts',
          "authorized: allowed ? 'yes' : 'no'",
          "authorized: (allowed || authority.permissions.some(p=>p.id===surface.permission_id)) ? 'yes' : 'no'",
        ],
        'drop-invitation-view-admission': [
          'invitations.ts',
          'if (!inv || !current || !canInspect())',
          'if (!inv || !current)',
        ],
        'offer-withdrawn-grant': [
          'invitations.ts',
          'if (mayWithdraw(g) && !g.withdrawn)',
          'if (mayWithdraw(g))',
        ],
      };
      assert.ok(changes[mutation]);
      mutantRoot = '/work/output/administration-mutant-' + randomUUID();
      cpSync('/work/src', mutantRoot + '/src', { recursive: true });
      const [file, from, to] = changes[mutation],
        target = mutantRoot + '/src/server/access/' + file,
        source = readFileSync(target, 'utf8');
      assert.equal(source.split(from).length - 1, 1);
      writeFileSync(target, source.replace(from, to));
      start = (
        await import(
          pathToFileURL(mutantRoot + '/src/server/access/terminal.ts').href
        )
      ).startAccessTerminal;
    }
    terminal = await start({
      config,
      tls: env.tls,
      mailbox: {
        async send(m) {
          messages.push(m);
        },
      },
      hooks,
      reading,
    });
    if (mutation === 'early-failure') throw Error('Injected early failure');
    function request(
      route,
      { method = 'GET', body, client, key = randomUUID() } = {},
    ) {
      return new Promise((resolve, reject) => {
        const bytes =
          body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = https.request(
          {
            host: '127.0.0.1',
            port: 9443,
            servername: 'api.inc02.test',
            ca: env.ca,
            path: '/api/access/v1' + route,
            method,
            headers: {
              Host: 'api.inc02.test:9443',
              Origin: uiOrigin,
              ...(client ? { cookie: client.cookie } : {}),
              ...(bytes
                ? {
                    'content-type': 'application/json',
                    'content-length': bytes.length,
                    'x-ledgerdesk-csrf': client.csrf,
                    'x-ledgerdesk-intent': key,
                  }
                : {}),
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString();
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: raw ? JSON.parse(raw) : null,
              });
            });
            res.on('error', reject);
          },
        );
        req.setTimeout(12000, () =>
          req.destroy(Error('Bounded administration request timed out')),
        );
        req.on('error', reject);
        req.end(bytes);
      });
    }
    const post = (route, body, client, key) =>
      request(route, { method: 'POST', body, client, key });
    async function reception() {
      const r = await request('/reception');
      assert.equal(r.status, 200);
      return {
        cookie: r.headers['set-cookie'][0].split(';')[0],
        csrf: r.body.csrf_token,
      };
    }
    async function login(email) {
      const f = await reception(),
        r = await post('/sessions', { email, password }, f);
      assert.equal(r.status, 200);
      return {
        cookie: r.headers['set-cookie'][0].split(';')[0],
        csrf: r.body.csrf_token,
      };
    }
    const master = await login('master@example.test');
    async function admit(email, permissions) {
      const issued = await post(
        '/invitations',
        {
          email,
          family: 'application',
          expires_at: Date.now() + 300000,
          grants: permissions.map((permission_id) => ({
            permission_id,
            exercise_or_grant: 'exercise',
            scope_ref: 'inc02-material',
            support_ref: 'domain',
          })),
        },
        master,
      );
      assert.equal(issued.status, 200, JSON.stringify(issued.body));
      const f = await reception(),
        id = issued.body.invitation_id;
      assert.equal(
        (await post('/invitations/' + id + '/challenges', {}, f)).status,
        200,
      );
      const mail = messages.at(-1);
      const p = await post(
        '/invitation-proofs/' + mail.challenge_id + '/verify',
        { code: mail.code },
        f,
      );
      assert.equal(p.status, 200);
      assert.equal(
        (
          await post(
            '/invitations/' + id + '/accept',
            { expected_revision: 1, proof_id: p.body.proof_id },
            f,
          )
        ).status,
        200,
      );
      assert.equal(
        (await post('/account/initial-credential', { password }, f)).status,
        200,
      );
      return (
        await env.admin.query(
          'SELECT id FROM access_trial.account WHERE email=$1',
          [email],
        )
      ).rows[0].id;
    }
    const aliceId = await admit('alice@example.test', [
        'read_material',
        'conditional',
      ]),
      foreignId = await admit('foreign@example.test', ['read_material']);
    await env.admin.query(
      "UPDATE access_trial.permission_definition SET requires_investiture=true WHERE id='conditional'",
    );
    for (const [id, name, scope] of [
      [aliceId, 'Alex <script>unsafe()</script>', 'inc02-material'],
      [masterId, 'Office account', 'inc02-material'],
      [foreignId, 'Secret foreign name', 'foreign'],
    ])
      await env.admin.query(
        'INSERT INTO material_trial.census_entry VALUES($1,$2,$3,$4,1)',
        [id, scope, name, 'synthetic-census'],
      );
    const alice = await login('alice@example.test'),
      foreign = await login('foreign@example.test');
    const proposal = (email) => ({
      email,
      family: 'application',
      expires_at: Date.now() + 300000,
      grants: [
        {
          permission_id: 'read_material',
          exercise_or_grant: 'exercise',
          scope_ref: 'inc02-material',
          support_ref: 'domain',
        },
      ],
    });
    const issued = await post(
      '/invitations',
      proposal('alice@example.test'),
      master,
    );
    assert.equal(issued.status, 200);
    const invitation = issued.body;
    const view = (client, id = invitation.invitation_id) =>
      request('/invitations/' + id, { client });
    const caps = (client) => request('/capabilities', { client });
    await t.test(
      'D01 disclosed capabilities include disabled and unauthorized states with independent expected explanations',
      async () => {
        const r = await caps(alice);
        assert.equal(r.status, 200);
        const rows = r.body.capabilities;
        assert.deepEqual(
          rows.find((c) => c.capability_id === 'material-list'),
          {
            capability_id: 'material-list',
            implemented: true,
            enabled: true,
            authorized: 'yes',
            executable: 'yes',
            explanation: 'available',
          },
        );
        assert.deepEqual(
          rows.find((c) => c.capability_id === 'material-exact'),
          {
            capability_id: 'material-exact',
            implemented: true,
            enabled: false,
            authorized: 'yes',
            executable: 'no',
            explanation: 'disabled',
          },
        );
      },
    );
    await t.test(
      'D02 hidden surface never appears anywhere in the JSON; positive disclosed content remains',
      async () => {
        await env.admin.query(
          "UPDATE material_trial.surface SET revealable=false WHERE id='material-exact'",
        );
        try {
          const r = await caps(alice);
          assert.equal(r.status, 200);
          assert.equal(
            JSON.stringify(r.body).includes('material-exact'),
            false,
          );
          assert.equal(JSON.stringify(r.body).includes('revealable'), false);
          assert.deepEqual(Object.keys(r.body).sort(), [
            'capabilities',
            'invitation_options',
            'revision',
          ]);
          assert.ok(
            r.body.capabilities.some(
              (c) => c.capability_id === 'material-list',
            ),
          );
        } finally {
          await env.admin.query(
            "UPDATE material_trial.surface SET revealable=true WHERE id='material-exact'",
          );
        }
      },
    );
    async function conditional(missing) {
      await env.admin.query(
        'UPDATE material_trial.surface SET enabled=true,permission_id=$1 WHERE id=$2',
        [missing ? 'absent-permission' : 'conditional', 'material-exact'],
      );
    }
    async function restoreSurface() {
      await env.admin.query(
        "UPDATE material_trial.surface SET enabled=false,permission_id='read_material' WHERE id='material-exact'",
      );
    }
    await t.test(
      'D03 missing investiture and missing permission have identical complete public projections',
      async () => {
        try {
          await conditional(false);
          const first = await caps(alice);
          await conditional(true);
          const second = await caps(alice);
          assert.equal(first.status, 200);
          assert.deepEqual(first, second);
          assert.deepEqual(
            first.body.capabilities.find(
              (c) => c.capability_id === 'material-exact',
            ),
            {
              capability_id: 'material-exact',
              implemented: true,
              enabled: true,
              authorized: 'no',
              executable: 'no',
              explanation: 'not_authorized',
            },
          );
        } finally {
          await restoreSurface();
        }
      },
    );
    await t.test(
      'D04 object action positives and a readable zero-action invitation',
      async () => {
        const owner = await view(master),
          recipient = await view(alice);
        assert.equal(owner.status, 200);
        assert.equal(recipient.status, 200);
        assert.deepEqual(owner.body.available_actions, [
          {
            action: 'amend_invitation',
            target_id: invitation.invitation_id,
            revision: 1,
          },
          {
            action: 'withdraw_invitation',
            target_id: invitation.invitation_id,
            revision: 1,
          },
        ]);
        assert.deepEqual(recipient.body.available_actions, []);
        assert.equal(recipient.body.email, 'alice@example.test');
      },
    );
    await t.test(
      'D05 foreign and absent invitation IDs have the same neutral envelope, with a permitted control',
      async () => {
        const existing = await view(foreign),
          absent = await view(foreign, randomUUID());
        assert.deepEqual(existing, absent);
        assert.equal(existing.status, 404);
        assert.equal((await view(master)).status, 200);
        assert.deepEqual(
          await request(
            '/invitations/' + invitation.invitation_id + '/actions',
            { client: foreign },
          ),
          await request('/invitations/' + randomUUID() + '/actions', {
            client: foreign,
          }),
        );
      },
    );
    await t.test(
      'D06 offered action is reauthorized; a forbidden operation leaves the session usable',
      async () => {
        assert.ok(
          (await view(master)).body.available_actions.some(
            (a) => a.action === 'withdraw_invitation',
          ),
        );
        await env.admin.query(
          "UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='invite'",
          [masterId],
        );
        try {
          const r = await post(
            '/invitations/' + invitation.invitation_id + '/withdraw',
            { expected_revision: 1, reason: 'Directed denied action' },
            master,
          );
          assert.deepEqual(
            {
              status: r.status,
              session: (await request('/session', { client: master })).status,
            },
            { status: 403, session: 200 },
          );
        } finally {
          await env.admin.query(
            "UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='invite'",
            [masterId],
          );
        }
      },
    );
    await t.test(
      'D07 both disclosure pairs have bounded timing observations and a detected shifted control',
      async () => {
        const samples = {
            investiture: [],
            permission: [],
            foreign: [],
            absent: [],
          },
          absent = randomUUID();
        for (
          let round = -TIMING_PROTOCOL.warmupRounds;
          round < TIMING_PROTOCOL.rounds;
          round++
        ) {
          for (const missing of round % 2 ? [false, true] : [true, false]) {
            await conditional(missing);
            const start = performance.now();
            await caps(alice);
            if (round >= 0)
              samples[missing ? 'permission' : 'investiture'].push(
                performance.now() - start,
              );
          }
          for (const [name, id] of round % 2
            ? [
                ['foreign', invitation.invitation_id],
                ['absent', absent],
              ]
            : [
                ['absent', absent],
                ['foreign', invitation.invitation_id],
              ]) {
            const start = performance.now();
            await view(foreign, id);
            if (round >= 0) samples[name].push(performance.now() - start);
          }
        }
        await restoreSurface();
        for (const pair of [
          ['investiture', 'permission'],
          ['foreign', 'absent'],
        ]) {
          const result = compareTiming(
            Object.fromEntries(pair.map((k) => [k, samples[k]])),
          );
          const shifted = compareTiming({
            baseline: samples[pair[0]],
            shifted: samples[pair[0]].map((x) => x + 100),
          });
          writeFileSync(
            '/work/output/timing-' + pair[0] + '.json',
            JSON.stringify({ result, shifted }, null, 2),
          );
          assert.equal(result.signalDetected, false, JSON.stringify(result));
          assert.equal(shifted.signalDetected, true);
        }
      },
    );
    app = next({
      dev: false,
      dir: path.resolve('tests/access/runtime-ui'),
      hostname: 'ui.inc02.test',
      port: 8443,
    });
    await app.prepare();
    let uiCookieHits = 0;
    const handler = app.getRequestHandler();
    uiServer = https.createServer(env.tls, (req, res) => {
      if (req.headers.cookie?.includes('__Host-ledgerdesk')) uiCookieHits++;
      return handler(req, res);
    });
    await new Promise((r) => uiServer.listen(8443, '127.0.0.1', r));
    browser = await chromium.launch({
      headless: true,
      args: [
        '--host-resolver-rules=MAP *.inc02.test 127.0.0.1',
        '--no-proxy-server',
      ],
    });
    async function browserSession(client) {
      const context = await browser.newContext({
        viewport: { width: 1100, height: 850 },
      });
      await replaceCookie(context, client);
      return { context, page: await context.newPage() };
    }
    async function replaceCookie(context, client) {
      const [name, value] = client.cookie.split('=');
      await context.addCookies([
        {
          name,
          value,
          domain: 'api.inc02.test',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Strict',
        },
      ]);
    }
    await t.test(
      'D08 real UI shows all disclosed axes, paged names only, keyboard focus and narrow original-text safety',
      async () => {
        const { context, page } = await browserSession(master),
          diagnostics = observeBrowser(
            page,
            '/work/output/browser-diagnostics',
          );
        try {
          await diagnostics.run('D08', async () => {
            const initial = await page.goto(uiOrigin),
              html = await initial.text();
            for (const hidden of [
              masterId,
              aliceId,
              config.digestKey,
              master.csrf,
              'Secret foreign name',
              'private-surface-marker',
            ])
              assert.equal(html.includes(hidden), false);
            await page
              .getByRole('heading', { name: 'Session active' })
              .waitFor();
            await page.locator('[data-capability="material-exact"]').waitFor();
            assert.match(
              await page
                .locator('[data-capability="material-exact"]')
                .innerText(),
              /Implemented\s+Yes\s+Enabled\s+No/,
            );
            await page
              .getByRole('button', {
                name: 'Load authorized people',
                exact: true,
              })
              .click();
            await page
              .getByText('Authorized people in this page.', { exact: true })
              .waitFor();
            const names = [
              await page.locator('.people-panel li strong').innerText(),
            ];
            await page
              .getByRole('button', { name: 'Next authorized page' })
              .click();
            await page
              .getByRole('button', { name: 'Next authorized page' })
              .waitFor({ state: 'detached' });
            names.push(
              await page.locator('.people-panel li strong').innerText(),
            );
            assert.deepEqual(
              names.sort(),
              ['Alex <script>unsafe()</script>', 'Office account'].sort(),
            );
            assert.equal(
              await page
                .getByText('Secret foreign name', { exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page
                .locator('script')
                .filter({ hasText: 'unsafe()' })
                .count(),
              0,
            );
            await page
              .getByRole('button', { name: 'Refresh session', exact: true })
              .focus();
            assert.equal(
              await page.evaluate(() => document.activeElement?.textContent),
              'Refresh session',
            );
            await page.keyboard.press('Tab');
            assert.equal(
              await page.evaluate(() => document.activeElement?.tagName),
              'BUTTON',
            );
            await page.screenshot({
              path: '/work/output/administration-desktop.png',
              fullPage: true,
            });
            await page.setViewportSize({ width: 390, height: 844 });
            assert.equal(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
              true,
            );
            await page.screenshot({
              path: '/work/output/administration-narrow.png',
              fullPage: true,
            });
          });
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'D09 a lost real issue response retries identical key and bytes including expiry, with one stored effect',
      async () => {
        const { context, page } = await browserSession(master);
        try {
          await page.goto(uiOrigin);
          await page.getByRole('heading', { name: 'Session active' }).waitFor();
          await page
            .getByRole('button', { name: 'Open invitation workspace' })
            .click();
          await page
            .getByLabel('Recipient email', { exact: true })
            .fill('retry-ui@example.test');
          await page.evaluate(() => {
            const original = window.fetch;
            window.__attempts = [];
            window.fetch = async (...args) => {
              const response = await original(...args);
              if (
                String(args[0]).endsWith('/api/access/v1/invitations') &&
                args[1]?.method === 'POST'
              ) {
                window.__attempts.push({
                  key: args[1].headers['x-ledgerdesk-intent'],
                  body: args[1].body,
                  status: response.status,
                });
                if (window.__attempts.length === 1) {
                  await response.text();
                  throw new TypeError(
                    'Directed loss of an actual service response',
                  );
                }
              }
              return response;
            };
          });
          await page
            .getByRole('button', { name: 'Create invitation', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'Retry exact unconfirmed request' })
            .waitFor();
          assert.equal(
            await page
              .getByText(
                'Invitation recorded. It has not granted any permission.',
                { exact: true },
              )
              .count(),
            0,
          );
          await pause(30);
          await page
            .getByRole('button', { name: 'Retry exact unconfirmed request' })
            .click();
          await page
            .getByText('The exact request is now confirmed.', { exact: false })
            .waitFor();
          const observed = await page.evaluate(() => window.__attempts);
          assert.equal(observed.length, 2);
          assert.equal(observed[0].status, 200);
          assert.deepEqual(observed[0], observed[1]);
          assert.equal(
            (
              await env.admin.query(
                "SELECT count(*)::int n FROM access_trial.invitation WHERE email='retry-ui@example.test'",
              )
            ).rows[0].n,
            1,
          );
          await page
            .getByRole('button', { name: 'Load invitation', exact: true })
            .click();
          await page
            .getByRole('button', {
              name: 'Withdraw pending invitation',
              exact: true,
            })
            .waitFor();
          await page.screenshot({
            path: '/work/output/invitation-actions.png',
            fullPage: true,
          });
          assert.equal(
            await page
              .getByRole('button', {
                name: 'Check recorded operation',
                exact: true,
              })
              .count(),
            0,
            'Issuance supplies an invitation ID, not an operation receipt',
          );
          await page
            .getByRole('button', {
              name: 'Withdraw pending invitation',
              exact: true,
            })
            .click();
          await page
            .getByText('Pending invitation withdrawn.', { exact: true })
            .waitFor();
          await page
            .getByRole('button', {
              name: 'Check recorded operation',
              exact: true,
            })
            .click();
          await page
            .getByText('The server reports this operation as completed.', {
              exact: false,
            })
            .waitFor();
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'D10 delayed real capabilities are discarded after replacement by another session of the same account',
      async () => {
        const { context, page } = await browserSession(master);
        try {
          await page.goto(uiOrigin);
          await page
            .getByRole('heading', { name: 'What this session can do' })
            .waitFor();
          await page.evaluate(() => {
            const original = window.fetch;
            window.fetch = async (...args) => {
              const response = await original(...args);
              if (String(args[0]).endsWith('/capabilities')) {
                window.__held = true;
                await new Promise((r) => (window.__release = r));
              }
              return response;
            };
          });
          await page
            .getByRole('button', { name: 'Refresh session', exact: true })
            .click();
          await page.waitForFunction(() => window.__held === true);
          const second = await login('master@example.test');
          assert.notEqual(second.csrf, master.csrf);
          await replaceCookie(context, second);
          await page.evaluate(() => window.__release());
          await page
            .getByText(
              'The session changed. Refresh the session before continuing.',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await page
              .getByRole('heading', { name: 'What this session can do' })
              .count(),
            0,
          );
          assert.equal(await page.locator('[data-capability]').count(), 0);
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'D11 delayed real invitation is not adopted by a replacement session of the same account',
      async () => {
        const { context, page } = await browserSession(master);
        try {
          await page.goto(uiOrigin);
          await page.getByRole('heading', { name: 'Session active' }).waitFor();
          await page
            .getByRole('button', { name: 'Open invitation workspace' })
            .click();
          await page
            .getByLabel('Invitation identifier', { exact: true })
            .fill(invitation.invitation_id);
          await page.evaluate((id) => {
            const original = window.fetch;
            window.fetch = async (...args) => {
              const response = await original(...args);
              if (String(args[0]).endsWith('/invitations/' + id)) {
                window.__held = true;
                await new Promise((r) => (window.__release = r));
              }
              return response;
            };
          }, invitation.invitation_id);
          await page
            .getByRole('button', { name: 'Load invitation', exact: true })
            .click();
          await page.waitForFunction(() => window.__held === true);
          await replaceCookie(context, await login('master@example.test'));
          await page.evaluate(() => window.__release());
          await page
            .getByText(
              'The session changed. Refresh the session before continuing.',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await page
              .getByRole('heading', { name: 'Review before accepting' })
              .count(),
            0,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'D12 new capability projection rejects an elapsed deadline after commit without claiming universal temporal conformity',
      async () => {
        const digest = terminal.service.digest(master.cookie.split('=')[1]);
        await env.admin.query(
          'UPDATE access_trial.session SET expires_at=$2 WHERE digest=$1',
          [digest, Date.now() + 200],
        );
        hooks.afterCommit = async (route) => {
          if (route === 'capabilities') await pause(250);
        };
        try {
          const r = await caps(master);
          assert.equal(r.status, 503);
          writeFileSync(
            '/work/output/temporal-observation.json',
            JSON.stringify(
              {
                surface: 'capabilities',
                status: r.status,
                fullTemporalConformity: false,
                scope:
                  'Directed before-handoff expiry only; R24 remains an observed failure.',
              },
              null,
              2,
            ),
          );
        } finally {
          delete hooks.afterCommit;
          await env.admin.query(
            'UPDATE access_trial.session SET expires_at=$2 WHERE digest=$1',
            [digest, until],
          );
        }
      },
    );
    await t.test(
      'D13 UI host receives no session credential and unauthorized census adds no identity fields',
      async () => {
        assert.equal(uiCookieHits, 0);
        const r = await request('/people', { client: foreign });
        assert.equal(r.status, 404);
        assert.deepEqual(Object.keys(r.body).sort(), [
          'code',
          'status',
          'title',
          'type',
        ]);
        assert.equal(
          (await request('/session', { client: foreign })).status,
          200,
        );
      },
    );
    await t.test(
      'D14 accepted-grant action works without generic invitation options',
      async () => {
        const grant = randomUUID();
        await env.admin.query(
          'INSERT INTO access_trial.grant_record VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,false,1)',
          [
            grant,
            aliceId,
            'read_material',
            'grant',
            'organisation',
            'domain',
            'synthetic-target-authority',
            until,
          ],
        );
        const id = (
          await env.admin.query(
            'SELECT origin_invitation_id FROM access_trial.account WHERE id=$1',
            [aliceId],
          )
        ).rows[0].origin_invitation_id;
        const projection = await view(alice, id);
        assert.equal(projection.status, 200);
        assert.equal((await caps(alice)).body.invitation_options.length, 0);
        assert.equal(
          projection.body.available_actions.filter(
            (a) => a.action === 'withdraw_grant',
          ).length,
          1,
        );
        const { context, page } = await browserSession(alice);
        try {
          await page.goto(uiOrigin);
          await page.getByRole('heading', { name: 'Session active' }).waitFor();
          await page
            .getByRole('button', { name: 'Open invitation workspace' })
            .click();
          await page
            .getByLabel('Invitation identifier', { exact: true })
            .fill(id);
          await page
            .getByRole('button', { name: 'Load invitation', exact: true })
            .click();
          await page
            .getByRole('button', {
              name: 'Withdraw accepted permission',
              exact: true,
            })
            .waitFor();
          assert.equal(
            await page
              .getByRole('button', { name: 'Create invitation', exact: true })
              .count(),
            0,
          );
          await page
            .getByRole('button', {
              name: 'Withdraw accepted permission',
              exact: true,
            })
            .click();
          await page
            .getByText(
              'Permission withdrawn. The acceptance remains recorded.',
              { exact: true },
            )
            .waitFor();
          const action = projection.body.available_actions.find(
            (a) => a.action === 'withdraw_grant',
          );
          assert.equal(
            (
              await env.admin.query(
                'SELECT withdrawn FROM access_trial.grant_record WHERE id=$1',
                [action.target_id],
              )
            ).rows[0].withdrawn,
            true,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'D16 a verified recipient sees acceptance only while its account remains eligible',
      async () => {
        const flow = await reception(),
          id = invitation.invitation_id;
        assert.equal(
          (await post('/invitations/' + id + '/challenges', {}, flow)).status,
          200,
        );
        const mail = messages.at(-1);
        assert.equal(
          (
            await post(
              '/invitation-proofs/' + mail.challenge_id + '/verify',
              { code: mail.code },
              flow,
            )
          ).status,
          200,
        );
        const eligible = await view(flow);
        assert.deepEqual(
          { status: eligible.status, actions: eligible.body.available_actions },
          {
            status: 200,
            actions: [
              { action: 'accept_invitation', target_id: id, revision: 1 },
            ],
          },
        );
        await env.admin.query(
          'UPDATE access_trial.account SET restricted=true WHERE id=$1',
          [aliceId],
        );
        try {
          const restricted = await view(flow);
          assert.deepEqual(
            {
              status: restricted.status,
              actions: restricted.body.available_actions,
            },
            { status: 200, actions: [] },
          );
        } finally {
          await env.admin.query(
            'UPDATE access_trial.account SET restricted=false WHERE id=$1',
            [aliceId],
          );
        }
        assert.equal(
          (await view(flow)).body.available_actions[0].action,
          'accept_invitation',
        );
      },
    );
    await t.test(
      'D17 delayed census is discarded for another account and another session of the same account',
      async () => {
        for (const email of ['alice@example.test', 'master@example.test']) {
          const { context, page } = await browserSession(master);
          try {
            await page.goto(uiOrigin);
            await page
              .getByRole('button', {
                name: 'Load authorized people',
                exact: true,
              })
              .click();
            await page.locator('.people-panel li strong').first().waitFor();
            assert.ok(
              (await page.locator('.people-panel li strong').count()) > 0,
              'positive census content',
            );
            await page.evaluate(() => {
              const original = window.fetch;
              window.fetch = async (...args) => {
                const response = await original(...args);
                if (String(args[0]).includes('/api/access/v1/people')) {
                  window.__held = true;
                  await new Promise((r) => (window.__release = r));
                }
                return response;
              };
            });
            await page
              .getByRole('button', {
                name: 'Load authorized people',
                exact: true,
              })
              .click();
            await page.waitForFunction(() => window.__held === true);
            const other = await login(email);
            assert.notEqual(other.csrf, master.csrf);
            await replaceCookie(context, other);
            await page.evaluate(() => window.__release());
            await page.waitForFunction(
              () =>
                document.body.innerText.includes(
                  'The session changed. Refresh the session before continuing.',
                ) || document.querySelector('.people-panel li strong') !== null,
            );
            assert.deepEqual(
              {
                notice:
                  (await page
                    .getByText(
                      'The session changed. Refresh the session before continuing.',
                      { exact: true },
                    )
                    .count()) === 1,
                rows: await page.locator('.people-panel li strong').count(),
              },
              { notice: true, rows: 0 },
              'census rows of the replaced session were rendered',
            );
          } finally {
            await context.close();
          }
        }
      },
    );
    await t.test(
      'D18 a withdrawn grant loses its offer without losing its view or becoming an authority escalation',
      async () => {
        const account = await admit('withdrawal-control@example.test', [
          'read_material',
        ]);
        const id = (
          await env.admin.query(
            'SELECT origin_invitation_id FROM access_trial.account WHERE id=$1',
            [account],
          )
        ).rows[0].origin_invitation_id;
        const positive = await view(master, id);
        assert.equal(positive.status, 200);
        const action = positive.body.available_actions.find(
          (a) => a.action === 'withdraw_grant',
        );
        assert.ok(action);
        const route = '/grants/' + action.target_id + '/withdraw';
        assert.equal(
          (
            await post(
              route,
              {
                expected_revision: action.revision,
                reason: 'Directed withdrawal',
              },
              master,
            )
          ).status,
          200,
        );
        const refreshed = await view(master, id);
        const before = (
          await env.admin.query(
            "SELECT count(*)::int n FROM access_trial.invitation_event WHERE object_ref='restricted-grant'",
          )
        ).rows[0].n;
        const stale = await post(
          route,
          {
            expected_revision: action.revision,
            reason: 'Old revision after withdrawal',
          },
          master,
        );
        const current = await post(
          route,
          {
            expected_revision: action.revision + 1,
            reason: 'Already withdrawn',
          },
          master,
        );
        const after = (
          await env.admin.query(
            "SELECT count(*)::int n FROM access_trial.invitation_event WHERE object_ref='restricted-grant'",
          )
        ).rows[0].n;
        assert.deepEqual(
          {
            status: refreshed.status,
            offers: refreshed.body.available_actions,
            stale: stale.status,
            current: current.status,
            escalations: after - before,
          },
          { status: 200, offers: [], stale: 409, current: 403, escalations: 0 },
        );
        const { context, page } = await browserSession(master);
        try {
          await page.goto(uiOrigin);
          await page
            .getByRole('button', { name: 'Open invitation workspace' })
            .click();
          await page
            .getByLabel('Invitation identifier', { exact: true })
            .fill(id);
          await page
            .getByRole('button', { name: 'Load invitation', exact: true })
            .click();
          await page
            .getByRole('heading', { name: 'Review before accepting' })
            .waitFor();
          assert.equal(
            await page
              .getByRole('button', {
                name: 'Withdraw accepted permission',
                exact: true,
              })
              .count(),
            0,
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'D19 invitation controls obey offers: absent management actions are hidden and acceptance remains disabled',
      async () => {
        for (const [client, canManage] of [
          [master, true],
          [alice, false],
        ]) {
          const { context, page } = await browserSession(client);
          try {
            const projection = await view(client);
            assert.equal(projection.status, 200);
            assert.equal(
              projection.body.available_actions.length,
              canManage ? 2 : 0,
            );
            await page.goto(uiOrigin);
            await page
              .getByRole('button', { name: 'Open invitation workspace' })
              .click();
            await page
              .getByLabel('Invitation identifier', { exact: true })
              .fill(invitation.invitation_id);
            await page
              .getByRole('button', { name: 'Load invitation', exact: true })
              .click();
            await page
              .getByRole('heading', { name: 'Review before accepting' })
              .waitFor();
            assert.deepEqual(
              {
                amend: await page
                  .getByRole('button', {
                    name: 'Amend proposed permission',
                    exact: true,
                  })
                  .count(),
                withdraw: await page
                  .getByRole('button', {
                    name: 'Withdraw pending invitation',
                    exact: true,
                  })
                  .count(),
                acceptDisabled: await page
                  .getByRole('button', {
                    name: 'Accept displayed revision',
                    exact: true,
                  })
                  .isDisabled(),
              },
              {
                amend: canManage ? 1 : 0,
                withdraw: canManage ? 1 : 0,
                acceptDisabled: true,
              },
            );
          } finally {
            await context.close();
          }
        }
      },
    );
    await t.test(
      'D20 a lost real login response permits sign-out after a verified session, not after an unconfirmed read',
      async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await page.goto(uiOrigin);
          await page
            .getByText(
              'Use your existing credentials, or activate the predeclared office account.',
              { exact: true },
            )
            .waitFor();
          await page.evaluate(() => {
            const original = window.fetch;
            window.__loginCalls = 0;
            window.__noticeDocument = 'notice-lifetime-document';
            window.__failSession = true;
            window.fetch = async (...args) => {
              const response = await original(...args);
              if (
                String(args[0]).endsWith('/sessions') &&
                args[1]?.method === 'POST'
              ) {
                window.__loginCalls++;
                if (window.__loginCalls === 1) {
                  await response.text();
                  throw new TypeError('Directed lost login response');
                }
              }
              if (
                String(args[0]).endsWith('/session') &&
                window.__failSession
              ) {
                window.__failSession = false;
                await response.text();
                throw new TypeError('Directed unconfirmed session observation');
              }
              return response;
            };
          });
          await page
            .getByLabel('Email address', { exact: true })
            .fill('alice@example.test');
          await page.getByLabel('Password', { exact: true }).fill(password);
          await page
            .locator('form')
            .getByRole('button', { name: 'Sign in', exact: true })
            .click();
          const lost = page.getByText(
            'No result was received. Refresh the session to check current access before signing in again.',
            { exact: true },
          );
          await lost.waitFor();
          await page
            .getByRole('button', { name: 'Recover', exact: true })
            .click();
          await page
            .getByText(
              'An earlier result is unconfirmed. Retry its unchanged request, or refresh the session after an uncertain sign-in.',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await page.getByLabel('New password', { exact: true }).count(),
            0,
          );
          await page
            .getByRole('button', { name: 'Refresh session', exact: true })
            .click();
          await lost.waitFor();
          assert.equal(
            await page.getByRole('heading', { name: 'Session active' }).count(),
            0,
          );
          await page
            .getByRole('button', { name: 'Refresh session', exact: true })
            .click();
          await page
            .getByText('Current session verified by the server.', {
              exact: true,
            })
            .waitFor();
          const unconfirmedNotice =
            (await page
              .getByText(
                'The earlier sign-in result remains unconfirmed. Current access was checked separately; refreshing did not recover that result.',
                { exact: true },
              )
              .count()) === 1;
          await page
            .getByRole('button', { name: 'Refresh session', exact: true })
            .click();
          await page
            .getByText('Current session verified by the server.', {
              exact: true,
            })
            .waitFor();
          const sameSessionNotice =
            (await page.getByText(loginNotice, { exact: true }).count()) === 1;
          await page.evaluate(() => {
            window.__failSession = true;
          });
          await page
            .getByRole('button', { name: 'Refresh session', exact: true })
            .click();
          await lost.waitFor();
          const failedObservationNotice =
            (await page.getByText(loginNotice, { exact: true }).count()) === 1;
          const cookies = await context.cookies(apiOrigin);
          const sessionCookie = cookies.find(
            (c) => c.name === '__Host-ledgerdesk-session',
          );
          assert.ok(sessionCookie);
          await page
            .getByRole('button', { name: 'Sign out', exact: true })
            .click();
          await page.waitForFunction(
            () =>
              document.body.innerText.includes(
                'Signed out. The previous session is invalid.',
              ) ||
              document.body.innerText.includes(
                'An earlier result is unconfirmed. Retry its unchanged request before starting another.',
              ),
          );
          assert.deepEqual(
            {
              unconfirmedNotice,
              sameSessionNotice,
              failedObservationNotice,
              noticeAfterLogout: await page
                .getByText(loginNotice, { exact: true })
                .count(),
              signedOut:
                (await page
                  .getByText('Signed out. The previous session is invalid.', {
                    exact: true,
                  })
                  .count()) === 1,
              loginCalls: await page.evaluate(() => window.__loginCalls),
              oldSession: (
                await request('/session', {
                  client: {
                    cookie: sessionCookie.name + '=' + sessionCookie.value,
                  },
                })
              ).status,
              authenticated: await page
                .getByRole('heading', { name: 'Session active' })
                .count(),
            },
            {
              unconfirmedNotice: true,
              sameSessionNotice: true,
              failedObservationNotice: true,
              noticeAfterLogout: 0,
              signedOut: true,
              loginCalls: 1,
              oldSession: 403,
              authenticated: 0,
            },
          );
          await page.getByLabel('Password', { exact: true }).fill(password);
          await page
            .locator('form')
            .getByRole('button', { name: 'Sign in', exact: true })
            .click();
          await page
            .getByText(
              'Signed in. This session does not grant corpus approval or unrestricted reading.',
              { exact: true },
            )
            .waitFor();
          assert.deepEqual(
            {
              notice: await page
                .getByText(loginNotice, { exact: true })
                .count(),
              authenticated: await page
                .getByRole('heading', { name: 'Session active' })
                .count(),
              loginCalls: await page.evaluate(() => window.__loginCalls),
              sameDocument: await page.evaluate(
                () => window.__noticeDocument === 'notice-lifetime-document',
              ),
            },
            { notice: 0, authenticated: 1, loginCalls: 2, sameDocument: true },
          );
        } finally {
          await context.close();
        }
      },
    );
    await t.test(
      'D21 acceptance without an offer stays disabled even with a current verified proof',
      async () => {
        const issued = await post(
          '/invitations',
          proposal('alice@example.test'),
          master,
        );
        assert.equal(issued.status, 200);
        const context = await browser.newContext(),
          page = await context.newPage();
        try {
          await page.goto(uiOrigin);
          await page
            .getByRole('button', { name: 'Open invitation workspace' })
            .click();
          await page
            .getByLabel('Invitation identifier', { exact: true })
            .fill(issued.body.invitation_id);
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
          const mail = messages.at(-1);
          assert.equal(
            (
              await env.admin.query(
                'SELECT invitation_id FROM access_trial.email_proof WHERE id=$1',
                [mail.challenge_id],
              )
            ).rows[0].invitation_id,
            issued.body.invitation_id,
          );
          await page
            .getByLabel('Invitation challenge identifier', { exact: true })
            .fill(mail.challenge_id);
          await page
            .getByLabel('Invitation verification code', { exact: true })
            .fill(mail.code);
          await page
            .getByRole('button', {
              name: 'Verify invitation email',
              exact: true,
            })
            .click();
          await page
            .getByText(
              'Email verified. This has not accepted the invitation.',
              { exact: true },
            )
            .waitFor();
          const accept = page.getByRole('button', {
            name: 'Accept displayed revision',
            exact: true,
          });
          assert.equal(
            await accept.isEnabled(),
            true,
            'positive proof and offer',
          );
          await env.admin.query(
            'UPDATE access_trial.account SET restricted=true WHERE id=$1',
            [aliceId],
          );
          await page
            .getByRole('button', { name: 'Load invitation', exact: true })
            .click();
          await page
            .getByText(
              'No actions are available in this view. Its terms remain readable.',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await accept.isDisabled(),
            true,
            'proof alone cannot enable acceptance',
          );
          assert.equal(
            await page
              .getByRole('heading', { name: 'Review before accepting' })
              .count(),
            1,
          );
          await env.admin.query(
            'UPDATE access_trial.account SET restricted=false WHERE id=$1',
            [aliceId],
          );
          await page
            .getByRole('button', { name: 'Load invitation', exact: true })
            .click();
          await page
            .getByText(
              'No actions are available in this view. Its terms remain readable.',
              { exact: true },
            )
            .waitFor({ state: 'hidden' });
          assert.equal(
            await accept.isEnabled(),
            true,
            'restored eligibility restores the offer',
          );
        } finally {
          await env.admin.query(
            'UPDATE access_trial.account SET restricted=false WHERE id=$1',
            [aliceId],
          );
          await context.close();
        }
      },
    );
    for (const [id, transition] of [
      ['D22', 'same-account replacement on refresh'],
      ['D23', 'other-account replacement on refresh'],
      ['D24', 'confirmed absence after an unconfirmed logout'],
      ['D25', 'observed session mismatch'],
    ]) {
      await t.test(
        `${id} login notice ends only with ${transition}`,
        async () => {
          const email = `notice-${id.toLowerCase()}@example.test`;
          // Fresh real invitation/credential paths keep unrelated rate budgets intact.
          await admit(email, ['read_material']);
          const context = await browser.newContext(),
            page = await context.newPage();
          try {
            await page.goto(uiOrigin);
            await page
              .getByText(
                'Use your existing credentials, or activate the predeclared office account.',
                { exact: true },
              )
              .waitFor();
            await page.evaluate(() => {
              const original = window.fetch;
              window.__noticeDocument = 'notice-lifetime-document';
              window.__loginCalls = 0;
              window.__loseLogout = false;
              window.fetch = async (...args) => {
                const response = await original(...args);
                if (
                  String(args[0]).endsWith('/sessions') &&
                  args[1]?.method === 'POST'
                ) {
                  window.__loginCalls++;
                  if (window.__loginCalls === 1) {
                    await response.text();
                    throw new TypeError('Directed lost login response');
                  }
                }
                if (
                  String(args[0]).endsWith('/sessions/logout') &&
                  window.__loseLogout
                ) {
                  window.__loseLogout = false;
                  await response.text();
                  throw new TypeError('Directed lost logout response');
                }
                return response;
              };
            });
            await page.getByLabel('Email address', { exact: true }).fill(email);
            await page.getByLabel('Password', { exact: true }).fill(password);
            await page
              .locator('form')
              .getByRole('button', { name: 'Sign in', exact: true })
              .click();
            const lost = page.getByText(
              'No result was received. Refresh the session to check current access before signing in again.',
              { exact: true },
            );
            await lost.waitFor();
            await page
              .getByRole('button', { name: 'Refresh session', exact: true })
              .click();
            await page
              .getByText('Current session verified by the server.', {
                exact: true,
              })
              .waitFor();
            const cookie = (await context.cookies(apiOrigin)).find(
              (c) => c.name === '__Host-ledgerdesk-session',
            );
            assert.ok(cookie);
            const oldClient = { cookie: cookie.name + '=' + cookie.value };
            const before = await request('/session', { client: oldClient });
            assert.deepEqual(
              {
                notice: await page
                  .getByText(loginNotice, { exact: true })
                  .count(),
                authenticated: await page
                  .getByRole('heading', { name: 'Session active' })
                  .count(),
                status: before.status,
              },
              { notice: 1, authenticated: 1, status: 200 },
            );

            if (id === 'D24') {
              await page.evaluate(() => {
                window.__loseLogout = true;
              });
              await page
                .getByRole('button', { name: 'Sign out', exact: true })
                .click();
              await lost.waitFor();
              // The server completed logout, but its response was deliberately lost.
              assert.deepEqual(
                {
                  notice: await page
                    .getByText(loginNotice, { exact: true })
                    .count(),
                  authenticated: await page
                    .getByRole('heading', { name: 'Session active' })
                    .count(),
                  oldSession: (await request('/session', { client: oldClient }))
                    .status,
                },
                { notice: 1, authenticated: 1, oldSession: 403 },
              );
              await page
                .getByRole('button', { name: 'Refresh session', exact: true })
                .click();
              await page
                .getByText(
                  'Use your existing credentials, or activate the predeclared office account.',
                  { exact: true },
                )
                .waitFor();
            } else {
              const replacement = id === 'D23' ? foreign : await login(email);
              assert.equal(replacement.csrf === before.body.csrf_token, false);
              await replaceCookie(context, replacement);
              if (id === 'D25') {
                await page.evaluate(() =>
                  window.dispatchEvent(new Event('focus')),
                );
                await page
                  .getByText(
                    'The session changed. Refresh the session before continuing.',
                    { exact: true },
                  )
                  .waitFor();
              } else {
                await page
                  .getByRole('button', { name: 'Refresh session', exact: true })
                  .click();
                await page
                  .getByText('Current session verified by the server.', {
                    exact: true,
                  })
                  .waitFor();
                assert.equal(
                  (await request('/session', { client: replacement })).status,
                  200,
                );
                assert.equal(
                  await page
                    .getByText(
                      'The session changed. Refresh the session before continuing.',
                      { exact: true },
                    )
                    .count(),
                  0,
                  'refresh adopts directly rather than relying on the mismatch callback',
                );
              }
            }
            assert.deepEqual(
              {
                notice: await page
                  .getByText(loginNotice, { exact: true })
                  .count(),
                authenticated: await page
                  .getByRole('heading', { name: 'Session active' })
                  .count(),
                loginCalls: await page.evaluate(() => window.__loginCalls),
                sameDocument: await page.evaluate(
                  () => window.__noticeDocument === 'notice-lifetime-document',
                ),
              },
              {
                notice: 0,
                authenticated: id === 'D22' || id === 'D23' ? 1 : 0,
                loginCalls: 1,
                sameDocument: true,
              },
            );
          } finally {
            await context.close();
          }
        },
      );
    }
    await t.test(
      'D15 capability and action projections each commit evidence before HTTP handoff without an open transaction',
      async () => {
        for (const [route, request] of [
          ['capabilities', () => caps(master)],
          ['invitation_view', () => view(master)],
        ]) {
          let release, reached;
          const ready = new Promise((r) => (reached = r)),
            held = new Promise((r) => (release = r));
          let finished = false;
          let timer;
          hooks.afterCommit = async (current) => {
            if (current === route) {
              reached();
              await Promise.race([
                held,
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(Error('Bounded projection observer timed out')),
                    5000,
                  );
                }),
              ]);
            }
          };
          const result = request().then((r) => {
            finished = true;
            return r;
          });
          try {
            await Promise.race([
              ready,
              result.then(() => {
                throw Error('Projection escaped its observer');
              }),
            ]);
            const evidence = (
              await env.admin.query(
                `SELECT e.id,e.result,(SELECT count(*)::int FROM access_trial.transport_observation o WHERE o.evidence_id=e.id) AS observations
            FROM access_trial.evidence e WHERE operation=$1 ORDER BY recorded_at DESC LIMIT 1`,
                [route],
              )
            ).rows[0];
            const sessions = (
              await env.admin.query(
                "SELECT state,xact_start FROM pg_stat_activity WHERE usename='inc02_runtime'",
              )
            ).rows;
            assert.ok(sessions.length > 0);
            assert.ok(
              sessions.every(
                (s) => s.state === 'idle' && s.xact_start === null,
              ),
            );
            assert.deepEqual(
              {
                result: evidence.result,
                observations: evidence.observations,
                finished,
              },
              { result: 200, observations: 0, finished: false },
            );
            release();
            assert.equal((await result).status, 200);
            const limit = Date.now() + 3000;
            let observed = 0;
            do {
              observed = (
                await env.admin.query(
                  'SELECT count(*)::int n FROM access_trial.transport_observation WHERE evidence_id=$1',
                  [evidence.id],
                )
              ).rows[0].n;
              if (!observed) await pause(10);
            } while (!observed && Date.now() < limit);
            assert.equal(observed, 1);
          } finally {
            release();
            clearTimeout(timer);
            delete hooks.afterCommit;
            await result;
          }
        }
      },
    );
  },
);
