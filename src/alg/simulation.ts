/**
 * The simulation harness: an in-process heap, a seeded stream of arrivals, and a replay.
 *
 * **This is not a production path and must not become one.** The queue an operator sees is served
 * by the database, which keeps the order across restarts and inside transactions. The heap below
 * exists so that two claims can be *measured* rather than asserted: that no ticket waits
 * unboundedly, and that changing the weights changes the queue by a stated amount. Both need ten
 * thousand arrivals replayed at speed, and neither needs a database.
 *
 * Everything here is seeded. There is no `Math.random`, no `Date.now`, and no wall clock anywhere
 * in the module: the same seed replays the same month, on any machine, in any order, forever.
 */

import { createHash } from 'node:crypto';

import type { AccountTier, PriorityWeights, QueueFeatures, QueueKey, Severity, ValueBand } from './priority.ts';
import {
  DEFAULT_PRIORITY_WEIGHTS,
  compareQueueKeys,
  compareStoredRows,
  queueKey,
} from './priority.ts';

/** xoshiro128** seeded from a digest of the seed text. No dependency, same stream everywhere. */
export function makeRng(seedText: string): () => number {
  const h = createHash('sha256').update(seedText, 'utf8').digest();
  let s0 = h.readUInt32BE(0) >>> 0;
  let s1 = h.readUInt32BE(4) >>> 0;
  let s2 = h.readUInt32BE(8) >>> 0;
  let s3 = h.readUInt32BE(12) >>> 0;
  const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;
  return function next(): number {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0) / 4294967296;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };
}

/** A ticket in the replayed world: the queue features plus the window they were derived from. */
export type SimTicket = QueueFeatures & { slaWindowMs: number };

/**
 * The written response policy, in minutes to first response.
 *
 * It is the simulated world's version of the policy table an analyst writes before any code, and
 * the numbers are the harness's own: they exist to give the replay a realistic spread of windows,
 * not to state a commercial commitment.
 */
export type SlaPolicy = Readonly<Record<AccountTier, Readonly<Record<Severity, number>>>>;

export const DEFAULT_SLA_POLICY: SlaPolicy = {
  premium: { 1: 120, 2: 60, 3: 30, 4: 15 },
  standard: { 1: 480, 2: 240, 3: 120, 4: 60 },
};

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** Hour of the UTC day at an epoch instant, without constructing a date or reading a timezone. */
export function utcHourOfDay(epochMs: number): number {
  return Math.floor((((epochMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
}

export type ArrivalOptions = {
  seed: string;
  count: number;
  /** Epoch milliseconds of the first arrival. */
  startAt: number;
  /** Mean inter-arrival time at the busiest hour of the day. */
  peakInterArrivalMs: number;
  /** The UTC hours during which customers are at their keyboards, as `[from, to)`. */
  busyHoursUtc: readonly [number, number];
  /** Arrival intensity outside those hours, as a fraction of the peak. */
  quietIntensity: number;
  /** Share of arrivals belonging to a premium account. */
  premiumShare: number;
  /** Probability of each severity, from 1 to 4. Must sum to 1. */
  severityShares: readonly [number, number, number, number];
  policy: SlaPolicy;
};

/**
 * One replayed month at the load the sensitivity study and the starvation property both use.
 *
 * Arrivals are **bursty on purpose**. A support desk does not receive tickets at a constant rate:
 * customers write during their working day and stop overnight, so a backlog builds through the
 * afternoon and drains before morning. A constant-rate stream would leave two or three tickets
 * waiting at any instant, and a queue that shallow cannot show what changing its ordering does —
 * every configuration would score the same and the study would be a table of ones.
 *
 * The average rate still sits below what the agents can absorb, which is the condition the
 * anti-starvation bound is stated under; the burst is in *when* the work arrives, not in how much.
 */
export const DEFAULT_ARRIVALS: ArrivalOptions = {
  seed: 'ledgerdesk/alg/arrivals/v1',
  count: 10_000,
  startAt: Date.UTC(2026, 0, 1, 0, 0, 0),
  peakInterArrivalMs: 160_000,
  busyHoursUtc: [8, 20],
  quietIntensity: 0.2,
  premiumShare: 0.25,
  severityShares: [0.45, 0.3, 0.18, 0.07],
  policy: DEFAULT_SLA_POLICY,
};

/** The intensity of the arrival process at an instant, as a fraction of the peak rate. */
export function arrivalIntensity(epochMs: number, options: ArrivalOptions): number {
  const hour = utcHourOfDay(epochMs);
  const [from, to] = options.busyHoursUtc;
  const busy = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  return busy ? 1 : options.quietIntensity;
}

function pickSeverity(u: number, shares: readonly [number, number, number, number]): Severity {
  let cumulative = 0;
  const levels: readonly Severity[] = [1, 2, 3, 4];
  for (let i = 0; i < levels.length; i++) {
    cumulative += shares[i] ?? 0;
    if (u < cumulative) return levels[i] as Severity;
  }
  return 4;
}

/** Identifiers are zero-padded so that ordering them as text orders them as numbers. */
export function simTicketId(index: number): string {
  return `T-${String(index).padStart(6, '0')}`;
}

/**
 * A seeded stream of arrivals, sorted by arrival instant by construction.
 *
 * The instants come from a non-homogeneous Poisson process generated by thinning: candidate gaps
 * are drawn at the peak rate and each candidate is kept with the probability of the intensity at
 * its hour. Severities follow the declared shares and sentiment is uniform on [−1,1] at the three
 * decimals the ticket record stores. These distributions are the harness's declared assumptions:
 * they shape how often the queue is contended, and the sensitivity study reports differences
 * *between* weight configurations replayed against the very same stream, so a distribution that is
 * merely plausible does not put those differences in doubt.
 */
export function generateArrivals(options: Partial<ArrivalOptions> = {}): SimTicket[] {
  const config: ArrivalOptions = { ...DEFAULT_ARRIVALS, ...options };
  const shareSum = config.severityShares.reduce((total, share) => total + share, 0);
  if (Math.abs(shareSum - 1) > 1e-9) {
    throw new RangeError(`severity shares must sum to 1, got ${shareSum}`);
  }
  if (config.quietIntensity <= 0 || config.quietIntensity > 1) {
    throw new RangeError(`the quiet intensity must lie in (0,1], got ${config.quietIntensity}`);
  }

  const rng = makeRng(`${config.seed}|${config.count}|${config.peakInterArrivalMs}`);
  const tickets: SimTicket[] = [];
  let cursor = config.startAt;

  for (let index = 1; index <= config.count; index++) {
    // Inverse transform on the exponential at the peak rate, thinned by the intensity of the hour
    // it lands in. `1 - u` keeps the argument of the logarithm off zero.
    for (;;) {
      cursor += Math.max(1, Math.round(-config.peakInterArrivalMs * Math.log(1 - rng())));
      if (rng() < arrivalIntensity(cursor, config)) break;
    }
    const tier: AccountTier = rng() < config.premiumShare ? 'premium' : 'standard';
    const severity = pickSeverity(rng(), config.severityShares);
    const valueBand = (1 + Math.floor(rng() * 5)) as ValueBand;
    const sentiment = Math.round((rng() * 2 - 1) * 1000) / 1000;
    const slaWindowMs = config.policy[tier][severity] * 60 * 1000;

    tickets.push({
      id: simTicketId(index),
      severity,
      sentiment,
      tier,
      valueBand,
      createdAt: cursor,
      slaDueAt: cursor + slaWindowMs,
      now: cursor,
      slaWindowMs,
    });
  }

  return tickets;
}

/** The order key of a ticket evaluated at an instant that is not the one stored on it. */
export function keyAt(
  ticket: SimTicket,
  now: number,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): QueueKey {
  return queueKey({ ...ticket, now }, weights);
}

type HeapEntry = { ticket: SimTicket; key: QueueKey };

export type QueueHeap = {
  push(ticket: SimTicket, now: number): void;
  /** The published lazy revalidation: pop, re-key at `now`, and reinsert if the root moved. */
  popNext(now: number): SimTicket | null;
  /** The published tick: re-key everything and rebuild in linear time. */
  rebuild(now: number): void;
  size(): number;
  peekKey(): QueueKey | null;
  /** Every ticket still queued, in no particular order. For assertions, not for serving. */
  contents(): SimTicket[];
};

/**
 * A binary heap over the order key.
 *
 * The key depends on wall time, so a heap built at one instant is stale at the next. Both published
 * remedies are implemented and both are exercised: `popNext` revalidates the root lazily, one
 * ticket at a time, and `rebuild` re-keys the whole heap and reheapifies bottom-up — which is
 * linear, not linearithmic, and that difference is the reason the sweep can run every thirty
 * seconds without being the thing that limits the queue.
 */
export function makeQueueHeap(weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS): QueueHeap {
  const entries: HeapEntry[] = [];

  const swap = (i: number, j: number): void => {
    const tmp = entries[i] as HeapEntry;
    entries[i] = entries[j] as HeapEntry;
    entries[j] = tmp;
  };

  const siftUp = (start: number): void => {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareQueueKeys((entries[index] as HeapEntry).key, (entries[parent] as HeapEntry).key) < 0) {
        swap(index, parent);
        index = parent;
      } else {
        return;
      }
    }
  };

  const siftDown = (start: number): void => {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (
        left < entries.length &&
        compareQueueKeys((entries[left] as HeapEntry).key, (entries[best] as HeapEntry).key) < 0
      ) {
        best = left;
      }
      if (
        right < entries.length &&
        compareQueueKeys((entries[right] as HeapEntry).key, (entries[best] as HeapEntry).key) < 0
      ) {
        best = right;
      }
      if (best === index) return;
      swap(index, best);
      index = best;
    }
  };

  const popRoot = (): HeapEntry | null => {
    if (entries.length === 0) return null;
    const root = entries[0] as HeapEntry;
    const last = entries.pop() as HeapEntry;
    if (entries.length > 0) {
      entries[0] = last;
      siftDown(0);
    }
    return root;
  };

  const pushEntry = (entry: HeapEntry): void => {
    entries.push(entry);
    siftUp(entries.length - 1);
  };

  return {
    push(ticket, now) {
      pushEntry({ ticket, key: keyAt(ticket, now, weights) });
    },

    popNext(now) {
      // One full pass re-keys every entry at this instant, after which the root is correct by
      // construction. The bound turns a hypothetical non-terminating loop into a loud failure.
      const bound = entries.length * 2 + 2;
      for (let step = 0; step < bound; step++) {
        const candidate = popRoot();
        if (candidate === null) return null;
        const revalidated = keyAt(candidate.ticket, now, weights);
        const next = entries[0];
        if (next === undefined || compareQueueKeys(revalidated, next.key) <= 0) {
          return candidate.ticket;
        }
        pushEntry({ ticket: candidate.ticket, key: revalidated });
      }
      throw new Error('lazy revalidation did not settle: the order key is not stable at a fixed instant');
    },

    rebuild(now) {
      for (const entry of entries) {
        entry.key = keyAt(entry.ticket, now, weights);
      }
      for (let index = (entries.length >> 1) - 1; index >= 0; index--) {
        siftDown(index);
      }
    },

    size() {
      return entries.length;
    },

    peekKey() {
      return entries.length === 0 ? null : (entries[0] as HeapEntry).key;
    },

    contents() {
      return entries.map((entry) => entry.ticket);
    },
  };
}

export type ReplayOptions = {
  arrivals: readonly SimTicket[];
  weights: PriorityWeights;
  /** How many tickets can be in service at once. */
  agents: number;
  /** How long one agent holds one ticket. */
  handleMs: number;
  /** The sweep interval at which keys are recomputed and the queue is re-served. */
  tickMs: number;
  /** When to record the waiting set, or `null` to record none. */
  snapshot: { everyMs: number; offsetMs: number } | null;
};

export const DEFAULT_REPLAY: Omit<ReplayOptions, 'arrivals' | 'weights'> = {
  agents: 4,
  handleMs: 15 * 60 * 1000,
  tickMs: 30 * 1000,
  snapshot: { everyMs: 6 * HOUR_MS, offsetMs: 0 },
};

/** The waiting set at one instant — the queue as an agent would find it on opening the console. */
export type QueueSnapshot = {
  at: number;
  waiting: SimTicket[];
};

export type ServiceRecord = {
  id: string;
  severity: Severity;
  tier: AccountTier;
  createdAt: number;
  slaDueAt: number;
  slaWindowMs: number;
  /** The instant an agent picked the ticket up — first response, in SLA terms. */
  startedAt: number;
  waitMs: number;
  /** True when the pick-up happened after the SLA instant. */
  breachedAtService: boolean;
};

export type ReplayResult = {
  served: ServiceRecord[];
  /** Identifiers still queued when the replay ran out of horizon. Empty in a stable world. */
  unserved: string[];
  order: string[];
  snapshots: QueueSnapshot[];
  breachRate: number;
  maxWaitMs: number;
  p95WaitMs: number;
  peakQueueLength: number;
  ticks: number;
};

/**
 * Replays a month: arrivals enter the heap at their instant, agents take the head as they free up.
 *
 * The loop runs until the last arrival has been served, so `unserved` is empty in any world whose
 * service rate stays above its arrival rate — and non-empty, loudly, in one that does not.
 */
export function replay(options: ReplayOptions): ReplayResult {
  const { arrivals, weights, agents, handleMs, tickMs, snapshot } = options;
  if (agents < 1) throw new RangeError(`the replay needs at least one agent, got ${agents}`);
  if (arrivals.length === 0) {
    return {
      served: [],
      unserved: [],
      order: [],
      snapshots: [],
      breachRate: 0,
      maxWaitMs: 0,
      p95WaitMs: 0,
      peakQueueLength: 0,
      ticks: 0,
    };
  }

  const heap = makeQueueHeap(weights);
  const served: ServiceRecord[] = [];
  const snapshots: QueueSnapshot[] = [];
  const busyUntil: number[] = new Array<number>(agents).fill(Number.NEGATIVE_INFINITY);

  let arrivalIndex = 0;
  let ticks = 0;
  let peakQueueLength = 0;
  // The tick grid is anchored to the epoch rather than to the first arrival, so that a sampling
  // instant such as "every six hours" lands on a tick exactly instead of near one.
  let now = Math.floor((arrivals[0] as SimTicket).createdAt / tickMs) * tickMs;

  // The horizon is generous rather than tight: it is a guard against a non-terminating loop, and a
  // world that needs it has already failed the property the replay exists to measure.
  const horizon =
    (arrivals[arrivals.length - 1] as SimTicket).createdAt + handleMs * arrivals.length + tickMs;

  while ((arrivalIndex < arrivals.length || heap.size() > 0) && now <= horizon) {
    while (arrivalIndex < arrivals.length && (arrivals[arrivalIndex] as SimTicket).createdAt <= now) {
      heap.push(arrivals[arrivalIndex] as SimTicket, now);
      arrivalIndex++;
    }

    if (snapshot !== null && mod(now - snapshot.offsetMs, snapshot.everyMs) === 0) {
      snapshots.push({ at: now, waiting: heap.contents() });
    }
    if (heap.size() > peakQueueLength) peakQueueLength = heap.size();

    if (heap.size() > 0) {
      heap.rebuild(now);
      for (let agent = 0; agent < agents && heap.size() > 0; agent++) {
        if ((busyUntil[agent] as number) > now) continue;
        const ticket = heap.popNext(now);
        if (ticket === null) break;
        busyUntil[agent] = now + handleMs;
        served.push({
          id: ticket.id,
          severity: ticket.severity,
          tier: ticket.tier,
          createdAt: ticket.createdAt,
          slaDueAt: ticket.slaDueAt,
          slaWindowMs: ticket.slaWindowMs,
          startedAt: now,
          waitMs: now - ticket.createdAt,
          breachedAtService: now > ticket.slaDueAt,
        });
      }
    }

    ticks++;
    now += tickMs;
  }

  const unserved = heap.contents().map((ticket) => ticket.id);
  const waits = served.map((record) => record.waitMs).sort((a, b) => a - b);
  const breaches = served.filter((record) => record.breachedAtService).length;

  return {
    served,
    unserved,
    order: served.map((record) => record.id),
    snapshots,
    breachRate: served.length === 0 ? 0 : breaches / served.length,
    maxWaitMs: waits.length === 0 ? 0 : (waits[waits.length - 1] as number),
    p95WaitMs: percentile(waits, 0.95),
    peakQueueLength,
    ticks,
  };
}

/** Remainder that stays non-negative for negative operands, unlike `%`. */
function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** The snapshot ordered under a weight configuration — the queue an agent would have been shown. */
export function rankSnapshot(
  snapshot: QueueSnapshot,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): string[] {
  return snapshot.waiting
    .map((ticket) => ({ id: ticket.id, key: keyAt(ticket, snapshot.at, weights) }))
    .sort((a, b) => compareQueueKeys(a.key, b.key))
    .map((row) => row.id);
}

/** Nearest-rank percentile over an already sorted array. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

/**
 * Kendall's τ between two orderings of the same identifiers, in `O(n log n)`.
 *
 * Both orders are total, so no pair is tied and τ-a and τ-b coincide: the coefficient is one minus
 * twice the share of pairs the second order swapped. 1 means the two queues are the same queue;
 * 0 means knowing one tells you nothing about the other; −1 means one is the other reversed.
 */
export function kendallTau(baseline: readonly string[], candidate: readonly string[]): number {
  if (baseline.length !== candidate.length) {
    throw new RangeError('Kendall τ needs two orderings of the same length');
  }
  const n = baseline.length;
  if (n < 2) return 1;

  const rank = new Map<string, number>();
  baseline.forEach((id, index) => rank.set(id, index));

  const ranks = candidate.map((id) => {
    const value = rank.get(id);
    if (value === undefined) throw new RangeError(`'${id}' is not in the baseline ordering`);
    return value;
  });

  const inversions = countInversions(ranks);
  return 1 - (4 * inversions) / (n * (n - 1));
}

function countInversions(values: readonly number[]): number {
  const buffer = new Array<number>(values.length);
  const work = values.slice();

  const sort = (low: number, high: number): number => {
    if (high - low < 2) return 0;
    const mid = (low + high) >> 1;
    let count = sort(low, mid) + sort(mid, high);
    let i = low;
    let j = mid;
    let k = low;
    while (i < mid && j < high) {
      if ((work[i] as number) <= (work[j] as number)) {
        buffer[k++] = work[i++] as number;
      } else {
        count += mid - i;
        buffer[k++] = work[j++] as number;
      }
    }
    while (i < mid) buffer[k++] = work[i++] as number;
    while (j < high) buffer[k++] = work[j++] as number;
    for (let index = low; index < high; index++) work[index] = buffer[index] as number;
    return count;
  };

  return sort(0, work.length);
}

/**
 * How much of the first page the two orders agree on.
 *
 * τ answers "how differently does the whole queue read"; this answers "how much of what an agent
 * will actually see today has changed", which is the difference an operator notices.
 */
export function topKOverlap(baseline: readonly string[], candidate: readonly string[], k: number): number {
  const head = new Set(baseline.slice(0, k));
  if (head.size === 0) return 1;
  const shared = candidate.slice(0, k).filter((id) => head.has(id)).length;
  return shared / head.size;
}

/**
 * The queue as a sorted column yields it, for the same tickets at the same instant.
 *
 * The comparison this enables is the point: the heap order and this order are two independent
 * readings of one key, and a test that holds them against each other catches the day someone
 * changes one of the two.
 */
export function storedOrder(
  tickets: readonly SimTicket[],
  now: number,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): string[] {
  return tickets
    .map((ticket) => ({ id: ticket.id, key: keyAt(ticket, now, weights) }))
    .sort((a, b) => compareStoredRows(a.key, b.key))
    .map((row) => row.id);
}

/** The order the heap serves, drained at one instant. */
export function heapOrder(
  tickets: readonly SimTicket[],
  now: number,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): string[] {
  const heap = makeQueueHeap(weights);
  for (const ticket of tickets) heap.push(ticket, now);
  const order: string[] = [];
  for (;;) {
    const ticket = heap.popNext(now);
    if (ticket === null) break;
    order.push(ticket.id);
  }
  return order;
}
