# Migrations

Forward-only. One numbered file per change; no destructive edits to an applied migration — a correction is a new numbered migration. The schema of record is the result of applying all files in order on a clean database; the table below lists every file in the set.

| File | Contents |
|---|---|
| `0001_core.sql` | report schema, types, the immutability function, the fourteen core tables, the queue index, non-ledger RLS, the four roles and their grants |
| `0002_ledger.sql` | ledger type and table, chain and append-only triggers, the row-class contract, ledger RLS and grants, checkpoint anchoring, the two knowledge-gap foreign keys |
| `0003_kb_admission.sql` | knowledge-base admission record |
| `0004_eval_outcome.sql` | per-item evaluation outcomes (must exist before the first sealed run) |
| `0005_app_access.sql` | the application role's grants and the staff-only ticket write policy |
| `0006_ledger_writer_sequence.sql` | the ledger writer's sequence grant |
| `0007_audit_writer.sql` | the audit writer's grants |
| `0008_triage_columns.sql` | the priority, escalation reason and clause with their one-directional invariant, the body digest and its index, and the triage writer's prompt grant |
| `0009_kb_retrieval.sql` | the snapshot pointer, an immutable knowledge base, the answer's evidence columns and its citations as composite references, the application role's knowledge-base grants and the staff-only write policies, the gap's closure and its unreachable state, `kb_snapshot_advance`, the two ticket-state triggers, and the cross-tenant approver made unrepresentable |
| `0010_kb_gap_cycle.sql` | the gap-record writer, the advance re-signed to derive everything from the row of the chain and to write the admission with it, the closure by verification, the revocation of every callable definer function from PUBLIC, `select` on `kb_admission`, the staff-only read policy on `kb_gap`, the admission's reference to the article it admitted, four bounds that were prose, and one ledger row per admission by index |

## Every `security definer` function carries its own revocation

**A standing rule from `0010`, and it is a rule because the language's default is the opposite of what this schema wants.** `create function` grants EXECUTE to PUBLIC. A `security definer` function is therefore, on the day it is written, a privilege escalation available to every role in the cluster unless the migration that creates it says otherwise — and for three migrations nobody said otherwise. What that cost was measured rather than supposed: the application role could write articles into another organisation's corpus and move that organisation's snapshot pointer, with no approver, no admission and no row in any chain.

So: **every migration that creates a `security definer` function revokes EXECUTE from `public` in the same file**, and grants it to the role that needs it — by name, one grant per caller, or to nobody at all when the function exists for the owner and the tests. `test_SEC_kb_definer_functions_are_not_public` sweeps `pg_proc` rather than a list, so a function added without its revocation fails the build instead of waiting to be noticed.

Trigger functions are outside the rule and outside the sweep, and the exclusion is written here rather than left to be inferred: a trigger function is not callable — invoking one directly raises *trigger functions can only be called as triggers* — so its EXECUTE privilege grants nobody anything, while revoking it would change the conditions under which every existing trigger was created.

## Applying them

`ci/db_check.sh` applies every file above, in order, to a clean database and runs the named database tests; the `db` job of CI runs it against a PostgreSQL 16 service container. The list it applies is derived from disk rather than kept by hand — a migration nobody adds to an array is a migration that never runs. Two details are not optional:

- **Statement by statement, not one transaction per file.** `0002` adds a value to `agent_kind` and then uses it in a check constraint, and PostgreSQL refuses a new enum value inside the transaction that added it.
- **The platform objects come first.** The migrations grant to and revoke from the roles the managed platform provides, and the policies read request claims through its `auth` schema. On a bare server those objects come from `ci/sql/00_platform_shim.sql`, which is a test fixture and deliberately not a migration: keeping it out of this directory is what lets the applied schema stay equal to the published one in both directions.

The roles the set creates are cluster-wide rather than per-database, so a second clean application needs them dropped first — `ci/db_check.sh` does that between its two runs, which is how `test_MIGRATIONS_forward_only_is_deterministic` gets two independent applications to compare.

The applied schema is then diffed, in both directions and with no exception list, against `ci/expected/schema.sql`. That file is the committed record of what this set produces; see `ci/expected/README.md` for how to generate it.

## Carrying a database forward across the envelope contract change

`0009` lands together with a correction to the published agent output contract, and that correction moves `AGENT_IO_SCHEMA_SHA256`. `prompt_version.schema_hash` holds that digest and the row is immutable by trigger, so a database that already carries the triage prompt would otherwise refuse to start: the standing registration describes a contract this build no longer publishes, and the process raises `E_PROMPT_NO_REGISTRADO`.

**Nothing has to be done by hand, and two things must not be done at all.**

The composition root registers the whole lineage of each agent's prompt — not only the generation it is about to run under — when it first builds an organisation's runtime. That is lazy and per organisation rather than something that happens at start-up, and it is idempotent, so the second organisation to start finds what the first wrote. Generation 0 of the triage prompt is checked against the digest it was originally registered with — pinned as a literal in `agents/triage/prompt.ts` — and left exactly as it is; generation 1 is inserted beside it with the same words, the new digest, and generation 0 as its parent. On a clean database both rows are inserted; on a database carried forward, only the second is. There is no branch anywhere asking which kind of database it is.

Prohibited, and both are quicker than reading this paragraph:

- **Editing or deleting a row of `prompt_version`.** The table is immutable by trigger for a reason: the ledger rows naming generation 0 were produced under generation 0's contract, and a row that changed its digest afterwards would make every one of them describe a contract it never ran under.
- **Dropping the database to make the error go away.** That destroys the evidence of every run so far in order to avoid registering one row.

The declared consequence is a cache, not a loss: the chokepoint's cache key includes `prompt_version_id`, so answers recorded under generation 0 stop being reachable as hits. The rows remain and remain readable, and `state_hash` moves in the same release for two further reasons anyway — the knowledge-base snapshot is now read from the database instead of a sentinel, and the ruleset digest gained the retrieval's parameters.
