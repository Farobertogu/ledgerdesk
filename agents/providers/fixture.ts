/**
 * One provider for a process that runs three agents.
 *
 * A gateway holds exactly one provider, and that is the right shape: the provider is the far side
 * of the one path to a model, and a gateway that chose among several would be a gateway with
 * several. But an organisation's runtime now drives three agents through that one gateway, so
 * something has to route — and the only honest discriminator is the one the request already
 * carries and the ledger already records.
 *
 * **The model is that discriminator.** The composition root chose a model for each agent, the
 * choice travels in `ProviderRequest.model`, and it is written into `model_requested` on the row.
 * Routing on it means the fixture answers as the agent the row says it answered as. The
 * alternatives are worse in ways that are quiet: routing on a phrase in the system prompt breaks
 * when a prompt is reworded, and routing on a field added to the request for the purpose would put
 * something in the payload that exists only to help a test.
 *
 * A model no branch names is refused rather than answered by a default, because a default here is a
 * fixture answering for an agent nobody wired.
 *
 * Siblings inside `agents/providers/` compose freely; what the seam check forbids is a caller
 * OUTSIDE this directory reaching past the composition root to pick one.
 */

import type { ModelProvider } from '../gateway.ts';
import { draftFixtureProvider, type DraftFixtureEntry } from './draft_fixture.ts';
import { triageFixtureProvider, type TriageFixtureEntry } from './triage_fixture.ts';

export type FixtureModels = {
  triage: string;
  draft: string;
  validate: string;
};

export type FixtureOptions = {
  models: FixtureModels;
  triage?: readonly TriageFixtureEntry[];
  draft?: readonly DraftFixtureEntry[];
  /** The model id the response carries. Defaults to the one requested, which is the honest case. */
  returns_model?: string;
};

export function fixtureProvider(options: FixtureOptions): ModelProvider {
  const triage = triageFixtureProvider({
    entries: options.triage ?? [],
    ...(options.returns_model === undefined ? {} : { returns_model: options.returns_model }),
  });
  const drafting = draftFixtureProvider(
    { draft: options.models.draft, validate: options.models.validate },
    {
      entries: options.draft ?? [],
      ...(options.returns_model === undefined ? {} : { returns_model: options.returns_model }),
    },
  );

  return async function fixture(request, callOptions) {
    if (request.model === options.models.triage) return triage(request, callOptions);
    if (request.model === options.models.draft || request.model === options.models.validate) {
      return drafting(request, callOptions);
    }
    throw new Error(`no fixture answers for the model '${request.model}'`);
  };
}
