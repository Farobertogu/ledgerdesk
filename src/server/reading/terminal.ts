import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { PROBLEMS } from '../../contracts/material_reading.ts';
import { readLoopbackOrigin } from '../../contracts/reading_origin.ts';
import type { ReadingOutcome, TransportObservation } from '../kb/reading.ts';
import { parseReadingRequest } from './http.ts';
import { contextFromTrial } from './context.ts';
import { readTrialConfig } from './config.ts';
import type { CommittedReading, ReadingPersistencePort } from './persistence.ts';

/** A test observer can pause exact stages; it is constructor-only, not an HTTP or env feature. */
export type TerminalObserver = (event: 'admitted' | 'committed' | 'before-clock' | 'after-clock'
  | 'handoff' | 'finished' | 'interrupted' | 'released', prepared?: CommittedReading) => void | Promise<void>;

async function send(res: ServerResponse, outcome: ReadingOutcome): Promise<TransportObservation> {
  if (res.destroyed) return { outcome: 'interrupted', observedBytes: null };
  const status = 'status' in outcome ? outcome.status : 200;
  const body = Buffer.from(JSON.stringify(outcome));
  res.sendDate = false;
  res.statusCode = status;
  res.setHeader('Content-Type', status === 200 ? 'application/json' : 'application/problem+json');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', body.length);
  // No compression, application streaming, keepalive cache, intermediary or ETag in this trial.
  res.setHeader('Connection', 'close');
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: TransportObservation['outcome']) => {
      if (done) return; done = true; clearTimeout(timer);
      res.off('finish', onFinish); res.off('close', onClose); res.off('error', onClose);
      // Node finish does not prove human receipt; body bytes actually received are client evidence.
      resolve({ outcome, observedBytes: null });
    };
    const onFinish = () => finish('finished');
    const onClose = () => finish('interrupted');
    const timer = setTimeout(() => { res.destroy(); finish('uncertain'); }, 3000);
    res.once('finish', onFinish); res.once('close', onClose); res.once('error', onClose);
    try { res.end(body); } catch { res.destroy(); finish('uncertain'); }
  });
}

/** Standalone HTTP realization of T04. Next's Response-based endpoints remain fail-closed.
 * T05 must compose the viewer with this owner; proxying an already-authorized body would not
 * automatically extend admission over the proxy's later handoff.
 */
export async function startReadingTerminal(options: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  createStore: (onLoss: () => void) => ReadingPersistencePort;
  port?: number;
  observer?: TerminalObserver;
}>) {
  const configuredOrigin = options.env.LEDGERDESK_READING_UI_ORIGIN;
  const uiOrigin = readLoopbackOrigin(configuredOrigin);
  if (configuredOrigin !== undefined && !uiOrigin) throw new Error('Invalid reading UI origin');
  const context = contextFromTrial(readTrialConfig(options.env));
  const activeResponses = new Set<ServerResponse>();
  const observe = options.observer ?? (() => undefined);
  const store = context ? options.createStore(() => {
    for (const res of activeResponses) res.destroy();
  }) : null;
  if (store) {
    try { await store.connect(); } catch { await store.close(); throw new Error('Reading terminal unavailable'); }
  }
  let queue: Promise<unknown> = Promise.resolve();
  let stopping = false;
  const server = createServer((req, res) => {
    activeResponses.add(res); res.once('close', () => activeResponses.delete(res));
    // CORS permits this browser to read a response; it never creates reading authority.
    // Non-browser trial clients still require the same server-owned synthetic context.
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!uiOrigin || origin !== uiOrigin) { void send(res, PROBLEMS[403]); return; }
      res.setHeader('Access-Control-Allow-Origin', uiOrigin);
    }
    let request: Request;
    try {
      // Host never controls destination, authority or route interpretation.
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid request target');
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (value) headers.set(name, value.join(','));
      }
      request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers });
    } catch { void send(res, PROBLEMS[400]); return; }
    const operation = parseReadingRequest(request);
    if (!operation) { void send(res, PROBLEMS[400]); return; }
    if (!context || !store) { void send(res, PROBLEMS[403]); return; }
    if (stopping) { void send(res, PROBLEMS[503]); return; }
    const task = async () => {
      let prepared: CommittedReading | undefined;
      let responseStatus: number | null = null;
      let transport: TransportObservation = { outcome: 'uncertain', observedBytes: null };
      try {
        if (res.destroyed || stopping) return;
        await store.acquire(); await observe('admitted');
        prepared = await store.prepare(context, operation); await observe('committed', prepared);
        await observe('before-clock', prepared);
        if (prepared.earliestExpiry !== null && Date.now() >= prepared.earliestExpiry) {
          // Expired local permission is re-projected, not leaked as a special 503 for that ID.
          // This abandoned preparation transferred no bytes; the current preparation has its own receipt.
          await store.observe(prepared.receiptId, { outcome: 'interrupted', observedBytes: 0 }, null);
          prepared = undefined;
          prepared = await store.prepare(context, operation);
        }
        await observe('after-clock', prepared);
        // This check contains observed control loss. It is not physical fencing under every pause.
        if (!store.available()) throw new Error('Control unavailable');
        await observe('handoff', prepared);
        const outcome = prepared.response;
        transport = await send(res, outcome);
        responseStatus = res.headersSent ? ('status' in outcome ? outcome.status : 200) : null;
        await observe(transport.outcome === 'finished' ? 'finished' : 'interrupted', prepared);
      } catch {
        if (!res.headersSent && !res.destroyed) {
          transport = await send(res, PROBLEMS[503]); responseStatus = res.headersSent ? 503 : null;
        }
        else res.destroy();
      } finally {
        if (prepared) {
          try { await store.observe(prepared.receiptId, transport, responseStatus); }
          catch {
            // Existing durable intent stays uncertain. Do not invent success or silently reuse a broken store.
            stopping = true;
          }
        }
        await store.release(); await observe('released', prepared);
      }
    };
    queue = queue.then(task, task).catch(() => { stopping = true; res.destroy(); });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: options.port ?? 0, exclusive: true }, () => {
        server.off('error', reject); resolve();
      });
    });
  } catch { await store?.close(); throw new Error('Reading terminal unavailable'); }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Reading binding unavailable');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async idle() { await queue; },
    async close() {
      stopping = true;
      for (const res of activeResponses) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue; await store?.close();
    },
  };
}
