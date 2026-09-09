import { timingSafeEqual } from 'node:crypto';
import { CSRF_HEADER, SESSION_COOKIE, type SessionTransport } from '../../contracts/access_transport.ts';

const preflightMethods = 'POST';
const preflightRequestHeaders = ['content-type', CSRF_HEADER, 'x-ledgerdesk-intent'] as const;

export type Envelope = Readonly<{
  method: string;
  host?: string;
  origin?: string;
  cookie?: string;
  csrf?: string;
  contentType?: string;
  requestedMethod?: string;
  requestedHeaders?: string;
}>;

export function tokenMatches(value: unknown, expected: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    /^[A-Za-z0-9_-]{43}$/.test(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export function sessionToken(cookie: string | undefined): string | null {
  if (!cookie || cookie.length > 4096) return null;
  const found = cookie.split(';').map((pair) => pair.trim())
    .filter((pair) => pair.split('=', 1)[0] === SESSION_COOKIE);
  if (found.length !== 1) return null;
  const token = found[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function sessionSetCookie(token: string, maxAgeSeconds: number): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !Number.isSafeInteger(maxAgeSeconds) ||
      maxAgeSeconds < 1 || maxAgeSeconds > 86400) throw new Error('INVALID_SESSION_COOKIE');
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/** Transport admission, not authentication, authorization or evidence of an effect. */
export function transportEnvelope(config: SessionTransport, request: Envelope): boolean {
  if (request.host !== new URL(config.terminalOrigin).host || request.origin !== config.uiOrigin) return false;
  if (request.method === 'GET') return true;
  if (request.method === 'POST') return request.contentType === 'application/json';
  if (request.method !== 'OPTIONS' || request.requestedMethod !== preflightMethods) return false;
  const headers = (request.requestedHeaders ?? '').toLowerCase().split(',').map((s) => s.trim()).sort();
  return headers.join(',') === preflightRequestHeaders.slice(0, 2).sort().join(',') ||
    headers.join(',') === [...preflightRequestHeaders].sort().join(',');
}

export function csrfMatches(request: Envelope, expected: string): boolean {
  return request.method === 'POST' && tokenMatches(request.csrf, expected);
}

export function corsHeaders(config: SessionTransport): Record<string, string> {
  return {
    'access-control-allow-origin': config.uiOrigin,
    'access-control-allow-credentials': 'true',
    'vary': 'Origin', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  };
}

/** A cached preflight never replaces admission and CSRF checks on the actual request. */
export function preflightHeaders(config: SessionTransport): Record<string, string> {
  return {
    ...corsHeaders(config),
    'access-control-allow-methods': preflightMethods,
    'access-control-allow-headers': preflightRequestHeaders.join(', '),
    'access-control-max-age': '60',
  };
}
