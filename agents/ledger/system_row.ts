/**
 * The writer of the rows that are not model calls.
 *
 * Eight of the nine row classes describe something the system did without asking anybody: an
 * admission into the knowledge base, a commitment made before the run it constrains, an anchor of
 * the chain head. They belong in the same chain as the model calls — that is what makes the chain a
 * record of what happened rather than a record of what was spent — and until now nothing could
 * write one, because the only writer in the tree was the model chokepoint and the chokepoint's
 * whole shape is "redact, attest, price, call, record".
 *
 * **This is not the gateway and must never become it.** They share the store and they share the
 * chain, and that is the whole of what they share. A caller here has already decided that a fact is
 * true and is recording it; a caller there is asking a question it has not yet paid for. If this
 * file ever grows a provider, a price or a redactor, the seam that makes "there is exactly one path
 * to a model" checkable has been erased by the file that exists because that path was not needed.
 *
 * ## What is fixed rather than accepted
 *
 * `agent`, `tokens_in`, `tokens_out`, `cost_aud`, `latency_ms` and `restarts` are hardwired and are
 * **not parameters**. The schema requires them to be zero for every non-model class, so a parameter
 * would be a parameter whose only legal value is the one already written here — and an illegal one
 * would inflate the consumption figure that the ceiling recomputes from the chain. A caller that
 * could pass a cost is a caller that could raise the budget by writing a row, which is the one
 * thing the recompute-from-the-chain design exists to prevent.
 *
 * `class` excludes three of the nine, and the third exclusion is the one worth explaining.
 * `agent_call` is obvious: this writer produces no reproducibility block, and the check constraint
 * `ledger_agent_call_complete` would refuse the row. `promotion_attempt` and `modification_event`
 * are excluded because `ledger_agent_identity` requires them to carry `agent = 'evolve'`, and the
 * agent here is fixed at `system`. The brief this file was built from named only the first
 * exclusion; the published constraint names the other two, and where the two disagree the
 * constraint governs — a row this writer could construct and the database would refuse is worse
 * than a class this writer declines to write.
 *
 * ## The keys are checked here, before the insert
 *
 * `ledger_link()` already refuses a row whose class-required keys are absent or carry JSON null.
 * Doing it again here is not redundancy for its own sake: a violation caught by the trigger arrives
 * as `E_LEDGER_FILA_INCOMPLETA` from inside a transaction, eight frames from the caller, naming
 * nothing about which key was missing. Caught here it names the key. The table below is transcribed
 * from `migrations/0002_ledger.sql` §3 and the transcription is what the test checks.
 */

import type { Json } from '../canonical.ts';
import { GatewayError } from '../errors.ts';
import { stateHash } from './row.ts';
import type { LedgerClass, LedgerRowContent } from './row.ts';
import type { AppendedRow, LedgerStore } from './store.ts';

/**
 * The classes this writer may produce: everything except the model row and the two the evolution
 * agent signs. See the header for why the exclusion list is three long and not one.
 */
export type SystemLedgerClass = Exclude<
  LedgerClass,
  'agent_call' | 'promotion_attempt' | 'modification_event'
>;

/**
 * The keys each class owns, transcribed from `migrations/0002_ledger.sql` §3.
 *
 * Presence is not enough where the contract says NAMED: a key carrying JSON null names nothing, and
 * the trigger rejects it. The same reading is applied here.
 */
export const CLASS_REQUIRED_KEYS: Readonly<Record<SystemLedgerClass, readonly string[]>> = {
  start: ['attempt_id', 'started_at', 'budget_reserved', 'code_sha'],
  commitment: ['commitment_kind', 'sha256', 'covers', 'committed_before'],
  prereg_anchor: ['document', 'sha256', 'field_count', 'blocks'],
  agreement_r3: ['item_id', 'template_id', 'agreement', 'r', 'rollout_seeds', 'temperature'],
  kb_admission: [
    'admission_id',
    'gap_id',
    'approved_by',
    'snapshot_from',
    'snapshot_to',
    'content_hash',
    'provenance_source',
  ],
  checkpoint: ['seq_covered', 'head_row_hash', 'k'],
};

export type SystemRow = {
  run_id: string;
  org_id: string;
  /** Null for a row that belongs to no ticket, which most of these do. */
  ticket_id?: string | null;
  class: SystemLedgerClass;
  /** The keys the class owns, and whatever else the class's own schema admits. */
  output: Json;
  /** The three components whose digest is `state_hash`. Every row pins its state, this one too. */
  state: { schema_version: string; ruleset_hash: string; kb_snapshot: string };
  toolchain: Json;
  /** `agreement_r3` requires one; every other class here leaves it null. */
  split_id?: string | null;
  /** ISO 8601, UTC. The instant the fact was true, supplied by the writer and never defaulted. */
  ts: string;
};

/**
 * Appends one non-model row to the chain of a run.
 *
 * The row is built against the head inside the store's own transaction, exactly as a model row is,
 * so `seq`, `cum_tokens` and `prev_hash` are read and used without a gap between them.
 */
export async function appendSystemRow(store: LedgerStore, row: SystemRow): Promise<AppendedRow> {
  const required = CLASS_REQUIRED_KEYS[row.class];
  if (!required) {
    throw new GatewayError('E_CONFIG_INVALID', 'no key contract is published for this row class', {
      class: row.class,
    });
  }

  const output = row.output;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    throw new GatewayError('E_CONFIG_INVALID', 'the output of a ledger row is a JSON object', {
      class: row.class,
    });
  }

  for (const key of required) {
    const value = (output as { [key: string]: Json })[key];
    if (value === undefined || value === null) {
      throw new GatewayError(
        'E_CONFIG_INVALID',
        `a ${row.class} row must name ${key}, and a key carrying null names nothing`,
        { class: row.class, missing_key: key },
      );
    }
  }

  const state_hash = stateHash(row.state);

  return store.append(row.run_id, row.org_id, (head) => {
    const content: LedgerRowContent = {
      run_id: row.run_id,
      seq: (head?.seq ?? 0) + 1,
      org_id: row.org_id,
      ticket_id: row.ticket_id ?? null,
      // Fixed. See the header: none of the six below is a parameter, and the reason is the ceiling.
      agent: 'system',
      prompt_version_id: null,
      model_requested: null,
      model_returned: null,
      sampling: null,
      seed: null,
      input_hash: null,
      input_path: null,
      prompt_hash: null,
      response_hash: null,
      state_hash,
      split_id: row.split_id ?? null,
      toolchain: row.toolchain,
      restarts: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_aud: '0.000000',
      latency_ms: 0,
      // A row that spends nothing advances nothing: the running total is carried, not incremented.
      cum_tokens: head?.cum_tokens ?? 0,
      class: row.class,
      output,
      confidence: null,
      ts: row.ts,
    };
    return content;
  });
}
