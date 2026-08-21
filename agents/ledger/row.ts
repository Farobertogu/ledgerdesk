/**
 * The ledger row, as the writer has to build it.
 *
 * `migrations/0002_ledger.sql` is the contract; this file is the shape that satisfies it and the
 * arithmetic of the link. Everything here is derivable from that migration, and nothing here is
 * allowed to disagree with it — where the two could drift, the comment says which one governs.
 *
 * **What the database checks, and what it leaves to the writer.** The trigger `ledger_link()`
 * verifies that `prev_hash` is the current head of the run, that `seq` advances past it, and that
 * an `agent_call` row carries all eight columns that describe the call it made; the constraint
 * `ledger_hash_shape` verifies that `row_hash` is sixty-four hex characters and is not equal to
 * `prev_hash`. None of that is a check that `row_hash` is the *right* digest — the database cannot
 * take a digest of a row it is in the middle of inserting. So the writer computes it, and this file
 * exports the same function twice over: once as `linkRow`, which the writer calls, and once as
 * `verifyRowHash`, which an auditor calls against a row read back out. A chain whose verifier is a
 * different implementation from its writer is a chain nobody has actually checked.
 *
 * **What "the row without hashes" means, said out loud.** The migration writes the rule as
 * `row_hash = sha256(prev_hash || canonical_json(row without hashes))`. Two of the row's columns
 * are the chain itself and are excluded: `prev_hash`, which is already the prefix of the digest,
 * and `row_hash`, which is the digest. The other four columns whose names end in `_hash` —
 * `input_hash`, `prompt_hash`, `response_hash`, `state_hash` — are *content*, they are the whole
 * reproducibility block in condensed form, and excluding them would leave exactly the part of the
 * row that matters unprotected by the chain. They stay in. `id` is excluded because it is assigned
 * by the sequence during the insert and cannot be known before it.
 *
 * **`ts` is supplied, never defaulted.** The column has `default now()`, and a row whose timestamp
 * the database chose is a row whose digest the writer could not have taken over its timestamp. The
 * writer sets it.
 */

import { canonicalJson, digestOf, sha256Hex, isHex64 } from '../canonical.ts';
import type { Json } from '../canonical.ts';

/** The nine row classes of `ledger_class`, in the order the enum declares them. */
export type LedgerClass =
  | 'agent_call'
  | 'start'
  | 'promotion_attempt'
  | 'modification_event'
  | 'commitment'
  | 'prereg_anchor'
  | 'agreement_r3'
  | 'kb_admission'
  | 'checkpoint';

/** `agent_kind`, after `0002` adds the harness's own identity to it. */
export type AgentKind = 'triage' | 'draft' | 'validate' | 'evolve' | 'system';

export const GENESIS = 'GENESIS';

/**
 * Every column of `ledger_entry` except `id`, `prev_hash` and `row_hash`.
 *
 * The eight nullable columns are nullable here for the same reason they are nullable there: they
 * describe a model call, and eight of the nine classes describe something else. For `class =
 * 'agent_call'` the check constraint reinstates all eight, so a null in any of them is not a
 * looser row — it is a rejected one.
 */
export type LedgerRowContent = {
  run_id: string;
  seq: number;
  org_id: string;
  ticket_id: string | null;
  agent: AgentKind;
  prompt_version_id: string | null;
  model_requested: string | null;
  model_returned: string | null;
  sampling: Json | null;
  seed: number | null;
  input_hash: string | null;
  input_path: string | null;
  prompt_hash: string | null;
  response_hash: string | null;
  state_hash: string;
  split_id: string | null;
  toolchain: Json;
  restarts: number;
  tokens_in: number;
  tokens_out: number;
  /** `numeric(12,6)`, as text. See `formatAud` for why it is never a number here. */
  cost_aud: string;
  latency_ms: number;
  cum_tokens: number;
  class: LedgerClass;
  output: Json;
  /** `numeric(4,3)`, as text, or null. */
  confidence: string | null;
  /** ISO 8601, UTC, millisecond precision. Supplied by the writer, never defaulted. */
  ts: string;
};

/** A row with its place in the chain worked out. */
export type ChainedRow = LedgerRowContent & {
  prev_hash: string;
  row_hash: string;
};

/**
 * The canonical form the digest is taken over: the row's columns as one object, with the two chain
 * columns and the sequence-assigned identifier left out.
 */
export function canonicalRow(row: LedgerRowContent): string {
  const covered: Record<string, Json> = {
    run_id: row.run_id,
    seq: row.seq,
    org_id: row.org_id,
    ticket_id: row.ticket_id,
    agent: row.agent,
    prompt_version_id: row.prompt_version_id,
    model_requested: row.model_requested,
    model_returned: row.model_returned,
    sampling: row.sampling,
    seed: row.seed,
    input_hash: row.input_hash,
    input_path: row.input_path,
    prompt_hash: row.prompt_hash,
    response_hash: row.response_hash,
    state_hash: row.state_hash,
    split_id: row.split_id,
    toolchain: row.toolchain,
    restarts: row.restarts,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    cost_aud: row.cost_aud,
    latency_ms: row.latency_ms,
    cum_tokens: row.cum_tokens,
    class: row.class,
    output: row.output,
    confidence: row.confidence,
    ts: row.ts,
  };
  return canonicalJson(covered);
}

export function rowHash(prevHash: string, row: LedgerRowContent): string {
  return sha256Hex(prevHash + canonicalRow(row));
}

/** Attaches the row to the head of its chain. `null` head means this row opens the run. */
export function linkRow(row: LedgerRowContent, head: { row_hash: string } | null): ChainedRow {
  const prev_hash = head ? head.row_hash : GENESIS;
  const linked = { ...row, prev_hash, row_hash: rowHash(prev_hash, row) };

  // `ledger_hash_shape` rejects a row that closes a trivial loop on itself. A sha256 collision with
  // its own input is not a thing that happens, so this can only fire on a caller that handed us a
  // `prev_hash` it made up — which is worth catching here rather than as a constraint violation
  // eight frames away.
  if (linked.row_hash === linked.prev_hash) {
    throw new Error('linkRow: the row hashes to its own predecessor');
  }
  return linked;
}

/**
 * Recomputes the digest of a row read back out of the database and compares it to the stored one.
 *
 * Two things the caller has to get right, and they are the same two things the writer got right:
 * `cost_aud` and `confidence` must be rendered at the scale their columns declare (six and three
 * decimal places), and `ts` must be rendered as the same ISO 8601 instant in UTC. A row read with
 * a driver that hands back numbers and `Date` objects has to be put back into that form before it
 * can be checked; `rowFromDatabase` in the store does exactly that, and is the only conversion this
 * tree performs.
 */
export function verifyRowHash(row: ChainedRow): boolean {
  return isHex64(row.row_hash) && rowHash(row.prev_hash, row) === row.row_hash;
}

/**
 * `state_hash` — the digest of the three things that, together, decide what the system would do
 * with this input: the version of the schemas it validates against, the hash of the rules in force,
 * and the snapshot of the knowledge base it may cite. Two rows with the same `input_hash` and
 * different `state_hash` are not comparable, and that is precisely what the column is for.
 */
export function stateHash(state: {
  schema_version: string;
  ruleset_hash: string;
  kb_snapshot: string;
}): string {
  return digestOf({
    schema_version: state.schema_version,
    ruleset_hash: state.ruleset_hash,
    kb_snapshot: state.kb_snapshot,
  });
}
