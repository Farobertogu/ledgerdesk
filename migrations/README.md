# Migrations

Forward-only. One numbered file per change; no destructive edits to an applied migration — a correction is a new numbered migration. The schema of record is the result of applying all files in order on a clean database.

| File | Contents |
|---|---|
| `0001_core.sql` | report schema, types, the immutability function, the fourteen core tables, the queue index, non-ledger RLS, the four roles and their grants |
| `0002_ledger.sql` | ledger type and table, chain and append-only triggers, the row-class contract, ledger RLS and grants, checkpoint anchoring, the two knowledge-gap foreign keys |
| `0003_kb_admission.sql` | knowledge-base admission record |
| `0004_eval_outcome.sql` | per-item evaluation outcomes (must exist before the first sealed run) |

## Applying them

`ci/db_check.sh` applies the four files in order to a clean database and runs the named database tests; the `db` job of CI runs it against a PostgreSQL 16 service container. Two details are not optional:

- **Statement by statement, not one transaction per file.** `0002` adds a value to `agent_kind` and then uses it in a check constraint, and PostgreSQL refuses a new enum value inside the transaction that added it.
- **The platform objects come first.** The migrations grant to and revoke from the roles the managed platform provides, and the policies read request claims through its `auth` schema. On a bare server those objects come from `ci/sql/00_platform_shim.sql`, which is a test fixture and deliberately not a migration: keeping it out of this directory is what lets the applied schema stay equal to the published one in both directions.

The four roles the set creates are cluster-wide rather than per-database, so a second clean application needs them dropped first — `ci/db_check.sh` does that between its two runs, which is how `test_MIGRATIONS_forward_only_is_deterministic` gets two independent applications to compare.
