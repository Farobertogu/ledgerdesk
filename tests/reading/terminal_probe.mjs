// Test-only viability probe. Its control commits are simulated in memory.
// The observable handoff is ServerResponse.write, NOT kernel delivery, Next,
// a proxy, PostgreSQL durability, or a guarantee of physical expiry/fencing.
import http from 'node:http';
import { performance } from 'node:perf_hooks';

export const PROBE_MARKER = 'T01_SYNTHETIC_ONLY_á_e\u0301\r\n';

export function latch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, release: resolve };
}

class Admission {
  tail = Promise.resolve();

  async acquire() {
    const previous = this.tail;
    const next = latch();
    this.tail = next.promise;
    await previous;
    let held = true;
    return () => {
      if (held) { held = false; next.release(); }
    };
  }
}

export async function openTerminalProbe() {
  const events = [];
  const handlerErrors = [];
  const admission = new Admission();
  const scenarios = new Map();
  const control = { permitted: true, revision: 0, generation: 1, healthy: true };
  let nextId = 0;

  const record = (type, details = {}) => {
    const event = { sequence: events.length + 1, at: performance.now(), type, ...details };
    events.push(event);
    return event;
  };

  const problem = (response, status, code, title) => {
    response.writeHead(status, {
      'Content-Type': 'application/problem+json',
      'Cache-Control': 'private, no-store',
    });
    response.end(JSON.stringify({ type: 'about:blank', title, status, code }));
  };

  async function serve(request, response) {
    const id = request.url?.split('/').at(-1);
    const scenario = scenarios.get(id);
    scenarios.delete(id);
    if (!scenario) { problem(response, 404, 'UNAVAILABLE', 'Unavailable'); return; }
    let release = () => {};
    try {
      // The scenario and subject are supplied by the test server, not HTTP data.
      if (scenario.enabled === false || scenario.context === false) {
        record('gate_denied', { id });
        problem(response, 403, 'UNAUTHENTICATED', 'Unauthenticated');
        return;
      }
      const prepared = { ...control };
      const generation = scenario.generation ?? prepared.generation;
      record('prepared', { id, revision: prepared.revision });
      await scenario.afterPrepare?.();
      release = await admission.acquire();
      record('admission_acquired', { id });

      // Deliberately unsafe alternatives exist ONLY to test the oracle.
      const decision = scenario.unsafe === 'stale-authorization' ? prepared : { ...control };
      if (!control.healthy || generation !== control.generation) {
        record('control_unavailable', { id });
        problem(response, 503, 'TECHNICAL_FAILURE', 'Technical failure');
        return;
      }
      if (!decision.permitted) {
        record('material_denied', { id, revision: decision.revision });
        problem(response, 404, 'UNAVAILABLE', 'Unavailable');
        return;
      }
      record('control_commit_simulated', { id, revision: decision.revision });
      if (scenario.unsafe === 'release-before-handoff') {
        release();
        record('admission_released_early', { id });
      }
      await scenario.afterCommit?.();
      if (!control.healthy || generation !== control.generation) {
        record('terminal_control_unavailable', { id });
        problem(response, 503, 'TECHNICAL_FAILURE', 'Technical failure');
        return;
      }
      const deadline = scenario.validForMs === undefined
        ? null : performance.now() + scenario.validForMs;
      record('last_temporal_check', { id, deadline });
      // This barrier models a scheduler pause after the last time check. It is
      // deliberately not repaired by another check: that only moves the gap.
      await scenario.afterTemporalCheck?.({ deadline });

      const text = scenario.large ? PROBE_MARKER.padEnd(100000, 'x') : PROBE_MARKER;
      const body = Buffer.from(JSON.stringify({
        contract: 'reading/1',
        projection: {
          kind: 'CONTENT',
          reference: { unit_id: 'synthetic-unit', version_id: 'synthetic-version' },
          metadata: {}, original_language: 'es', original_text: text,
        },
      }), 'utf8');
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      });
      record('handoff_attempt', { id, revision: decision.revision, bytes: body.length, deadline });
      const acceptedWithoutBackpressure = response.write(body);
      record('node_write_returned', {
        id, acceptedWithoutBackpressure, writableLength: response.writableLength,
      });
      response.end();
    } catch (error) {
      handlerErrors.push(error);
      record('handler_error', { id, message: error.message });
      if (!response.headersSent) problem(response, 503, 'TECHNICAL_FAILURE', 'Technical failure');
      else response.destroy(error);
    } finally {
      release();
      record('admission_released', { id });
    }
  }

  const server = http.createServer((request, response) => { void serve(request, response); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  function read(scenario = {}) {
    const id = String(++nextId);
    scenarios.set(id, scenario);
    return new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: `/probe/${id}`, agent: false }, (response) => {
        const chunks = [];
        if (scenario.pauseClient) response.pause();
        record('client_headers', { id, status: response.statusCode });
        response.on('data', (chunk) => {
          chunks.push(chunk);
          record('client_bytes', { id, bytes: chunk.length });
        });
        response.once('end', () => {
          const body = Buffer.concat(chunks);
          record('client_end', { id, bytes: body.length });
          try {
            resolve({ id, status: response.statusCode, headers: response.headers, body, json: JSON.parse(body.toString('utf8')) });
          } catch (error) { reject(error); }
        });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Probe response aborted')));
        scenario.onClientReady?.(() => response.resume());
      });
      request.setTimeout(4000, () => request.destroy(new Error('Local probe deadline exceeded')));
      request.once('error', reject);
    });
  }

  async function invalidate(kind = 'permission') {
    record('invalidation_requested', { kind });
    const release = await admission.acquire();
    try {
      if (kind === 'generation') control.generation += 1;
      else control.permitted = false;
      control.revision += 1;
      record('invalidation_committed_simulated', { kind, revision: control.revision });
    } finally { release(); }
  }

  return {
    events, handlerErrors, read, invalidate,
    loseControl() { control.healthy = false; record('control_connection_lost_simulated'); },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

// Independent trace oracle: authorization claims from the emitter do not count.
// Only the controlled invalidator's committed revision and actual write attempts
// establish the bounded application-level ordering checked by this probe.
export function staleHandoffs(events) {
  return events.filter((event) => event.type === 'handoff_attempt' && events.some((prior) =>
    prior.type === 'invalidation_committed_simulated' && prior.sequence < event.sequence &&
    prior.revision > event.revision));
}
