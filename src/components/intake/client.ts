import {validateAccess, validateAccessProblem} from '../../contracts/access.ts';
import type {SessionTransport} from '../../contracts/access_transport.ts';
import {scalarText} from '../../contracts/intake.ts';
import {ViewLifetime, StaleView, verifySessionForView} from '../access/view_lifecycle.ts';

export class IntakeRequestFailure extends Error {
  readonly status: number;
  constructor(status: number) {super(status === 404 ? 'This record is unavailable. Its absence does not establish that an earlier effect did not occur.' : `The request was not completed (${status}).`); this.status = status;}
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function capturedTextBytes(value: string): Uint8Array {
  if (!scalarText(value)) throw Error('The text contains an incomplete Unicode character.');
  return new TextEncoder().encode(value);
}
async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel(); throw Error('Response exceeds the admitted size.');
  }
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > maximum) throw Error('Response exceeds the admitted size.');
      chunks.push(next.value);
    }
  } catch (error) {await reader.cancel().catch(() => {}); throw error;}
  finally {reader.releaseLock();}
  if (declared !== null && Number(declared) !== size) throw Error('Incomplete response.');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  return bytes;
}

/** Every protected result uses the same before/after exact-session and local-context guard. */
export class IntakeClient {
  readonly transport: SessionTransport;
  readonly lifetime = new ViewLifetime();
  readonly fetcher: typeof fetch;
  csrf: string | null = null;
  constructor(transport: SessionTransport, fetcher: typeof fetch = fetch) {
    this.transport = transport;
    // Native browser fetch requires its global receiver, not this client instance.
    this.fetcher = fetcher.bind(globalThis);
  }
  suspend() {this.lifetime.reset(); this.csrf = null;}
  async session(): Promise<boolean> {
    const scope = this.lifetime.capture();
    const response = await this.fetcher(this.transport.terminalOrigin + '/api/access/v1/session', {
      credentials: 'include', cache: 'no-store', redirect: 'error', signal: scope.signal,
    });
    const bytes = await boundedBytes(response, 32768);
    const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    this.lifetime.assert(scope.epoch);
    if (!response.ok) {
      if (!validateAccessProblem(body, response.status, response.headers.get('content-type') ?? '')) throw Error('Invalid session response.');
      if (body.code === 'unauthenticated') {this.suspend(); return false;}
      throw Error('The current session could not be confirmed.');
    }
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json' || !validateAccess('current_session', 'response', body))
      throw Error('Invalid session response.');
    if (this.csrf !== null && this.csrf !== body.csrf_token) {this.suspend(); throw new StaleView();}
    this.csrf = body.csrf_token;
    return true;
  }
  async request(options: {
    path: string; method?: 'GET' | 'POST'; accept: string; contentType?: string;
    body?: string | Uint8Array; key?: string; maximum: number;
    assertContext: () => void; validate?: (value: unknown, status: number) => boolean;
  }): Promise<{status: number; value: unknown; bytes: Uint8Array}> {
    if (!this.csrf) throw new StaleView();
    const scope = this.lifetime.capture(), expected = this.csrf;
    const assertContext = () => {this.lifetime.assert(scope.epoch); options.assertContext();};
    await verifySessionForView(this.transport.terminalOrigin, expected, scope.signal, assertContext, this.fetcher);
    const method = options.method ?? 'GET';
    const response = await this.fetcher(this.transport.terminalOrigin + options.path, {
      method, credentials: 'include', cache: 'no-store', redirect: 'error', signal: scope.signal,
      headers: {accept: options.accept, ...(method === 'POST' ? {
        'content-type': options.contentType ?? 'application/json', 'x-ledgerdesk-csrf': expected,
      } : {}), ...(options.key ? {'x-ledgerdesk-intent': options.key} : {})},
      ...(options.body === undefined ? {} : {body: typeof options.body === 'string' ? options.body : options.body.slice().buffer}),
    });
    const bytes = await boundedBytes(response, response.ok ? options.maximum : 32768);
    // Also guard failures: an old error must not clear or replace the current view.
    await verifySessionForView(this.transport.terminalOrigin, expected, scope.signal, assertContext, this.fetcher);
    const mediaType = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok) {
      if (mediaType !== 'application/problem+json') throw Error('Invalid error response.');
      const problem = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (problem?.status !== response.status || problem?.profile !== 'intake/1') throw Error('Invalid error response.');
      throw new IntakeRequestFailure(response.status);
    }
    let value: unknown = bytes;
    if (options.validate) {
      if (mediaType !== options.accept && !(mediaType === 'application/json' && options.accept === 'application/vnd.ledgerdesk.intake.v2+json'))
        throw Error('Unexpected response representation.');
      value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (!options.validate(value, response.status)) throw Error('Invalid response representation.');
    } else if (mediaType !== options.accept) throw Error('Unexpected response representation.');
    assertContext();
    return {status: response.status, value, bytes};
  }
}
