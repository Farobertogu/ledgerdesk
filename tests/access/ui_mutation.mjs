import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const UI_MUTATIONS = {
  'retain-login-notice-after-logout': [
    'AccessPanel.tsx',
    "await call('logout');\n                      setUnconfirmedLogin(false);",
    "await call('logout');",
  ],
  'clear-login-notice-on-refresh': [
    'AccessPanel.tsx',
    'if (sessionToken.current && sessionToken.current !== s.csrf_token)',
    'if (true)',
  ],
  'retain-login-notice-on-replacement': [
    'AccessPanel.tsx',
    'if (sessionToken.current && sessionToken.current !== s.csrf_token)',
    'if (false)',
  ],
  'retain-login-notice-without-session': [
    'AccessPanel.tsx',
    "if ((e as { code?: string }).code === 'unauthenticated') {\n        setUnconfirmedLogin(false);",
    "if ((e as { code?: string }).code === 'unauthenticated') {",
  ],
  'retain-login-notice-on-session-change': [
    'AccessPanel.tsx',
    'function sessionChanged() {\n    setUnconfirmedLogin(false);',
    'function sessionChanged() {',
  ],
  'drop-census-session-adoption': [
    'PeoplePanel.tsx',
    'await verifySession(apiOrigin, sessionToken, signal);\n      lifetime.current.assert(lease.epoch);',
    '// Deliberately omit the post-response observation.',
  ],
  'ignore-invitation-offers': [
    'InvitationPanel.tsx',
    'view?.available_actions.some((a) => a.action === action) ?? false',
    'true',
  ],
  'retain-provisional-login': [
    'AccessPanel.tsx',
    "pending.current?.route === 'login'",
    'false',
  ],
};

// Build-time mutations run only inside the disposable test image, before Next compiles.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.env.ACCESS_UI_MUTATION || '';
  assert.equal(process.cwd(), '/work');
  assert.equal(process.env.LEDGERDESK_ACCESS_CONTAINER, '1');
  if (name) {
    assert.ok(Object.hasOwn(UI_MUTATIONS, name), 'Unknown UI mutation');
    const [file, from, to] = UI_MUTATIONS[name];
    const target = '/work/src/components/access/' + file;
    const source = readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(
      source.split(from).length - 1,
      1,
      'UI mutation must match exactly once',
    );
    writeFileSync(target, source.replace(from, to));
  }
  writeFileSync(
    '/work/tests/access/runtime-ui/mutation.json',
    JSON.stringify({ name }),
  );
}
