import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ACCESS_ROUTES,
  accessProblem,
  decodeAccess,
  validateAccess,
  type AccessRoute,
} from '../../contracts/access.ts';
import { SESSION_COOKIE } from '../../contracts/access_transport.ts';
import { accessConfig, type AccessConfig } from './config.ts';
import {
  transportEnvelope,
  corsHeaders,
  preflightHeaders,
  sessionToken,
  sessionSetCookie,
} from './transport.ts';
import {
  AccessService,
  FLOW_COOKIE,
  type LocalMailbox,
  type AccessHooks,
  type AccessOutput,
} from './service.ts';

/** Preserve distinct Set-Cookie fields, including simultaneous deletion/creation. */
export function accessCookieHeaders(
  out: AccessOutput,
  now = Date.now(),
): string[] {
  const cookies: string[] = [];
  if (out.sessionCookie !== undefined)
    cookies.push(
      out.sessionCookie
        ? sessionSetCookie(
            out.sessionCookie,
            Math.max(1, Math.floor((out.credentialExpiresAt! - now) / 1000)),
          )
        : `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
  if (out.flowCookie)
    cookies.push(
      sessionSetCookie(
        out.flowCookie,
        Math.max(1, Math.floor((out.expiresAt! - now) / 1000)),
      ).replace(SESSION_COOKIE, FLOW_COOKIE),
    );
  return cookies;
}

function cookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw || raw.length > 4096) return null;
  const parts = raw
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.split('=', 1)[0] === name);
  if (parts.length !== 1) return null;
  const value = parts[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function singletonHeaders(req: IncomingMessage): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i].toLowerCase();
    if (
      [
        'host',
        'origin',
        'cookie',
        'content-type',
        'content-length',
        'x-ledgerdesk-csrf',
        'x-ledgerdesk-intent',
      ].includes(key)
    ) {
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return !req.headers['transfer-encoding'] && !req.headers['content-encoding'];
}
export async function startAccessTerminal(options: {
  config: AccessConfig;
  tls: ServerOptions;
  mailbox: LocalMailbox;
  hooks?: AccessHooks;
}) {
  const config = accessConfig(options.config);
  const service = new AccessService(config, options.mailbox, options.hooks);
  await service.initialize();
  const running = new Set<Promise<void>>();
  let active = 0;
  const server = createServer(
    { ...options.tls, maxHeaderSize: 8192 },
    (req, res) => {
      const p = handle(req, res).catch(() => {
        if (!res.headersSent)
          respond(res, 503, accessProblem('technical_failure'));
        else res.destroy();
      });
      running.add(p);
      void p.finally(() => running.delete(p));
    },
  );
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  function respond(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | string[]> = {},
  ) {
    if (res.destroyed) return;
    res.sendDate = false;
    res.writeHead(status, {
      ...corsHeaders(config.transport),
      'content-type':
        status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    });
    res.end(body === null ? '' : JSON.stringify(body));
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const envelope = {
      method: req.method ?? '',
      host: req.headers.host,
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
      requestedMethod: req.headers['access-control-request-method'] as
        | string
        | undefined,
      requestedHeaders: req.headers['access-control-request-headers'] as
        | string
        | undefined,
    };
    if (
      !singletonHeaders(req) ||
      !transportEnvelope(config.transport, envelope)
    ) {
      respond(res, 403, accessProblem('forbidden'));
      return;
    }
    const route = (
      Object.entries(ACCESS_ROUTES) as [
        AccessRoute,
        (typeof ACCESS_ROUTES)[AccessRoute],
      ][]
    ).find(([, v]) => v.path === req.url && v.consumer === 'T02')?.[0];
    if (!route) {
      respond(res, 404, accessProblem('unavailable'));
      return;
    }
    if (req.method === 'OPTIONS') {
      respond(res, 204, null, preflightHeaders(config.transport));
      return;
    }
    if (ACCESS_ROUTES[route].method !== req.method) {
      respond(res, 400, accessProblem('invalid_request'));
      return;
    }
    if (active >= 16) {
      respond(res, 503, accessProblem('technical_failure'));
      return;
    }
    active++;
    let release: (() => Promise<void>) | undefined;
    try {
      // Admit the receiver before consuming credential bodies. No SQL transaction while receiving.
      const admitted = await service.receive(route, () => res.destroy());
      release = () => admitted.close();
      const max = config.security.bodyBytes;
      const size = Number(req.headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(size) || size < 0 || size > max) {
        respond(res, 413, accessProblem('payload_too_large'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      req.setTimeout(5000, () => req.destroy());
      for await (const chunk of req) {
        total += chunk.length;
        if (total > max) {
          respond(res, 413, accessProblem('payload_too_large'));
          return;
        }
        chunks.push(chunk);
      }
      let body: Record<string, unknown> = {};
      try {
        if (req.method === 'POST')
          body = decodeAccess(Buffer.concat(chunks)) as Record<string, unknown>;
        else if (total) throw new Error();
      } catch {
        respond(res, 400, accessProblem('invalid_request'));
        return;
      }
      if (!validateAccess(route, 'request', body)) {
        respond(res, 400, accessProblem('invalid_request'));
        return;
      }
      const result = await service.perform(
        {
          route,
          body,
          session: sessionToken(req.headers.cookie),
          flow: cookie(req, FLOW_COOKIE),
          csrf: req.headers['x-ledgerdesk-csrf'] as string | undefined,
          intent: req.headers['x-ledgerdesk-intent'] as string | undefined,
          peer: req.socket.remoteAddress ?? 'unavailable',
        },
        () => res.destroy(),
        admitted,
      );
      release = result.close;
      const out = result.output;
      if (out.expiresAt && Date.now() >= out.expiresAt) {
        respond(res, 503, accessProblem('technical_failure'));
        await result.observe?.('interrupted');
        return;
      }
      const headers: Record<string, string | string[]> = {};
      const cookies = accessCookieHeaders(out);
      if (cookies.length) headers['set-cookie'] = cookies;
      // Admission remains held through this synchronous handoff, not until human receipt.
      respond(res, out.status, out.body, headers);
      await result.observe?.(
        res.destroyed || !res.writableEnded ? 'interrupted' : 'handed_off',
      );
    } finally {
      try {
        await release?.();
      } finally {
        active--;
      }
    }
  }
  const port = Number(new URL(config.transport.terminalOrigin).port);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    service,
    server,
    url: config.transport.terminalOrigin,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await Promise.allSettled(running);
    },
  };
}
