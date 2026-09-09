/** Separate transport profile; it does not change reading/1 or authorize an act. */
export const SESSION_TRANSPORT = 'session/1' as const;
export const SESSION_COOKIE = '__Host-ledgerdesk-session' as const;
export const CSRF_HEADER = 'x-ledgerdesk-csrf' as const;

export type SessionTransport = Readonly<{
  profile: typeof SESSION_TRANSPORT;
  uiOrigin: string;
  terminalOrigin: string;
}>;

function trialOrigin(value: unknown, hostname: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname &&
      Number(url.port) >= 1024 && Number(url.port) <= 65535 &&
      value === `https://${hostname}:${Number(url.port)}`;
  } catch { return false; }
}

/** Trusted configuration only. No query, cookie, request body or fallback selects it. */
export function sessionTransport(input: unknown): SessionTransport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_TRANSPORT');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'profile,terminalOrigin,uiOrigin' ||
      value.profile !== SESSION_TRANSPORT ||
      !trialOrigin(value.uiOrigin, 'ui.inc02.test') ||
      !trialOrigin(value.terminalOrigin, 'api.inc02.test')) throw new Error('INVALID_TRANSPORT');
  return Object.freeze({ profile: SESSION_TRANSPORT, uiOrigin: value.uiOrigin, terminalOrigin: value.terminalOrigin });
}

export function sessionRequest(method: 'GET' | 'POST', csrf?: string): RequestInit {
  if (method !== 'GET' && method !== 'POST') throw new Error('INVALID_METHOD');
  if (method === 'POST' && !/^[A-Za-z0-9_-]{43}$/.test(csrf ?? '')) throw new Error('INVALID_CSRF');
  return {
    method, credentials: 'include', cache: 'no-store', redirect: 'error',
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json', [CSRF_HEADER]: csrf! }, body: '{}' } : {}),
  };
}
