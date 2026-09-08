import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTrialConfig, assertTrialLaunch, TrialConfigurationError } from '../../src/server/reading/config.ts';
import { contextFromTrial } from '../../src/server/reading/context.ts';
import { handleReadingRequest, parseReadingRequest } from '../../src/server/reading/http.ts';

const enabled = Object.freeze({
  LEDGERDESK_READING_TRIAL: '1',
  LEDGERDESK_READING_ENVIRONMENT: 'local-synthetic',
  LEDGERDESK_READING_SUBJECT: 'synthetic-reader-a',
  LEDGERDESK_READING_GENERATION: 'run-1',
});
const request = (path = '/api/v1/material', headers) => new Request(`http://127.0.0.1${path}`, { headers });

describe('T01 internal trial gate (configuration, not physical DB isolation)', () => {
  it('defaults closed, independent of legacy identity and all supplied authority values', () => {
    for (const flag of [undefined, '', '0']) {
      assert.equal(readTrialConfig({ ...enabled, LEDGERDESK_READING_TRIAL: flag, LEDGERDESK_DEV_IDENTITY: '1' }), null);
    }
    assert.equal(contextFromTrial(null), null);
  });
  it('rejects malformed flags, missing context and incompatible environments without echoing values', () => {
    for (const change of [
      { LEDGERDESK_READING_TRIAL: 'true' },
      { LEDGERDESK_READING_ENVIRONMENT: 'production-secret' },
      { LEDGERDESK_READING_SUBJECT: 'real-user-secret' },
      { LEDGERDESK_READING_GENERATION: '' },
    ]) assert.throws(() => readTrialConfig({ ...enabled, ...change }), TrialConfigurationError);
  });
  it('allows Next production build mode in a declared local synthetic trial, not a real identity', () => {
    const config = readTrialConfig({ ...enabled, NODE_ENV: 'production' });
    assert.equal(config.subjectId, 'synthetic-reader-a');
    assert.equal(contextFromTrial(config).purpose, 'synthetic-reading-trial');
    assert.ok(Object.isFrozen(config));
    assertTrialLaunch(config, ['node', 'next', 'start', '--hostname', '127.0.0.1']);
    for (const args of [[], ['-H', '0.0.0.0'], ['-H', 'localhost'], ['-H', '127.0.0.1', '-H', '0.0.0.0']]) {
      assert.throws(() => assertTrialLaunch(config, args), TrialConfigurationError);
    }
    assertTrialLaunch(null, []);
  });
});

describe('T01/T02 HTTP preparation, deliberately no successful material service', () => {
  it('returns identical private no-store 403 for absent context and malicious legacy/browser authority', async () => {
    const baseline = await handleReadingRequest(request(), {});
    const expected = await baseline.text();
    assert.equal(baseline.status, 403);
    for (const path of ['/api/v1/material', '/api/v1/material/missing/versions/missing']) {
      const response = await handleReadingRequest(request(path, {
        cookie: 'ld_dev_user=synthetic-reader-a', host: 'trusted.internal',
        authorization: 'Bearer invented', 'x-subject': 'synthetic-reader-a', 'x-role': 'owner',
      }), { LEDGERDESK_DEV_IDENTITY: '1' });
      assert.equal(response.status, 403);
      assert.equal(await response.text(), expected);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-type'), 'application/problem+json');
      assert.equal(response.headers.get('etag'), null);
    }
  });
  it('validates public form before resolving context, without silently accepting extra fields', async () => {
    for (const path of [
      '/api/v1/material?subject=synthetic-reader-a', '/api/v1/material?',
      '/api/v1/material/u/versions/v?role=owner', '/api/v1/material/%ZZ/versions/v',
      '/api/v1/material/u/versions/', '/api/v1/material/u/versions/v/extra',
      '/api/v1/material/' + 'x'.repeat(129) + '/versions/v',
    ]) assert.equal((await handleReadingRequest(request(path), {})).status, 400, path);
    const post = new Request('http://127.0.0.1/api/v1/material', { method: 'POST', body: '{}' });
    assert.equal((await handleReadingRequest(post, enabled)).status, 400);
    assert.equal((await handleReadingRequest(request('/api/v1/material', { 'content-length': '1' }), enabled)).status, 400);
  });
  it('preserves opaque decoded IDs exactly rather than normalizing or interpreting them as paths', () => {
    assert.deepEqual(parseReadingRequest(request('/api/v1/material/a%2Fb/versions/e%CC%81')), {
      kind: 'exact', reference: { unit_id: 'a/b', version_id: 'e\u0301' },
    });
  });
  it('reports 503 rather than fake success when configured but the T04 implementation is absent', async () => {
    for (const path of ['/api/v1/material', '/api/v1/material/u/versions/v']) {
      const response = await handleReadingRequest(request(path), enabled);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        type: 'about:blank', title: 'Technical failure', status: 503, code: 'TECHNICAL_FAILURE',
      });
    }
  });
  it('fails closed on incompatible runtime configuration, with no internal cause in the problem', async () => {
    const response = await handleReadingRequest(request(), { ...enabled, LEDGERDESK_READING_ENVIRONMENT: 'secret-invalid' });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('secret'));
  });
  it('ignores forged legacy credentials with the trial enabled on both reading routes', async () => {
    const env = { ...enabled, LEDGERDESK_DEV_IDENTITY: '1' };
    for (const path of ['/api/v1/material', '/api/v1/material/u/versions/v']) {
      const baseline = await handleReadingRequest(request(path), env);
      const forged = await handleReadingRequest(request(path, {
        cookie: 'ld_dev_user=11111111-1111-4111-8111-111111111111', host: 'trusted.internal',
        authorization: 'Bearer invented', 'x-subject': 'synthetic-other', 'x-role': 'owner',
      }), env);
      assert.equal(baseline.status, 503);
      assert.equal(forged.status, baseline.status);
      assert.equal(await forged.text(), await baseline.text());
      assert.deepEqual([...forged.headers], [...baseline.headers]);
    }
  });
  it('rejects HEAD before resolving context', async () => {
    const head = new Request('http://127.0.0.1/api/v1/material', { method: 'HEAD' });
    assert.equal(parseReadingRequest(head), null);
    const response = await handleReadingRequest(head, enabled);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'REQUEST_NOT_ADMITTED');
  });
  it('rejects transfer-encoding even when no request body is supplied', async () => {
    const transfer = request('/api/v1/material', { 'transfer-encoding': 'chunked' });
    assert.equal(transfer.body, null);
    assert.equal(parseReadingRequest(transfer), null);
    const response = await handleReadingRequest(transfer, enabled);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'REQUEST_NOT_ADMITTED');
  });
  it('does not accept the source-profile route as a silent English-profile alias', () => {
    assert.equal(parseReadingRequest(request('/api/v1/material/u/versiones/v')), null);
  });
});
