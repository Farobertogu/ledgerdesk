# ADR-020 · The ledger writer's sequence grant

**Status:** accepted · **Decision date:** 2026-08-22

## Context

The complete schema grants `app_rw` `insert, select` on `ledger_entry`, whose primary key is a `bigserial`. Evaluating that default calls `nextval` on `ledger_entry_id_seq`, and sequence usage is a separate privilege that no migration granted — so the role the schema names as the ledger writer could not write a single row. The gateway build surfaced it on first contact: it is the first code to insert a ledger row as `app_rw`; every application table takes caller-supplied UUIDs, which is why nothing hit the gap earlier. Writing as the table owner instead was rejected: it would place every row outside the row-level-security policy that is supposed to admit it.

## Decision

`0006_ledger_writer_sequence.sql`: `grant usage on sequence ledger_entry_id_seq to app_rw;` — one line, nothing else. The harness-only compensation file is retired in the same change; the gateway harness applies migrations and nothing else, and the golden schema is regenerated so the both-directions diff records the grant.

## Consequences

The ledger's write path works from a clean clone by applying `migrations/` in order, under the policies — no scaffolding, no owner-role bypass. Known and deliberately deferred: a run spanning two organisations still cannot chain (head reads run under RLS and see one tenant); single-tenant runs — everything current increments produce — are unaffected, and the general case arrives, if a consumer ever needs it, as security-definer accessors in a migration of its own.
