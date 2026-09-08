import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';

/** Directed assertions against this server's configuration, not a general leak detector. */
export function assertNoTrialData(html, config) {
  assert.ok(config, 'The HTML guard requires an enabled trial configuration');
  const tokens = { ...Object.fromEntries(
    ['subjectId', 'generation', 'deploymentId', 'scopeId'].map(key => [key, config[key]])),
    materialField: 'original_text' };
  for (const [label, token] of Object.entries(tokens)) {
    assert.equal(typeof token, 'string', `Missing HTML guard input: ${label}`);
    assert.ok(token.length > 0, `Empty HTML guard input: ${label}`);
    // Literal matching avoids treating configuration values as regular expressions.
    assert.ok(!html.includes(token), `Initial HTML contains a forbidden trial field: ${label}`);
  }
}

/** Detect changed/missing build identity at checkpoints; this does not lock build artifacts. */
export async function captureBuildIdentity(path) {
  async function identity() {
    const [id, info] = await Promise.all([readFile(path, 'utf8'), stat(path, { bigint: true })]);
    assert.ok(id.trim(), 'Build identity is empty; complete a build before testing');
    return { id, modified: info.mtimeNs, size: info.size };
  }
  const initial = await identity();
  return async (checkpoint) => {
    assert.deepEqual(await identity(), initial, `Build identity changed during HTTP checks: ${checkpoint}`);
  };
}

/** The child must still bind this exact port itself; never attach to an existing service. */
export async function reserveLoopbackPort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return {
    port: server.address().port,
    release: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

/** Diagnostic labels correlate a hit with a stage; they do not identify the caller's PID. */
export async function startDatabaseTrap(getStage, report = hit => console.error(JSON.stringify(hit))) {
  const hits = [];
  const server = createServer(socket => {
    const hit = Object.freeze({ event: 'legacy_database_trap', timestamp: new Date().toISOString(),
      remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, stage: getStage() });
    hits.push(hit);
    socket.destroy();
    report(hit);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  return {
    port: server.address().port,
    assertUntouched: () => assert.equal(hits.length, 0, `Legacy database trap received connections: ${JSON.stringify(hits)}`),
    count: () => hits.length,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
