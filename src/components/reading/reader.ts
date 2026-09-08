import {
  consumeProblem, validateListResponse, validateDetailResponse,
  type ListResponse, type Projection, type Reference,
} from '../../contracts/material_reading.ts';

export type Failure = 'unavailable' | 'unauthenticated' | 'technical' | 'invalid';
export type ReaderState = Readonly<{
  list: ListResponse | null;
  phase: 'loading' | 'ready' | 'error' | 'paused';
  selected: Reference | null;
  detail: Projection | null;
  detailPhase: 'idle' | 'loading' | 'ready';
  failure: Failure | null;
}>;
const initial: ReaderState = {
  list: null, phase: 'paused', selected: null, detail: null,
  detailPhase: 'idle', failure: null,
};
export const sameReference = (a: Reference, b: Reference) =>
  a.unit_id === b.unit_id && a.version_id === b.version_id;

class ReadFailure extends Error {
  readonly reason: Failure;
  constructor(reason: Failure) { super(reason); this.reason = reason; }
}

/** In-memory view state only. Request ordering does not establish delivery authority. */
export class Reader {
  private state: ReaderState = initial;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private detailSequence = 0;
  private listAbort?: AbortController;
  private detailAbort?: AbortController;
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = (input, init) => fetch(input, init)) { this.request = request; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: ReaderState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  pause = () => {
    this.epoch++;
    this.detailSequence++;
    this.listAbort?.abort();
    this.detailAbort?.abort();
    this.publish(initial);
  };
  private fail(error: unknown) {
    this.pause();
    this.publish({ ...initial, phase: 'error',
      failure: error instanceof ReadFailure ? error.reason : 'technical' });
  }
  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(url, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    });
    const media = response.headers.get('content-type')?.split(';')[0].trim();
    if (media !== 'application/json' && media !== 'application/problem+json') throw new ReadFailure('invalid');
    const body: unknown = await response.json();
    if (response.status !== 200) {
      if (media !== 'application/problem+json') throw new ReadFailure('invalid');
      const problem = consumeProblem(body, response.status);
      if (!problem.ok) throw new ReadFailure('invalid');
      throw new ReadFailure(problem.value.status === 403 ? 'unauthenticated'
        : problem.value.status === 404 ? 'unavailable'
        : problem.value.status === 400 ? 'invalid' : 'technical');
    }
    if (media !== 'application/json'
      || !response.headers.get('cache-control')?.split(',').some(v => v.trim().toLowerCase() === 'no-store')) {
      throw new ReadFailure('invalid');
    }
    return body;
  }
  reload = async () => {
    this.pause();
    const epoch = this.epoch;
    const abort = this.listAbort = new AbortController();
    this.publish({ ...initial, phase: 'loading' });
    try {
      const result = validateListResponse(await this.json('/api/v1/material', abort.signal));
      if (epoch !== this.epoch) return;
      if (!result.ok) throw new ReadFailure('invalid');
      const keys = result.value.items.map(item => JSON.stringify([item.reference.unit_id, item.reference.version_id]));
      if (new Set(keys).size !== keys.length) throw new ReadFailure('invalid');
      this.publish({ ...initial, phase: 'ready', list: result.value });
    } catch (error) { if (epoch === this.epoch) this.fail(error); }
  };
  back = () => {
    this.detailSequence++;
    this.detailAbort?.abort();
    this.publish({ ...this.state, selected: null, detail: null, detailPhase: 'idle' });
  };
  select = async (reference: Reference) => {
    if (!this.state.list?.items.some(item => sameReference(reference, item.reference))) return;
    this.detailAbort?.abort();
    const sequence = ++this.detailSequence;
    const epoch = this.epoch;
    const abort = this.detailAbort = new AbortController();
    this.publish({ ...this.state, selected: reference, detail: null, detailPhase: 'loading' });
    try {
      const path = `/api/v1/material/${encodeURIComponent(reference.unit_id)}/versions/${encodeURIComponent(reference.version_id)}`;
      const result = validateDetailResponse(await this.json(path, abort.signal));
      if (epoch !== this.epoch || sequence !== this.detailSequence) return;
      if (!result.ok || !sameReference(result.value.projection.reference, reference)) throw new ReadFailure('invalid');
      this.publish({ ...this.state, detail: result.value.projection, detailPhase: 'ready' });
    } catch (error) {
      if (epoch === this.epoch && sequence === this.detailSequence) this.fail(error);
    }
  };
}
