/**
 * The security events of the chokepoint, and the chain they are written into.
 *
 * **Why these events go somewhere durable at all.** A canary that fails to redact means the
 * redactor stopped working, on a live call, carrying a real ticket. Raising a typed error tells the
 * caller, and the caller escalates one ticket and moves on; nothing anywhere records that the
 * control fired. The next person to ask "has this ever happened?" would have no way to answer, and
 * an answer of "we would have noticed" is the answer that is always given and never true. So the
 * event lands in `audit_event`, which is org-scoped, append-only by trigger, and chained — the same
 * three properties that make the ledger evidence rather than logging.
 *
 * **Best effort, and deliberately so.** Recording the event must never change what the caller sees.
 * If the audit write fails, the original `GatewayError` still comes out, unchanged and untouched:
 * a redaction failure that could not be filed is still a redaction failure, and swallowing it in
 * favour of a database error would replace a security signal with an infrastructure one. The audit
 * failure is written to the process log and the call fails for the reason it actually failed.
 *
 * **Nothing that caused the event travels with it.** `detail` carries kinds and counts and the
 * figures of the ceiling. It never carries the value that was caught — an `E_PII_EGRESS` row
 * quoting the address it stopped would put that address in the audit table, permanently, by way of
 * the control that exists to keep it out. The rows below are assembled from an explicit list of
 * fields for that reason, rather than by spreading whatever the error happened to hold.
 *
 * **The chain is per organisation, not per run.** `audit_event` has no `run_id`; its trigger reads
 * the head of the calling organisation, ordered by `id`, and its unique index is on
 * `(org_id, prev_hash)`. The writer's obligations are otherwise identical to the ledger's, and for
 * identical reasons: it computes `row_hash`, because a trigger cannot digest a row it is inserting,
 * and it supplies `ts`, because a timestamp the database chose is one the digest could not cover.
 */

import { canonicalJson, sha256Hex, isHex64 } from './canonical.ts';
import type { Json } from './canonical.ts';

export const AUDIT_GENESIS = 'GENESIS';

/** Every column of `audit_event` except `id`, `prev_hash` and `row_hash`. */
export type AuditEventContent = {
  org_id: string;
  /** Null: the writer is the system's own path to the model, not a person. */
  actor_id: string | null;
  /** The typed code of the event. The register in `errors.ts` is the closed alphabet. */
  action: string;
  object_type: string;
  object_id: string;
  detail: Json;
  /** ISO 8601, UTC, millisecond precision. Supplied by the writer, never defaulted. */
  ts: string;
};

export type ChainedAuditEvent = AuditEventContent & {
  prev_hash: string;
  row_hash: string;
};

export function canonicalAuditRow(row: AuditEventContent): string {
  return canonicalJson({
    org_id: row.org_id,
    actor_id: row.actor_id,
    action: row.action,
    object_type: row.object_type,
    object_id: row.object_id,
    detail: row.detail,
    ts: row.ts,
  });
}

export function auditRowHash(prevHash: string, row: AuditEventContent): string {
  return sha256Hex(prevHash + canonicalAuditRow(row));
}

export function linkAuditRow(
  row: AuditEventContent,
  head: { row_hash: string } | null,
): ChainedAuditEvent {
  const prev_hash = head ? head.row_hash : AUDIT_GENESIS;
  return { ...row, prev_hash, row_hash: auditRowHash(prev_hash, row) };
}

/** The auditor's half: recompute the digest of a row read back and compare it to the stored one. */
export function verifyAuditRowHash(row: ChainedAuditEvent): boolean {
  return isHex64(row.row_hash) && auditRowHash(row.prev_hash, row) === row.row_hash;
}

/**
 * Where a security event goes.
 *
 * One operation, and it is not optional on the gateway's configuration. A sink that a caller may
 * leave out is a sink the next caller leaves out, and the events that then vanish are exactly the
 * ones nobody would notice were missing — which is the failure mode this whole component is built
 * to avoid, reproduced one layer up.
 */
export interface AuditSink {
  record(event: AuditEventContent): Promise<{ id: string; row_hash: string }>;
}
