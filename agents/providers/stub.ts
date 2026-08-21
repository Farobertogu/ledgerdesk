/**
 * A provider that answers from the digest of the request, and never from a network.
 *
 * **What it is for.** Two things, and it is worth separating them. The first is the test suite: the
 * properties the chokepoint owes — that no personal value leaves, that the ceiling cuts, that a
 * repeated input costs nothing the second time — are properties of the pipeline, and a pipeline is
 * only measurable against a provider whose answer is known in advance. The second is replay: a
 * demonstration that must reproduce a recorded run byte for byte cannot make a network call, and a
 * function of the request hash is the only kind of answer that survives that requirement.
 *
 * **What it is not.** It is not a model and it does not imitate one. The text it returns is a small
 * envelope carrying a digest, which is enough for the pipeline to hash, cost, cache and record, and
 * is deliberately not enough to be mistaken for an answer. Fixtures shaped like the real agent
 * outputs belong with the agents that define those shapes, and arrive with them.
 *
 * **On the real provider library, and why it is not here yet.** The chokepoint exists so that such a
 * library has exactly one place it may be imported from, and `ci/seam_check.mjs` has been enforcing
 * that address since before the address existed. Adding the dependency now would add a pinned
 * version to the manifest and a second identity to the toolchain block of every row, in an
 * increment that has no caller to exercise either. It is a declared deferral, not an omission: the
 * first agent to need a real answer brings the library with it, and the only file it may be named
 * in is already written.
 */

import type { ModelProvider, ProviderRequest, ProviderResponse } from '../gateway.ts';
import { canonicalJson, sha256Hex } from '../canonical.ts';

export type StubOptions = {
  /**
   * The model id the response will carry. Defaults to the one that was requested — the case worth
   * configuring is the other one, where a provider answers under a name nobody asked for and the
   * pin has to notice.
   */
  returns_model?: string;
  /** A synthetic delay, so a caller can exercise its own deadline against something. */
  latency_ms?: number;
};

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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export function stubProvider(options: StubOptions = {}): ModelProvider {
  return async function stub(request, callOptions): Promise<ProviderResponse> {
    if (options.latency_ms && options.latency_ms > 0) {
      await sleep(options.latency_ms, callOptions.signal);
    }

    const digest = digestOfRequest(request);
    // Sixteen bits of the digest, mapped into [0, 1] and held to the three decimal places the
    // ledger's confidence column has. Deterministic, and varying across inputs, which is what a
    // fixture for that column has to be.
    const confidence = Number((parseInt(digest.slice(0, 4), 16) / 0xffff).toFixed(3));

    const text = canonicalJson({
      schema_version: '1.0',
      confidence,
      digest: digest.slice(0, 32),
    });

    return {
      model: options.returns_model ?? request.model,
      text,
      tokens_in: tokenise(request.system) + tokenise(request.user),
      tokens_out: tokenise(text),
    };
  };
}
