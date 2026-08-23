/**
 * Decisions filed to the organisation's audit chain, by the application's own client.
 *
 * ## Two alphabets in one column, declared rather than blurred
 *
 * `audit_event.action` has carried exactly one closed set so far: the typed failure codes of the
 * model chokepoint, filed when a control fires. A triage cycle also has to file something that is
 * not a failure — the verdict that sent a ticket to a person — and writing `TICKET_ESCALATED` into
 * the same column without saying so would quietly turn a register of errors into a register of two
 * unrelated things, which is exactly the sort of drift a closed alphabet exists to prevent.
 *
 * So this is a **second closed set**, disjoint from the first, recorded in ADR-023 §5. It is
 * lengthened only by amending that record, which ADR-024 does: the drafting cycle files two
 * decisions of its own, and the set goes from two members to four.
 *
 * **What is NOT added, and the distinction is the point.** An escalation raised by the drafting
 * cycle — a retrieval that found nothing, a draft that stood on a source it was never given —
 * reuses `TICKET_ESCALATED`. The action names *what happened to the ticket*, and what happened is
 * that it went to a person; which stage of which cycle decided that is in the detail, where a
 * reader who cares can find it and a tally that counts escalations does not have to know about it.
 * A fifth member `TICKET_GAP_OPENED` is reserved for the increment that emits gap records and is
 * deliberately not taken here, on the same terms as every other reservation in this repository: a
 * value nothing can write is a value nobody can trust.
 *
 * ## Why the row is written here and not through the chokepoint's store
 *
 * The store holds its own pool and opens its own transaction, so a row written through it is a row
 * in a different transaction from the ticket it describes. A crash between the two would leave an
 * escalated ticket with no record of the decision — the one row whose absence nobody would notice,
 * because the ticket looks perfectly normal. Written on the caller's client, inside the caller's
 * transaction, the verdict and the state it produced commit together or neither does.
 *
 * `app_rw` holds insert and sequence usage on `audit_event` from ADR-021, and the chaining trigger
 * links whatever writer arrives — this one computes `row_hash` and supplies `ts` for the same two
 * reasons the ledger's writer does: a trigger cannot digest a row it is inserting, and a timestamp
 * the database chose is one the digest could not have covered.
 *
 * ## Why the row exists at all, when the columns already carry the verdict
 *
 * The columns are overwritable. A ticket that is escalated, resolved, reopened and escalated again
 * carries one reason at a time, and the first one is gone. The chain is append-only, so the full
 * verdict — every clause evaluated, fired or not, under the ruleset that was in force — survives
 * the second escalation. That is what an audit of "why did this ever go to a person" needs and
 * what a column can never be.
 *
 * **`detail` never carries any part of the body.** Kinds, names, thresholds and instants travel;
 * the customer's words do not. Same rule as the failure alphabet, for the same reason: an
 * append-only table is a poor place to discover a customer's words.
 */

import type { PoolClient } from 'pg';

import { canonicalJson } from '@agents/canonical.ts';
import type { Json } from '@agents/canonical.ts';
import { linkAuditRow } from '@agents/audit.ts';

/** The closed set. ADR-023 §5, amended by ADR-024. */
export const DECISION_ACTIONS = [
  'TICKET_TRIAGED',
  'TICKET_ESCALATED',
  /** A draft was produced for a ticket and written with its citations. */
  'TICKET_DRAFTED',
  /** A draft was judged against the sources it was written from, and the verdict recorded. */
  'TICKET_VALIDATED',
] as const;

export type DecisionAction = (typeof DECISION_ACTIONS)[number];

const HEAD = 'select row_hash from audit_event where org_id = $1::uuid order by id desc limit 1';

const INSERT = `
  insert into audit_event (org_id, actor_id, action, object_type, object_id, detail, ts,
                           prev_hash, row_hash)
  values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::timestamptz, $8, $9)
  returning id, row_hash`;

export type Decision = {
  orgId: string;
  action: DecisionAction;
  ticketId: string;
  detail: Json;
  /** ISO 8601, UTC. The instant the decision was taken, not the instant it was written. */
  ts: string;
};

/**
 * Appends one decision to the calling organisation's chain, on the caller's client.
 *
 * `actor_id` is null and stays null: the writer is a component, not a person, and the column is
 * nullable precisely so that a machine actor is not handed somebody's identity.
 *
 * A chain conflict surfaces as the `23505` of `audit_one_child_per_head` and aborts the caller's
 * transaction, which is the correct outcome and not a swallowed one: the caller retries the whole
 * unit, which restores the ticket and re-applies it against the new head. Retrying only the audit
 * row would mean committing a verdict whose record failed.
 */
export async function recordDecision(
  client: PoolClient,
  decision: Decision,
): Promise<{ id: string; row_hash: string }> {
  const head = await client.query<{ row_hash: string }>(HEAD, [decision.orgId]);

  const row = linkAuditRow(
    {
      org_id: decision.orgId,
      actor_id: null,
      action: decision.action,
      object_type: 'ticket',
      object_id: decision.ticketId,
      detail: decision.detail,
      ts: decision.ts,
    },
    head.rows[0] ?? null,
  );

  const inserted = await client.query<{ id: string; row_hash: string }>(INSERT, [
    row.org_id,
    row.actor_id,
    row.action,
    row.object_type,
    row.object_id,
    canonicalJson(row.detail),
    row.ts,
    row.prev_hash,
    row.row_hash,
  ]);

  return inserted.rows[0];
}
