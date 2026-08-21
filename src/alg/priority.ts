/**
 * The composite SLA-aware priority — the queue's ordering algorithm, as a pure function.
 *
 * Three properties are deliberate and every one of them is a testable claim rather than a comment:
 *
 *   1. **No clock inside, and no clock on the ticket either.** The instant of evaluation is an
 *      argument of the call, not a field of the feature vector. The vector describes the ticket;
 *      `now` describes the moment someone is asking. Keeping them apart is not tidiness — it makes
 *      it impossible to rank two tickets against two different clocks, which is a queue that no
 *      single moment justifies and which looks entirely correct on the screen.
 *   2. **Weights are arguments.** The published default is one configuration among several; the
 *      sensitivity generator sweeps others against it. A weight vector that is not a probability
 *      distribution is rejected rather than silently renormalised.
 *   3. **The order is total.** Two tickets tie only when they are the same ticket. A queue whose
 *      order depends on which rows the storage engine happened to return is not an algorithm.
 *
 * The score is not the order. `P(t)` ranks tickets *within* a breach class; a breached ticket
 * always precedes a non-breached one whatever the two scores are. That is the anti-starvation
 * mechanism, and it lives in the comparator, not in the weights.
 *
 *   sev  = SEVERITY_MAP[severity]                                  ∈ {0.25, 0.50, 0.75, 1.00}
 *   neg  = (1 − sentiment) / 2                                     sentiment ∈ [−1, 1]
 *   urg  = clamp((now − created_at) / (sla_due_at − created_at), 0, 1)
 *   tier = TIER_MAP[tier] · VALUE_BAND_MAP[value_band]
 *
 *   P    = w_s·sev + w_n·neg + w_u·urg + w_v·tier                   Σw = 1
 *   key  = (breached, P, −created_at, −id)   lexicographic, descending  ← the total order
 */

/** Severity as the ticket record carries it: 1 is the mildest, 4 the most severe. */
export const SEVERITY_LEVELS = [1, 2, 3, 4] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const ACCOUNT_TIERS = ['standard', 'premium'] as const;
export type AccountTier = (typeof ACCOUNT_TIERS)[number];

export const VALUE_BANDS = [1, 2, 3, 4, 5] as const;
export type ValueBand = (typeof VALUE_BANDS)[number];

/** The published normalisation of severity onto [0,1]. */
export const SEVERITY_MAP: Readonly<Record<Severity, number>> = {
  1: 0.25,
  2: 0.5,
  3: 0.75,
  4: 1,
};

/**
 * The two account factors, whose product is the `tier` term.
 *
 * Both are parameters of the module rather than facts of the domain: they are the numeric image of
 * a written commercial policy, and when that policy is transcribed into the account tables these
 * two maps are the single place that changes. Their product stays inside [0,1] by construction,
 * which every other term also owes.
 */
export const TIER_MAP: Readonly<Record<AccountTier, number>> = { standard: 0.5, premium: 1 };

export const VALUE_BAND_MAP: Readonly<Record<ValueBand, number>> = {
  1: 0.2,
  2: 0.4,
  3: 0.6,
  4: 0.8,
  5: 1,
};

/** The subset of a ticket's state that decides its place in the queue. */
export type QueueFeatures = {
  /** Stable identifier. It is the last component of the order key, which is what makes it total. */
  id: string;
  severity: Severity;
  /** `null` is the model declining to score the sentiment; the term is then neutral. */
  sentiment: number | null;
  tier: AccountTier;
  valueBand: ValueBand;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. The instant the SLA expires, not a duration. */
  slaDueAt: number;
};

export type PriorityWeights = {
  severity: number;
  negativity: number;
  urgency: number;
  tier: number;
};

/** The configuration the written SLA policy produces. Every other configuration is a perturbation. */
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  severity: 0.35,
  negativity: 0.25,
  urgency: 0.3,
  tier: 0.1,
};

/** Floating-point slack allowed on Σw = 1. */
export const WEIGHT_SUM_TOLERANCE = 1e-9;

/**
 * The decimal places at which the score is fixed before it becomes an ordering key.
 *
 * Two scores that differ below this precision are one score, and the tiebreak decides. The queue
 * that a storage engine serves compares a stored number, so the in-process comparator has to
 * compare a number of the same precision or the two orders would diverge on the last digit of a
 * float. Quantising here is what makes that divergence impossible rather than unlikely.
 */
export const PRIORITY_DECIMALS = 6;

/**
 * Written out rather than computed as a power.
 *
 * `**` is specified as *implementation-approximated* for the general case. Every engine in practice
 * returns exactly one million for `10 ** 6`, and relying on that is still relying on something the
 * standard does not promise — in a module whose whole claim is that two machines produce the same
 * bytes, a literal costs nothing and promises everything.
 */
const PRIORITY_SCALE = 1_000_000;

/** The anomalies the priority computation can observe in a feature vector, as a closed set. */
export const PRIORITY_ANOMALIES = [
  'FUTURE_CREATED_AT',
  'NON_POSITIVE_SLA_WINDOW',
  'SENTIMENT_ABSENT',
  'SENTIMENT_OUT_OF_RANGE',
  'UNKNOWN_TIER',
  'UNKNOWN_VALUE_BAND',
] as const;

export type PriorityAnomaly = (typeof PRIORITY_ANOMALIES)[number];

export type PriorityComponent = {
  /** The term normalised onto [0,1]. */
  normalised: number;
  weight: number;
  /** `normalised · weight` — the share of the score this term is responsible for. */
  contribution: number;
};

/**
 * The explanation, not just the number.
 *
 * Every field a queue explainer needs to say *why* this ticket is above that one is here, which is
 * why the function returns a record instead of a scalar: a priority nobody can account for is a
 * ranking the operator has to take on trust.
 */
export type PriorityBreakdown = {
  /** `Σ contribution`, unrounded. */
  score: number;
  /** `score` fixed at `PRIORITY_DECIMALS` — the value that orders the queue and that storage keeps. */
  storedScore: number;
  breached: boolean;
  components: {
    severity: PriorityComponent;
    negativity: PriorityComponent;
    urgency: PriorityComponent;
    tier: PriorityComponent;
  };
  anomalies: readonly PriorityAnomaly[];
};

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Rejects anything that is not a real instant, at every entry point that takes one.
 *
 * This exists because the mistake was made. `now` sits between the feature vector and the optional
 * weights, and a caller passing weights or thresholds into that slot gets no complaint from the
 * runtime — every argument is just a value — and the result is a plausible-looking order computed
 * against a clock of `NaN`. Types catch it inside this module; nothing catches it from an untyped
 * caller or across a boundary where the object arrived as JSON. So the check is here, once, and it
 * costs a comparison.
 */
export function assertInstant(now: number): void {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError(
      `the evaluation instant must be a finite epoch-millisecond number, got ${typeof now === 'object' ? JSON.stringify(now) : String(now)}`,
    );
  }
}

/** Fixes a score at the stored precision. Half-up, so it is the same rounding a database applies. */
export function quantisePriority(score: number): number {
  return Math.round(score * PRIORITY_SCALE) / PRIORITY_SCALE;
}

/**
 * Rejects a weight vector that is not a distribution.
 *
 * Renormalising silently would mean the table of published weights and the weights actually in
 * force could differ, which is the one thing a sensitivity study cannot survive.
 */
export function assertValidWeights(weights: PriorityWeights): void {
  const entries = Object.entries(weights);
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`priority weight '${name}' must lie in [0,1], got ${String(value)}`);
    }
  }
  const sum = entries.reduce((total, [, value]) => total + value, 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new RangeError(`priority weights must sum to 1, got ${sum}`);
  }
}

export function isSeverity(value: unknown): value is Severity {
  return (SEVERITY_LEVELS as readonly unknown[]).includes(value);
}

export function isAccountTier(value: unknown): value is AccountTier {
  return (ACCOUNT_TIERS as readonly unknown[]).includes(value);
}

export function isValueBand(value: unknown): value is ValueBand {
  return (VALUE_BANDS as readonly unknown[]).includes(value);
}

export type NormalisedAccount = {
  tier: AccountTier;
  valueBand: ValueBand;
  anomalies: readonly PriorityAnomaly[];
};

/**
 * The account factors of a ticket whose account is unknown, orphaned or malformed.
 *
 * It defaults down, never up: an account nobody can identify is served as `standard` in the lowest
 * band. The anomaly is returned so the caller can record it — a default that leaves no trace is
 * indistinguishable from a fact.
 */
export function normaliseAccount(tier: unknown, valueBand: unknown): NormalisedAccount {
  const anomalies: PriorityAnomaly[] = [];
  let resolvedTier: AccountTier = 'standard';
  let resolvedBand: ValueBand = 1;

  if (isAccountTier(tier)) {
    resolvedTier = tier;
  } else {
    anomalies.push('UNKNOWN_TIER');
  }

  if (isValueBand(valueBand)) {
    resolvedBand = valueBand;
  } else {
    anomalies.push('UNKNOWN_VALUE_BAND');
  }

  return { tier: resolvedTier, valueBand: resolvedBand, anomalies };
}

export function normalisedSeverity(severity: Severity): number {
  return SEVERITY_MAP[severity];
}

/**
 * The negativity term. Absent sentiment is neutral here and costs confidence elsewhere: the queue
 * must not reward a ticket for being unscored, and it must not punish it either.
 */
export function normalisedNegativity(sentiment: number | null): number {
  if (sentiment === null || !Number.isFinite(sentiment)) return 0.5;
  return (1 - clamp(sentiment, -1, 1)) / 2;
}

export type UrgencyResult = { value: number; anomalies: readonly PriorityAnomaly[] };

/**
 * The urgency term: the fraction of the SLA window already spent.
 *
 * Monotonically non-decreasing in `now` and equal to 1 at the due instant — the property the
 * anti-starvation bound rests on. Two degenerate vectors are handled explicitly rather than
 * arithmetically:
 *
 *   - a `created_at` in the future is clock skew. Time spent is clamped to zero, never negative,
 *     and the anomaly is recorded. This is checked first: skew is a fact about the clock, and a
 *     skewed vector must not be read as an expired one.
 *   - a window that is zero or negative describes a ticket already due when it was created. It is
 *     maximally urgent, and the anomaly says the SLA policy behind it is malformed.
 */
export function normalisedUrgency(features: QueueFeatures, now: number): UrgencyResult {
  const elapsed = now - features.createdAt;
  if (elapsed < 0) {
    return { value: 0, anomalies: ['FUTURE_CREATED_AT'] };
  }
  const window = features.slaDueAt - features.createdAt;
  if (window <= 0) {
    return { value: 1, anomalies: ['NON_POSITIVE_SLA_WINDOW'] };
  }
  return { value: clamp(elapsed / window, 0, 1), anomalies: [] };
}

export function normalisedTier(tier: AccountTier, valueBand: ValueBand): number {
  return TIER_MAP[tier] * VALUE_BAND_MAP[valueBand];
}

/** True once the SLA instant has passed. Strict: a ticket is not breached at its due instant. */
export function isBreached(features: QueueFeatures, now: number): boolean {
  return now > features.slaDueAt;
}

/** The priority with its per-component account. Pure: same vector, same record, always. */
export function computePriority(
  features: QueueFeatures,
  now: number,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): PriorityBreakdown {
  assertInstant(now);
  assertValidWeights(weights);

  const anomalies: PriorityAnomaly[] = [];

  if (features.sentiment === null) {
    anomalies.push('SENTIMENT_ABSENT');
  } else if (!Number.isFinite(features.sentiment) || Math.abs(features.sentiment) > 1) {
    anomalies.push('SENTIMENT_OUT_OF_RANGE');
  }

  const urgency = normalisedUrgency(features, now);
  anomalies.push(...urgency.anomalies);

  const normalised = {
    severity: normalisedSeverity(features.severity),
    negativity: normalisedNegativity(features.sentiment),
    urgency: urgency.value,
    tier: normalisedTier(features.tier, features.valueBand),
  };

  const components = {
    severity: component(normalised.severity, weights.severity),
    negativity: component(normalised.negativity, weights.negativity),
    urgency: component(normalised.urgency, weights.urgency),
    tier: component(normalised.tier, weights.tier),
  };

  const score =
    components.severity.contribution +
    components.negativity.contribution +
    components.urgency.contribution +
    components.tier.contribution;

  return {
    score,
    storedScore: quantisePriority(score),
    breached: isBreached(features, now),
    components,
    anomalies,
  };
}

function component(normalised: number, weight: number): PriorityComponent {
  return { normalised, weight, contribution: normalised * weight };
}

/**
 * The order key. Four components, compared in this sequence, every one descending:
 * breach class, priority, then the two tiebreaks that make the order total.
 */
export type QueueKey = {
  breached: boolean;
  /** The stored precision, so that this comparator and a sorted column cannot disagree. */
  priority: number;
  createdAt: number;
  id: string;
};

export function queueKey(
  features: QueueFeatures,
  now: number,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): QueueKey {
  const breakdown = computePriority(features, now, weights);
  return {
    breached: breakdown.breached,
    priority: breakdown.storedScore,
    createdAt: features.createdAt,
    id: features.id,
  };
}

/**
 * Negative when `a` is served first. Zero only when the two keys name the same ticket.
 *
 * Breach first, so no ticket can be starved past its SLA by a stream of higher-scoring arrivals;
 * then priority; then the older ticket; then the identifier, which no two tickets share.
 */
export function compareQueueKeys(a: QueueKey, b: QueueKey): number {
  if (a.breached !== b.breached) return a.breached ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The queue as an operator sees it: every ticket in the order it will be served, at one instant.
 *
 * `now` is an argument of the **batch**, not of each ticket, and that is the point. Two tickets
 * ranked at two different instants are not ranked at all: the urgency term and the breach class are
 * both functions of the clock, so a caller that evaluated each row as it came off a cursor would
 * produce an order that no single moment justifies — and it would look perfectly correct. Taking
 * the instant once makes that mistake unrepresentable rather than merely documented.
 */
export function orderQueue<T extends QueueFeatures>(
  tickets: readonly T[],
  now: number,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): T[] {
  const keyed = tickets.map((ticket) => ({ ticket, key: queueKey(ticket, now, weights) }));
  keyed.sort((a, b) => compareQueueKeys(a.key, b.key));
  return keyed.map((entry) => entry.ticket);
}

/**
 * The widest `created_at` this encoding can pad, and the widest priority it can hold.
 *
 * Both are asserted at encoding time rather than assumed. An identifier that overflowed its field
 * would collate wrongly and quietly, which is the one failure mode a fixed-width encoding has.
 */
const COLLATION_TIME_WIDTH = 15; // milliseconds until the year 33658
const COLLATION_PRIORITY_CEILING = 9_999_999; // priority ≤ 1 at six decimals, with a decade spare

/**
 * The order key encoded as one string that sorts, ascending and lexicographically, into the queue
 * order — the way a collating index arranges its entries.
 *
 * This is deliberately **a different mechanism**, not a second copy of the comparator above. A
 * comparator re-typed as a comparator agrees with itself for the same reason a sentence agrees with
 * its own paraphrase, and a test built on that pair proves nothing. Here the descending columns are
 * inverted into ascending ones by complement, every numeric field is zero-padded to a fixed width
 * so that textual and numeric order coincide, and the result is compared with `<`. If the key,
 * its widths, or the direction of any column is wrong, this encoding and the comparator disagree —
 * which is exactly what the test is for.
 */
export function storedCollationKey(key: QueueKey): string {
  const priority = Math.round(key.priority * PRIORITY_SCALE);
  if (priority < 0 || priority > COLLATION_PRIORITY_CEILING) {
    throw new RangeError(`priority ${key.priority} does not fit the collation encoding`);
  }
  if (key.createdAt < 0 || String(key.createdAt).length > COLLATION_TIME_WIDTH) {
    throw new RangeError(`created_at ${key.createdAt} does not fit the collation encoding`);
  }
  // Breached first and higher priority first are descending columns; ascending text gives them by
  // complement. `created_at` and `id` are already ascending and need none.
  const breached = key.breached ? '0' : '1';
  const descendingPriority = String(COLLATION_PRIORITY_CEILING - priority).padStart(7, '0');
  const createdAt = String(key.createdAt).padStart(COLLATION_TIME_WIDTH, '0');
  return `${breached}|${descendingPriority}|${createdAt}|${key.id}`;
}

/**
 * The same order as `compareQueueKeys`, obtained by collating the encoding above.
 *
 * This is the reading a storage engine performs over stored columns; the comparator is the reading
 * the process performs over a key it just computed. Holding the two against each other is what
 * makes the agreement checkable instead of quotable.
 */
export function compareStoredRows(a: QueueKey, b: QueueKey): number {
  const left = storedCollationKey(a);
  const right = storedCollationKey(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Reopening a ticket: the SLA clock restarts from the reopen instant and the retry count survives.
 *
 * Both halves matter and they pull in opposite directions. Restarting the clock is fair to a
 * customer whose new question is new. Preserving the retries is fair to the system: a ticket that
 * has already exhausted a provider's patience does not get a fresh budget by being reopened, and
 * the escalation rule still sees the history.
 */
export function applyReopen<T extends QueueFeatures>(
  features: T,
  reopenedAt: number,
  slaWindowMs: number,
): T {
  if (slaWindowMs <= 0) {
    throw new RangeError(`the reopened SLA window must be positive, got ${slaWindowMs}`);
  }
  return {
    ...features,
    createdAt: reopenedAt,
    slaDueAt: reopenedAt + slaWindowMs,
  };
}

/** The window inside which a repeated body is the same submission rather than a new one. */
export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * The collapse key: an organisation, a body digest, and the instant the collapse group opened.
 *
 * **The anchor is what reconciles a five-minute window with a permanent uniqueness constraint.**
 * A key of organisation and body alone is stable forever, so the same complaint raised honestly the
 * next morning would collide with the row from last night and the insert would fail — a legitimate
 * ticket refused by a rule meant to absorb double-clicks. Naming the group by the arrival that
 * opened it gives every genuine re-submission a key of its own while every duplicate inside the
 * window resolves to the same string. Nothing about the constraint has to change.
 *
 * The discarded alternative is recorded because it is the tempting one: bucketing the timestamp
 * (`floor(t / window)`) also produces a rotating key, and it collapses two submissions ten seconds
 * apart into different groups whenever they straddle a bucket edge. Whether a duplicate is absorbed
 * would then depend on where the wall clock happened to fall, which is the class of non-determinism
 * this module exists to refuse.
 *
 * The digest is supplied, not computed here. Hashing is not the algorithm's business, and taking
 * the body as an argument would put a raw customer body inside a module that has no reason to
 * ever hold one.
 */
export function dedupeKey(orgId: string, bodySha256: string, anchorCreatedAt: number): string {
  return `${orgId}:${bodySha256}:${anchorCreatedAt}`;
}

export type Submission = {
  id: string;
  orgId: string;
  bodySha256: string;
  createdAt: number;
};

/**
 * The row a new submission is measured against: the most recent entry that shares its organisation
 * and body digest.
 *
 * `open` is the caller's answer to *is that entry still live?*. A duplicate must not be folded into
 * a ticket that has already been resolved and closed — the customer writing the same words again
 * after a closure is raising the matter again, not clicking twice.
 */
export type DedupeIncumbent = {
  id: string;
  /** The instant that named the incumbent's group, which its key already carries. */
  anchorCreatedAt: number;
  open: boolean;
};

export type DedupeDecision = {
  /** The key the new row would carry, or the incumbent's key when the submission collapses. */
  key: string;
  collapse: boolean;
  /** The identifier of the entry this submission folds into, when it collapses. */
  collapsedInto: string | null;
  /** The instant naming the group this submission belongs to. */
  anchorCreatedAt: number;
};

/**
 * Whether a submission is a duplicate of the entry that already holds its content.
 *
 * The window is measured from the group's anchor, not from the last duplicate seen, so a customer
 * clicking send every four minutes cannot walk the window forward indefinitely and keep one ticket
 * open for an hour. Three conditions, all of them necessary: an incumbent exists, it is still open,
 * and the new submission falls inside the window that the incumbent's anchor opened.
 */
export function dedupeDecision(
  submission: Submission,
  incumbent: DedupeIncumbent | null,
  windowMs: number = DEFAULT_DEDUPE_WINDOW_MS,
): DedupeDecision {
  const fresh = {
    key: dedupeKey(submission.orgId, submission.bodySha256, submission.createdAt),
    collapse: false,
    collapsedInto: null,
    anchorCreatedAt: submission.createdAt,
  };
  if (incumbent === null || !incumbent.open) return fresh;

  const gap = submission.createdAt - incumbent.anchorCreatedAt;
  if (gap < 0 || gap >= windowMs) return fresh;

  return {
    key: dedupeKey(submission.orgId, submission.bodySha256, incumbent.anchorCreatedAt),
    collapse: true,
    collapsedInto: incumbent.id,
    anchorCreatedAt: incumbent.anchorCreatedAt,
  };
}

export type CollapseResult<T extends Submission> = {
  /** One entry per distinct submission, each with the key its row would carry. */
  admitted: { submission: T; key: string }[];
  /** Every collapsed submission, paired with the entry that absorbed it. */
  collapsed: { submission: T; into: string }[];
};

/**
 * Folds a stream of submissions into the queue entries it should produce.
 *
 * Arrival order is the caller's; this walks it once and holds, per organisation and body, the group
 * currently open for collapsing. That group is replaced — not extended — when a later submission
 * falls outside its window, and the replacement takes a new anchor and therefore a new key.
 */
export function collapseDuplicates<T extends Submission>(
  submissions: readonly T[],
  windowMs: number = DEFAULT_DEDUPE_WINDOW_MS,
): CollapseResult<T> {
  const openGroups = new Map<string, DedupeIncumbent>();
  const admitted: { submission: T; key: string }[] = [];
  const collapsed: { submission: T; into: string }[] = [];

  for (const submission of submissions) {
    const content = `${submission.orgId}:${submission.bodySha256}`;
    const decision = dedupeDecision(submission, openGroups.get(content) ?? null, windowMs);
    if (decision.collapse && decision.collapsedInto !== null) {
      collapsed.push({ submission, into: decision.collapsedInto });
      continue;
    }
    openGroups.set(content, {
      id: submission.id,
      anchorCreatedAt: decision.anchorCreatedAt,
      open: true,
    });
    admitted.push({ submission, key: decision.key });
  }

  return { admitted, collapsed };
}
