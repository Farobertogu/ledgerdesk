import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import next from 'next';
import { chromium } from '@playwright/test';
import {
  journeyEnvironment,
  uiOrigin,
  apiOrigin,
  password,
  recipientEmail,
} from './journey_environment.mjs';
import { journeyTerminal } from './journey_mutation.mjs';
import { verifyFinalRoutes, readSourceComposition } from '../../ci/access_final_routes.mjs';
import { observeBrowser } from '../reading/browser_diagnostics.mjs';
import { original } from '../reading/T04_seed.mjs';
import './test_bootstrap_runtime.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(15);
  }
  throw Error(message);
}
const materialPath = '/api/v1/material/content/versions/v1';
test(
  'T06 one produced identity, accepted grant, real reading and effective withdrawal',
  { timeout: 240000 },
  async (t) => {
    const env = await journeyEnvironment();
    let terminal,
      browser,
      app,
      uiServer,
      masterContext,
      recipientContext,
      masterPage,
      recipientPage,
      masterId,
      recipientId,
      invitationId,
      grantId,
      modified;
    const messages = [],
      failures = [],
      gates = new Set(),
      hooks = { failure: (e) => failures.push(e.message) },
      readingHooks = {};
    const records = [];
    const uiDir = path.resolve('tests/access/final-ui');
    const initialBuild = readFileSync(
      path.join(uiDir, '.next/BUILD_ID'),
      'utf8',
    );
    t.afterEach(() => {
      for (const release of gates) release();
      gates.clear();
      delete hooks.beforeCommit;
      delete hooks.afterCommit;
      delete readingHooks.afterCommit;
      delete readingHooks.afterLastClock;
    });
    t.after(async () => {
      for (const release of gates) release();
      try {
        await browser?.close();
        uiServer?.closeAllConnections();
        if (uiServer) await new Promise((r) => uiServer.close(r));
        await app?.close();
        await terminal?.close();
      } finally {
        writeFileSync(
          '/work/output/journey.json',
          JSON.stringify(
            {
              buildId: initialBuild,
              scenarios: records,
              claim:
                'Synthetic whole journey; not production or full temporal conformity',
              open: ['R24', 'BROWSER-I03', 'BROWSER-J19'],
            },
            null,
            2,
          ),
        );
        await env.close();
        modified?.clean();
      }
    });
    const scenario = async (name, fn) => {
      let passed = false;
      await t.test(name, async () => {
        await fn();
        records.push(name);
        assert.equal(
          readFileSync(path.join(uiDir, '.next/BUILD_ID'), 'utf8'),
          initialBuild,
        );
        passed = true;
      });
      if (!passed) throw Error('Dependent journey stopped after ' + name);
    };
    const mutation = process.env.ACCESS_RUNTIME_MUTATION ?? '';
    modified = await journeyTerminal(mutation);
    terminal = await modified.start({
      config: env.config,
      tls: env.tls,
      mailbox: {
        async send(m) {
          messages.push(m);
        },
      },
      hooks,
      reading: env.reading,
      readingHooks,
    });
    if (mutation === 'early-failure')
      throw Error('Injected early failure after cleanup registration');
    function request(
      url,
      {
        body,
        client,
        key = randomUUID(),
        peer = '127.0.0.1',
        origin = uiOrigin,
      } = {},
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
            path: url,
            localAddress: peer,
            method: bytes ? 'POST' : 'GET',
            headers: {
              host: 'api.inc02.test:9443',
              origin,
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
          req.destroy(Error('Bounded journey HTTPS timeout')),
        );
        req.on('error', reject);
        req.end(bytes);
      });
    }
    const access = (url, args) => request('/api/access/v1' + url, args);
    const post = (url, body, client, extra = {}) =>
      access(url, { body, client, ...extra });
    const count = async (table) =>
      Number(
        (
          await env.admin.query(
            'SELECT count(*) AS n FROM access_trial.' + table,
          )
        ).rows[0].n,
      );
    async function flow(peer) {
      const r = await access('/reception', { peer });
      assert.equal(r.status, 200);
      return {
        cookie: r.headers['set-cookie'][0].split(';')[0],
        csrf: r.body.csrf_token,
      };
    }
    async function fromBrowser(context) {
      const cookie = (await context.cookies(apiOrigin)).find(
        (c) => c.name === '__Host-ledgerdesk-session',
      );
      assert.ok(cookie);
      const client = { cookie: cookie.name + '=' + cookie.value };
      const r = await access('/session', { client });
      assert.equal(r.status, 200);
      return { ...client, csrf: r.body.csrf_token };
    }
    async function signIn(page, email, pw = password) {
      await page.getByLabel('Email address', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(pw);
      await page
        .locator('form')
        .getByRole('button', { name: 'Sign in', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'Session active', exact: true })
        .waitFor();
    }
    async function openInvitations(page) {
      const b = page.getByRole('button', {
        name: 'Open invitation workspace',
        exact: true,
      });
      if (await b.count()) await b.click();
      await page.getByLabel('Invitation identifier', { exact: true }).waitFor();
    }
    function heldRead() {
      let arrive, release;
      const reached = new Promise((r) => (arrive = r)),
        gate = new Promise((r) => (release = r));
      const timer = setTimeout(release, 5000),
        finish = () => {
          clearTimeout(timer);
          release();
        };
      gates.add(finish);
      readingHooks.afterCommit = async (event) => {
        if (event.surface === 'material-exact') {
          arrive(event);
          await gate;
        }
      };
      return {
        release: finish,
        reached: Promise.race([
          reached,
          pause(6000).then(() => {
            throw Error('Held material did not arrive');
          }),
        ]),
      };
    }
    const replace = (p) =>
      env.control.query('SELECT material_trial.replace_policy($1,$2,$3)', [
        '"content"',
        '"v1"',
        JSON.stringify(p),
      ]);
    await scenario(
      'W01 exact final composition and startup configuration have positive and negative controls',
      async () => {
        const source = readSourceComposition(path.join(uiDir, 'source-composition.json'), process.env.ACCESS_COMPOSITION_SHA256);
        const manifest = verifyFinalRoutes('/work', uiDir, source);
        writeFileSync(
          '/work/output/composition.json',
          JSON.stringify(manifest, null, 2),
        );
        const run = (envVars, args = [], hook = false) =>
          execFileSync(
            process.execPath,
            [
              '--experimental-strip-types',
              '--input-type=module',
              '-e',
              "process.argv.push(...JSON.parse(process.env.PROBE_ARGS)); " +
                (hook ? "await (await import('./src/instrumentation.ts')).register()" : "await import('./next.config.mjs')"),
            ],
            {
              cwd: uiDir,
              env: {
                ...process.env,
                LEDGERDESK_READING_TRIAL: '0',
                NEXT_RUNTIME: 'nodejs',
                ...envVars,
                PROBE_ARGS: JSON.stringify(args),
              },
              timeout: 15000,
              stdio: 'pipe',
            },
          );
        run({});
        assert.throws(() => run({ LEDGERDESK_READING_TRIAL: 'wrong' }));
        const trial = {
          LEDGERDESK_READING_TRIAL: '1',
          LEDGERDESK_READING_ENVIRONMENT: 'local-synthetic',
          LEDGERDESK_READING_SUBJECT: 'synthetic-probe',
          LEDGERDESK_READING_GENERATION: 'probe',
        };
        run(trial, ['start', '--hostname', '127.0.0.1']);
        assert.throws(() => run(trial, ['start', '--hostname', '0.0.0.0']));
        // Exercise the copied startup hook itself, independently of next.config's guard.
        run({}, [], true);
        run(trial, ['start', '--hostname', '127.0.0.1'], true);
        for (const [vars, args] of [
          [{ LEDGERDESK_READING_TRIAL: 'wrong' }, []],
          [trial, ['start', '--hostname', '0.0.0.0']],
        ]) assert.throws(() => run(vars, args, true),
          (e) => e.stderr.toString().includes('Invalid isolated reading trial configuration'));
        assert.deepEqual(
          {
            accounts: await count('account'),
            grants: await count('grant_record'),
            acceptances: await count('acceptance'),
          },
          { accounts: 0, grants: 0, acceptances: 0 },
        );
      },
    );
    await scenario(
      'W02 bootstrap declarations are read-only to runtime and do not create authority',
      async () => {
        for (const sql of [
          'UPDATE access_trial.bootstrap_declaration SET root=root',
          'DELETE FROM access_trial.bootstrap_declaration',
          'INSERT INTO access_trial.bootstrap_declaration SELECT * FROM access_trial.bootstrap_declaration',
          'UPDATE access_trial.permission_definition SET active=false',
          'INSERT INTO access_trial.investiture SELECT * FROM access_trial.investiture',
        ])
          await assert.rejects(
            env.runtime.query(sql),
            (e) => e.code === '42501',
          );
        assert.equal(await count('investiture'), 0);
      },
    );
    process.env.LEDGERDESK_ACCESS_TRIAL = 'synthetic';
    process.env.LEDGERDESK_ACCESS_UI_ORIGIN = uiOrigin;
    process.env.LEDGERDESK_ACCESS_API_ORIGIN = apiOrigin;
    process.env.LEDGERDESK_READING_TRIAL = '0';
    app = next({
      dev: false,
      dir: uiDir,
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
    masterContext = await browser.newContext({
      viewport: { width: 1100, height: 850 },
    });
    masterPage = await masterContext.newPage();
    recipientContext = await browser.newContext({
      viewport: { width: 1100, height: 850 },
    });
    recipientPage = await recipientContext.newPage();
    const diagnostic = observeBrowser(
      recipientPage,
      '/work/output/browser-diagnostics',
    );
    await scenario(
      'W03 same build closes both final routes for missing/invalid configuration and opens the valid panel',
      async () => {
        for (const invalid of ['disabled', 'origin']) {
          if (invalid === 'disabled')
            delete process.env.LEDGERDESK_ACCESS_TRIAL;
          else {
            process.env.LEDGERDESK_ACCESS_TRIAL = 'synthetic';
            process.env.LEDGERDESK_ACCESS_API_ORIGIN =
              'http://api.inc02.test:9443';
          }
          let calls = 0;
          const watch = (r) => {
            if (new URL(r.url()).host === 'api.inc02.test:9443') calls++;
          };
          masterPage.on('request', watch);
          for (const route of ['/access', '/access/material']) {
            await masterPage.goto(uiOrigin + route);
            assert.match(
              await masterPage.locator('body').textContent(),
              /environment is not enabled/,
            );
          }
          assert.equal(calls, 0);
          masterPage.off('request', watch);
        }
        process.env.LEDGERDESK_ACCESS_TRIAL = 'synthetic';
        process.env.LEDGERDESK_ACCESS_API_ORIGIN = apiOrigin;
        await masterPage.goto(uiOrigin + '/access');
        await masterPage.getByLabel('Email address', { exact: true }).waitFor();
        assert.equal(
          await masterPage.locator('html').getAttribute('lang'),
          'en-AU',
        );
        assert.equal(
          await masterPage
            .locator('body')
            .evaluate((e) => getComputedStyle(e).backgroundColor),
          'rgb(242, 242, 239)',
        );
        await eventually(
          async () => (await count('flow')) > 0,
          'No real reception',
        );
      },
    );
    await scenario(
      'W04 unknown first visitor creates no account, grants or bootstrap effect',
      async () => {
        const f = await flow('127.0.0.2'),
          before = messages.length;
        assert.equal(
          (
            await post(
              '/activation/challenges',
              { email: 'stranger@example.test' },
              f,
              { peer: '127.0.0.2' },
            )
          ).status,
          200,
        );
        assert.deepEqual(
          {
            messages: messages.length,
            accounts: await count('account'),
            grants: await count('grant_record'),
            bootstrap: await count('bootstrap_activation'),
          },
          { messages: before, accounts: 0, grants: 0, bootstrap: 0 },
        );
      },
    );
    let activationBody, activationClient, activationKey, activationResult;
    await scenario(
      'W05 stale declared permission blocks activation atomically; current declaration remains usable',
      async () => {
        activationClient = await flow('127.0.0.3');
        assert.equal(
          (
            await post(
              '/activation/challenges',
              { email: 'master@example.test' },
              activationClient,
              { peer: '127.0.0.3' },
            )
          ).status,
          200,
        );
        await eventually(
          () => messages.some((m) => m.purpose === 'activation'),
          'No activation message',
        );
        const m = messages.find((m) => m.purpose === 'activation');
        activationBody = {
          challenge_id: m.challenge_id,
          code: m.code,
          password,
        };
        activationKey = randomUUID();
        // Directed external revision invalidation. No grants, accounts or budgets are inserted/reset.
        await env.admin.query(
          "UPDATE access_trial.permission_definition SET revision=2 WHERE id='read_material'",
        );
        try {
          const r = await post(
            '/activation/complete',
            activationBody,
            activationClient,
            { key: activationKey, peer: '127.0.0.3' },
          );
          const used = (
            await env.admin.query(
              'SELECT used FROM access_trial.proof WHERE id=$1',
              [m.challenge_id],
            )
          ).rows[0].used;
          assert.deepEqual(
            {
              status: r.status,
              accounts: await count('account'),
              grants: await count('grant_record'),
              used,
            },
            { status: 503, accounts: 0, grants: 0, used: false },
          );
        } finally {
          await env.admin.query(
            "UPDATE access_trial.permission_definition SET revision=1 WHERE id='read_material'",
          );
        }
      },
    );
    await scenario(
      'W06 browser activation creates only declared faculties and durable linked evidence',
      async () => {
        await masterPage
          .getByRole('button', { name: 'Activate', exact: true })
          .click();
        await masterPage
          .getByLabel('Email address', { exact: true })
          .fill('master@example.test');
        // The code came from the actual controlled mailbox, not a verifier fixture.
        await masterPage
          .getByLabel('Challenge identifier', { exact: true })
          .fill(activationBody.challenge_id);
        await masterPage
          .getByLabel('Verification code', { exact: true })
          .fill(activationBody.code);
        await masterPage
          .getByLabel('New password', { exact: true })
          .fill(password);
        // A proof is purpose/address-bound; activation is consumed once across provisional sessions.
        const [response] = await Promise.all([
          masterPage.waitForResponse(
            (r) =>
              new URL(r.url()).pathname ===
              '/api/access/v1/activation/complete',
          ),
          masterPage
            .getByRole('button', { name: 'Activate account', exact: true })
            .click(),
        ]);
        activationResult = await response.json();
        await masterPage
          .getByText('Account activated. You can now sign in.', { exact: true })
          .waitFor();
        masterId = (
          await env.admin.query(
            "SELECT id FROM access_trial.account WHERE email='master@example.test'",
          )
        ).rows[0].id;
        const grants = (
          await env.admin.query(
            'SELECT permission_id,faculty,acceptance_id,source_act FROM access_trial.grant_record ORDER BY permission_id',
          )
        ).rows;
        assert.deepEqual(
          grants,
          [
            ['invite', 'exercise'],
            ['read_material', 'grant'],
            ['read_people', 'exercise'],
          ].map(([permission_id, faculty]) => ({
            permission_id,
            faculty,
            acceptance_id: null,
            source_act: 'bootstrap:initial-administration',
          })),
        );
        const link = (
          await env.admin.query(
            `SELECT e.operation,e.result,b.account_id FROM access_trial.bootstrap_activation b JOIN access_trial.evidence e ON e.id=b.evidence_id`,
          )
        ).rows;
        assert.deepEqual(link, [
          { operation: 'activate_master', result: 200, account_id: masterId },
        ]);
        assert.equal(await count('acceptance'), 0);
        assert.equal(await count('investiture'), 0);
        await signIn(masterPage, 'master@example.test');
        const master = await fromBrowser(masterContext);
        assert.equal(
          (await request(materialPath, { client: master })).status,
          404,
        );
      },
    );
    await scenario(
      'W07 consumed activation and declaration edits cannot duplicate or extend initial faculties',
      async () => {
        const r = await post(
          '/activation/complete',
          activationBody,
          activationClient,
          { key: randomUUID(), peer: '127.0.0.3' },
        );
        assert.deepEqual(
          {
            status: r.status,
            code: r.body.code,
            accounts: await count('account'),
            grants: await count('grant_record'),
            bootstrap: await count('bootstrap_activation'),
          },
          {
            status: 403,
            code: 'forbidden',
            accounts: 1,
            grants: 3,
            bootstrap: 1,
          },
        );
        await assert.rejects(
          env.admin.query(
            "UPDATE access_trial.bootstrap_declaration SET faculties='[]'",
          ),
          (e) => e.code === '55000',
        );
        assert.equal(
          (
            await access('/capabilities', {
              client: await fromBrowser(masterContext),
            })
          ).body.invitation_options.length > 0,
          true,
        );
      },
    );
    await scenario(
      'W08 browser invitation produces no recipient account or usable grant before acceptance',
      async () => {
        await openInvitations(masterPage);
        await masterPage
          .getByLabel('Recipient email', { exact: true })
          .fill(recipientEmail);
        await masterPage
          .getByLabel('Proposed permission', { exact: true })
          .selectOption({
            label:
              'Read material — exercise — Material scope — Domain adoption',
          });
        const [r] = await Promise.all([
          masterPage.waitForResponse(
            (r) =>
              new URL(r.url()).pathname === '/api/access/v1/invitations' &&
              r.request().method() === 'POST',
          ),
          masterPage
            .getByRole('button', { name: 'Create invitation', exact: true })
            .click(),
        ]);
        assert.equal(r.status(), 200);
        invitationId = (await r.json()).invitation_id;
        assert.deepEqual(
          {
            accounts: await count('account'),
            grants: await count('grant_record'),
            acceptances: await count('acceptance'),
          },
          { accounts: 1, grants: 3, acceptances: 0 },
        );
      },
    );
    await scenario(
      'W09 exact-email verification is not acceptance; displayed terms are accepted through the browser',
      async () => {
        await recipientPage.goto(uiOrigin + '/access');
        await openInvitations(recipientPage);
        await recipientPage
          .getByLabel('Invitation identifier', { exact: true })
          .fill(invitationId);
        await recipientPage
          .getByRole('button', { name: 'Request invitation code', exact: true })
          .click();
        await eventually(
          () =>
            messages.some(
              (m) =>
                m.email === recipientEmail &&
                m.purpose === 'invitation' &&
                m.code,
            ),
          'No invitation code',
        );
        const m = messages.find(
          (m) =>
            m.email === recipientEmail && m.purpose === 'invitation' && m.code,
        );
        assert.equal(m.email, recipientEmail);
        assert.equal(
          (
            await env.admin.query(
              'SELECT invitation_id FROM access_trial.email_proof WHERE id=$1',
              [m.challenge_id],
            )
          ).rows[0].invitation_id,
          invitationId,
        );
        await recipientPage
          .getByLabel('Invitation challenge identifier', { exact: true })
          .fill(m.challenge_id);
        await recipientPage
          .getByLabel('Invitation verification code', { exact: true })
          .fill(m.code);
        await recipientPage
          .getByRole('button', { name: 'Verify invitation email', exact: true })
          .click();
        await recipientPage
          .getByRole('heading', {
            name: 'Review before accepting',
            exact: true,
          })
          .waitFor();
        assert.equal(await count('acceptance'), 0);
        assert.equal(await count('account'), 1);
        await recipientPage
          .getByRole('button', {
            name: 'Accept displayed revision',
            exact: true,
          })
          .click();
        await recipientPage
          .getByText(/Acceptance completed\. Operation/)
          .waitFor();
        recipientId = (
          await env.admin.query(
            'SELECT id FROM access_trial.account WHERE email=$1',
            [recipientEmail],
          )
        ).rows[0].id;
        const result = (
          await env.admin.query(
            `SELECT g.id,g.account_id,g.permission_id,g.faculty,a.invitation_id,a.revision,p.used FROM access_trial.grant_record g
      JOIN access_trial.acceptance a ON a.id=g.acceptance_id JOIN access_trial.email_proof p ON p.id=a.proof_id WHERE a.invitation_id=$1`,
            [invitationId],
          )
        ).rows;
        assert.equal(result.length, 1);
        grantId = result[0].id;
        assert.deepEqual(
          { ...result[0], id: undefined },
          {
            id: undefined,
            account_id: recipientId,
            permission_id: 'read_material',
            faculty: 'exercise',
            invitation_id: invitationId,
            revision: 1,
            used: true,
          },
        );
        await recipientPage
          .getByLabel('First password after acceptance', { exact: true })
          .fill(password);
        await recipientPage
          .getByRole('button', { name: 'Set first password', exact: true })
          .click();
        await recipientPage
          .getByText(
            'First password established. Use Sign in to start a session.',
            { exact: true },
          )
          .waitFor();
        await signIn(recipientPage, recipientEmail);
      },
    );
    await scenario(
      'W10 instantiated external material policy cannot substitute for the actual recipient grant',
      async () => {
        const p = await env.materialPolicy(recipientId);
        await env.admin.query(
          "INSERT INTO material_trial.policy VALUES('inc02-synthetic','inc02-material','\"content\"','\"v1\"',$1)",
          [JSON.stringify(p)],
        );
        const current = await fromBrowser(recipientContext),
          master = await fromBrowser(masterContext);
        assert.deepEqual(
          {
            reader: (await request(materialPath, { client: current })).status,
            master: (await request(materialPath, { client: master })).status,
          },
          { reader: 200, master: 404 },
        );
        assert.equal(
          (await request(materialPath, { client: current })).body.projection
            .original_text,
          original,
        );
      },
    );
    await scenario(
      'W18 final root styling preserves keyboard operation and the admitted people view',
      async () => {
        // External nominal-population input, bound to the account produced above.
        // This is not a new identity or census-management product operation.
        await env.admin.query(
          'INSERT INTO material_trial.census_entry VALUES($1,$2,$3,$4,1)',
          [
            recipientId,
            'inc02-material',
            'Synthetic recipient',
            'declared-population',
          ],
        );
        await masterPage
          .getByRole('button', { name: 'Load authorized people', exact: true })
          .click();
        await masterPage
          .getByText('Authorized people in this page.', { exact: true })
          .waitFor();
        assert.ok(
          (await masterPage.locator('.people-panel li strong').count()) > 0,
        );
        await masterPage
          .getByRole('button', { name: 'Refresh session', exact: true })
          .focus();
        await masterPage.keyboard.press('Tab');
        const focus = await masterPage.evaluate(() => {
          const e = document.activeElement,
            s = getComputedStyle(e);
          return {
            tag: e.tagName,
            outline: s.outlineStyle,
            width: parseFloat(s.outlineWidth),
            visible: e.getBoundingClientRect().width > 0,
          };
        });
        assert.deepEqual(focus, {
          tag: 'BUTTON',
          outline: 'solid',
          width: 3,
          visible: true,
        });
        await masterPage.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await masterPage.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await masterPage.screenshot({
          path: '/work/output/journey-administration-narrow.png',
          fullPage: true,
        });
      },
    );
    await scenario(
      'W11 actual browser waits for durable evidence and idle SQL before receiving exact material',
      async () =>
        diagnostic.run('W11', async () => {
          const [documentResponse] = await Promise.all([
            recipientPage.waitForResponse(
              (r) =>
                r.request().resourceType() === 'document' &&
                new URL(r.url()).pathname === '/access/material',
            ),
            recipientPage
              .getByRole('link', { name: 'Open material library', exact: true })
              .click(),
          ]);
          const html = await documentResponse.text();
          for (const value of [
            original,
            recipientId,
            recipientEmail,
            env.config.digestKey,
            'csrf_token',
            '__Host-ledgerdesk-session',
          ])
            assert.equal(html.includes(value), false);
          await recipientPage
            .getByRole('button', { name: /Journey material/ })
            .waitFor();
          let release, arrive;
          const gate = new Promise((r) => (release = r)),
            reached = new Promise((r) => (arrive = r));
          const timer = setTimeout(release, 5000);
          const finish = () => {
            clearTimeout(timer);
            release();
          };
          gates.add(finish);
          readingHooks.afterCommit = async (event) => {
            if (event.surface === 'material-exact') {
              arrive(event);
              await gate;
            }
          };
          let responses = 0;
          recipientPage.on('response', (r) => {
            if (new URL(r.url()).pathname === materialPath) responses++;
          });
          await recipientPage
            .getByRole('button', { name: /Journey material/ })
            .click();
          const event = await Promise.race([
            reached,
            pause(6000).then(() => {
              throw Error('Material observation timeout');
            }),
          ]);
          const observed = (
            await env.admin.query(
              `SELECT e.result,(SELECT count(*)::int FROM material_trial.observation o WHERE o.evidence_id=e.id) AS n,
      a.state,a.xact_start FROM material_trial.evidence e CROSS JOIN pg_stat_activity a WHERE e.id=$1 AND a.pid=$2`,
              [event.evidenceId, event.backendPid],
            )
          ).rows[0];
          assert.deepEqual(
            {
              observed,
              responses,
              dom: await recipientPage.getByTestId('original').count(),
            },
            {
              observed: { result: 200, n: 0, state: 'idle', xact_start: null },
              responses: 0,
              dom: 0,
            },
          );
          finish();
          await recipientPage.getByTestId('original').waitFor();
          assert.equal(
            await recipientPage.getByTestId('original').textContent(),
            original,
          );
          await eventually(
            async () =>
              (
                await env.admin.query(
                  'SELECT 1 FROM material_trial.observation WHERE evidence_id=$1',
                  [event.evidenceId],
                )
              ).rowCount === 1,
            'No transport observation',
          );
          assert.equal(
            await recipientPage
              .locator('script')
              .filter({ hasText: 'inert()' })
              .count(),
            0,
          );
          await recipientPage.screenshot({
            path: '/work/output/journey-reading-desktop.png',
            fullPage: true,
          });
          await recipientPage.setViewportSize({ width: 390, height: 844 });
          assert.equal(
            await recipientPage.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          await recipientPage.screenshot({
            path: '/work/output/journey-reading-narrow.png',
            fullPage: true,
          });
          assert.equal(uiCookieHits, 0);
        }),
    );
    await scenario(
      'W15 actual policy writer orders before or after the produced recipient material handoff',
      async () => {
        const client = await fromBrowser(recipientContext),
          gate = heldRead(),
          pending = request(materialPath, { client });
        let writer;
        try {
          await gate.reached;
          writer = replace(await env.materialPolicy(recipientId, 'NONE'));
          await eventually(
            async () =>
              (
                await env.admin.query(
                  'SELECT 1 FROM pg_locks WHERE pid=$1 AND classid=20202 AND NOT granted',
                  [env.control.processID],
                )
              ).rowCount === 1,
            'Policy writer did not wait on the actual reading admission',
          );
          gate.release();
          assert.equal((await pending).status, 200);
          await writer;
          delete readingHooks.afterCommit;
          assert.deepEqual(
            {
              material: (await request(materialPath, { client })).status,
              session: (await access('/session', { client })).status,
            },
            { material: 404, session: 200 },
          );
        } finally {
          gate.release();
          await pending;
          await writer;
          await replace(await env.materialPolicy(recipientId));
        }
        assert.equal(
          (await request(materialPath, { client })).status,
          200,
          'Restored external policy plus the same accepted grant is usable',
        );
      },
    );
    await scenario(
      'W16 writer-free expiry before the last check denies handoff on the actual produced authority',
      async () => {
        const client = await fromBrowser(recipientContext),
          deadline = Date.now() + 700;
        await replace(
          await env.materialPolicy(recipientId, 'CONTENT', deadline),
        );
        const gate = heldRead(),
          pending = request(materialPath, { client });
        try {
          await gate.reached;
          await pause(Math.max(0, deadline - Date.now() + 20));
          gate.release();
          const r = await pending;
          assert.deepEqual(
            {
              status: r.status,
              code: r.body.code,
              text: r.body.projection?.original_text,
            },
            { status: 503, code: 'TECHNICAL_FAILURE', text: undefined },
          );
        } finally {
          gate.release();
          await pending;
          await replace(await env.materialPolicy(recipientId));
        }
      },
    );
    await scenario(
      'W17 clock-to-transport suspension measures rather than conceals the temporal breach',
      async () => {
        const client = await fromBrowser(recipientContext),
          deadline = Date.now() + 700;
        await replace(
          await env.materialPolicy(recipientId, 'CONTENT', deadline),
        );
        let observed;
        readingHooks.afterLastClock = (expiry) => {
          assert.equal(expiry, deadline);
          observed = expiry;
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            Math.max(1, expiry - Date.now() + 30),
          );
        };
        try {
          const r = await request(materialPath, { client }),
            receivedAt = Date.now();
          assert.equal(observed, deadline);
          const result = {
            experiment: 'produced-recipient-clock-to-handoff',
            status: r.status,
            materialReceivedAfterDeadline:
              receivedAt >= deadline &&
              r.body.projection?.original_text === original,
            fullTemporalConformity: false,
          };
          writeFileSync(
            '/work/output/temporal-boundary.json',
            JSON.stringify(result, null, 2),
          );
          t.diagnostic(JSON.stringify(result));
          assert.ok(
            [200, 503].includes(r.status),
            'Record delivery or last-boundary rejection, not an unrelated failure',
          );
          if (r.status === 200)
            assert.equal(r.body.projection.original_text, original);
          else assert.equal(r.body.code, 'TECHNICAL_FAILURE');
          delete readingHooks.afterLastClock;
          assert.equal((await request(materialPath, { client })).status, 404);
        } finally {
          delete readingHooks.afterLastClock;
          await replace(await env.materialPolicy(recipientId));
        }
      },
    );
    await scenario(
      'W12 real offered withdrawal removes that accepted grant without logging the recipient out',
      async () => {
        await masterPage
          .getByLabel('Invitation identifier', { exact: true })
          .fill(invitationId);
        await masterPage
          .getByRole('button', { name: 'Load invitation', exact: true })
          .click();
        await masterPage
          .getByRole('button', {
            name: 'Withdraw accepted permission',
            exact: true,
          })
          .click();
        await masterPage
          .getByText('Permission withdrawn. The acceptance remains recorded.', {
            exact: true,
          })
          .waitFor();
        const client = await fromBrowser(recipientContext),
          r = await request(materialPath, { client });
        const g = (
          await env.admin.query(
            'SELECT withdrawn,revision FROM access_trial.grant_record WHERE id=$1',
            [grantId],
          )
        ).rows[0];
        assert.deepEqual(
          {
            status: r.status,
            grant: g,
            acceptances: await count('acceptance'),
            session: (await access('/session', { client })).status,
          },
          {
            status: 404,
            grant: { withdrawn: true, revision: 2 },
            acceptances: 1,
            session: 200,
          },
        );
        await recipientPage.reload();
        await recipientPage
          .getByText('No readable references were returned.', { exact: true })
          .waitFor();
        assert.equal(await recipientPage.getByTestId('original').count(), 0);
        await recipientPage.screenshot({
          path: '/work/output/journey-withdrawn.png',
          fullPage: true,
        });
      },
    );
    await scenario(
      'W13 ordinary recovery replaces the credential without restoring the withdrawn grant',
      async () => {
        const old = await fromBrowser(recipientContext),
          f = await flow('127.0.0.4');
        assert.equal(
          (
            await post('/recovery/challenges', { email: recipientEmail }, f, {
              peer: '127.0.0.4',
            })
          ).status,
          200,
        );
        await eventually(
          () =>
            messages.some(
              (m) => m.email === recipientEmail && m.purpose === 'recovery',
            ),
          'No recovery message',
        );
        const m = messages.find(
          (m) => m.email === recipientEmail && m.purpose === 'recovery',
        );
        assert.equal(
          (
            await post(
              '/recovery/complete',
              { challenge_id: m.challenge_id, code: m.code, password },
              f,
              { peer: '127.0.0.4' },
            )
          ).status,
          200,
        );
        const loginFlow = await flow('127.0.0.4'),
          r = await post(
            '/sessions',
            { email: recipientEmail, password },
            loginFlow,
            { peer: '127.0.0.4' },
          );
        assert.equal(r.status, 200);
        const fresh = {
          cookie: r.headers['set-cookie'][0].split(';')[0],
          csrf: r.body.csrf_token,
        };
        assert.deepEqual(
          {
            old: (await access('/session', { client: old })).status,
            material: (await request(materialPath, { client: fresh })).status,
            grants: await count('grant_record'),
            bootstrap: await count('bootstrap_activation'),
          },
          { old: 403, material: 404, grants: 4, bootstrap: 1 },
        );
      },
    );
    await scenario(
      'W14 runtime leaves the historical boundary and temporal limitations explicit',
      async () => {
        assert.equal(
          /you don't own a lock|deadlock detected/i.test(env.postgresLog()),
          false,
        );
        assert.equal(uiCookieHits, 0);
        assert.equal(await count('investiture'), 0);
        assert.ok(
          records.includes(
            'W12 real offered withdrawal removes that accepted grant without logging the recipient out',
          ),
        );
      },
    );
  },
);
