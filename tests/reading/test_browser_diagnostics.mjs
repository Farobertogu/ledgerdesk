import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { observeBrowser } from './browser_diagnostics.mjs';

async function fixture(t) {
  const directory = await mkdtemp(
    join(tmpdir(), 'ledgerdesk-browser-evidence-'),
  );
  t.after(async () => {
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith('ledgerdesk-browser-evidence-'));
    await rm(directory, { recursive: true });
  });
  const page = new EventEmitter();
  page.evaluate = async () => ({ originals: 0, sessionActive: false });
  return {
    directory,
    page,
    observation: observeBrowser(page, directory),
    files: async () =>
      Promise.all(
        (await readdir(directory)).map(async (name) =>
          JSON.parse(await readFile(join(directory, name), 'utf8')),
        ),
      ),
  };
}

test('browser observations persist a failing action without swallowing its error or storing request secrets', async (t) => {
  const f = await fixture(t),
    failure = Error('Directed assertion');
  const request = {
    url: () =>
      'https://example.test/api/access/v1/sessions?secret=must-not-appear',
    method: () => 'POST',
    headers: () => ({ cookie: 'must-not-appear' }),
    postData: () => 'must-not-appear',
  };
  await assert.rejects(
    f.observation.run('J19', async () => {
      f.observation.mark('sign-in');
      f.page.emit('request', request);
      f.page.emit('response', {
        url: request.url,
        request: () => request,
        status: () => 403,
      });
      f.page.emit('request', {
        ...request,
        url: () => 'https://example.test/private-machine-token',
      });
      throw failure;
    }),
    (error) => error === failure,
  );
  const [evidence] = await f.files();
  assert.equal(evidence.passed, false);
  assert.equal(evidence.step, 'sign-in');
  assert.equal(evidence.events.find((e) => e.event === 'response').status, 403);
  assert.ok(evidence.events.some((e) => e.path === '[non-application-path]'));
  assert.equal(
    /must-not-appear|private-machine-token|cookie/.test(
      JSON.stringify(evidence),
    ),
    false,
  );
  f.observation.close();
  assert.equal(f.page.eventNames().length, 0);
});

test('repeated browser observations retain separate files and bounded events', async (t) => {
  const f = await fixture(t);
  await f.observation.run('I03', async () => {
    for (let i = 0; i < 1005; i++) f.observation.mark('bounded');
  });
  await f.observation.run('I03', async () => {});
  const records = await f.files();
  assert.equal(records.length, 2);
  assert.ok(records.every((e) => e.passed));
  assert.ok(records.some((e) => e.events.length === 1000 && e.dropped === 5));
  f.observation.close();
});

test('an unavailable page still preserves the original test failure', async (t) => {
  const f = await fixture(t),
    failure = Error('Original browser failure');
  f.page.evaluate = async () => {
    throw Error('Page closed');
  };
  await assert.rejects(
    f.observation.run('J19', async () => {
      throw failure;
    }),
    (e) => e === failure,
  );
  assert.deepEqual((await f.files())[0].state, { unavailable: true });
  f.observation.close();
});
