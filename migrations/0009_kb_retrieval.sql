-- 0009_kb_retrieval.sql — the knowledge base becomes a thing the system reads, and the guards that
-- were conventions become mechanisms.
-- Forward-only: once applied this file is never edited; a correction is a new numbered migration.
-- Authority: adr/ADR-024-kb-retrieval-and-draft.md.
--
-- Eight sections. Four of them add somewhere for a value to live; four of them take a sentence that
-- was true only because nobody had tried the other thing, and make it true because the database
-- refuses the other thing.

-- ---------------------------------------------------------------------------
-- 1 · kb_snapshot_head — which snapshot is in force, for one organisation
--
-- A POINTER and not a derivation, and the difference is not stylistic.
--
-- The obvious derivation is "the snapshot of the most recent admission", and it fails on the first
-- organisation that has never admitted anything: it has a corpus, it has a snapshot, and it has no
-- admission row to derive one from. The second derivation is `max(kb_article.kb_snapshot)`, and it
-- fails on the ordering — snapshot labels are dates today and nothing says they always will be, so
-- `max` over text is an alphabetical accident that happens to agree with time. The third is an
-- environment variable, which puts the identity of the corpus a run cites outside the database that
-- holds the corpus.
--
-- One row per organisation, written by a migration or by kb_snapshot_advance() and by nothing else.
-- set_by names the ledger row that moved it, so the question "under whose authority did the corpus
-- change" has an answer that is not a timestamp.
-- ---------------------------------------------------------------------------
create table kb_snapshot_head (
  org_id       uuid        primary key references org(id),
  kb_snapshot  text        not null,
  set_by       bigint          null references ledger_entry(id),  -- the row that moved it
  set_at       timestamptz not null default now()
);
alter table kb_snapshot_head enable row level security;
create policy tenant_isolation_kb_snapshot_head on kb_snapshot_head
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- Every organisation that already exists gets the snapshot its articles were written under.
--
-- On a CLEAN database this statement matches nothing, because migrations run before any seed and
-- there are no organisations yet — the seed creates each organisation and its head together, which
-- is where that pairing belongs, since a head is data and not schema. On a database carried forward
-- from the previous increment there ARE organisations, and this is the backfill that gives them a
-- head without anybody having to remember to run something.
--
-- Both paths end with every organisation holding a head, and neither path is a special case in any
-- code: `snapshotHeadFor` reads the pointer and the sentinel `kb:none` is reserved for an
-- organisation that genuinely has no corpus at all.
insert into kb_snapshot_head (org_id, kb_snapshot)
  select id, 'kb-2026-08-01' from org
  on conflict (org_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2 · kb_article — immutable, and identifiable across snapshots
--
-- Immutable because a snapshot label is a promise that the bodies under it do not move. Editing a
-- body without changing the label does not break anything visibly: the replay still runs, the cache
-- still answers, and every row written before the edit now claims to have cited a document that no
-- longer exists. The same argument the ledger is append-only for, applied to the thing the ledger
-- cites. Same shape as ledger_immutable: a row trigger for UPDATE and DELETE, and a statement
-- trigger for TRUNCATE, which a row trigger never sees and the revoke never reaches for the owner.
--
-- unique (id, kb_snapshot) is the destination of the composite foreign key in §3. The table already
-- carries unique (kb_snapshot, canonical_key, id); this is the other projection, and it is the one
-- that makes "cite article X as it stood under snapshot S" expressible as a reference.
--
-- The check on canonical_key is what lets the identifier that travels to a model be built from it:
-- kb_id is `<canonical_key>:<id>`, and the published contract restricts a kb_id to
-- [A-Za-z0-9:_/-]. A key outside this alphabet would produce an identifier the envelope validator
-- refuses, which is a retrieval that fails at the border for a reason that lives in the corpus.
-- ---------------------------------------------------------------------------
alter table kb_article add constraint kb_article_canonical_key_shape
  check (canonical_key ~ '^[A-Za-z0-9_/-]{1,64}$');

alter table kb_article add constraint kb_article_id_snapshot_key unique (id, kb_snapshot);

create trigger trg_kb_article_no_update before update or delete on kb_article
  for each row execute function ledger_immutable();
create trigger trg_kb_article_no_truncate before truncate on kb_article
  for each statement execute function ledger_immutable();

-- ---------------------------------------------------------------------------
-- 3 · response — the evidence of US-03, and citations that cannot drift
--
-- Five columns and a table. The columns record what the drafting cycle learned: the snapshot the
-- sources came from, the verdict, when it was reached, and the two ledger rows that paid for it.
-- Every one of them is nullable because a response row can exist before it has been validated and
-- because the rows this migration inherits have none of it.
--
-- response_citation is where a citation stops being a list in a JSON blob and becomes a reference.
-- The composite foreign key is the whole point: (kb_article_id, kb_snapshot) into
-- kb_article(id, kb_snapshot) makes "this reply cites article X under snapshot S" a statement the
-- database can refuse. Citing an article under a snapshot it does not exist in — the failure a
-- corpus that moves underneath a stored answer produces, and the one nobody would notice — is not
-- caught by a check somebody has to write. It cannot be written down.
--
-- A re-draft after an admission INSERTS a new row rather than updating the old one, so both are
-- readable side by side and the vigente one is the newest by created_at. That is a property of the
-- writer, not of the schema, and it is stated here because the schema is where somebody will look
-- for a uniqueness constraint that deliberately does not exist.
-- ---------------------------------------------------------------------------
alter table response add column created_at         timestamptz not null default now();
alter table response add column kb_snapshot        text            null;
alter table response add column grounded           boolean         null;
alter table response add column validated_at       timestamptz     null;
alter table response add column draft_ledger_ref   bigint          null references ledger_entry(id);
alter table response add column validate_ledger_ref bigint         null references ledger_entry(id);

-- The claims the validator would not support, quoted from the draft in the draft's own words.
--
-- Beside the draft and NOT in the audit chain, and the distinction is the rule this repository
-- already lives under: `audit_event.detail` never carries any part of what a customer or an agent
-- wrote, because an append-only table is the worst possible place to discover such a thing. These
-- sentences are quotations from `response.draft`, which is in the row above them; putting them here
-- adds no text that is not already stored, and putting them in the chain would have.
alter table response add column unsupported_claims jsonb null;
alter table response add constraint response_unsupported_claims_is_a_list check (
  unsupported_claims is null or jsonb_typeof(unsupported_claims) = 'array');

-- A verdict without the snapshot it was reached under is a verdict nobody can re-run: the same
-- draft against a different corpus is a different question.
alter table response add constraint response_grounded_names_its_snapshot check (
  grounded is null or kb_snapshot is not null);

create index response_ticket_created_idx on response (ticket_id, created_at desc);

create table response_citation (
  response_id    uuid not null references response(id),
  kb_article_id  uuid not null,
  kb_snapshot    text not null,
  primary key (response_id, kb_article_id),
  constraint fk_citation_article foreign key (kb_article_id, kb_snapshot)
    references kb_article (id, kb_snapshot)
);
alter table response_citation enable row level security;
-- No org_id of its own: the tenant is reached through the response and its ticket, exactly as the
-- response's own policies do it.
create policy tenant_isolation_response_citation on response_citation
  using (exists (select 1 from response r join ticket t on t.id = r.ticket_id
                  where r.id = response_citation.response_id
                    and t.org_id = (auth.jwt() ->> 'org_id')::uuid));

-- ---------------------------------------------------------------------------
-- 4 · Grants and policies for the application role
--
-- SELECT on the knowledge base, INSERT and SELECT on the answer. **UPDATE on response is not
-- granted here and must not be**: editing and approving a draft is the agent console's increment,
-- it arrives with its own migration, and a grant handed over early is a grant nobody notices is
-- unused until something uses it.
--
-- The RESTRICTIVE update policy is the more interesting half, and it is written now precisely
-- BECAUSE the grant is not. `auth.uid() is not null` says: whatever role is eventually allowed to
-- update this table, a session with no subject may never do it. The machine actor carries
-- {org_id, role} and NO subject by the decision signed in ADR-023 §8 — so no component of this
-- system, today or after the console's migration lands, can approve or send a reply. The guarantee
-- is made once, here, rather than depending on the increment that opens the door remembering to
-- leave that one shut.
-- ---------------------------------------------------------------------------
grant select on kb_article, kb_gap, kb_snapshot_head to app_rw;
grant insert, select on response, response_citation to app_rw;

create policy draft_agent_inserts on response for insert
  with check ((auth.jwt() ->> 'role') in ('agent', 'supervisor')
              and exists (select 1 from ticket t
                           where t.id = response.ticket_id
                             and t.org_id = (auth.jwt() ->> 'org_id')::uuid));

create policy response_writer_has_a_subject on response as restrictive for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy citation_agent_inserts on response_citation for insert
  with check ((auth.jwt() ->> 'role') in ('agent', 'supervisor')
              and exists (select 1 from response r join ticket t on t.id = r.ticket_id
                           where r.id = response_citation.response_id
                             and t.org_id = (auth.jwt() ->> 'org_id')::uuid));

-- The knowledge base is written by staff and by nobody else. RESTRICTIVE, so these AND with the
-- tenant policies rather than widening them, and deliberately NOT applied to SELECT: retrieval runs
-- under {org_id} with no role at all — what it cannot see it cannot leak, and it has no business
-- holding a claim that would let it write a ticket. A role check on SELECT would make the reader
-- assert a standing it does not need.
create policy kb_article_write_is_staff on kb_article as restrictive for insert
  with check ((auth.jwt() ->> 'role') in ('agent', 'supervisor'));
create policy kb_gap_insert_is_staff on kb_gap as restrictive for insert
  with check ((auth.jwt() ->> 'role') in ('agent', 'supervisor'));
create policy kb_gap_update_is_staff on kb_gap as restrictive for update
  using ((auth.jwt() ->> 'role') in ('agent', 'supervisor'))
  with check ((auth.jwt() ->> 'role') in ('agent', 'supervisor'));
create policy kb_admission_write_is_staff on kb_admission as restrictive for insert
  with check ((auth.jwt() ->> 'role') in ('agent', 'supervisor'));

-- No grant of INSERT on kb_gap and none of UPDATE, today or ever. The gap record is written by
-- kb_gap_open() when the increment that owns it arrives, as a security definer function, and the
-- application role is granted EXECUTE on that function rather than INSERT on the table — which is
-- the pattern ADR-020 and ADR-021 already established for every other writer that has to hold an
-- invariant the table cannot state.

-- ---------------------------------------------------------------------------
-- 5 · The knowledge gap: closing it, and declaring it unclosable
--
-- kb_gap_close_by_check() is recreated as security definer with a pinned search_path, so that the
-- closure is reachable by a role holding EXECUTE on the function and nothing at all on the table,
-- and so the body cannot be redirected through a schema a caller controls.
--
-- What that does NOT do is worth stating, because the obvious reading is wrong: the guard reads a
-- session setting, and `security definer` does not change who may set one. A caller can still put
-- the marker in its own transaction. What makes a hand-written closure impossible is the three legs
-- together — the guard refuses a state change with no marker, the check above refuses a CLOSED row
-- without the witnesses that prove it, and app_rw holds NO UPDATE on this table at all, which is
-- the leg that actually holds. The function is how the closure becomes reachable without one.
--
-- kb_gap_mark_not_documentable() is new, and it exists because half of the requirement was
-- UNREACHABLE. The state kb_gap_state publishes three values; the guard rejects every state change
-- that is not the verified closure; so NOT_DOCUMENTABLE was a value the enum offered and nothing on
-- earth could write. A gap that cannot be answered from any admissible source is a real outcome and
-- it needs a way to be recorded that is not "leave it open forever".
--
-- The reason gets a column, because a function parameter with nowhere to go is a parameter that
-- gets dropped by the first person who reads the function. The check ties the two together in both
-- directions: the state without the reason is refused, and the reason without the state is too.
--
-- unique (ticket_id, query_sha256) turns "exactly one gap record per unanswered query" from a
-- sentence in the requirement into the thing that makes the retry of a failed emission idempotent.
-- ---------------------------------------------------------------------------
alter table kb_gap add column not_documentable_reason text null;

alter table kb_gap add constraint kb_gap_not_documentable_has_a_reason check (
  (state = 'NOT_DOCUMENTABLE') = (not_documentable_reason is not null));

alter table kb_gap add constraint kb_gap_one_record_per_query unique (ticket_id, query_sha256);

create or replace function kb_gap_close_by_check(p_gap uuid, p_ledger bigint)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  perform set_config('ledgerdesk.kb_gap_close', p_gap::text, true);
  update kb_gap set state = 'CLOSED', closed_by_check_at = now(), closing_ledger_ref = p_ledger
   where id = p_gap;
  perform set_config('ledgerdesk.kb_gap_close', '', true);
end $$;

create or replace function kb_gap_mark_not_documentable(p_gap uuid, p_reason text)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'E_KB_GAP_SIN_MOTIVO';
  end if;
  perform set_config('ledgerdesk.kb_gap_close', p_gap::text, true);
  update kb_gap set state = 'NOT_DOCUMENTABLE', not_documentable_reason = p_reason
   where id = p_gap and state = 'OPEN';
  perform set_config('ledgerdesk.kb_gap_close', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- 6 · kb_snapshot_advance — a snapshot is a complete set, never a delta
--
-- The cheap implementation copies only what changed and lets a reader union the new snapshot with
-- the old one. It is wrong in a way that does not announce itself: "the corpus under S'" then means
-- "the rows labelled S' plus the rows labelled S, unless one of them was superseded", which is a
-- join nobody wrote down, and a replay under S' reads a corpus that depends on which other
-- snapshots happen to still be in the table.
--
-- So an advance copies every row of the outgoing snapshot into the incoming one — same key, same
-- title, same body, same digest, new identity — inserts the admitted material beside them, and
-- moves the head. In ONE function, and deliberately not in TypeScript: a partial copy interrupted
-- by a crash leaves a snapshot that looks complete and is not, and there is no constraint anywhere
-- that would notice. Here the whole thing is one statement's worth of atomicity.
--
-- The cost is declared rather than discovered: one copy of the corpus per admission. At the size
-- this system holds a corpus that is the right trade, and the sentence that makes it the right
-- trade — "the replay under S is untouched, forever" — is what is being bought.
-- ---------------------------------------------------------------------------
create or replace function kb_snapshot_advance(
  p_org      uuid,
  p_from     text,
  p_to       text,
  p_admitted jsonb   default '[]'::jsonb,
  p_set_by   bigint  default null)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  copied  integer;
  added   integer := 0;
  item    jsonb;
begin
  if p_from = p_to then
    raise exception 'E_KB_SNAPSHOT_NO_AVANZA';
  end if;
  if exists (select 1 from kb_article where org_id = p_org and kb_snapshot = p_to) then
    raise exception 'E_KB_SNAPSHOT_YA_EXISTE';
  end if;

  insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
  select gen_random_uuid(), org_id, p_to, canonical_key, title, body, body_sha256, citable
    from kb_article
   where org_id = p_org and kb_snapshot = p_from;
  get diagnostics copied = row_count;

  for item in select * from jsonb_array_elements(p_admitted) loop
    insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
    values (gen_random_uuid(), p_org, p_to,
            item ->> 'canonical_key', item ->> 'title', item ->> 'body',
            encode(sha256(convert_to(item ->> 'body', 'UTF8')), 'hex'),
            coalesce((item ->> 'citable')::boolean, true));
    added := added + 1;
  end loop;

  insert into kb_snapshot_head (org_id, kb_snapshot, set_by, set_at)
  values (p_org, p_to, p_set_by, now())
  on conflict (org_id) do update
    set kb_snapshot = excluded.kb_snapshot, set_by = excluded.set_by, set_at = excluded.set_at;

  return copied + added;
end $$;

-- ---------------------------------------------------------------------------
-- 7 · Two states that stop being reachable by writing them
--
-- The state machine publishes AWAITING_AGENT → SENT with the guard "approved_by is not null — a
-- database constraint, not a convention". It was a convention: `no_autosend` on response says a
-- sent_at needs an approved_by, and nothing at all connected either of them to the ticket's state.
-- A component holding the write path could move a ticket to SENT with no response row in existence.
--
-- And DRAFTED → AWAITING_AGENT publishes "the validator reports grounded = true". That is the
-- sentence this whole increment is built to make true, so it is the one that most deserves to be
-- checked by something other than the code that was written to satisfy it.
--
-- security definer, for the reason ledger_link() is: the guard reads a table under whatever
-- policies the caller happens to hold, and a guard whose verdict depends on the reader's claims is
-- a guard with two answers. Reading past the policies gives it one.
-- ---------------------------------------------------------------------------
create or replace function ticket_state_needs_its_evidence() returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.status = 'SENT' and not exists (
       select 1 from response r
        where r.ticket_id = new.id
          and r.approved_by is not null
          and r.sent_at is not null) then
    raise exception 'E_TICKET_ENVIO_SIN_APROBACION';
  end if;

  if new.status = 'AWAITING_AGENT' and not exists (
       select 1 from response r
        where r.ticket_id = new.id
          and r.grounded is true) then
    raise exception 'E_TICKET_ESPERA_SIN_ANCLAJE';
  end if;

  return new;
end $$;

create trigger trg_ticket_state_evidence before insert or update on ticket
  for each row execute function ticket_state_needs_its_evidence();

-- ---------------------------------------------------------------------------
-- 8 · The cross-tenant approver, made unrepresentable
--
-- kb_admission.approved_by references app_user(id) and kb_gap.owner_id does the same, and neither
-- reference says anything about which organisation that user belongs to. A staff member of one
-- tenant could therefore be recorded as the human who approved material into another tenant's
-- corpus — a row that is valid, auditable, signed, and wrong, and which nothing would ever query
-- for because the join it fails is one nobody writes.
--
-- unique (id, org_id) on app_user is not a uniqueness anybody needed; it is the destination a
-- composite foreign key requires. With it, "the approver belongs to the organisation whose corpus
-- this is" stops being a rule the writer applies and becomes a row shape the database will not
-- accept.
-- ---------------------------------------------------------------------------
alter table app_user add constraint app_user_id_org_key unique (id, org_id);

alter table kb_admission add constraint fk_admission_approver_same_org
  foreign key (approved_by, org_id) references app_user (id, org_id);

alter table kb_gap add constraint fk_gap_owner_same_org
  foreign key (owner_id, org_id) references app_user (id, org_id);
