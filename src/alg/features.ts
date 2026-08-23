/**
 * The adapter: a ticket record, an account and a triage envelope, turned into the feature vector
 * the rule reads.
 *
 * The rule is a pure function of `EscalationFeatures` and every field of that type has to come
 * from somewhere. This file is the single answer to "from where", written once so that no caller
 * assembles a partial vector and no field acquires a second producer.
 *
 * | Field | Source |
 * |---|---|
 * | `id`, `createdAt` | the ticket record |
 * | `tier`, `valueBand` | the account, through `normaliseAccount` — an unknown account defaults down and says so |
 * | `severity`, `sentiment`, `confidence` | the validated envelope, and nothing else |
 * | `slaDueAt` | the ticket's SLA instant, or the sentinel below |
 * | `retries` | the ticket's own counter |
 * | `language` | the ticket's declared language, never a guess |
 * | `redactedBodyLength` | the gateway's result, or the sentinel below |
 * | `kbResultCount` | the retrieval's own count, or `null` when it has not run |
 * | `grounded` | the validated verdict, or `null` when no draft has been validated |
 * | `policyFlags` | the deterministic matcher |
 *
 * ## The two quantisations, and why they happen before the rule and not after
 *
 * `sentiment` and `confidence` are stored in `numeric(4,3)` columns. If the rule were evaluated on
 * the model's full-precision number and the column then rounded it, a confidence of 0.7495 would
 * fire the confidence clause and be stored as 0.750 — and an auditor re-running the decision from
 * the stored columns would get the opposite verdict from the one that was taken. So the values are
 * quantised **before** they are judged and are stored exactly as they were judged. The re-run from
 * columns is then the same computation, not a similar one.
 *
 * The rounding is half-away-from-zero and is spelled out rather than delegated to `Math.round`,
 * which rounds −0.5 towards +∞. Sentiment is the field that is routinely negative, and it is the
 * field whose threshold comparison is `≤` — so a naive round would move a value across σ in the
 * one direction that changes the answer.
 *
 * ## The two sentinels, declared here because the type cannot hold them
 *
 * `QueueFeatures.severity` and `slaDueAt` are not nullable, and yet the rule has to be evaluated
 * on a ticket that has not been triaged and on one whose triage failed — those are precisely the
 * states the `NEW → ESCALATED` and `TRIAGE_FAILED → ESCALATED` edges exist for. Two values stand
 * in, and each is chosen so that it cannot itself cause a clause to fire:
 *
 *   · `severity := 1`, whose normalised form is 0.25. The premium-severity clause has a floor of
 *     0.75, so an untriaged ticket can never escalate on a severity nobody assigned.
 *   · `slaDueAt := +∞`. `isBreached` is `now > slaDueAt`, so it is false; the urgency term is
 *     `elapsed / (∞ − createdAt) = 0`. Both are the honest reading of "no policy has been chosen
 *     yet", and neither introduces a NaN into the arithmetic.
 *
 * `kbResultCount` and `grounded` are `null` when the step that produces them has not run, and the
 * null MUST NOT be replaced by a zero or a false. `effectiveGrounded` reads a count of zero as "the
 * search ran and found nothing" and fires `GROUND` on it, so the three readings are three different
 * facts and only one of them is an escalation:
 *
 * | Value | Means | The clause |
 * |---|---|---|
 * | `null` | retrieval has not run for this ticket | not evaluable, does not fire |
 * | `0` | retrieval ran against the snapshot in force and matched nothing | fires `GROUND` |
 * | `n > 0` | retrieval found sources; grounding is then the validator's question | depends on `grounded` |
 *
 * **`?? 0` on either of these fields is forbidden, and the prohibition has a name.** It is the
 * single most natural edit anybody will make here — the types are `number | null` and `boolean |
 * null`, every consumer wants a value, and a defaulting operator makes the type error go away in
 * one keystroke. What it also does is escalate EVERY ticket in the system, correctly by the rule,
 * for a retrieval that never ran. `test_ALG_features_sentinels` asserts the null, and that test is
 * not to be edited; a case that needs different behaviour is a case added beside it.
 *
 * This module imports nothing outside `src/alg/`: it is a pure adapter over plain values, its
 * tests run with no database and no model, and the envelope reaches it as three numbers and a
 * string rather than as a type belonging to the agent layer.
 */

import type { EscalationFeatures, PolicyFlag } from './escalation.ts';
import { normaliseAccount, type PriorityAnomaly, type Severity } from './priority.ts';

/** The scale of the `sentiment` and `confidence` columns: `numeric(4,3)`. */
export const STORED_DECIMALS = 3;

const STORED_SCALE = 1000;

/** The severity an untriaged ticket is judged at. Its normalised form is 0.25. */
export const UNTRIAGED_SEVERITY: Severity = 1;

/** The SLA instant of a ticket that has no policy yet. */
export const NO_SLA_INSTANT = Number.POSITIVE_INFINITY;

/**
 * Half away from zero, at three decimals — the rounding a `numeric(4,3)` column applies, applied
 * to negatives as well.
 *
 * `Math.round(-0.5)` is `-0`, i.e. it rounds towards +∞; `numeric` rounds away from zero. On a
 * field whose threshold is `sentiment ≤ σ` with σ negative, that difference is the difference
 * between escalating and not.
 */
export function quantiseStored(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`quantiseStored: ${String(value)} is not a finite number`);
  }
  const magnitude = Math.round(Math.abs(value) * STORED_SCALE) / STORED_SCALE;
  const signed = value < 0 ? -magnitude : magnitude;
  // −0 and 0 are the same stored value and should be the same JavaScript value too, or a test
  // comparing them with deepEqual reports a difference nothing downstream can observe.
  return signed === 0 ? 0 : signed;
}

/** `numeric(4,3)` as text, which is how a fixed-scale decimal reaches the database. */
export function formatStored(value: number): string {
  return quantiseStored(value).toFixed(STORED_DECIMALS);
}

/** What the ticket record contributes. Epoch milliseconds, because the algorithm speaks in those. */
export type TicketFacts = {
  id: string;
  createdAt: number;
  /** The SLA instant, or null while no policy has been assigned. */
  slaDueAt: number | null;
  /** The declared language tag. Never detected — detection is a judgement nobody specified. */
  language: string;
  retries: number;
};

/** What the account contributes, unnormalised: `normaliseAccount` decides what it means. */
export type AccountFacts = {
  tier: unknown;
  valueBand: unknown;
};

/**
 * What the validated envelope contributes, or `null` when there is no envelope — pre-triage, or a
 * triage that failed.
 */
export type TriageReading = {
  category: string;
  severity: Severity;
  sentiment: number;
  confidence: number;
} | null;

export type FeatureInput = {
  ticket: TicketFacts;
  account: AccountFacts;
  triage: TriageReading;
  /**
   * The length of the body after redaction, `0` when redaction emptied it, and `null` when the
   * gateway was never reached. The three are different facts: zero means there was nothing left to
   * be confident about — the rule reads it as confidence 0 — and null means the question has not
   * been asked.
   */
  redactedBodyLength: number | null;
  /**
   * What the retrieval found, or absent when it has not run for this ticket.
   *
   * Optional rather than required, and `null` rather than a count of zero when omitted. The triage
   * cycle passes nothing here and must not: a triage happens before any retrieval, and a zero would
   * make every triaged ticket in the system escalate on a search that never ran.
   */
  retrieval?: { resultCount: number } | null;
  /** The validator's verdict on the draft, or absent when no draft has been validated. */
  validation?: { grounded: boolean } | null;
  policyFlags: readonly PolicyFlag[];
};

export type FeatureResult = {
  features: EscalationFeatures;
  /** The quantised values, as they are to be stored. Null when there was no envelope. */
  stored: { sentiment: number; confidence: number; severity: Severity; category: string } | null;
  /** What the account normalisation observed. A default that leaves no trace is a fact. */
  anomalies: readonly PriorityAnomaly[];
};

/**
 * The vector, and the values that go in the columns beside it.
 *
 * They are returned together because they must be the same numbers. A caller that took the vector
 * from here and quantised the columns itself would be one refactor away from storing a decision
 * that was never taken.
 */
export function featuresFromTicket(input: FeatureInput): FeatureResult {
  const account = normaliseAccount(input.account.tier, input.account.valueBand);

  const stored =
    input.triage === null
      ? null
      : {
          category: input.triage.category,
          severity: input.triage.severity,
          sentiment: quantiseStored(input.triage.sentiment),
          confidence: quantiseStored(input.triage.confidence),
        };

  const features: EscalationFeatures = {
    id: input.ticket.id,
    createdAt: input.ticket.createdAt,
    slaDueAt: input.ticket.slaDueAt ?? NO_SLA_INSTANT,
    tier: account.tier,
    valueBand: account.valueBand,
    severity: stored ? stored.severity : UNTRIAGED_SEVERITY,
    sentiment: stored ? stored.sentiment : null,
    confidence: stored ? stored.confidence : null,
    retries: input.ticket.retries,
    language: input.ticket.language,
    redactedBodyLength: input.redactedBodyLength,
    // `?? 0` and `?? false` are both forbidden here by name. See the header: an absent step is not
    // a step that found nothing, and conflating the two escalates every ticket in the system.
    kbResultCount: input.retrieval ? input.retrieval.resultCount : null,
    grounded: input.validation ? input.validation.grounded : null,
    policyFlags: input.policyFlags,
  };

  return { features, stored, anomalies: account.anomalies };
}
