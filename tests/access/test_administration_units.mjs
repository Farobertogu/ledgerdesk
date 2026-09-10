import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  capabilityExplanation,
  CAPABILITY_STATE_COPY,
} from '../../src/contracts/access_presentation.ts';
import { validateAccess } from '../../src/contracts/access.ts';
import { accessProblem } from '../../src/contracts/access.ts';
import {
  IntentionSlot,
  StaleView,
  verifySession,
  ViewLifetime,
  assertLocalContext,
  verifySessionForView,
} from '../../src/components/access/view_lifecycle.ts';
import { examples } from './examples.mjs';

test('removing the post-await local-context guard is detected without changing the session response', async () => {
  const moduleUrl = new URL(
    '../../src/components/access/view_lifecycle.ts',
    import.meta.url,
  );
  const source = readFileSync(moduleUrl, 'utf8').replaceAll('\r\n', '\n');
  const guard =
    'await verifySession(apiOrigin, expected, signal, fetcher);\n  assertContext();';
  assert.equal(source.split(guard).length - 1, 1);
  const sourceImport = '../../contracts/access.ts';
  const compiled = ts.transpileModule(
    source
      .replace(
        guard,
        'await verifySession(apiOrigin, expected, signal, fetcher);',
      )
      .replace(
        sourceImport,
        new URL('../../src/contracts/access.ts', import.meta.url).href,
      ),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const mutant = await import(
    'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
  );
  let epoch = 1,
    release;
  const held = new Promise((r) => (release = r));
  const pending = mutant.verifySessionForView(
    'https://api.inc02.test',
    'A'.repeat(43),
    new AbortController().signal,
    () => assertLocalContext(1, epoch),
    async () => {
      await held;
      return new Response(
        JSON.stringify({
          authenticated: true,
          session_revision: 1,
          csrf_token: 'A'.repeat(43),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  );
  epoch++;
  release();
  // The clean counterpart above rejects; the mutant incorrectly permits adoption.
  await assert.doesNotReject(pending);
});

test('explanation vectors disclose only the four axes, with fixed precedence', () => {
  const vectors = [
    [false, false, 'no', 'no', 'not_implemented'],
    [true, false, 'yes', 'no', 'disabled'],
    [true, true, 'unverified', 'no', 'unverified'],
    [true, true, 'yes', 'unverified', 'unverified'],
    [true, true, 'no', 'no', 'not_authorized'],
    [true, true, 'yes', 'no', 'not_executable'],
    [true, true, 'yes', 'yes', 'available'],
  ];
  for (const [
    implemented,
    enabled,
    authorized,
    executable,
    expected,
  ] of vectors) {
    const axes = { implemented, enabled, authorized, executable };
    assert.equal(
      capabilityExplanation({ ...axes, internalCause: 'missing-investiture' }),
      expected,
    );
    assert.equal(
      capabilityExplanation({ ...axes, internalCause: 'missing-permission' }),
      expected,
    );
  }
});
test('closed capabilities reject hidden rows, private diagnostics and conflicting summaries', () => {
  const response = structuredClone(examples.capabilities[1]);
  assert.ok(validateAccess('capabilities', 'response', response));
  for (const extra of [
    { revealable: false },
    { internal_reason: 'secret' },
    { explanation: 'missing_investiture' },
    { explanation: 'available' },
  ]) {
    assert.equal(
      validateAccess('capabilities', 'response', {
        ...response,
        capabilities: [{ ...response.capabilities[0], ...extra }],
      }),
      false,
    );
  }
  assert.equal(
    validateAccess('capabilities', 'response', {
      ...response,
      hidden_count: 3,
    }),
    false,
  );
});
test('object actions are tied to this view, revision and accepted grant; zero remains valid', () => {
  const v = structuredClone(examples.invitation_view[1]);
  assert.ok(validateAccess('invitation_view', 'response', v));
  const a = {
    action: 'withdraw_invitation',
    target_id: v.invitation_id,
    revision: v.revision,
  };
  assert.ok(
    validateAccess('invitation_view', 'response', {
      ...v,
      available_actions: [a],
    }),
  );
  for (const actions of [
    [{ ...a, target_id: 'foreign' }],
    [{ ...a, revision: 2 }],
    [{ ...a, action: 'impersonate' }],
    [a, a],
  ])
    assert.equal(
      validateAccess('invitation_view', 'response', {
        ...v,
        available_actions: actions,
      }),
      false,
    );
  assert.equal(
    validateAccess('invitation_view', 'response', {
      ...v,
      state: 'accepted',
      available_actions: [a],
    }),
    false,
  );
});
test('a same-account session replacement invalidates pending local lifetimes', () => {
  const life = new ViewLifetime(),
    lease = life.capture();
  life.assert(lease.epoch);
  life.reset();
  assert.equal(lease.signal.aborted, true);
  assert.throws(
    () => life.assert(lease.epoch),
    (e) => e.name === 'AbortError' && !(e instanceof StaleView),
  );
  life.assert(life.capture().epoch);
});
test('display labels cover the closed protocol states without changing them', () => {
  assert.deepEqual(CAPABILITY_STATE_COPY, {
    yes: 'Yes',
    no: 'No',
    unverified: 'Not verified',
  });
});
test('context cancellation during an awaited session observation does not report a changed session', async () => {
  let epoch = 1,
    release;
  const signal = new AbortController().signal;
  const session = {
    authenticated: true,
    session_revision: 1,
    csrf_token: 'A'.repeat(43),
  };
  const response = () =>
    new Response(JSON.stringify(session), {
      headers: { 'content-type': 'application/json' },
    });
  await verifySessionForView(
    'https://api.inc02.test',
    session.csrf_token,
    signal,
    () => assertLocalContext(1, epoch),
    async () => response(),
  );
  const held = new Promise((r) => (release = r));
  const pending = verifySessionForView(
    'https://api.inc02.test',
    session.csrf_token,
    signal,
    () => assertLocalContext(1, epoch),
    async () => {
      await held;
      return response();
    },
  );
  epoch++;
  release();
  await assert.rejects(
    pending,
    (e) => e.name === 'AbortError' && !(e instanceof StaleView),
  );
});
test('session comparison uses the exact session secret, not an account revision', async () => {
  const session = {
    authenticated: true,
    session_revision: 1,
    csrf_token: 'A'.repeat(43),
  };
  const response = (body) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
  const signal = new AbortController().signal;
  await verifySession(
    'https://api.inc02.test',
    'A'.repeat(43),
    signal,
    async () => response(session),
  );
  await assert.rejects(
    verifySession('https://api.inc02.test', 'A'.repeat(43), signal, async () =>
      response({ ...session, csrf_token: 'B'.repeat(43) }),
    ),
    StaleView,
  );
});
test('unconfirmed intention retains exact key, revision, expiry and payload until confirmed', () => {
  const slot = new IntentionSlot(),
    body = { expires_at: 123, grants: [{ permission_id: 'opaque:ä' }] },
    parameters = { invitation_id: 'one' };
  const first = slot.prepare(
    'issue_invitation',
    parameters,
    body,
    () => 'original-key',
  );
  body.expires_at = 456;
  body.grants[0].permission_id = 'changed';
  parameters.invitation_id = 'two';
  assert.deepEqual(first.body, {
    expires_at: 123,
    grants: [{ permission_id: 'opaque:ä' }],
  });
  assert.equal(
    slot.prepare(
      first.route,
      { ...first.parameters },
      { ...first.body },
      () => 'new-key',
    ),
    first,
  );
  assert.throws(
    () => slot.prepare('issue_invitation', parameters, body),
    /unconfirmed/,
  );
  slot.confirm({ ...first });
  assert.equal(slot.current, first);
  slot.confirm(first);
  assert.equal(slot.current, null);
});
test('no successful observation confirms a different pending effect', () => {
  const slot = new IntentionSlot(),
    old = slot.prepare('one', {}, {}, () => 'one');
  slot.clear();
  const fresh = slot.prepare('two', {}, {}, () => 'two');
  slot.confirm(old);
  assert.equal(slot.current, fresh);
});
test('an unconfirmed technical session read is not reported as a changed or unauthenticated session', async () => {
  await assert.rejects(
    verifySession(
      'https://api.inc02.test',
      'A'.repeat(43),
      new AbortController().signal,
      async () =>
        new Response(JSON.stringify(accessProblem('technical_failure')), {
          status: 503,
          headers: { 'content-type': 'application/problem+json' },
        }),
    ),
    (e) => !(e instanceof StaleView) && /could not confirm/.test(e.message),
  );
});
