# ADR-021 · The audit table's writer

**Status:** accepted · **Decision date:** 2026-08-22

## Context

`audit_event` exists since the first migration with everything an audit surface needs — org scoping, tenant RLS, append-only locks, and its own hash chain — and no grant to any role: the application could not write a single audit row. The gap surfaced during the gateway's adversarial review: a canary that fails to redact is a first-order security event, the reviewer's finding was that it only threw a typed error and left no durable trace, and the natural landing table turned out to be unwritable. The same gap would have blocked the triage agent's audit trail and the audit-log console in turn.

## Decision

`0007_audit_writer.sql`, two lines: `insert, select` on `audit_event` and `usage` on its id sequence, both to `app_rw` — the same single writing role, under the same tenant claims, that writes the ledger. No update, no delete, no truncate: the append-only locks stay untouched. The gateway wires its security events (`canary not redacted`, `egress leak detected`, `budget cut`) onto this surface in the same change, with a test that reads the row back through the tenant policy.

## Consequences

Security events have a durable, chained, tenant-scoped home from the first increment that produces them. The golden schema gains exactly the two grant lines.
