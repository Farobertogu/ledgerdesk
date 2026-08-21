/**
 * What it takes to register a prompt, as one value per generation.
 *
 * Three agents now write into `prompt_version` instead of one, and the shape of a registration is
 * the same for all three: an identifier fixed in source so that a clean clone, CI and a rehearsal
 * all name the same row; the agent it belongs to; its generation; its words; the digest of the
 * output contract those words demand; and its parent in the lineage.
 *
 * **Why the type lives in a module of its own.** The alternative was to declare it beside the first
 * prompt that needed it and have the other two import from there, which would make the drafting
 * agent depend on the triage agent for no reason other than the order they were built in. A shape
 * three peers share belongs above all three.
 *
 * **`parent_id` is the whole reason generations are cheap.** `prompt_version` is immutable by
 * trigger except for `promoted_at`, so a prompt whose words or whose contract change is never an
 * edit — it is a new row that names the old one as its parent. The chain of rows is then the record
 * of how the contract moved, and every ledger row written under either wording still names the
 * generation that actually produced it.
 */

import type { AgentKind } from './ledger/row.ts';

/** The agents that register prompts. `system` is the ledger's own identity and never a prompt. */
export type PromptAgent = Exclude<AgentKind, 'system'>;

export type PromptRegistration = {
  /** Fixed in source. A generated identifier would make every run's chain a different chain. */
  id: string;
  agent: PromptAgent;
  /** A monotone per-agent counter. Generation 0 is the first prompt an agent ever had. */
  generation: number;
  text: string;
  /** `sha256` of the published output contract these words demand. */
  schema_hash: string;
  /** The generation this one supersedes, or null for a root. */
  parent_id: string | null;
};

/**
 * The generations of one agent, oldest first, checked for the two things a list of them can get
 * wrong on its way past a reviewer.
 *
 * A lineage is a chain and not a set: generation `n` names generation `n − 1` as its parent, the
 * numbers advance by one, and only the root has no parent. None of that is enforced by the schema —
 * `unique (agent, generation)` allows gaps, and `parent_id` allows any row of the table — so it is
 * enforced here, where a mistake is a defect of this repository and is found by a build failing
 * rather than by a lineage that quietly forks.
 */
export function assertLineage(generations: readonly PromptRegistration[]): void {
  if (generations.length === 0) {
    throw new Error('assertLineage: an agent with no prompt generations cannot register anything');
  }

  generations.forEach((generation, index) => {
    if (generation.generation !== index) {
      throw new Error(
        `assertLineage: ${generation.agent} generation ${generation.generation} is listed at position ${index}`,
      );
    }
    const expectedParent = index === 0 ? null : (generations[index - 1] as PromptRegistration).id;
    if (generation.parent_id !== expectedParent) {
      throw new Error(
        `assertLineage: ${generation.agent} generation ${generation.generation} names the wrong parent`,
      );
    }
  });
}
