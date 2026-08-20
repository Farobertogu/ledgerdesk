# Migrations

Forward-only. One numbered file per change; no destructive edits to an applied migration — a correction is a new numbered migration. The schema of record is the result of applying all files in order on a clean database.

| File | Contents |
|---|---|
| `0001_core.sql` | schema, types, core tables, non-ledger RLS and grants |
| `0002_ledger.sql` | ledger type and table, append-only triggers, ledger RLS and grants, checkpoint anchoring |
| `0003_kb_admission.sql` | knowledge-base admission record |
| `0004_eval_outcome.sql` | per-item evaluation outcomes (must exist before the first sealed run) |
