/**
 * The ruleset, as one serialisable value.
 *
 * `state_hash` on every ledger row exists to say that two rows carrying the same `input_hash` under
 * different conditions are not comparable. Until a rule and a matcher were in the path, the only
 * condition that could move was the knowledge-base snapshot. Now the ruleset moves too: the same
 * ticket, the same words, the same model and the same answer produce a different verdict under a
 * different confidence floor or a different policy table, and two runs under two rulesets are two
 * experiments rather than one with more data.
 *
 * This module produces the value that is digested; the digest itself is taken where the gateway is
 * wired, because canonical serialisation belongs to the agent layer and this file belongs to the
 * algorithm — which imports nothing outside `src/alg/` and is therefore testable with no database,
 * no model and no bundler.
 *
 * **Everything the verdict depends on has to be in here.** A field left out is two calibrations
 * quietly sharing a cache and a comparison. The policy patterns travel as their source text because
 * a `RegExp` has no JSON form and the source is exactly what changes when a rule changes.
 */

import { DEFAULT_ESCALATION_THRESHOLDS, type EscalationThresholds } from './escalation.ts';
import { policyPatternSources } from './policy.ts';
import { DEFAULT_PRIORITY_WEIGHTS, PRIORITY_DECIMALS, type PriorityWeights } from './priority.ts';
import { retrievalDescription, type RetrievalDescription } from './retrieval.ts';

export type RulesetDescription = {
  thresholds: {
    confidence: number;
    sentiment: number;
    maxRetries: number;
    premiumSeverity: number;
    supportedLanguages: string[];
    nullSentimentConfidencePenalty: number;
  };
  weights: PriorityWeights;
  policyPatterns: { flag: string; name: string; source: string }[];
  priorityDecimals: number;
  /**
   * The retrieval's parameters.
   *
   * They belong in the digest for the same reason the thresholds do: with a retrieval in the path,
   * the verdict depends on which sources came back, and which sources came back depends on `k`, on
   * the ranking function and on the floor. Two runs under two settings are two experiments, and
   * without this block they would share a cache and a comparison while producing different drafts
   * from different corpora slices.
   */
  retrieval: RetrievalDescription;
};

/**
 * The ruleset in force, spelled out field by field rather than spread.
 *
 * Spreading would put whatever the objects happen to carry into a digest that decides whether two
 * runs are comparable — including a field added for some unrelated reason, which would invalidate
 * every cached answer in the chain the day it landed. Naming the fields makes widening the ruleset
 * an edit to this list.
 */
export function rulesetDescription(
  thresholds: EscalationThresholds = DEFAULT_ESCALATION_THRESHOLDS,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): RulesetDescription {
  return {
    thresholds: {
      confidence: thresholds.confidence,
      sentiment: thresholds.sentiment,
      maxRetries: thresholds.maxRetries,
      premiumSeverity: thresholds.premiumSeverity,
      supportedLanguages: [...thresholds.supportedLanguages],
      nullSentimentConfidencePenalty: thresholds.nullSentimentConfidencePenalty,
    },
    weights: {
      severity: weights.severity,
      negativity: weights.negativity,
      urgency: weights.urgency,
      tier: weights.tier,
    },
    policyPatterns: policyPatternSources(),
    priorityDecimals: PRIORITY_DECIMALS,
    retrieval: retrievalDescription(),
  };
}
