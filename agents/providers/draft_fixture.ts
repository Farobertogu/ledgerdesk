/**
 * The provider that answers for the two agents of the drafting cycle, and never from a network.
 *
 * It is the sibling of `triage_fixture.ts` and it is built on the same three commitments.
 *
 * **It is a function of the request and of nothing else.** No clock, no counter, no state between
 * calls. Two identical requests get identical answers, which is what lets the ledger's cache be the
 * idempotence mechanism it claims to be and what lets a rehearsal run with the network unplugged.
 *
 * **It answers by reading the request the way the real provider would.** The user message is one
 * JSON object carrying the enquiry and the sources, so this parses it and works from the sources it
 * was actually given. That is not an implementation detail — it is what makes the default answer
 * *grounded by construction*: a fixture that returned a fixed sentence would fail the overlap
 * conjunct against every corpus except the one it was written for, and every test that wanted a
 * grounded draft would have to hard-code a body from the seed.
 *
 * **The markers pin the outcomes the tests need.** Each one fires only on a request whose text
 * contains it, so they sit beside the demonstration data without being a mode. Two of them are
 * worth naming here because they are what the grounding rules are for:
 *
 *   · `DRAFT-FIXTURE-INVENTED` cites a source that was never handed over. Containment refuses it.
 *   · `DRAFT-FIXTURE-LEAK` copies a long run out of the second source while citing only the first.
 *     Nothing about the answer is malformed; it simply reproduces material whose provenance the
 *     record would not carry, and that is the case the verbatim rule exists for.
 *
 * **How a validate outcome is pinned, which is not obvious.** The validator's `enquiry` is the
 * DRAFT, not the ticket, so a marker written into a ticket body never reaches it. The chain is
 * explicit instead: a draft marker produces draft text that contains the validate marker, and the
 * validate call then matches on it. A test that wants an ungrounded verdict asks for the draft that
 * carries it.
 */

import { canonicalJson, sha256Hex } from '../canonical.ts';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '../gateway.ts';

export type FixtureSource = { kb_id: string; excerpt: string };

export type DraftFixtureVerdict = {
  text: string;
  kb_ids: readonly string[];
  confidence: number;
};

export type ValidateFixtureVerdict = {
  grounded: boolean;
  unsupported_claims: readonly string[];
  confidence: number;
};

/** A literal text is how a fixture produces something the validator has to refuse outright. */
export type DraftFixtureAnswer =
  | { draft: DraftFixtureVerdict }
  | { validate: ValidateFixtureVerdict }
  | { text: string };

export type DraftFixtureEntry = {
  /** The phrase that selects this entry, matched against the message the model would receive. */
  match: string;
  /** Which of the two agents this entry answers for. Checked, so an entry cannot answer the other. */
  agent: 'draft' | 'validate';
  answer: DraftFixtureAnswer;
};

export type DraftFixtureOptions = {
  /** Checked in order, before the built-in markers. Empty is the ordinary case. */
  entries?: readonly DraftFixtureEntry[];
  returns_model?: string;
};

/** The marker a draft can carry so that the validator's own marker fires on the next call. */
export const VALIDATE_REJECTS_MARKER = 'VALIDATE-FIXTURE-REJECTS';

export function renderDraftEnvelope(verdict: DraftFixtureVerdict): string {
  return canonicalJson({
    schema_version: '1.0',
    agent: 'draft',
    // At the root, because that is the only place the ledger's own reader looks.
    confidence: verdict.confidence,
    draft: { text: verdict.text, kb_ids: [...verdict.kb_ids] },
  });
}

export function renderValidateEnvelope(verdict: ValidateFixtureVerdict): string {
  return canonicalJson({
    schema_version: '1.0',
    agent: 'validate',
    confidence: verdict.confidence,
    validate: {
      grounded: verdict.grounded,
      unsupported_claims: [...verdict.unsupported_claims],
    },
  });
}

/**
 * The sources the call carried, read back out of the user message.
 *
 * A message this cannot parse is a message the gateway did not build, which is a defect of the
 * caller and not a shape to be tolerated: answering anyway would mean the fixture had quietly
 * stopped depending on the sources and every grounded-by-construction default had become a
 * coincidence.
 */
export function sourcesOf(user: string): { enquiry: string; sources: FixtureSource[] } {
  const parsed = JSON.parse(user) as { enquiry?: unknown; sources?: unknown };
  if (typeof parsed.enquiry !== 'string' || !Array.isArray(parsed.sources)) {
    throw new Error('the fixture was handed a user message it did not recognise');
  }
  return {
    enquiry: parsed.enquiry,
    sources: parsed.sources as FixtureSource[],
  };
}

/** The first `count` words of a text, which is what a grounded draft borrows from its source. */
function leadingWords(text: string, count: number): string {
  return text.replace(/\s+/g, ' ').trim().split(' ').slice(0, count).join(' ');
}

/**
 * The answer for a request no entry named: a well-formed draft that cites every source it was
 * given and carries enough of each one's wording to satisfy the overlap conjunct.
 *
 * Twelve words per source, which is comfortably above the six the conjunct asks for and comfortably
 * below a wholesale copy — a fixture that reproduced an excerpt in full would be indistinguishable
 * from the leak the verbatim rule refuses, and every default answer would fail.
 */
export function derivedDraft(sources: readonly FixtureSource[], digest: string): DraftFixtureVerdict {
  const sentences = sources.map((source) => `${leadingWords(source.excerpt, 12)}`);
  const text = [
    'Thanks for getting in touch.',
    ...sentences,
    'If that does not resolve it, reply here and we will take another look.',
  ].join(' ');

  return {
    text,
    kb_ids: sources.map((source) => source.kb_id),
    // Held high and derived, for the reason the triage fixture holds its own high: an unnamed body
    // is a body a test did not care about, and a confidence that occasionally fell below the
    // escalation floor would fail such a test on the digest of its own subject line.
    confidence: Number((0.85 + (parseInt(digest.slice(0, 4), 16) / 0xffff) * 0.14).toFixed(3)),
  };
}

export const DRAFT_FIXTURE_MARKERS: readonly DraftFixtureEntry[] = [
  // Not JSON at all: the case the strict parse exists for.
  {
    match: 'DRAFT-FIXTURE-INVALID',
    agent: 'draft',
    answer: { text: 'Here is the reply you asked for:\n```json\n{"schema_version":"1.0"}\n```' },
  },
  // Schema-valid in every other respect and citing nothing: `minItems: 1` is what refuses it.
  {
    match: 'DRAFT-FIXTURE-NOCITE',
    agent: 'draft',
    answer: {
      draft: {
        text: 'We have looked into this and everything appears to be in order on our side.',
        kb_ids: [],
        confidence: 0.9,
      },
    },
  },
  // A source that was never handed over. Containment refuses it, and it is not retried.
  {
    match: 'DRAFT-FIXTURE-INVENTED',
    agent: 'draft',
    answer: {
      draft: {
        text: 'Our published policy covers this in full and no further action is needed from you.',
        kb_ids: ['policy/invented:00000000000040008000000000000000'],
        confidence: 0.94,
      },
    },
  },
  // Cites a source and shares none of its wording: the overlap conjunct is what this one measures.
  {
    match: 'DRAFT-FIXTURE-NOOVERLAP',
    agent: 'draft',
    answer: {
      draft: {
        text: 'Zzyzx qwertyuiop plugh xyzzy frobnicate bletch snafu grault garply waldo fred thud.',
        // Replaced at answer time with the first identifier this call was actually given, so the
        // citation is offered and only the overlap fails. See `answerFor`.
        kb_ids: ['<first>'],
        confidence: 0.93,
      },
    },
  },
  // A draft that hands the validator its own marker, which is how an ungrounded verdict is pinned.
  {
    match: 'DRAFT-FIXTURE-UNGROUNDED',
    agent: 'draft',
    answer: {
      draft: {
        text: `<grounded-draft> ${VALIDATE_REJECTS_MARKER}`,
        kb_ids: ['<first>'],
        confidence: 0.88,
      },
    },
  },
  {
    match: VALIDATE_REJECTS_MARKER,
    agent: 'validate',
    answer: {
      validate: {
        grounded: false,
        unsupported_claims: ['the reply promises a timeframe no source states'],
        confidence: 0.9,
      },
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

/**
 * The placeholders a marker may carry, resolved against the sources of THIS call.
 *
 * `<first>` becomes an identifier the call was actually given, and `<grounded-draft>` becomes
 * wording borrowed from it. Without them a marker would have to name a source from the seed, and
 * every test using it would break the day the seed changed — which is the failure the phrase-based
 * selection of these fixtures exists to avoid in the first place.
 */
function resolvePlaceholders(
  verdict: DraftFixtureVerdict,
  sources: readonly FixtureSource[],
): DraftFixtureVerdict {
  const first = sources[0];
  return {
    ...verdict,
    text: verdict.text.replace(
      '<grounded-draft>',
      first ? `Thanks for getting in touch. ${leadingWords(first.excerpt, 12)}` : 'Thanks for getting in touch.',
    ),
    kb_ids: verdict.kb_ids.map((kb_id) =>
      kb_id === '<first>' ? (first ? first.kb_id : kb_id) : kb_id,
    ),
  };
}

/**
 * The two agents this provider answers for, keyed by the model each one asks with.
 *
 * The model is the discriminator rather than a phrase in the system prompt, because the model is
 * structural: the composition root chose it for this agent and it travels in the request and into
 * the row. A prompt-sniffing fixture would start answering as the wrong agent the day somebody
 * reworded a prompt, and it would do it silently.
 */
export type DraftFixtureModels = { draft: string; validate: string };

export function draftFixtureProvider(
  models: DraftFixtureModels,
  options: DraftFixtureOptions = {},
): ModelProvider {
  const entries = [...(options.entries ?? []), ...DRAFT_FIXTURE_MARKERS];

  return async function draftFixture(request): Promise<ProviderResponse> {
    const agent =
      request.model === models.draft ? 'draft' : request.model === models.validate ? 'validate' : null;
    if (agent === null) {
      throw new Error(`the drafting fixture was asked for '${request.model}', which is not its model`);
    }

    const { sources } = sourcesOf(request.user);
    const matched = entries.find(
      (entry) => entry.agent === agent && request.user.includes(entry.match),
    );

    let text: string;
    if (matched && 'text' in matched.answer) {
      text = matched.answer.text;
    } else if (matched && 'draft' in matched.answer) {
      text = renderDraftEnvelope(resolvePlaceholders(matched.answer.draft, sources));
    } else if (matched && 'validate' in matched.answer) {
      text = renderValidateEnvelope(matched.answer.validate);
    } else if (agent === 'draft') {
      text = renderDraftEnvelope(derivedDraft(sources, digestOfRequest(request)));
    } else {
      // The validator's default is agreement, and that is safe precisely because agreement grants
      // nothing: four arithmetic conditions decide grounding and this is the fifth conjunct, so a
      // fixture that always said yes still cannot make an ungrounded draft grounded.
      text = renderValidateEnvelope({ grounded: true, unsupported_claims: [], confidence: 0.95 });
    }

    return {
      model: options.returns_model ?? request.model,
      text,
      tokens_in: tokenise(request.system) + tokenise(request.user),
      tokens_out: tokenise(text),
    };
  };
}
