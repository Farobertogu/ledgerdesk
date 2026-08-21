/**
 * A triage provider that answers with the shape of a real envelope, and never from a network.
 *
 * `stub.ts` says that fixtures shaped like a real agent's output belong with the agent that
 * defines the shape and arrive with it. This is that arrival. The generic stub answers with a
 * three-key object carrying a digest, which is enough for the chokepoint to hash, cost, cache and
 * record and is deliberately not enough to be mistaken for a verdict; everything downstream of the
 * envelope — the validator, the feature adapter, the rule, the transition — needs an answer with a
 * complete triage block in it, and that is what this returns.
 *
 * **How an answer is chosen, and why by substring.** Every entry names a phrase. The first entry
 * whose phrase appears in the message the model would have received wins; if none does, the answer
 * is derived from the digest of the request. Matching on a phrase rather than on a digest is what
 * makes the table writable by hand: a digest is a function of the redacted body, the prompt, the
 * sampling parameters and the sources, so pinning one would mean recomputing the table every time
 * any of those moved, and a demonstration whose fixtures go stale when a prompt is reworded is a
 * demonstration nobody can rehearse.
 *
 * **It is a function of the request and of nothing else.** No clock, no counter, no state between
 * calls. Two identical requests get identical answers, which is what lets the ledger's cache be
 * the idempotence mechanism it claims to be, and what lets a replay reproduce a run byte for byte.
 *
 * **The markers.** The entries at the bottom exist so a test can pin an outcome it needs — a
 * response that is not JSON, an envelope missing its block, an envelope carrying another agent's
 * work. They fire only on a body that contains the marker and are inert in every other body, which
 * is why they can live beside the demonstration data without being a mode.
 */

import { canonicalJson, sha256Hex } from '../canonical.ts';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '../gateway.ts';
import type { TriageSeverity } from '../triage/envelope.ts';

/** A triage verdict as it is authored: the envelope's fields, without its constant keys. */
export type TriageFixtureVerdict = {
  category: string;
  severity: TriageSeverity;
  sentiment: number;
  confidence: number;
};

/**
 * What an entry answers with: either a verdict, which is rendered into a well-formed envelope, or
 * a literal text, which is how a fixture produces something the validator has to refuse.
 */
export type TriageFixtureAnswer = { verdict: TriageFixtureVerdict } | { text: string };

export type TriageFixtureEntry = {
  /** The phrase that selects this entry, matched against the message the model would receive. */
  match: string;
  answer: TriageFixtureAnswer;
};

export type TriageFixtureOptions = {
  /** Checked in order, before the built-in markers. Empty is the ordinary case. */
  entries?: readonly TriageFixtureEntry[];
  /** The model id the response carries. Defaults to the one requested, which is the honest case. */
  returns_model?: string;
};

/** The envelope, rendered canonically so that identical verdicts are identical bytes. */
export function renderTriageEnvelope(verdict: TriageFixtureVerdict): string {
  return canonicalJson({
    schema_version: '1.0',
    agent: 'triage',
    // At the root, because that is the only place the ledger's own reader looks.
    confidence: verdict.confidence,
    triage: {
      category: verdict.category,
      severity: verdict.severity,
      sentiment: verdict.sentiment,
    },
  });
}

/**
 * The markers a test pins an outcome with. Each one names the refusal it is there to produce.
 *
 * `TRIAGE-FIXTURE-CLEAN` is the one that is not a refusal: a confident, neutral, mid-severity
 * verdict, chosen so that no clause of the escalation rule fires on a standard-tier account. A
 * test that wants a plain `NEW → TRIAGED` needs an answer that provokes nothing, and an answer
 * derived from a digest cannot promise that.
 */
export const TRIAGE_FIXTURE_MARKERS: readonly TriageFixtureEntry[] = [
  {
    match: 'TRIAGE-FIXTURE-CLEAN',
    answer: { verdict: { category: 'billing', severity: 2, sentiment: 0.1, confidence: 0.92 } },
  },
  {
    match: 'TRIAGE-FIXTURE-LOWCONF',
    answer: { verdict: { category: 'billing', severity: 2, sentiment: 0.1, confidence: 0.4 } },
  },
  {
    match: 'TRIAGE-FIXTURE-ANGRY',
    answer: { verdict: { category: 'billing', severity: 3, sentiment: -0.8, confidence: 0.91 } },
  },
  // Not JSON at all: the case the strict parse exists for.
  {
    match: 'TRIAGE-FIXTURE-INVALID',
    answer: {
      text: 'Here is the triage you asked for:\n```json\n{"schema_version":"1.0"}\n```\nHope that helps.',
    },
  },
  // Schema-valid by the published contract, and empty of a verdict: the hole in `required`.
  {
    match: 'TRIAGE-FIXTURE-BARE',
    answer: { text: canonicalJson({ schema_version: '1.0', agent: 'triage', confidence: 0.9 }) },
  },
  // Two agents' work in one envelope.
  {
    match: 'TRIAGE-FIXTURE-FOREIGN',
    answer: {
      text: canonicalJson({
        schema_version: '1.0',
        agent: 'triage',
        confidence: 0.9,
        triage: { category: 'billing', severity: 2, sentiment: 0.1 },
        draft: { answer: 'We will look into it.', citations: [] },
      }),
    },
  },
];

/** The same four-characters-to-a-token figure the gateway estimates with, applied honestly here. */
function tokenise(text: string): number {
  return Math.ceil(text.length / 4);
}

function digestOfRequest(request: ProviderRequest): string {
  return sha256Hex(
    canonicalJson({
      model: request.model,
      system: request.system,
      user: request.user,
      sampling: {
        temperature: request.sampling.temperature,
        top_p: request.sampling.top_p,
        max_tokens: request.sampling.max_tokens,
        stop: request.sampling.stop ? [...request.sampling.stop] : null,
      },
      seed: request.seed,
    }),
  );
}

/** Sixteen bits of a digest, mapped onto [0,1] and held at three decimals. */
function unitFrom(digest: string, offset: number): number {
  return Number((parseInt(digest.slice(offset, offset + 4), 16) / 0xffff).toFixed(3));
}

/**
 * The answer for a body no entry named: a complete, valid envelope whose fields vary with the
 * input and are the same for the same input.
 *
 * The confidence floor is deliberate. An unnamed body is a body a test did not care about, and a
 * fixture that occasionally produced a confidence below the escalation threshold would make such a
 * test fail on the digest of its own subject line. Certainty is the fixture's, not a claim about
 * any model's.
 */
function derivedVerdict(digest: string): TriageFixtureVerdict {
  const severities: readonly TriageSeverity[] = [1, 2, 3, 4];
  const index = parseInt(digest.slice(8, 10), 16) % severities.length;
  return {
    category: 'general',
    severity: severities[index] as TriageSeverity,
    // Held inside (-0.5, 0.5): a derived sentiment that crossed the escalation threshold would
    // escalate a ticket because of the digest of its own body.
    sentiment: Number((unitFrom(digest, 4) - 0.5).toFixed(3)),
    confidence: Number((0.8 + unitFrom(digest, 0) * 0.19).toFixed(3)),
  };
}

export function triageFixtureProvider(options: TriageFixtureOptions = {}): ModelProvider {
  const entries = [...(options.entries ?? []), ...TRIAGE_FIXTURE_MARKERS];

  return async function triageFixture(request): Promise<ProviderResponse> {
    const matched = entries.find((entry) => request.user.includes(entry.match));

    const text = matched
      ? 'text' in matched.answer
        ? matched.answer.text
        : renderTriageEnvelope(matched.answer.verdict)
      : renderTriageEnvelope(derivedVerdict(digestOfRequest(request)));

    return {
      model: options.returns_model ?? request.model,
      text,
      tokens_in: tokenise(request.system) + tokenise(request.user),
      tokens_out: tokenise(text),
    };
  };
}
