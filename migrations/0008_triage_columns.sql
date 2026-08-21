-- 0008_triage_columns.sql — the columns a triage verdict needs, and the writer's last missing grant.
-- Forward-only: once applied this file is never edited; a correction is a new numbered migration.
-- Authority: adr/ADR-023-triage-columns.md.
--
-- Four columns and one index. Each of them exists because a value the triage cycle computes had
-- nowhere honest to live: the composite priority, the escalation reason, the clause that produced
-- it, and the digest that lets the intake recognise a body it has already accepted.

-- ---------------------------------------------------------------------------
-- 1 · priority — the stored composite score
-- The algorithm fixes the score at six decimal places before it becomes an ordering key
-- (src/alg/priority.ts, PRIORITY_DECIMALS), so the column carries six. The score is a convex
-- combination of terms that are each normalised onto [0,1] with weights summing to 1, so it
-- cannot leave [0,1]; the type is wider than that and the check is what states the range, since
-- a numeric(9,6) would accept 42 without complaint and an ordering key of 42 is not a priority.
-- ---------------------------------------------------------------------------
alter table ticket add column priority numeric(9,6) null check (priority between 0 and 1);

-- ---------------------------------------------------------------------------
-- 2 · escalation_reason and escalation_clause — the two halves of a recorded verdict
--
-- BOTH are stored, and the reason they are not one column is that they answer different
-- questions. The reason is what a report counts: one index from a closed alphabet of eight. The
-- clause is what an auditor re-runs: the stable name of the predicate that fired. They are in
-- one-to-one correspondence today and the rule's type does not promise they always will be — one
-- reason may come to carry more than one clause — so the record keeps both rather than deriving
-- one from the other later and discovering the derivation was never a function.
--
-- text with a check, and deliberately not an enum. The alphabet is closed at eight and a ninth
-- index is a dated decision, not a builder's choice; when one is taken, a check constraint is
-- rewritten inside a transaction and an enum value is not removable at all. The check transcribes
-- src/alg/escalation.ts (ESCALATION_REASONS) literally.
-- ---------------------------------------------------------------------------
alter table ticket add column escalation_reason text null
  check (escalation_reason in ('CONF','SENT','TIER','RETRY','SLA','GROUND','POLICY','LANG'));

alter table ticket add column escalation_clause text null;

-- The invariant, and it is deliberately one-directional: a ticket in ESCALATED carries both the
-- reason and the clause, and a ticket that has left ESCALATED keeps whatever it carried. An
-- escalation that a supervisor then resolves is still an escalation that happened, and a
-- constraint that cleared the record on the way out would destroy the only column-level evidence
-- of why a person was ever asked to look.
alter table ticket add constraint ticket_escalated_has_reason check (
  status <> 'ESCALATED'
  or (escalation_reason is not null and escalation_clause is not null));

-- ---------------------------------------------------------------------------
-- 3 · body_sha256 — the digest the intake deduplicates on
--
-- Lowercase hex of the sha256 of the body exactly as it is persisted, computed in Node by the
-- intake. Nullable and NOT backfilled: computing it in SQL would need pgcrypto, which is an
-- extension this schema does not require, and the rows that predate this migration are seed rows
-- and demonstration rows whose duplication nobody is trying to absorb. The consequence is stated
-- rather than discovered — a row with a null digest never participates in the collapse, on either
-- side of it.
--
-- The index carries created_at descending because the lookup is always "the most recent row of
-- this organisation with this digest", and the ordering is the half of that sentence an index on
-- the two equality columns alone would leave to a sort.
-- ---------------------------------------------------------------------------
alter table ticket add column body_sha256 text null;

create index ticket_body_sha256_idx on ticket (org_id, body_sha256, created_at desc);

-- ---------------------------------------------------------------------------
-- 4 · the triage writer registers its own prompt
--
-- Same shape of gap as ADR-020 and ADR-021, found the same way — by building the first component
-- that needed it. ledger_entry.prompt_version_id is NOT NULL and references prompt_version, so a
-- model call cannot be recorded until the prompt it ran under is a row; 0001 granted app_rw
-- SELECT on prompt_version and nothing else, so the role the schema names as the writer of agent
-- calls could read prompts and never register the one it was about to run.
--
-- INSERT only. The table already refuses everything else by mechanism: the immutability trigger
-- rejects any UPDATE other than promoted_at, and DELETE and TRUNCATE are revoked. Promotion is a
-- later increment's gate and needs no grant here.
-- ---------------------------------------------------------------------------
grant insert on prompt_version to app_rw;
