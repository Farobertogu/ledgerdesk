/**
 * The escalation rule — a deterministic disjunction over a typed feature vector.
 *
 * The rule is a disjunction, so it can only ever *add* escalations. No clause can cancel another,
 * and in particular no property of the customer's account can hold back an escalation that some
 * other clause has already fired. That is a structural property of the evaluation, not a promise:
 * the evaluator stops at the first clause that fires and never consults a second to overrule it.
 *
 *   escalate ⟺  confidence < θ_c
 *            ∨  sentiment ≤ σ
 *            ∨  (tier = premium ∧ sev ≥ 0.75)
 *            ∨  retries > r_max
 *            ∨  breached
 *            ∨  ¬grounded
 *            ∨  policy_flag
 *            ∨  the language is out of the supported set
 *
 * Two things are stored beside the escalated ticket: the **reason**, one index from a closed
 * alphabet of eight, and the **clause**, the stable name of the predicate that fired. The reason
 * is what a report counts; the clause is what an auditor re-runs. Neither is free text and neither
 * is a model's opinion — `policyFlags` arrives as a list of enumerated values produced by a
 * deterministic matcher upstream, precisely so that no judgement about a customer's intent is ever
 * outsourced to a language model.
 */

import type { AccountTier, QueueFeatures, Severity } from './priority.ts';
import { assertInstant, isBreached, normalisedSeverity } from './priority.ts';

/**
 * The closed alphabet. Eight indices, and nothing outside it may be stored as a reason. The set is
 * closed on purpose: a channel whose values can be enumerated carries a bounded amount of
 * information, and an open one carries whatever the producer decides to put in it.
 *
 * **A ninth index is reserved and is not taken.** `INCONSIST` — two sources that both claim to
 * answer and do not agree — is named as reserved by the dated decision in ADR-023 §2. Naming it
 * costs nothing and buys the thing an open channel never has: the next person who meets that case
 * finds a reservation instead of inventing a synonym for it. It enters the alphabet only with its
 * own record, its own tally, and a rewrite of the check constraint that carries these values in the
 * schema. The array below does not change until then, and neither does anything that counts it.
 */
export const ESCALATION_REASONS = [
  'CONF',
  'SENT',
  'TIER',
  'RETRY',
  'SLA',
  'GROUND',
  'POLICY',
  'LANG',
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/**
 * The auditable list. A body earns a flag by matching a written rule, never by a model deciding
 * that it "seems" to be one of these; the matcher lives upstream and its output is this enum.
 */
export const POLICY_FLAGS = ['refund', 'complaint', 'legal', 'safety', 'injection'] as const;

export type PolicyFlag = (typeof POLICY_FLAGS)[number];

/** Everything the rule reads, on top of what the queue already needs. */
export type EscalationFeatures = QueueFeatures & {
  /**
   * The triage confidence, or `null` when triage has not run. A clause that cannot be evaluated
   * does not fire; a ticket is not escalated for lacking a field the pipeline has not produced yet.
   */
  confidence: number | null;
  /** How many times the provider call has been retried for this ticket. */
  retries: number;
  /** The ticket's declared language tag, e.g. `en`, `en-AU`, `es-CO`. */
  language: string;
  /** Length of the body after redaction, or `null` when redaction has not run. */
  redactedBodyLength: number | null;
  /** How many knowledge-base results the retrieval returned, or `null` when it has not run. */
  kbResultCount: number | null;
  /** The validator's verdict on the draft, or `null` when no draft has been validated. */
  grounded: boolean | null;
  /** The deterministic matcher's output. Empty is the ordinary case. */
  policyFlags: readonly PolicyFlag[];
};

export type EscalationThresholds = {
  /** θ_c — the confidence floor. */
  confidence: number;
  /** σ — the sentiment at or below which a ticket goes to a person. */
  sentiment: number;
  /** r_max — the last retry count that is still tolerated; the clause fires strictly above it. */
  maxRetries: number;
  /** The normalised severity at which a premium account escalates on severity alone. */
  premiumSeverity: number;
  /** Primary language subtags the system answers in. Everything else goes to a person unanswered. */
  supportedLanguages: readonly string[];
  /**
   * How much confidence an unscored sentiment costs.
   *
   * A model that returns no sentiment has told us something about its own certainty, and the queue
   * has already treated the missing value as neutral. Charging the difference to confidence is
   * what keeps that neutrality from reading as agreement.
   */
  nullSentimentConfidencePenalty: number;
};

/**
 * The defaults in force.
 *
 * `confidence`, `sentiment` and `maxRetries` are **provisional**: the first two are fixed properly
 * by minimising a declared loss over a held-out split, with a false negative costing five times a
 * false positive, and that calibration belongs to the increment that owns the evaluation harness.
 * Until then they are ordinary parameters with published values, and every test below seeds its
 * own thresholds rather than leaning on these — a rule whose tests only pass at one setting is a
 * constant, not a rule.
 */
export const DEFAULT_ESCALATION_THRESHOLDS: EscalationThresholds = {
  confidence: 0.75,
  sentiment: -0.6,
  maxRetries: 3,
  premiumSeverity: 0.75,
  supportedLanguages: ['en'],
  nullSentimentConfidencePenalty: 0.2,
};

/**
 * The confidence the rule actually judges, which is not always the number triage reported.
 *
 * A body that is empty once redaction has run carries nothing to be confident about, so its
 * confidence is zero whatever the pipeline claims — including when the pipeline never got far
 * enough to claim anything.
 */
export function effectiveConfidence(
  features: EscalationFeatures,
  thresholds: EscalationThresholds = DEFAULT_ESCALATION_THRESHOLDS,
): number | null {
  if (features.redactedBodyLength === 0) return 0;
  if (features.confidence === null) return null;
  if (features.sentiment === null) {
    return Math.max(0, features.confidence - thresholds.nullSentimentConfidencePenalty);
  }
  return features.confidence;
}

/**
 * Whether the draft is grounded, which a retrieval that returned nothing settles on its own.
 *
 * `null` means no draft has been validated yet, and the grounding clause is then not evaluable.
 */
export function effectiveGrounded(features: EscalationFeatures): boolean | null {
  if (features.kbResultCount === 0) return false;
  return features.grounded;
}

/** The primary subtag, lowercased: `en-AU` and `EN` are both `en`. */
export function primaryLanguageSubtag(language: string): string {
  return language.trim().toLowerCase().split('-')[0] ?? '';
}

export function isSupportedLanguage(
  language: string,
  supported: readonly string[] = DEFAULT_ESCALATION_THRESHOLDS.supportedLanguages,
): boolean {
  const subtag = primaryLanguageSubtag(language);
  if (subtag === '') return false;
  return supported.some((entry) => primaryLanguageSubtag(entry) === subtag);
}

export function isPremiumHighSeverity(
  tier: AccountTier,
  severity: Severity,
  floor: number = DEFAULT_ESCALATION_THRESHOLDS.premiumSeverity,
): boolean {
  return tier === 'premium' && normalisedSeverity(severity) >= floor;
}

export type EscalationClause = {
  /** The stable name stored beside the reason. Renaming one is a change to the audit record. */
  name: string;
  reason: EscalationReason;
  /** The clause in one sentence, for the screen that has to explain the decision to a person. */
  statement: string;
  /**
   * `now` is the instant the rule is being asked, passed to every clause whether it reads the clock
   * or not. Only the SLA clause does today; giving them all the same shape means a clause that
   * starts caring about time later does not change this type and every call site with it.
   */
  fires: (features: EscalationFeatures, now: number, thresholds: EscalationThresholds) => boolean;
};

/**
 * The eight clauses, in the order they are evaluated — and the order is a design decision with two
 * criteria, written here because a precedence nobody justified is a precedence nobody can review.
 *
 * **First criterion: the earliest point at which the system could have escalated without asking a
 * model.** The clauses a ticket's own record settles come first, then those needing triage, then
 * the one needing a retrieved draft. The reason stored is therefore a statement about *when the
 * system knew*, never about *what the model said* — a ticket that was escalatable at intake does
 * not end up attributed to a model's opinion formed afterwards.
 *
 * **Second criterion, inside a stage: the code that is rarer and costlier to lose goes first.** The
 * channel stores one reason, so precedence decides which fact survives and which is destroyed. Two
 * things make a fact cheap to lose — that it is recoverable from a column anyone can read, and that
 * it is common enough that losing an occasional instance barely moves its tally. `POLICY` is
 * neither: no published column carries the flags, and the population is small, so a legal or safety
 * flag hidden behind a commoner code is simply gone. `SLA` is both: `breached` is the first column
 * of the order key and the queue shows it, and it fires on a fifth of the replayed month — so it
 * yields to everything else in its stage and still reports itself whenever it is the only thing
 * true.
 *
 * The concrete case that fixes the intra-stage order: **a legal threat written in Spanish.** Under
 * language-first it records `LANG` and reaches a translation queue; under policy-first it records
 * `POLICY` and reaches a person who handles legal exposure. The ticket escalates either way — the
 * disjunction guarantees that — but only one of the two routes it to the right desk.
 *
 * Rejected: taking the order in which the rule's disjuncts happen to be written. A disjunction's
 * written order carries no meaning, and adopting it would put confidence first, so an injected
 * prompt that a model also felt unsure about would be filed as low confidence — the single worst
 * outcome available, and reached by deferring to an accident of punctuation.
 *
 * Because the rule is a disjunction, this order decides **which reason is stored** and never
 * whether the ticket escalates. That is asserted exhaustively over all 256 combinations.
 */
export const ESCALATION_CLAUSES: readonly EscalationClause[] = [
  // ---- decidable from the ticket record alone, before any model is called --------------------
  {
    name: 'policy_flag_raised',
    reason: 'POLICY',
    statement: 'the deterministic policy matcher raised at least one flag on this ticket',
    fires: (features) => features.policyFlags.length > 0,
  },
  {
    name: 'retry_budget_exhausted',
    reason: 'RETRY',
    statement: 'the provider retry budget is spent',
    fires: (features, _now, thresholds) => features.retries > thresholds.maxRetries,
  },
  {
    name: 'language_out_of_scope',
    reason: 'LANG',
    statement: 'the ticket is not in a supported language, so no answer is attempted',
    fires: (features, _now, thresholds) =>
      !isSupportedLanguage(features.language, thresholds.supportedLanguages),
  },
  {
    name: 'sla_breached',
    reason: 'SLA',
    statement: 'the SLA instant has passed',
    fires: (features, now) => isBreached(features, now),
  },
  // ---- decidable once triage has run ----------------------------------------------------------
  {
    name: 'confidence_below_threshold',
    reason: 'CONF',
    statement: 'triage confidence is below the escalation threshold',
    fires: (features, _now, thresholds) => {
      const confidence = effectiveConfidence(features, thresholds);
      return confidence !== null && confidence < thresholds.confidence;
    },
  },
  {
    name: 'sentiment_at_or_below_threshold',
    reason: 'SENT',
    statement: 'the customer sentiment is at or below the escalation threshold',
    fires: (features, _now, thresholds) =>
      features.sentiment !== null && features.sentiment <= thresholds.sentiment,
  },
  {
    name: 'premium_high_severity',
    reason: 'TIER',
    statement: 'a premium account raised a high-severity ticket',
    fires: (features, _now, thresholds) =>
      isPremiumHighSeverity(features.tier, features.severity, thresholds.premiumSeverity),
  },
  // ---- decidable only once a draft has been retrieved and validated ---------------------------
  {
    name: 'draft_not_grounded',
    reason: 'GROUND',
    statement: 'the draft is not grounded in a retrieved source',
    fires: (features) => effectiveGrounded(features) === false,
  },
];

/**
 * The stage at which each clause becomes decidable, published so that the precedence above can be
 * checked against its own stated criterion rather than taken on trust.
 */
export const CLAUSE_STAGE: Readonly<Record<string, 'record' | 'triage' | 'draft'>> = {
  policy_flag_raised: 'record',
  retry_budget_exhausted: 'record',
  language_out_of_scope: 'record',
  sla_breached: 'record',
  confidence_below_threshold: 'triage',
  sentiment_at_or_below_threshold: 'triage',
  premium_high_severity: 'triage',
  draft_not_grounded: 'draft',
};

export type EscalationVerdict = {
  escalate: boolean;
  reason: EscalationReason | null;
  clause: string | null;
};

/** The verdict: whether to escalate, under which reason, and by which named clause. */
export function evaluateEscalation(
  features: EscalationFeatures,
  now: number,
  thresholds: EscalationThresholds = DEFAULT_ESCALATION_THRESHOLDS,
): EscalationVerdict {
  assertInstant(now);
  for (const clause of ESCALATION_CLAUSES) {
    if (clause.fires(features, now, thresholds)) {
      return { escalate: true, reason: clause.reason, clause: clause.name };
    }
  }
  return { escalate: false, reason: null, clause: null };
}

export type ClauseOutcome = {
  clause: string;
  reason: EscalationReason;
  fired: boolean;
};

/**
 * Every clause evaluated, fired or not.
 *
 * The verdict stores one reason because a queue that counted every reason a ticket could have
 * escalated for would double-count it. An audit still needs to see the rest, and this is where it
 * reads them — the same predicates, in the same order, evaluated without short-circuiting.
 */
export function evaluateEscalationClauses(
  features: EscalationFeatures,
  now: number,
  thresholds: EscalationThresholds = DEFAULT_ESCALATION_THRESHOLDS,
): readonly ClauseOutcome[] {
  assertInstant(now);
  return ESCALATION_CLAUSES.map((clause) => ({
    clause: clause.name,
    reason: clause.reason,
    fired: clause.fires(features, now, thresholds),
  }));
}

export function isEscalationReason(value: unknown): value is EscalationReason {
  return (ESCALATION_REASONS as readonly unknown[]).includes(value);
}

export function clauseByName(name: string): EscalationClause | undefined {
  return ESCALATION_CLAUSES.find((clause) => clause.name === name);
}
