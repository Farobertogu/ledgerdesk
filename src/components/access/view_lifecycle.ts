import {
  validateAccess,
  validateAccessProblem,
} from '../../contracts/access.ts';

export class StaleView extends Error {
  constructor() {
    super('The session changed. Refresh the session before continuing.');
  }
}
/** Abandoned local work is cancellation, not evidence of a different session. */
export function assertLocalContext(expected: number, current: number) {
  if (expected !== current)
    throw new DOMException('Context changed', 'AbortError');
}
/** A local lifetime is distinct from account identity and account revision. */
export class ViewLifetime {
  epoch = 0;
  controller = new AbortController();
  capture() {
    return { epoch: this.epoch, signal: this.controller.signal };
  }
  assert(epoch: number) {
    assertLocalContext(epoch, this.epoch);
    if (this.controller.signal.aborted)
      throw new DOMException('Context changed', 'AbortError');
  }
  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.epoch++;
  }
}
/** A read result is not adopted after an observed replacement of the exact session. */
export async function verifySession(
  apiOrigin: string,
  expected: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (!expected) return;
  const response = await fetcher(apiOrigin + '/api/access/v1/session', {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  const raw = await response.text();
  if (raw.length > 32768) throw new Error('Invalid session response.');
  const body = JSON.parse(raw);
  if (!response.ok) {
    if (
      !validateAccessProblem(
        body,
        response.status,
        response.headers.get('content-type') ?? '',
      )
    )
      throw new Error('Invalid session response.');
    if (body.code === 'unauthenticated') throw new StaleView();
    throw new Error(
      'The service could not confirm the current session. Try again.',
    );
  }
  if (
    response.headers.get('content-type')?.split(';')[0] !== 'application/json'
  )
    throw new Error('Invalid session response.');
  if (!validateAccess('current_session', 'response', body))
    throw new Error('Invalid session response.');
  if (body.csrf_token !== expected) throw new StaleView();
}

/** The local context can change while the exact-session observation is in flight. */
export async function verifySessionForView(
  apiOrigin: string,
  expected: string,
  signal: AbortSignal,
  assertContext: () => void,
  fetcher: typeof fetch = fetch,
) {
  assertContext();
  await verifySession(apiOrigin, expected, signal, fetcher);
  assertContext();
}

export type FrozenRequest = Readonly<{
  route: string;
  parameters: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
  key: string;
  signature: string;
}>;
/** In-memory only. An uncertain effect must not silently turn into a new intention. */
export class IntentionSlot {
  current: FrozenRequest | null = null;
  prepare(
    route: string,
    parameters: Record<string, string>,
    body: Record<string, unknown>,
    key = () => crypto.randomUUID(),
  ) {
    const signature = JSON.stringify([route, parameters, body]);
    if (this.current && this.current.signature !== signature)
      throw Error(
        'An earlier result is unconfirmed. Retry its exact request before changing the operation.',
      );
    if (!this.current)
      this.current = Object.freeze({
        route,
        parameters: structuredClone(parameters),
        body: structuredClone(body),
        key: key(),
        signature,
      });
    return this.current;
  }
  confirm(request: FrozenRequest) {
    if (this.current === request) this.current = null;
  }
  clear() {
    this.current = null;
  }
}
