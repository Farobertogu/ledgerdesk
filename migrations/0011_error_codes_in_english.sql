-- 0011_error_codes_in_english.sql — the error codes raised by this schema are renamed to English.
-- Forward-only: once applied this file is never edited; a correction is a new numbered migration.
-- Authority: 0001_core.sql, 0002_ledger.sql, 0009_kb_retrieval.sql,
--             0010_kb_gap_cycle.sql
--             — the migrations that raise these codes. This file records no architectural decision
--             of its own, because it takes none: it renames identifiers and changes no behaviour,
--             and that it changes no behaviour is a checked claim, not an asserted one.
--
-- ## Why a migration exists at all for a rename
--
-- The codes below are raised from inside function bodies, and a body is not a value a later
-- statement can adjust: it is the text of the function. PostgreSQL here is forward-only — an
-- applied migration is never edited — so the only way a raised identifier changes is by SHIPPING
-- THE FUNCTION AGAIN. That is why 45 renamed identifiers cost 9 whole function definitions:
-- the size of this file is the price of the discipline, not the size of the change.
--
-- ## The only change is the identifier, and that is a checked claim rather than an intention
--
-- Every definition below was extracted from its source migration as literal bytes and rewritten by
-- a script that performs one operation: replacing an error code with an error code, word-bounded,
-- everywhere it occurs in the definition — in the literal that is raised and in any comment that
-- names it, because a comment left pointing at a code that no longer exists is not an untouched
-- comment but a false one, and it ships into pg_proc.prosrc like the rest of the body. The script then
-- REVERSES its own substitution and demands the result be byte-identical to what it read. A stray
-- space, a dropped comment, a re-wrapped line or a lost blank line fails that comparison, and the
-- script refuses to emit rather than emitting something plausible. Nothing here was retyped.
--
-- The reason for that machinery is specific and recent. `kb_gap_close_by_verification()` is
-- `security definer`, so row level security does not apply inside it; the line that folds the
-- caller's organisation into the read of the gap is the whole of what stops one tenant closing
-- another tenant's gap. Retyping that body to rename a string beside it is how such a line is lost.
--
-- ## `create or replace`, and never `drop` then `create`
--
-- Two reasons, both load-bearing:
--
--   1. **Privileges.** `create or replace` leaves ownership and the access control list untouched.
--      `drop` + `create` resets the ACL to the language default, and that default GRANTS EXECUTE
--      TO PUBLIC — which is precisely the hole 0010 §5 was written to close. A rename that
--      reopened it would be a regression wearing the clothes of a tidy-up.
--   2. **Triggers.** 4 of these functions are trigger functions with triggers depending on them.
--      `drop function` refuses while a trigger depends on it, and `drop ... cascade` would take
--      the trigger with it. `create or replace` keeps the same `pg_proc` row, so every existing
--      trigger goes on pointing at it and NO TRIGGER IS RECREATED HERE. None is dropped either.
--
-- No signature changes in this file, so no `create or replace` in it can create an overload by
-- accident: each statement replaces the function it names and nothing else.
--
-- ## The privileges are restated anyway
--
-- Section 10 repeats, verbatim from 0010, the revocations and grants covering the functions this
-- file replaces. Under `create or replace` they are a no-op, which is the point: they are
-- idempotent, they cannot loosen anything, and they keep the standing rule of
-- `migrations/README.md` — every migration that ships a `security definer` function carries its
-- own revocation — true of this file read on its own.
--
-- ## What is NOT here
--
-- Callers. The TypeScript that reads these codes, the SQL tests that assert them and the committed
-- schema dump `ci/expected/schema.sql` all move in their own changes; this file is the database
-- half. Applying it alone will fail `test_MIGRATIONS_schema_matches_spec`, because the committed
-- dump still carries the old bodies, and it will fail every test that asserts an old code by name.
--
-- ## The renaming
--
--   E_LEDGER_FILA_INCOMPLETA           ->  E_LEDGER_ROW_INCOMPLETE
--   E_PROMPT_VERSION_INMUTABLE         ->  E_PROMPT_VERSION_IMMUTABLE
--   E_KB_GAP_CIERRE_NO_VERIFICADO      ->  E_KB_GAP_CLOSURE_NOT_VERIFIED
--   E_KB_GAP_SIN_MOTIVO                ->  E_KB_GAP_REASON_MISSING
--   E_KB_SNAPSHOT_NO_AVANZA            ->  E_KB_SNAPSHOT_NOT_ADVANCING
--   E_KB_SNAPSHOT_YA_EXISTE            ->  E_KB_SNAPSHOT_ALREADY_EXISTS
--   E_KB_SNAPSHOT_MOVIDO               ->  E_KB_SNAPSHOT_MOVED
--   E_TICKET_ENVIO_SIN_APROBACION      ->  E_TICKET_SENT_NOT_APPROVED
--   E_TICKET_ESPERA_SIN_ANCLAJE        ->  E_TICKET_AWAITING_NOT_GROUNDED
--   E_KB_HUECO_ORG_AJENA               ->  E_KB_GAP_FOREIGN_ORG
--   E_KB_HUECO_SIN_EVIDENCIA           ->  E_KB_GAP_EVIDENCE_MISSING
--   E_KB_HUECO_SIN_DUENO               ->  E_KB_GAP_OWNER_MISSING
--   E_KB_HUECO_SIN_FECHA               ->  E_KB_GAP_DATE_MISSING
--   E_KB_HUECO_SIN_REGLA_DE_NULO       ->  E_KB_GAP_NULL_RULE_MISSING
--   E_KB_HUECO_NO_ESCRITO              ->  E_KB_GAP_NOT_WRITTEN
--   E_KB_AVANCE_SIN_FILA               ->  E_KB_ADVANCE_LEDGER_ROW_MISSING
--   E_KB_AVANCE_ORG_AJENA              ->  E_KB_ADVANCE_FOREIGN_ORG
--   E_KB_AVANCE_SIN_APROBADOR          ->  E_KB_ADVANCE_CALLER_NOT_APPROVER
--   E_KB_ADMISION_SIN_HUECO            ->  E_KB_ADMISSION_GAP_MISSING
--   E_KB_ADMISION_SIN_TICKET           ->  E_KB_ADMISSION_TICKET_MISMATCH
--   E_KB_ADMISION_SIN_PROVENIENCIA     ->  E_KB_ADMISSION_PROVENANCE_MISSING
--   E_KB_ADMISION_NO_ES_UNA            ->  E_KB_ADMISSION_NOT_EXACTLY_ONE
--   E_KB_ADMISION_INCOMPLETA           ->  E_KB_ADMISSION_INCOMPLETE
--   E_KB_ADMISION_SIN_CITABILIDAD      ->  E_KB_ADMISSION_CITABLE_MISSING
--   E_KB_ADMISION_NO_CABE_EN_EXTRACTO  ->  E_KB_ADMISSION_EXCEEDS_EXCERPT
--   E_KB_ADMISION_HASH_NO_CUADRA       ->  E_KB_ADMISSION_HASH_MISMATCH
--   E_KB_CIERRE_SIN_HUECO              ->  E_KB_CLOSURE_GAP_NOT_VISIBLE
--   E_KB_CIERRE_HUECO_NO_ABIERTO       ->  E_KB_CLOSURE_GAP_NOT_OPEN
--   E_KB_CIERRE_SIN_RESPUESTA          ->  E_KB_CLOSURE_RESPONSE_MISSING
--   E_KB_CIERRE_ORG_AJENA              ->  E_KB_CLOSURE_FOREIGN_ORG
--   E_KB_CIERRE_SIN_ANCLAJE            ->  E_KB_CLOSURE_NOT_GROUNDED
--   E_KB_CIERRE_SIN_TESTIGO            ->  E_KB_CLOSURE_WITNESS_MISSING
--   E_KB_CIERRE_SNAPSHOT_NO_VIGENTE    ->  E_KB_CLOSURE_SNAPSHOT_NOT_CURRENT
--   E_KB_CIERRE_SIN_CITA_ADMITIDA      ->  E_KB_CLOSURE_ADMISSION_NOT_CITED

-- ---------------------------------------------------------------------------
-- 1 · prompt_version_only_promoted_at()
--
-- Verbatim from 0001_core.sql:109 — trigger function.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_PROMPT_VERSION_INMUTABLE -> E_PROMPT_VERSION_IMMUTABLE  (1 occurrence)
-- ---------------------------------------------------------------------------
create or replace function prompt_version_only_promoted_at() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
as $$
begin
  if (to_jsonb(new) - 'promoted_at') is distinct from (to_jsonb(old) - 'promoted_at') then
    raise exception 'E_PROMPT_VERSION_IMMUTABLE';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · kb_gap_state_guard()
--
-- Verbatim from 0001_core.sql:284 — trigger function.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_KB_GAP_CIERRE_NO_VERIFICADO -> E_KB_GAP_CLOSURE_NOT_VERIFIED  (1 occurrence)
-- ---------------------------------------------------------------------------
create or replace function kb_gap_state_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
as $$
begin
  if new.state is distinct from old.state
     and coalesce(current_setting('ledgerdesk.kb_gap_close', true), '') <> old.id::text then
    raise exception 'E_KB_GAP_CLOSURE_NOT_VERIFIED';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3 · ledger_link()
--
-- Verbatim from 0002_ledger.sql:95 — trigger function, security definer.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_LEDGER_FILA_INCOMPLETA -> E_LEDGER_ROW_INCOMPLETE  (5 occurrences)
-- ---------------------------------------------------------------------------
create or replace function ledger_link() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public, pg_temp
as $$
declare
  head      text;
  head_seq  bigint;
  required  text[];
begin
  -- The head read below is correct only under READ COMMITTED: at any stricter level the snapshot
  -- predates the lock and a stale head would be accepted.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;

  -- Serialise per run UNDER READ COMMITTED; the snapshot of a REPEATABLE READ transaction
  -- predates the lock, and what closes that case is the unique index on (run_id, prev_hash).
  perform pg_advisory_xact_lock(hashtextextended(new.run_id::text, 0));

  select seq, row_hash into head_seq, head
    from ledger_entry where run_id = new.run_id order by seq desc limit 1;
  -- The head is the LAST row: a seq that does not advance forks the chain without forging a hash.
  if head_seq is not null and new.seq <= head_seq then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;
  if new.prev_hash is distinct from coalesce(head,'GENESIS') then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;

  if new.class = 'agent_call' and (
       new.prompt_version_id is null or new.model_requested is null or
       new.model_returned    is null or new.sampling        is null or
       new.input_hash        is null or new.input_path      is null or
       new.prompt_hash       is null or new.response_hash   is null or
       new.state_hash        is null) then
    raise exception 'E_LEDGER_ROW_INCOMPLETE';
  end if;

  -- Presence of the keys each class owns. The database guarantees that nothing is missing;
  -- the writer validates the full typing against quality/schemas/ledger_class/<class>.schema.json.
  required := case new.class
    when 'start'              then array['attempt_id','started_at','budget_reserved','code_sha']
    when 'promotion_attempt'  then array['attempt_id','candidate_prompt_version_id',
                                         'incumbent_prompt_version_id','conjuncts','failing_conjunct',
                                         'power','outcome','interpretation']
    when 'modification_event' then array['modification_id','gating_arm','verdict',
                                         'would_have_been_rejected','reason','dag_node_id']
    when 'commitment'         then array['commitment_kind','sha256','covers','committed_before']
    when 'prereg_anchor'      then array['document','sha256','field_count','blocks']
    when 'agreement_r3'       then array['item_id','template_id','agreement','r',
                                         'rollout_seeds','temperature']
    when 'kb_admission'       then array['admission_id','gap_id','approved_by','snapshot_from',
                                         'snapshot_to','content_hash','provenance_source']
    when 'checkpoint'         then array['seq_covered','head_row_hash','k']
    else null::text[]
  end;
  -- Presence is not enough where the contract says NAMED: a key carrying JSON null names nothing.
  -- failing_conjunct is the single key allowed to be null, and only in the state that authorises it.
  if required is not null and exists (
       select 1 from unnest(required) as k
        where k <> 'failing_conjunct'
          and (new.output -> k is null or jsonb_typeof(new.output -> k) = 'null')) then
    raise exception 'E_LEDGER_ROW_INCOMPLETE';
  end if;

  if new.class = 'promotion_attempt' then
    if (new.output -> 'failing_conjunct') is null then
      raise exception 'E_LEDGER_ROW_INCOMPLETE';
    end if;
    if jsonb_typeof(new.output -> 'failing_conjunct') = 'null'
       and (new.output ->> 'outcome') is distinct from 'PROMOTED' then
      raise exception 'E_LEDGER_ROW_INCOMPLETE';
    end if;
    if (new.output ->> 'outcome') = 'ABORTED' and (new.output -> 'abort_reason') is null then
      raise exception 'E_LEDGER_ROW_INCOMPLETE';
    end if;
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 4 · kb_gap_mark_not_documentable(uuid,text)
--
-- Verbatim from 0009_kb_retrieval.sql:245 — callable function, security definer.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_KB_GAP_SIN_MOTIVO -> E_KB_GAP_REASON_MISSING  (1 occurrence)
-- ---------------------------------------------------------------------------
create or replace function kb_gap_mark_not_documentable(p_gap uuid, p_reason text)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'E_KB_GAP_REASON_MISSING';
  end if;
  perform set_config('ledgerdesk.kb_gap_close', p_gap::text, true);
  update kb_gap set state = 'NOT_DOCUMENTABLE', not_documentable_reason = p_reason
   where id = p_gap and state = 'OPEN';
  perform set_config('ledgerdesk.kb_gap_close', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- 5 · kb_snapshot_advance(uuid,text,text,jsonb,bigint)
--
-- Verbatim from 0009_kb_retrieval.sql:280 — callable function, security definer.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_KB_SNAPSHOT_NO_AVANZA -> E_KB_SNAPSHOT_NOT_ADVANCING  (1 occurrence)
--     E_KB_SNAPSHOT_YA_EXISTE -> E_KB_SNAPSHOT_ALREADY_EXISTS  (1 occurrence)
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
    raise exception 'E_KB_SNAPSHOT_NOT_ADVANCING';
  end if;
  if exists (select 1 from kb_article where org_id = p_org and kb_snapshot = p_to) then
    raise exception 'E_KB_SNAPSHOT_ALREADY_EXISTS';
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
-- 6 · ticket_state_needs_its_evidence()
--
-- Verbatim from 0009_kb_retrieval.sql:342 — trigger function, security definer.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_TICKET_ENVIO_SIN_APROBACION -> E_TICKET_SENT_NOT_APPROVED  (1 occurrence)
--     E_TICKET_ESPERA_SIN_ANCLAJE -> E_TICKET_AWAITING_NOT_GROUNDED  (1 occurrence)
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
    raise exception 'E_TICKET_SENT_NOT_APPROVED';
  end if;

  if new.status = 'AWAITING_AGENT' and not exists (
       select 1 from response r
        where r.ticket_id = new.id
          and r.grounded is true) then
    raise exception 'E_TICKET_AWAITING_NOT_GROUNDED';
  end if;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 7 · kb_gap_open(uuid,uuid,uuid,text,text,boolean,text,text,uuid,date,text,uuid[],bigint)
--
-- Verbatim from 0010_kb_gap_cycle.sql:120 — callable function, security definer.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_KB_HUECO_ORG_AJENA -> E_KB_GAP_FOREIGN_ORG  (1 occurrence)
--     E_KB_HUECO_SIN_EVIDENCIA -> E_KB_GAP_EVIDENCE_MISSING  (5 occurrences)
--     E_KB_HUECO_SIN_DUENO -> E_KB_GAP_OWNER_MISSING  (1 occurrence)
--     E_KB_HUECO_SIN_FECHA -> E_KB_GAP_DATE_MISSING  (1 occurrence)
--     E_KB_HUECO_SIN_REGLA_DE_NULO -> E_KB_GAP_NULL_RULE_MISSING  (1 occurrence)
--     E_KB_HUECO_NO_ESCRITO -> E_KB_GAP_NOT_WRITTEN  (1 occurrence)
-- ---------------------------------------------------------------------------
create or replace function kb_gap_open(
  p_gap             uuid,
  p_org             uuid,
  p_ticket          uuid,
  p_query_terms     text,
  p_kb_snapshot     text,
  p_zero_match      boolean,
  p_query_sha256    text,
  p_question_sha256 text,
  p_owner           uuid,
  p_committed_date  date,
  p_null_rule       text,
  p_divergent       uuid[]  default null,
  p_ledger          bigint  default null)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  existing uuid;
begin
  if p_org is distinct from (auth.jwt() ->> 'org_id')::uuid then
    raise exception 'E_KB_GAP_FOREIGN_ORG';
  end if;

  -- Evidence: what was searched for, under which corpus, and what came back.
  if p_query_terms is null or p_query_terms !~ '[^[:space:]]' then
    raise exception 'E_KB_GAP_EVIDENCE_MISSING';
  end if;
  if p_kb_snapshot is null or p_kb_snapshot !~ '[^[:space:]]' then
    raise exception 'E_KB_GAP_EVIDENCE_MISSING';
  end if;
  if p_zero_match is null then
    raise exception 'E_KB_GAP_EVIDENCE_MISSING';
  end if;
  if p_query_sha256 is null or p_query_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'E_KB_GAP_EVIDENCE_MISSING';
  end if;
  if p_question_sha256 is null or p_question_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'E_KB_GAP_EVIDENCE_MISSING';
  end if;

  -- The commitment: who closes it, and by when. Both are human facts and neither is invented here.
  if p_owner is null then
    raise exception 'E_KB_GAP_OWNER_MISSING';
  end if;
  if p_committed_date is null then
    raise exception 'E_KB_GAP_DATE_MISSING';
  end if;

  -- The rule for what the absence means, declared before the absence rather than after it.
  if p_null_rule is null or p_null_rule !~ '[^[:space:]]' then
    raise exception 'E_KB_GAP_NULL_RULE_MISSING';
  end if;

  -- The STANDING record for this question on this ticket, whatever corpus it was raised under. This
  -- is what makes a question re-asked after an admission the same episode rather than a new one:
  -- the corpus moved, the query digest moved with it, and the question did not.
  select id into existing from kb_gap
   where ticket_id = p_ticket and question_sha256 = p_question_sha256 and state <> 'CLOSED';
  if existing is not null then
    return existing;
  end if;

  -- And the record for this exact query under this exact corpus, in whatever state it is in. 0009's
  -- uniqueness forbids a second one, so a retried emission finds its own row here.
  --
  -- **Declared residual**: when that row is CLOSED, this returns a closed episode to a live
  -- escalation. It is honest — same question, same corpus, already adjudicated — and it is visible:
  -- a supervisor following the link from an escalated ticket lands on a record marked CLOSED. The
  -- alternative would be writing a second row for a pair the frozen constraint says is one, which is
  -- not this migration's to change. ADR-026 §2 records it.
  select id into existing from kb_gap
   where ticket_id = p_ticket and query_sha256 = p_query_sha256;
  if existing is not null then
    return existing;
  end if;

  -- No conflict target: two uniqueness rules can refuse this row now, and a target would name only
  -- one of them. Whichever refuses, the read-backs below find the row that stands.
  insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                      question_sha256, divergent_kb_ids, owner_id, committed_date, null_rule, state,
                      opened_ledger_ref)
  values (p_gap, p_org, p_ticket, p_query_terms, p_kb_snapshot, p_zero_match, p_query_sha256,
          p_question_sha256, p_divergent, p_owner, p_committed_date, p_null_rule, 'OPEN', p_ledger)
  on conflict do nothing;

  -- Read back in the same order the two checks above ask in, because a concurrent writer may have
  -- won either race.
  select id into existing from kb_gap
   where ticket_id = p_ticket and question_sha256 = p_question_sha256 and state <> 'CLOSED';
  if existing is null then
    select id into existing from kb_gap
     where ticket_id = p_ticket and query_sha256 = p_query_sha256;
  end if;
  if existing is null then
    raise exception 'E_KB_GAP_NOT_WRITTEN';
  end if;
  return existing;
end $$;

-- ---------------------------------------------------------------------------
-- 8 · kb_snapshot_advance(bigint,jsonb)
--
-- Verbatim from 0010_kb_gap_cycle.sql:265 — callable function, security definer.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_KB_SNAPSHOT_NO_AVANZA -> E_KB_SNAPSHOT_NOT_ADVANCING  (1 occurrence)
--     E_KB_SNAPSHOT_YA_EXISTE -> E_KB_SNAPSHOT_ALREADY_EXISTS  (2 occurrences)
--     E_KB_SNAPSHOT_MOVIDO -> E_KB_SNAPSHOT_MOVED  (1 occurrence)
--     E_KB_AVANCE_SIN_FILA -> E_KB_ADVANCE_LEDGER_ROW_MISSING  (1 occurrence)
--     E_KB_AVANCE_ORG_AJENA -> E_KB_ADVANCE_FOREIGN_ORG  (1 occurrence)
--     E_KB_AVANCE_SIN_APROBADOR -> E_KB_ADVANCE_CALLER_NOT_APPROVER  (1 occurrence)
--     E_KB_ADMISION_SIN_HUECO -> E_KB_ADMISSION_GAP_MISSING  (1 occurrence)
--     E_KB_ADMISION_SIN_TICKET -> E_KB_ADMISSION_TICKET_MISMATCH  (1 occurrence)
--     E_KB_ADMISION_SIN_PROVENIENCIA -> E_KB_ADMISSION_PROVENANCE_MISSING  (1 occurrence)
--     E_KB_ADMISION_NO_ES_UNA -> E_KB_ADMISSION_NOT_EXACTLY_ONE  (1 occurrence)
--     E_KB_ADMISION_INCOMPLETA -> E_KB_ADMISSION_INCOMPLETE  (1 occurrence)
--     E_KB_ADMISION_SIN_CITABILIDAD -> E_KB_ADMISSION_CITABLE_MISSING  (1 occurrence)
--     E_KB_ADMISION_NO_CABE_EN_EXTRACTO -> E_KB_ADMISSION_EXCEEDS_EXCERPT  (1 occurrence)
--     E_KB_ADMISION_HASH_NO_CUADRA -> E_KB_ADMISSION_HASH_MISMATCH  (1 occurrence)
-- ---------------------------------------------------------------------------
create or replace function kb_snapshot_advance(p_ledger bigint, p_admitted jsonb)
  returns table (article_id uuid, canonical_key text, body_sha256 text)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  row_org       uuid;
  row_ticket    uuid;
  row_out       jsonb;
  snapshot_from text;
  snapshot_to   text;
  admission     uuid;
  gap           uuid;
  approver      uuid;
  gap_ticket    uuid;
  item          jsonb;
  body          text;
  digest        text;
  minted        uuid;
  head_now      text;
begin
  select l.org_id, l.ticket_id, l.output into row_org, row_ticket, row_out
    from ledger_entry l
   where l.id = p_ledger and l.class = 'kb_admission';
  if row_org is null then
    raise exception 'E_KB_ADVANCE_LEDGER_ROW_MISSING';
  end if;

  if row_org is distinct from (auth.jwt() ->> 'org_id')::uuid then
    raise exception 'E_KB_ADVANCE_FOREIGN_ORG';
  end if;

  snapshot_from := row_out ->> 'snapshot_from';
  snapshot_to   := row_out ->> 'snapshot_to';
  admission     := (row_out ->> 'admission_id')::uuid;
  gap           := (row_out ->> 'gap_id')::uuid;
  approver      := (row_out ->> 'approved_by')::uuid;

  if approver is null or auth.uid() is distinct from approver then
    raise exception 'E_KB_ADVANCE_CALLER_NOT_APPROVER';
  end if;

  if snapshot_from is null or snapshot_to is null or snapshot_from = snapshot_to then
    raise exception 'E_KB_SNAPSHOT_NOT_ADVANCING';
  end if;
  if exists (select 1 from kb_article where org_id = row_org and kb_snapshot = snapshot_to) then
    raise exception 'E_KB_SNAPSHOT_ALREADY_EXISTS';
  end if;

  -- The corpus this admission was decided under has to be the one still in force, and the pointer is
  -- LOCKED before that is asked.
  --
  -- **The lost update this closes.** The application reads the head, puts it in the chain row as
  -- `snapshot_from`, and calls this. Two admissions decided in the same window therefore read one
  -- head, mint two different successors, copy the same corpus twice and set the pointer twice: the
  -- second wins and the document the first admitted stops being in force — while its chain row, its
  -- `kb_admission` row and its approver all record an admission that happened. Nothing is destroyed,
  -- because the corpus is append-only and the stranded snapshot keeps its articles; but the gap the
  -- first was raised for can then never close, because the closure asks the corpus IN FORCE for the
  -- admitted key and it is not there. A supervisor is left with an admission that succeeded and a
  -- gap that will not shut, and nothing on any screen connects the two.
  --
  -- `for update` is what makes the check mean anything rather than merely usually hold: the second
  -- transaction blocks here until the first commits, then reads the pointer the first moved and is
  -- refused by name. Read without the lock, both would pass the comparison and both would write.
  --
  -- **It is asked AFTER the two above, and the order is deliberate.** A retried admission — the same
  -- chain row replayed — trips both this and `E_KB_SNAPSHOT_ALREADY_EXISTS`, and "this admission has
  -- already happened" is the more useful of the two things to be told. This one is for the case
  -- nobody has a word for yet, so it gets the message about the corpus having moved.
  select kb_snapshot into head_now from kb_snapshot_head where org_id = row_org for update;
  if head_now is distinct from snapshot_from then
    raise exception 'E_KB_SNAPSHOT_MOVED';
  end if;

  -- The chain row has to hang off the gap's own ticket, or the admission does not appear in the
  -- panel that shows the ticket's chain and the evidence of the cycle is invisible where it is read.
  select g.ticket_id into gap_ticket from kb_gap g where g.id = gap and g.org_id = row_org;
  if gap_ticket is null then
    raise exception 'E_KB_ADMISSION_GAP_MISSING';
  end if;
  if row_ticket is distinct from gap_ticket then
    raise exception 'E_KB_ADMISSION_TICKET_MISMATCH';
  end if;

  if row_out -> 'provenance' is null or jsonb_typeof(row_out -> 'provenance') <> 'object' then
    raise exception 'E_KB_ADMISSION_PROVENANCE_MISSING';
  end if;

  -- One body per admission, because one admission names one article: `kb_admission.article_id` is a
  -- single reference and a list would have to pick one of its own elements to put in it.
  if p_admitted is null or jsonb_typeof(p_admitted) <> 'array' or jsonb_array_length(p_admitted) <> 1 then
    raise exception 'E_KB_ADMISSION_NOT_EXACTLY_ONE';
  end if;
  item := p_admitted -> 0;

  if item ->> 'canonical_key' is null or item ->> 'title' is null or item ->> 'body' is null then
    raise exception 'E_KB_ADMISSION_INCOMPLETE';
  end if;
  if item -> 'citable' is null or jsonb_typeof(item -> 'citable') <> 'boolean' then
    raise exception 'E_KB_ADMISSION_CITABLE_MISSING';
  end if;

  body := item ->> 'body';

  -- A body that does not fit whole into one excerpt is refused rather than trimmed. The retrieval
  -- truncates at the envelope's bound, so an article whose deciding sentence falls after the cut
  -- would be quoted to a customer with the deciding sentence missing — and the gap it was admitted
  -- to close would close on padding. 2048 is `EXCERPT_MAX` of the published envelope contract; the
  -- two are compared by a test rather than kept in step by hand.
  if length(body) > 2048 then
    raise exception 'E_KB_ADMISSION_EXCEEDS_EXCERPT';
  end if;

  digest := encode(sha256(convert_to(body, 'UTF8')), 'hex');
  if row_out ->> 'content_hash' is distinct from digest then
    raise exception 'E_KB_ADMISSION_HASH_MISMATCH';
  end if;

  -- The complete copy, exactly as 0009 argues it: a snapshot is a set and never a delta.
  insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
  select gen_random_uuid(), a.org_id, snapshot_to, a.canonical_key, a.title, a.body, a.body_sha256, a.citable
    from kb_article a
   where a.org_id = row_org and a.kb_snapshot = snapshot_from;

  minted := gen_random_uuid();
  insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
  values (minted, row_org, snapshot_to, item ->> 'canonical_key', item ->> 'title', body, digest,
          (item ->> 'citable')::boolean);

  insert into kb_admission (id, org_id, gap_id, approved_by, snapshot_from, snapshot_to,
                            content_hash, provenance, ledger_ref, article_id)
  values (admission, row_org, gap, approver, snapshot_from, snapshot_to, digest,
          row_out -> 'provenance', p_ledger, minted);

  insert into kb_snapshot_head (org_id, kb_snapshot, set_by, set_at)
  values (row_org, snapshot_to, p_ledger, now())
  on conflict (org_id) do update
    set kb_snapshot = excluded.kb_snapshot, set_by = excluded.set_by, set_at = excluded.set_at;

  return query select minted, item ->> 'canonical_key', digest;
end $$;

-- ---------------------------------------------------------------------------
-- 9 · kb_gap_close_by_verification(uuid,uuid)
--
-- Verbatim from 0010_kb_gap_cycle.sql:453 — callable function, security definer.
-- Only these literals were replaced, and the reverse substitution reproduces that source exactly:
--     E_KB_CIERRE_SIN_HUECO -> E_KB_CLOSURE_GAP_NOT_VISIBLE  (1 occurrence)
--     E_KB_CIERRE_HUECO_NO_ABIERTO -> E_KB_CLOSURE_GAP_NOT_OPEN  (1 occurrence)
--     E_KB_CIERRE_SIN_RESPUESTA -> E_KB_CLOSURE_RESPONSE_MISSING  (1 occurrence)
--     E_KB_CIERRE_ORG_AJENA -> E_KB_CLOSURE_FOREIGN_ORG  (1 occurrence)
--     E_KB_CIERRE_SIN_ANCLAJE -> E_KB_CLOSURE_NOT_GROUNDED  (1 occurrence)
--     E_KB_CIERRE_SIN_TESTIGO -> E_KB_CLOSURE_WITNESS_MISSING  (1 occurrence)
--     E_KB_CIERRE_SNAPSHOT_NO_VIGENTE -> E_KB_CLOSURE_SNAPSHOT_NOT_CURRENT  (1 occurrence)
--     E_KB_CIERRE_SIN_CITA_ADMITIDA -> E_KB_CLOSURE_ADMISSION_NOT_CITED  (1 occurrence)
-- ---------------------------------------------------------------------------
create or replace function kb_gap_close_by_verification(p_gap uuid, p_response uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  gap_org      uuid;
  gap_state    kb_gap_state;
  res_org      uuid;
  res_snapshot text;
  res_grounded boolean;
  res_witness  bigint;
  head         text;
begin
  -- 0 · the caller's own organisation, folded into the read of the gap itself.
  --
  -- **This is `security definer`, so RLS does not apply inside it — and without this line the
  -- function undid the policy that hides the row.** A session of another tenant could not SEE this
  -- gap under RLS and could still close it, because every check below compares the gap against the
  -- ANSWER and none of them compared either against the session. Measured, in a transaction that was
  -- rolled back: a Corella Health session read zero rows for a Northwind gap and then closed it.
  --
  -- `kb_gap_open` had already set the standard where it was introduced — a function that took the
  -- organisation on trust would let any holder of EXECUTE write a record into any tenant — and this
  -- function was the one that did not meet it. "Nothing load-bearing is taken from the caller" was
  -- true of the FACTS it decides on and false of the AUTHORISATION to decide them, which are not
  -- the same claim.
  --
  -- The reference names the function rather than a section of the file it was first written in,
  -- because that file is no longer this one: a pointer by position is true only where it was
  -- written, and this paragraph is now two migrations away from what it was pointing at.
  --
  -- It is folded into the read rather than added as a check afterwards, so a foreign session is
  -- refused with "no such gap" — indistinguishable from one that does not exist, which is the
  -- doctrine the application surface already applies at this boundary.
  select g.org_id, g.state into gap_org, gap_state
    from kb_gap g
   where g.id = p_gap and g.org_id = (auth.jwt() ->> 'org_id')::uuid;
  if gap_org is null then
    raise exception 'E_KB_CLOSURE_GAP_NOT_VISIBLE';
  end if;
  if gap_state <> 'OPEN' then
    raise exception 'E_KB_CLOSURE_GAP_NOT_OPEN';
  end if;

  select t.org_id, r.kb_snapshot, r.grounded, r.validate_ledger_ref
    into res_org, res_snapshot, res_grounded, res_witness
    from response r join ticket t on t.id = r.ticket_id
   where r.id = p_response;
  if res_org is null then
    raise exception 'E_KB_CLOSURE_RESPONSE_MISSING';
  end if;

  -- 2 · the same organisation. Checked before anything else is read out of the answer, so a caller
  --     cannot learn whether another tenant's answer exists from which refusal comes back.
  if res_org is distinct from gap_org then
    raise exception 'E_KB_CLOSURE_FOREIGN_ORG';
  end if;

  -- 1 · anchored, and with the row that paid for the verdict.
  if res_grounded is not true then
    raise exception 'E_KB_CLOSURE_NOT_GROUNDED';
  end if;
  if res_witness is null then
    raise exception 'E_KB_CLOSURE_WITNESS_MISSING';
  end if;

  -- 3 · produced under the corpus in force, which is what "the current snapshot" means.
  select h.kb_snapshot into head from kb_snapshot_head h where h.org_id = gap_org;
  if head is null or res_snapshot is null or res_snapshot is distinct from head then
    raise exception 'E_KB_CLOSURE_SNAPSHOT_NOT_CURRENT';
  end if;

  -- 4 · and it cites material admitted against THIS gap, matched by the key that survives an
  --     advance and derived here rather than accepted from whoever called.
  --
  --     The chain of joins is the whole argument: an admission for this gap names an article; that
  --     article carries a canonical key; the corpus in force carries a row under the same key; and
  --     the answer cites THAT row. Nothing in it is a value the caller supplied.
  if not exists (
       select 1
         from kb_admission m
         join kb_article admitted
           on admitted.id = m.article_id and admitted.kb_snapshot = m.snapshot_to
         join kb_article standing
           on standing.canonical_key = admitted.canonical_key
          and standing.org_id = gap_org
          and standing.kb_snapshot = res_snapshot
         join response_citation c
           on c.kb_article_id = standing.id and c.kb_snapshot = standing.kb_snapshot
        where m.gap_id = p_gap
          and m.org_id = gap_org
          and c.response_id = p_response) then
    raise exception 'E_KB_CLOSURE_ADMISSION_NOT_CITED';
  end if;

  perform set_config('ledgerdesk.kb_gap_close', p_gap::text, true);
  update kb_gap set state = 'CLOSED', closed_by_check_at = now(), closing_ledger_ref = res_witness
   where id = p_gap;
  perform set_config('ledgerdesk.kb_gap_close', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- 10 · The privileges these functions already had, restated
--
-- `create or replace` preserved every one of them, so each statement below is a no-op against a
-- database that has 0010 applied. They are here so that this file, read alone, states the access
-- each function it ships is supposed to have — and so that a future edit which substitutes
-- `drop` + `create` for `create or replace` fails closed instead of quietly publishing a
-- `security definer` function to PUBLIC.
--
-- Copied byte for byte from the migrations that established them:
--   0010_kb_gap_cycle.sql:581
--   0010_kb_gap_cycle.sql:582
--   0010_kb_gap_cycle.sql:584
--   0010_kb_gap_cycle.sql:585
--   0010_kb_gap_cycle.sql:586
--   0010_kb_gap_cycle.sql:588
--   0010_kb_gap_cycle.sql:589
--   0010_kb_gap_cycle.sql:590
--
-- The trigger functions above carry no statement here, and the omission is deliberate: 0010 §5
-- leaves trigger functions outside the sweep — a trigger function is not callable, so its EXECUTE
-- privilege grants nobody anything — and `test_SEC_kb_definer_functions_are_not_public` excludes
-- them by return type. Adding a revocation would change a privilege this repository decided to
-- leave alone, which is not a rename.
-- ---------------------------------------------------------------------------
revoke execute on function kb_gap_mark_not_documentable(uuid, text) from public;
revoke execute on function kb_snapshot_advance(uuid, text, text, jsonb, bigint) from public;
revoke execute on function kb_gap_open(uuid, uuid, uuid, text, text, boolean, text, text, uuid, date, text, uuid[], bigint) from public;
revoke execute on function kb_snapshot_advance(bigint, jsonb) from public;
revoke execute on function kb_gap_close_by_verification(uuid, uuid) from public;
grant execute on function kb_gap_open(uuid, uuid, uuid, text, text, boolean, text, text, uuid, date, text, uuid[], bigint) to app_rw;
grant execute on function kb_snapshot_advance(bigint, jsonb) to app_rw;
grant execute on function kb_gap_close_by_verification(uuid, uuid) to app_rw;
