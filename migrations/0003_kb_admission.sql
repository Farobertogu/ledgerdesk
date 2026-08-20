-- 0003_kb_admission.sql · one row per admission of new material into the knowledge base.
-- Forward-only; it changes no table of the ledger or of the sealing contract.
-- Authority: adr/ADR-018-complete-schema.md.
--
-- What the four load-bearing fields buy: gap_id and ledger_ref make a verified closure
-- auditable end to end — gap opened, material admitted with provenance and a human approver,
-- query re-run against snapshot_to, grounded = true. content_hash makes the admitted body
-- comparable across runs. snapshot_from -> snapshot_to is what keeps replay intact, and the
-- check forbids the degenerate admission that pretends to change nothing.

create table kb_admission (
  id             uuid        primary key,
  org_id         uuid        not null references org(id),
  gap_id         uuid        not null references kb_gap(id),   -- the gap record that opened it
  approved_by    uuid        not null references app_user(id), -- HUMAN approver; there is no automatic path
  snapshot_from  text        not null,                         -- kb_snapshot before the admission
  snapshot_to    text        not null,                         -- kb_snapshot after it
  content_hash   text        not null,                         -- sha256 of the admitted body
  provenance     jsonb       not null,                         -- source, obtained_at, citability
  ledger_ref     bigint      not null references ledger_entry(id),  -- the row that recorded the admission
  admitted_at    timestamptz not null default now(),
  check (snapshot_from <> snapshot_to)
);
alter table kb_admission enable row level security;
create policy tenant_isolation_kb_admission on kb_admission
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
