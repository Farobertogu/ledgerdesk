-- 0002_ledger.sql · append-only per-task ledger, its row-class contract, its policies
-- and the anchoring of the chain head. NEVER edited in place.
-- Authority: adr/ADR-018-complete-schema.md.
--
-- Applied outside a single transaction block: 'system' is added to agent_kind here and is
-- used further down by a check constraint, and PostgreSQL refuses a new enum value inside
-- the transaction that added it. ci/db_check.sh therefore applies each file statement by
-- statement rather than wrapped in one transaction.

alter type agent_kind add value 'system';

-- ---------------------------------------------------------------------------
-- 1 · The alphabet of row classes, closed
-- ---------------------------------------------------------------------------
create type ledger_class as enum (
  'agent_call',          -- the model row: one model invocation, with the full reproducibility block
  'start',               -- opening of a promotion attempt
  'promotion_attempt',   -- the terminal of an attempt: promoted, rejected or aborted
  'modification_event',  -- a proposal by the evolution agent, with the verifier's full verdict
  'commitment',          -- a hash committed before the run it constrains
  'prereg_anchor',       -- the hash of the pre-registration document
  'agreement_r3',        -- per-item agreement of the calibration rollouts
  'kb_admission',        -- the row that records an admission into the knowledge base
  'checkpoint');         -- periodic anchor of the chain head

-- ---------------------------------------------------------------------------
-- 2 · ledger_entry
-- class reuses the 'clase' column of the ledger this evolves; when an agent_call row also
-- carries that source's own class value, the value travels in output->'csv_class'.
-- ---------------------------------------------------------------------------
create table ledger_entry (
  id              bigserial primary key,
  run_id          uuid        not null,           -- one run = one demonstration or evaluation session
  seq             bigint      not null,           -- monotone within run_id
  org_id          uuid        not null references org(id),
  ticket_id       uuid            null references ticket(id),
  agent           agent_kind  not null,
  prompt_version_id uuid      not null references prompt_version(id),

  -- reproducibility block
  model_requested text        not null,
  model_returned  text        not null,           -- the id the RESPONSE carried, not the one asked for
  sampling        jsonb       not null,           -- {temperature, top_p, max_tokens, stop}
  seed            bigint          null,
  input_hash      text        not null,           -- sha256 of the redacted input
  input_path      text        not null,           -- the exact path of the input consumed
  prompt_hash     text        not null,
  response_hash   text        not null,
  state_hash      text        not null,           -- sha256 of (schema_version, ruleset_hash, kb_snapshot)
  split_id        uuid            null references eval_split(id),
  toolchain       jsonb       not null,           -- {app, node, model_sdk, ruleset} pinned versions
  restarts        int         not null default 0,

  -- cost / performance
  tokens_in       int         not null,
  tokens_out      int         not null,
  cost_aud        numeric(12,6) not null,
  latency_ms      int         not null,
  cum_tokens      bigint      not null,
  class           ledger_class not null,

  -- output
  output          jsonb       not null,
  confidence      numeric(4,3)    null check (confidence is null or (confidence >= 0 and confidence <= 1)),

  ts              timestamptz not null default now(),
  prev_hash       text        not null,
  row_hash        text        not null,
  unique (run_id, seq)
);

-- append-only, by mechanism and not by convention
revoke update, delete, truncate on ledger_entry from public, authenticated, anon, service_role;
create or replace function ledger_immutable() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
as $$
begin raise exception 'E_LEDGER_APPEND_ONLY'; end $$;
create trigger trg_ledger_no_update before update or delete on ledger_entry
  for each row execute function ledger_immutable();
-- A row trigger never fires on TRUNCATE, and the revoke above does not reach the owner.
create trigger trg_ledger_no_truncate before truncate on ledger_entry
  for each statement execute function ledger_immutable();

-- ---------------------------------------------------------------------------
-- 3 · The chain, and the completeness the writer may not skip
-- row_hash = sha256(prev_hash || canonical_json(row without hashes)); the trigger verifies
-- the link and the completeness of the row, and rejects anything else.
--
-- security definer, deliberately: the trigger reads the head of the chain from its own table.
-- Under the policies of the inserting role that read would be clipped per tenant and two
-- organisations inside one run would produce incoherent chains. ledger_entry does not carry
-- force row level security, so the owner sees the whole chain — that omission is deliberate.
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
    raise exception 'E_LEDGER_FILA_INCOMPLETA';
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
    raise exception 'E_LEDGER_FILA_INCOMPLETA';
  end if;

  if new.class = 'promotion_attempt' then
    if (new.output -> 'failing_conjunct') is null then
      raise exception 'E_LEDGER_FILA_INCOMPLETA';
    end if;
    if jsonb_typeof(new.output -> 'failing_conjunct') = 'null'
       and (new.output ->> 'outcome') is distinct from 'PROMOTED' then
      raise exception 'E_LEDGER_FILA_INCOMPLETA';
    end if;
    if (new.output ->> 'outcome') = 'ABORTED' and (new.output -> 'abort_reason') is null then
      raise exception 'E_LEDGER_FILA_INCOMPLETA';
    end if;
  end if;

  return new;
end $$;
create trigger trg_ledger_link before insert on ledger_entry
  for each row execute function ledger_link();

-- ---------------------------------------------------------------------------
-- 4 · The row-class contract
-- The relaxation is surgical: exactly the eight columns that describe a model call that did
-- not happen become nullable, and a check reinstates all eight for agent_call, so the
-- guarantee keeps living in the schema and not only in a trigger.
--
-- What is NOT relaxed for any class: run_id, seq, org_id, agent, class, state_hash, toolchain,
-- restarts, tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, output, ts, prev_hash,
-- row_hash. Every row, commitment rows included, still pins its state and its toolchain.
--
-- Sentinels for every class other than agent_call: tokens_in, tokens_out, cost_aud and
-- latency_ms are 0 (a row that did not call the model really cost zero, and the consumption
-- counter recomputes from the chain); cum_tokens carries the running total with no increment;
-- restarts is 0; agent is 'system', except promotion_attempt and modification_event, which the
-- evolution agent does propose and which therefore keep agent = 'evolve'.
-- ---------------------------------------------------------------------------
alter table ledger_entry
  alter column prompt_version_id drop not null,
  alter column model_requested   drop not null,
  alter column model_returned    drop not null,
  alter column sampling          drop not null,
  alter column input_hash        drop not null,
  alter column input_path        drop not null,
  alter column prompt_hash       drop not null,
  alter column response_hash     drop not null;

alter table ledger_entry add constraint ledger_agent_call_complete check (
  class <> 'agent_call' or (
    prompt_version_id is not null and model_requested is not null and
    model_returned    is not null and sampling        is not null and
    input_hash        is not null and input_path      is not null and
    prompt_hash       is not null and response_hash   is not null));

alter table ledger_entry add constraint ledger_agent_identity check (
  (class in ('promotion_attempt','modification_event') and agent = 'evolve')
  or (class not in ('agent_call','promotion_attempt','modification_event') and agent = 'system')
  or class = 'agent_call');

alter table ledger_entry add constraint ledger_agreement_r3_has_split check (
  class <> 'agreement_r3' or split_id is not null);

-- The cost sentinels become mechanical: a row that did not call the model may not inflate the
-- budget that the consumption counter recomputes from the chain.
alter table ledger_entry add constraint ledger_nonmodel_costs_zero check (
  class = 'agent_call'
  or (tokens_in = 0 and tokens_out = 0 and cost_aud = 0 and latency_ms = 0 and restarts = 0));

-- Shape of the chain columns: not proof that a hash is the right one, but no room for the empty
-- string, a space, or a row that closes a trivial loop on itself.
alter table ledger_entry add constraint ledger_hash_shape check (
  row_hash ~ '^[a-f0-9]{64}$'
  and (prev_hash = 'GENESIS' or prev_hash ~ '^[a-f0-9]{64}$')
  and row_hash <> prev_hash);

-- A head has at most one child, by mechanism: unique (run_id, seq) only catches the exact
-- collision, and this is also what closes the stale-head race at any isolation level, because
-- uniqueness is evaluated against the physical index and not against the snapshot.
create unique index ledger_one_child_per_head on ledger_entry (run_id, prev_hash);

create index ledger_ticket_idx on ledger_entry (ticket_id, seq) where ticket_id is not null;

-- ---------------------------------------------------------------------------
-- 5 · start and its terminal
-- A start is the opening of a promotion attempt, not the launch of a run: the row is written
-- at the moment the attempt reserves budget, before the first generation of that attempt. Its
-- terminal is the promotion_attempt row with the same attempt_id. The consumption counter
-- reads starts, never terminals: an abort does not refund budget.
-- ---------------------------------------------------------------------------
create unique index ledger_start_unique_per_attempt
  on ledger_entry ((output->>'attempt_id')) where class = 'start';
create unique index ledger_terminal_unique_per_attempt
  on ledger_entry ((output->>'attempt_id')) where class = 'promotion_attempt';

-- ---------------------------------------------------------------------------
-- 6 · Row-level security for the ledger, and its grants
-- ---------------------------------------------------------------------------
alter table ledger_entry enable row level security;

create policy ledger_writer_insert on ledger_entry for insert to app_rw
  with check (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy ledger_tenant_select on ledger_entry for select to app_rw
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);
create policy ledger_quality_select on ledger_entry for select to quality_ro
  using (true);   -- the quality side audits the WHOLE run; it is not a multi-tenant consumer
grant insert, select on ledger_entry to app_rw;
grant select        on ledger_entry to quality_ro, quality_eval;
revoke all on ledger_entry from anon;

-- ---------------------------------------------------------------------------
-- 7 · Anchoring of the chain head
-- The writer emits, every K content rows of a run (rows with class <> 'checkpoint'; an anchor
-- neither advances the counter nor anchors itself), a checkpoint row in the ledger and its
-- mirror row here, and one closing checkpoint carrying n_total when the run ends. K is the
-- sealed sizing field of the same name, emitted by the derivator and never typed.
--
-- The external witness is the repository: the anchor is also appended to
-- reports/ledger_anchor.log and pushed, so truncating the database cannot rewrite it.
-- external_ref stores the commit sha and verification is a git cat-file, not a promise.
--
-- The writer rejects row K+1 when the checkpoint of row K does not exist
-- (E_LEDGER_ANCLA_AUSENTE). That rejection lives in the application writer and not in a
-- trigger: the database guarantees immutability, the writer guarantees periodicity, and CI
-- reconciles the two.
-- ---------------------------------------------------------------------------
create table ledger_checkpoint (
  id            bigserial   primary key,
  run_id        uuid        not null,
  seq_covered   bigint      not null,          -- the seq of the anchored head
  head_row_hash text        not null,
  k             int         not null,          -- the pre-registered K under which it was emitted
  external_ref  text        not null,          -- sha of the commit that witnesses this anchor
  anchored_at   timestamptz not null default now(),
  unique (run_id, seq_covered)
);

-- append-only by mechanism, like ledger_entry and audit_event: an anchor that can be
-- deleted anchors nothing
revoke update, delete, truncate on ledger_checkpoint from public, authenticated, anon, service_role;
create trigger trg_checkpoint_no_update before update or delete on ledger_checkpoint
  for each row execute function ledger_immutable();
create trigger trg_checkpoint_no_truncate before truncate on ledger_checkpoint
  for each statement execute function ledger_immutable();

-- An anchor may not point at a row that does not exist: the anchor is append-only, so a false
-- one could never be removed. unique (run_id, seq) above is exactly the destination it needs.
alter table ledger_checkpoint add constraint fk_checkpoint_row
  foreign key (run_id, seq_covered) references ledger_entry (run_id, seq);

alter table ledger_checkpoint add constraint checkpoint_hash_shape check (
  head_row_hash ~ '^[a-f0-9]{64}$');

-- ---------------------------------------------------------------------------
-- 8 · The two knowledge-gap references to the ledger
-- Forward-only and non-destructive: they could not be born in 0001 because ledger_entry
-- is born here.
-- ---------------------------------------------------------------------------
alter table kb_gap add constraint fk_kb_gap_opened  foreign key (opened_ledger_ref)  references ledger_entry(id);
alter table kb_gap add constraint fk_kb_gap_closing foreign key (closing_ledger_ref) references ledger_entry(id);
