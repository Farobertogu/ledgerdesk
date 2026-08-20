# ADR-018 · Complete database schema and ledger contract

**Status:** accepted · **Decision date:** 2026-08-21

## Context

The specification's migration set did not apply on a clean database: three tables referenced by NOT NULL foreign keys had no DDL (`prompt_version`, `eval_split`, `kb_gap`), the `quality_report` schema was revoked and used but never created, and `ledger_entry` had row-level security enabled without policies. Separately, the ledger contract did not admit the row classes the design requires beyond agent calls — promotion attempts, modification events, commitment rows, the pre-registration anchor, calibration agreements — and had no start-of-run class and no anchoring of the chain head. A badly modelled ledger is lost, not migrated: this must be right before the first row is written.

## Decision

1. **Migration order, forward-only.** `0001_core.sql`: `create schema quality_report`; types `user_role`, `ticket_state`, `agent_kind`, `kb_gap_state`; the immutability trigger function; the seven core tables (`org`, `app_user`, `account`, `sla_policy`, `ticket`, `response`, `human_edit`) and the seven previously missing tables (`prompt_version`, `eval_split`, `eval_item`, `eval_result`, `kb_article`, `audit_event`, `kb_gap`); non-ledger RLS and grants. `0002_ledger.sql`: the `ledger_class` type and `ledger_entry` with its class contract; append-only triggers; ledger RLS, policies and grants; `ledger_checkpoint` with the same append-only locks; the two `kb_gap` → ledger foreign keys. `0003_kb_admission.sql` and `0004_eval_outcome.sql` as published. **`0004` must exist before the first sealed run; the data it holds cannot be produced afterwards.**
2. **Four database roles.** `app_rw` (application), `quality_ro` (pure reader), `quality_gen` (corpus generator: the declared writer of `eval_item`), `quality_eval` (evaluator: the declared writer of `eval_result`). The read-only test names exactly these two write exceptions and fails if a third appears.
3. **`ledger_class` has nine values**: `agent_call`, `start`, `promotion_attempt`, `modification_event`, `commitment`, `prereg_anchor`, `agreement_r3`, `checkpoint`, `kb_admission`. Each non-model class carries its own required payload keys or declared sentinel values; a free-form row is invalid by check constraint.
4. **Run accounting.** Every run opens with a `start` row; the invariant `starts == terminals` (promoted / rejected / aborted) is testable; an aborted generation still consumes budget.
5. **Chain-head anchoring.** A `checkpoint` row every K content rows (K is the sealed sizing field of the same name), plus an external witness file `reports/ledger_anchor.log` committed to the repository; a closing row records the final row count. Rewriting repository history would destroy the witness, and is prohibited by process.
6. **Schema conformance test.** The migration test compares the applied clean-database state against the full published schema in both directions, with an exception list that starts empty; a sibling test asserts the migration set applies forward-only and deterministically.

## Consequences

The first code card (data spine) can be built and merged with this ADR as its authority; any later change to `migrations/` requires a new accepted ADR by the process gate. The ledger's shape is now fixed before any row exists — the alternative, migrating a mis-modelled ledger, was rejected as impossible by definition.
