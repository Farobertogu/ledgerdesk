/**
 * The provider that talks to a real model.
 *
 * It is a `ModelProvider` and nothing more: one function from a typed request to a typed response.
 * Everything that makes a call safe — what may be sent, what it costs, whether it happens at all,
 * what is recorded — was decided above it by the chokepoint, and this file has no way to widen any
 * of that and no reason to want to. Swapping it for the fixture is swapping one function.
 *
 * ## The one place an SDK may be imported, and why it is now two places
 *
 * `ci/seam_check.mjs` allowed a provider SDK in exactly one file, `agents/gateway.ts`, and that
 * rule was written before any provider existed precisely so that the first violation would be
 * caught rather than grandfathered. This file is the first thing that needs the exemption widened,
 * and widening it is a recorded decision — ADR-025 — rather than an edit to a check.
 *
 * What the widening buys, and what it costs, are both worth stating. The gateway keeps its
 * monopoly on *calling* a provider: the check gains a complementary assertion that
 * `agents/providers/**` may be imported only from the composition root, so no handler, no page and
 * no runner can reach a provider except by being handed one. The exemption therefore moves the SDK
 * from one file to a directory whose whole contents are unreachable except through the wiring — a
 * narrower guarantee than "one file", stated as two rules instead of one.
 *
 * ## Two things the API does not have, declared rather than discovered
 *
 * **There is no seed.** `ProviderRequest.seed` travels into the cache key and into the ledger row,
 * where it means "this is the nth time we asked this question". The far side never sees it, so two
 * calls that differ only in their seed are two different rows asking an identical question. That is
 * the correct behaviour for the retry loop — the point of moving the seed is to move the cache key —
 * and it is NOT a claim that the provider was asked to sample differently. Nothing downstream reads
 * it as one; this note exists so nobody starts.
 *
 * **Not every model accepts the sampling parameters.** On the current generation of models
 * `temperature` and `top_p` were removed from the request and are rejected outright. A provider
 * that quietly dropped them would produce a ledger row whose reproducibility block names a
 * temperature that never governed anything — a lie in the one column set that exists so a result
 * can be re-obtained. So the models this adapter serves are enumerated, each one is a model that
 * takes the parameters the row records, and a request for anything else is refused before it
 * leaves. That is a smaller catalogue than the API offers, and the constraint driving it is this
 * system's own: temperature zero is what makes a re-run after a crash a cache hit rather than a
 * second opinion.
 *
 * ## The key
 *
 * `ANTHROPIC_API_KEY` is read from the environment by the SDK and is never named in a message, a
 * detail bag or a row. The factory refuses to build without it, so a process configured for the
 * real provider and missing its credential fails at startup with a sentence an operator can act on,
 * rather than at the first ticket somebody triages in front of an audience.
 */

import Anthropic from '@anthropic-ai/sdk';
import { VERSION } from '@anthropic-ai/sdk/version';

import { GatewayError } from '../errors.ts';
import type { ModelProvider, ProviderRequest, ProviderResponse } from '../gateway.ts';

/**
 * What this adapter will ask for, with the published list prices of each.
 *
 * Prices are US dollars per million tokens, as the vendor quotes them; the conversion to the
 * Australian dollars the ledger holds happens in one place, below, at a rate that is a declared
 * constant rather than a live lookup. ADR-025 carries the rate, its date and the reason a
 * demonstration budget is not a foreign-exchange desk.
 *
 * The pairing follows ADR-004: the cheap model does the two narrow, high-volume jobs — a
 * classification and a yes/no check — and the strong one writes the reply a person will read.
 */
export const ANTHROPIC_MODELS = {
  'claude-haiku-4-5': { input_usd_per_1m: 1, output_usd_per_1m: 5 },
  'claude-opus-4-6': { input_usd_per_1m: 5, output_usd_per_1m: 25 },
} as const;

export type AnthropicModel = keyof typeof ANTHROPIC_MODELS;

/** The cheap model, for triage and for the grounding check. */
export const ANTHROPIC_SMALL_MODEL: AnthropicModel = 'claude-haiku-4-5';

/** The strong model, for the reply itself. */
export const ANTHROPIC_LARGE_MODEL: AnthropicModel = 'claude-opus-4-6';

/**
 * Australian dollars per US dollar, fixed and dated.
 *
 * A budget ceiling that moved with an exchange rate would be a ceiling that cut at a different
 * number every morning, and the consumption figure recomputed from the chain would then be the sum
 * of amounts converted at whatever rate applied when each row was written. A declared constant
 * makes the arithmetic reproducible; the price of that is that the figure is an approximation of a
 * real invoice, which is what a demonstration budget is anyway.
 */
export const AUD_PER_USD = 1.55;

export type ModelPriceAud = { input_aud_per_1k: number; output_aud_per_1k: number };

/** The catalogue in the shape and the currency the chokepoint prices with. */
export function anthropicPricing(): Record<string, ModelPriceAud> {
  const pricing: Record<string, ModelPriceAud> = {};
  for (const [model, price] of Object.entries(ANTHROPIC_MODELS)) {
    pricing[model] = {
      input_aud_per_1k: (price.input_usd_per_1m / 1000) * AUD_PER_USD,
      output_aud_per_1k: (price.output_usd_per_1m / 1000) * AUD_PER_USD,
    };
  }
  return pricing;
}

/**
 * The identity that travels into `toolchain.model_sdk` on every row this provider produces.
 *
 * Read from the package rather than written here, so that a dependency bump is visible in the rows
 * it produced. `toolchain` exists to answer "what produced this" and a pinned string somebody has
 * to remember to edit answers it wrongly the first time nobody does.
 */
export const ANTHROPIC_PROVIDER_ID = `anthropic-sdk@${VERSION}`;

export type AnthropicProviderOptions = {
  /** Injectable so a test can hand in a double. Production reads the environment. */
  client?: Pick<Anthropic, 'messages'>;
};

/**
 * The adapter, or a typed refusal to build one.
 *
 * Built once per process by the composition root and never per call: the SDK holds a connection
 * pool and an agent, and a client per request would open a socket per ticket.
 */
export function anthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  const client = options.client ?? buildClient();

  return async function anthropic(request, callOptions): Promise<ProviderResponse> {
    assertServiceable(request);

    const message = await client.messages.create(
      {
        model: request.model,
        max_tokens: request.sampling.max_tokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        temperature: request.sampling.temperature,
        top_p: request.sampling.top_p,
        ...(request.sampling.stop ? { stop_sequences: [...request.sampling.stop] } : {}),
      },
      { signal: callOptions.signal },
    );

    if (message.stop_reason === 'refusal') {
      // A policy decline is an outcome and not an exception on the wire: HTTP 200, no usable
      // content. It is raised so the cycle treats it as a failed attempt rather than parsing an
      // empty answer into a schema violation and blaming the contract.
      throw new Error('the provider declined the request');
    }

    // Concatenated rather than "the first text block", because a response may carry several and
    // taking one would silently truncate an answer whose tail was in the next block.
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (text.length === 0) {
      throw new Error(`the provider answered with no text (stop_reason ${message.stop_reason})`);
    }
    if (message.stop_reason === 'max_tokens') {
      // The answer is cut off mid-token, so it cannot be a valid envelope and no seed will change
      // that. Raised here, where the cause is known, rather than arriving downstream as a parse
      // failure that looks like a model that cannot follow a contract.
      throw new Error('the answer was cut off at max_tokens, so it is not a complete envelope');
    }

    return {
      // What the RESPONSE carried, which is not necessarily what was asked for. The chokepoint's
      // pin is what decides whether the difference is an error, and it needs the truth to decide on.
      model: message.model,
      text,
      tokens_in: message.usage.input_tokens,
      tokens_out: message.usage.output_tokens,
    };
  };
}

function buildClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new GatewayError(
      'E_CONFIG_INVALID',
      'the real provider was selected and ANTHROPIC_API_KEY is not set in this environment',
      { provider: 'anthropic' },
    );
  }
  // No key argument: the SDK reads the environment, so the value never passes through this tree and
  // cannot end up in a stack frame, a log line or a detail bag.
  return new Anthropic();
}

/**
 * Whether this adapter will serve the request at all.
 *
 * The catalogue is the check. A model outside it is refused rather than attempted, because the two
 * ways of being outside it are both bad: an unknown identifier is a typo that would come back as a
 * 404 halfway through a demonstration, and a known identifier from the generation that rejects
 * sampling parameters would come back as a 400 — or, worse, would tempt the next person to fix the
 * 400 by dropping the parameters and leaving the row claiming they were sent.
 */
function assertServiceable(request: ProviderRequest): void {
  if (!(request.model in ANTHROPIC_MODELS)) {
    throw new GatewayError(
      'E_CONFIG_INVALID',
      'this provider serves a declared set of models and was asked for one outside it',
      { model_requested: request.model, serves: Object.keys(ANTHROPIC_MODELS) },
    );
  }
}
