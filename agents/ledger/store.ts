/**
 * The narrow surface the chokepoint needs from the ledger, and nothing wider.
 *
 * Four operations, and the reason there are exactly four:
 *
 *   · `append` extends the chain. It takes a builder rather than a row because the row cannot be
 *     built until the head is known — `seq` counts from it, `cum_tokens` accumulates on it and
 *     `prev_hash` *is* it — and the head cannot be known safely outside the transaction that
 *     inserts. Handing the store a finished row would mean reading the head in one transaction and
 *     using it in another, which is the race the unique index on `(run_id, prev_hash)` exists to
 *     catch. Handing it a builder keeps the read and the write together.
 *   · `spentMicroAud` recomputes consumption **from the chain**. Not from a counter this process
 *     holds: a counter in a variable resets when the process does, and a ceiling that resets is a
 *     ceiling multiplied by the number of restarts.
 *   · `findCached` is the cache. There is no second store — the ledger already holds every response
 *     the system has produced, indexed by the digest of the input that produced it, which is also
 *     how a replay finds them. A cache beside the ledger would be a second answer to the question
 *     "what did the system say", and the point of the ledger is that there is one.
 *   · `close` releases the connections, because a test that leaves a pool open never exits.
 *
 * Implementations are injected rather than constructed here. The path is `app → agents → gateway →
 * provider`, and a gateway that reached back into the application's database module to borrow a
 * connection would be an arrow pointing the wrong way through the seam.
 */

import type { Json } from '../canonical.ts';
import type { LedgerRowContent } from './row.ts';

/** The last row of a run: what the next row has to attach to and count from. */
export type LedgerHead = {
  seq: number;
  row_hash: string;
  cum_tokens: number;
};

export type AppendedRow = {
  id: string;
  seq: number;
  prev_hash: string;
  row_hash: string;
  ts: string;
};

/**
 * What identifies a cached call.
 *
 * The specification keys the cache on `input_hash` + `prompt_version_id`. This adds the model, the
 * sampling parameters and the seed, which can only make the key finer: two calls that agree on the
 * input and the prompt but were sampled differently are not the same call, and serving one from
 * the other would put a response in the chain under sampling parameters that did not produce it.
 *
 * It also adds `prompt_hash`, and that one is not merely finer — it closes a hole. Keying on the
 * *identifier* of the prompt version assumes the identifier determines the text, which the schema
 * does guarantee for a registered row and which nothing guarantees about the text a caller actually
 * passed. Without the digest, a caller that named one prompt version and sent another's words would
 * be served a response the words it sent never produced, and the row recording it would name the
 * prompt that did not write it. The key is over what was sent.
 */
export type CacheProbe = {
  input_hash: string;
  prompt_version_id: string;
  prompt_hash: string;
  model_requested: string;
  sampling: Json;
  seed: number | null;
};

/** A response the chain already holds, and the reproducibility block that came with it. */
export type CachedCall = {
  seq: number;
  model_returned: string;
  response_hash: string;
  response_text: string;
  tokens_in: number;
  tokens_out: number;
  confidence: string | null;
};

/** `null` run means the whole visible chain — the term's consumption, not one session's. */
export type BudgetScope = {
  run_id: string | null;
};

export interface LedgerStore {
  /**
   * Reads the head of `run_id`, lets `build` produce the row that follows it, links and inserts it,
   * and retries the whole pair when another writer takes the head first.
   */
  append(
    runId: string,
    orgId: string,
    build: (head: LedgerHead | null) => LedgerRowContent,
  ): Promise<AppendedRow>;

  /** Consumption so far, in millionths of a dollar, summed over the chain. */
  spentMicroAud(orgId: string, scope: BudgetScope): Promise<number>;

  /** The earliest real call matching `probe`, or null. Rows that were themselves served from the
   * cache are never sources: the chain always points back to the call that actually happened. */
  findCached(orgId: string, probe: CacheProbe): Promise<CachedCall | null>;

  close(): Promise<void>;
}
