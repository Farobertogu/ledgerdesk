-- 0001_core.sql · schema, types, core tables, non-ledger RLS, roles and grants.
-- Forward-only: once applied this file is never edited; a correction is a new numbered migration.
-- Authority: adr/ADR-018-complete-schema.md.

-- ---------------------------------------------------------------------------
-- 1 · Report schema
-- Created before the revoke below, which the RLS section applies to it, and before
-- 0004 creates a table inside it.
-- ---------------------------------------------------------------------------
create schema quality_report;
revoke all on schema quality_report from public;

-- ---------------------------------------------------------------------------
-- 2 · Types
-- agent_kind lives here and not with the ledger because prompt_version.agent consumes
-- it in this migration; 0002 adds the 'system' value the non-model ledger classes carry.
-- ---------------------------------------------------------------------------
create type user_role    as enum ('customer','agent','supervisor');
create type ticket_state as enum ('NEW','TRIAGED','DRAFTED','AWAITING_AGENT','SENT',
                                  'ESCALATED','RESOLVED','CLOSED','REOPENED','TRIAGE_FAILED');
create type agent_kind   as enum ('triage','draft','validate','evolve');
create type kb_gap_state as enum ('OPEN','NOT_DOCUMENTABLE','CLOSED');

-- ---------------------------------------------------------------------------
-- 3 · Immutability trigger function
-- Defined here because audit_event (this migration) and quality_report.eval_outcome
-- (0004) both hang off it; 0002 re-declares it idempotently with the ledger.
-- ---------------------------------------------------------------------------
create or replace function ledger_immutable() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
as $$
begin raise exception 'E_LEDGER_APPEND_ONLY'; end $$;

-- ---------------------------------------------------------------------------
-- 4 · Core tables
-- ---------------------------------------------------------------------------
create table org      (id uuid primary key, name text not null, tier_default text not null);

create table app_user (id uuid primary key, org_id uuid not null references org(id),
                       role user_role not null, locale text not null default 'en-AU');

create table account  (id uuid primary key, org_id uuid not null references org(id),
                       tier text not null check (tier in ('standard','premium')),
                       value_band int not null check (value_band between 1 and 5));

-- the priority weights derive from a written policy, not from taste
create table sla_policy (
  id uuid primary key, tier text not null, severity int not null check (severity between 1 and 4),
  first_response_minutes int not null, resolution_minutes int not null,
  unique (tier, severity));

create table ticket (
  id uuid primary key,
  org_id uuid not null references org(id),
  account_id uuid not null references account(id),
  customer_id uuid not null references app_user(id),
  subject text not null,
  body_raw text not null,                      -- never leaves the tenant, never reaches the model
  body_redacted text,                          -- the only body the gateway may send
  channel text not null default 'web',
  language text not null default 'en',
  created_at timestamptz not null default now(),
  status ticket_state not null default 'NEW',
  category text, severity int check (severity between 1 and 4),
  sentiment numeric(4,3) check (sentiment between -1 and 1),
  confidence numeric(4,3) check (confidence between 0 and 1),
  sla_policy_id uuid references sla_policy(id),
  sla_due_at timestamptz, breached_at timestamptz,
  retries int not null default 0,
  dedupe_key text,
  unique (org_id, dedupe_key));

create table response (
  id uuid primary key, ticket_id uuid not null references ticket(id),
  draft text not null, final text, sent_at timestamptz,
  approved_by uuid references app_user(id),
  constraint no_autosend check (sent_at is null or approved_by is not null));

create table human_edit (
  id uuid primary key, response_id uuid not null references response(id),
  diff text not null, edit_distance_norm numeric(5,4) not null,
  editor_id uuid not null references app_user(id), ts timestamptz not null default now());

create index ticket_queue_idx on ticket (org_id, status, sla_due_at);

-- ---------------------------------------------------------------------------
-- 5 · prompt_version — destination of two NOT NULL foreign keys
-- generation is a monotone per-agent counter assigned by the writer (max(generation)+1
-- for that agent, inside the inserting transaction) and NOT a count of promotions:
-- without that, two successive rejected candidates of one agent collide on the unique key.
-- ---------------------------------------------------------------------------
create table prompt_version (
  id           uuid        primary key,
  agent        agent_kind  not null,
  generation   int         not null check (generation >= 0),
  text         text        not null,
  schema_hash  text        not null,          -- sha256 of the output schema this prompt demands
  parent_id    uuid            null references prompt_version(id),  -- DAG; root = null
  created_at   timestamptz not null default now(),
  promoted_at  timestamptz     null,          -- ONLY the promotion gate writes it
  unique (agent, generation)
);

-- Immutable except promoted_at: a prompt whose text changes after a run makes the
-- generations incomparable, which is the same reason the ledger is append-only.
-- search_path is pinned because the body resolves the jsonb minus operator through it: a role
-- with CREATE on a schema of its own could otherwise define one and neutralise the immutability.
create or replace function prompt_version_only_promoted_at() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
as $$
begin
  if (to_jsonb(new) - 'promoted_at') is distinct from (to_jsonb(old) - 'promoted_at') then
    raise exception 'E_PROMPT_VERSION_INMUTABLE';
  end if;
  return new;
end $$;
create trigger trg_prompt_version_immutable before update on prompt_version
  for each row execute function prompt_version_only_promoted_at();
revoke delete, truncate on prompt_version from public, authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 6 · eval_split — destination of ledger_entry.split_id
-- One row per sealed set of a run.
-- ---------------------------------------------------------------------------
create table eval_split (
  id              uuid        primary key,
  run_id          uuid        not null,
  kind            text        not null check (kind in ('selection','report','ood','blind_label')),
  n               int         not null check (n > 0),
  manifest_sha256 text        not null,   -- sealed hash of the manifest
  content_sha256  text        not null,   -- the seal covers BODIES, not only ids
  sealed_at       timestamptz not null,
  revealed_at     timestamptz     null,   -- revealing a split closes it
  unique (run_id, kind)
);

-- ---------------------------------------------------------------------------
-- 7 · eval_item — the corpus with its ground truth
-- Populated by the corpus generator, which holds the only declared write grant (§9 below).
-- ---------------------------------------------------------------------------
create table eval_item (
  id           uuid        primary key,
  item_id      text        not null unique,   -- canonical corpus id; the one that travels to the manifest
  template_id  text        not null,          -- the clan: unit of inference for the paired estimator
  family       text        not null,
  body         text        not null,
  body_sha256  text        not null,          -- reconciles against the manifest's content hashes
  label        jsonb       not null,          -- ground truth {category, severity, sentiment, escalate, reason}
  label_source text        not null check (label_source in ('generator','blind_human')),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8 · eval_result — the aggregate the application is allowed to read
-- Aggregate exclusively: no item ids, no bodies, nothing per item. The per-item detail
-- lives in quality_report.eval_outcome (0004), which the application role cannot reach.
-- Each row is one query consumed against the pre-committed exposure budget.
-- ---------------------------------------------------------------------------
create table eval_result (
  id                uuid          primary key,
  split_id          uuid          not null references eval_split(id),
  prompt_version_id uuid          not null references prompt_version(id),
  query_index       bigint        not null,        -- one row = one query against the budget
  n                 int           not null check (n > 0),
  correct           int           not null,
  accuracy          numeric(5,4)  not null,
  ci_low            numeric(5,4)  not null,
  ci_high           numeric(5,4)  not null,
  ci_unit           text          not null check (ci_unit in ('clan','item')),  -- no interval without its unit
  deff              numeric(6,3)      null,        -- design effect declared, never implicit
  sealed_hash       text          not null,        -- the manifest hash the panel shows beside it
  computed_at       timestamptz   not null default now(),
  unique (split_id, prompt_version_id, query_index)
);

-- ---------------------------------------------------------------------------
-- 9 · kb_article
-- canonical_key and body_sha256 are the two fields the deterministic source-conflict
-- predicate compares: shared canonical key with divergent resolution hash.
-- ---------------------------------------------------------------------------
create table kb_article (
  id            uuid        primary key,
  org_id        uuid        not null references org(id),
  kb_snapshot   text        not null,
  canonical_key text        not null,
  title         text        not null,
  body          text        not null,
  body_sha256   text        not null,
  citable       boolean     not null,   -- feeds the declared null rule of a knowledge gap
  created_at    timestamptz not null default now(),
  unique (kb_snapshot, canonical_key, id)
);
alter table kb_article enable row level security;
create policy tenant_isolation_kb_article on kb_article
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- ---------------------------------------------------------------------------
-- 10 · audit_event — append-only like the ledger
-- ---------------------------------------------------------------------------
create table audit_event (
  id          bigserial   primary key,
  org_id      uuid        not null references org(id),
  actor_id    uuid            null references app_user(id),
  action      text        not null,
  object_type text        not null,
  object_id   text        not null,
  detail      jsonb       not null default '{}'::jsonb,
  ts          timestamptz not null default now(),
  prev_hash   text        not null,
  row_hash    text        not null
);
alter table audit_event add constraint audit_hash_shape check (
  row_hash ~ '^[a-f0-9]{64}$'
  and (prev_hash = 'GENESIS' or prev_hash ~ '^[a-f0-9]{64}$')
  and row_hash <> prev_hash);

revoke update, delete, truncate on audit_event from public, authenticated, anon, service_role;
create trigger trg_audit_no_update before update or delete on audit_event
  for each row execute function ledger_immutable();
-- A row trigger never fires on TRUNCATE, and the revoke above does not reach the owner — which is
-- the role the migrations and CI run as. Without this, append-only is a convention for TRUNCATE.
create trigger trg_audit_no_truncate before truncate on audit_event
  for each statement execute function ledger_immutable();
alter table audit_event enable row level security;
create policy tenant_isolation_audit on audit_event
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- The chain is a mechanism here too, not two columns nobody verifies. The scope is the
-- organisation because audit_event has no run_id; the lock namespace is 1 so it never shares
-- space with the ledger's own advisory lock.
create or replace function audit_event_link() returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare head text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 1));
  select row_hash into head from audit_event where org_id = new.org_id order by id desc limit 1;
  if new.prev_hash is distinct from coalesce(head,'GENESIS') then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;
  return new;
end $$;
create trigger trg_audit_link before insert on audit_event
  for each row execute function audit_event_link();
create unique index audit_one_child_per_head on audit_event (org_id, prev_hash);

-- ---------------------------------------------------------------------------
-- 11 · kb_gap — the knowledge-gap record, in columns instead of prose
-- The two ledger references are added in 0002, where ledger_entry is born.
-- ---------------------------------------------------------------------------
create table kb_gap (
  id             uuid          primary key,
  org_id         uuid          not null references org(id),
  ticket_id      uuid          not null references ticket(id),
  -- query evidence
  query_terms    text          not null,
  kb_snapshot    text          not null,
  zero_match     boolean       not null,
  query_sha256   text          not null,   -- sha256(query_terms || kb_snapshot): the re-run is identical
                                           -- by construction, not «similar»
  divergent_kb_ids uuid[]          null,   -- populated only when the gap is born from a source conflict
  owner_id       uuid          not null references app_user(id),
  committed_date date          not null,
  null_rule      text          not null,   -- declared BEFORE the null, not after it
  state          kb_gap_state  not null default 'OPEN',
  closed_by_check_at timestamptz   null,
  opened_ledger_ref  bigint        null,   -- foreign key added in 0002
  closing_ledger_ref bigint        null,   -- foreign key added in 0002; the run that returned grounded=true
  created_at     timestamptz   not null default now(),
  -- CLOSED is unreachable without the verification mark and the ledger row that proves it
  check (state <> 'CLOSED' or (closed_by_check_at is not null and closing_ledger_ref is not null))
);
alter table kb_gap enable row level security;
create policy tenant_isolation_kb_gap on kb_gap
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- CLOSED is written by one function and only one. The guard reads a session marker that only
-- kb_gap_close_by_check() sets, so no application path can close a gap by hand: the check above
-- forbids a CLOSED row without its witnesses, and this forbids reaching CLOSED at all otherwise.
create or replace function kb_gap_state_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
as $$
begin
  if new.state is distinct from old.state
     and coalesce(current_setting('ledgerdesk.kb_gap_close', true), '') <> old.id::text then
    raise exception 'E_KB_GAP_CIERRE_NO_VERIFICADO';
  end if;
  return new;
end $$;
create trigger trg_kb_gap_state_guard before update on kb_gap
  for each row execute function kb_gap_state_guard();

create or replace function kb_gap_close_by_check(p_gap uuid, p_ledger bigint)
  returns void
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  perform set_config('ledgerdesk.kb_gap_close', p_gap::text, true);
  update kb_gap set state = 'CLOSED', closed_by_check_at = now(), closing_ledger_ref = p_ledger
   where id = p_gap;
  perform set_config('ledgerdesk.kb_gap_close', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- 12 · Row-level security, non-ledger half
-- The ledger's own enable/policies/grants descend to 0002, where the table exists.
-- ---------------------------------------------------------------------------
alter table ticket enable row level security;
alter table response enable row level security;

-- tenant isolation: two organisations are seeded, so this is demonstrable and not decorative
create policy tenant_isolation on ticket
  using (org_id = (auth.jwt() ->> 'org_id')::uuid);

-- Role isolation: a customer sees only their own tickets. RESTRICTIVE on purpose — a permissive
-- policy would be OR-ed with tenant_isolation and every customer would see the whole tenant. The
-- org_id clause stays inside it so that deleting tenant_isolation still fails closed.
create policy customer_own_rows on ticket as restrictive for select
  using (org_id = (auth.jwt() ->> 'org_id')::uuid
         and ( (auth.jwt() ->> 'role') in ('agent','supervisor') or customer_id = auth.uid() ));

-- Write path: only server actions with a re-checked role, and only inside the tenant. response
-- carries no org_id, so the tenant is reached through its ticket; without the with check an
-- update could move a row out of the tenant it was allowed to touch.
create policy agent_writes on response for update
  using ((auth.jwt() ->> 'role') in ('agent','supervisor')
         and exists (select 1 from ticket t where t.id = response.ticket_id
                      and t.org_id = (auth.jwt() ->> 'org_id')::uuid))
  with check ((auth.jwt() ->> 'role') in ('agent','supervisor')
         and exists (select 1 from ticket t where t.id = response.ticket_id
                      and t.org_id = (auth.jwt() ->> 'org_id')::uuid));

-- Read path for response: with row-level security enabled and only an update policy, the table
-- would be unreadable for every role but the owner, and the draft has to be readable to be shown.
create policy response_tenant_select on response for select
  using (exists (select 1 from ticket t where t.id = response.ticket_id
                  and t.org_id = (auth.jwt() ->> 'org_id')::uuid));

-- human_edit carries NO row-level security in this migration, and that is declared rather than
-- overlooked: it holds no tenant column of its own and no role has any grant on it yet. It is
-- reached only through response, and its policy lands with the console that writes it.

create index response_ticket_idx on response (ticket_id);  -- the draft is read by ticket

-- the application role can never read the report schema
revoke usage on schema quality_report from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 13 · Named roles and the two declared write exceptions
-- The seam between the application and the quality side is made of grants, not of discipline.
-- ---------------------------------------------------------------------------
create role app_rw;        -- the writer: gateway and agents, always with org_id in the token
create role quality_ro;    -- the quality side: pure reader
create role quality_gen;   -- corpus generator: the ONLY writer of eval_item
create role quality_eval;  -- evaluator: the ONLY writer of eval_result

grant insert, select on eval_item   to quality_gen;    -- exception 1
grant insert, select on eval_result to quality_eval;   -- exception 2
-- eval_item holds every body of the corpus and every ground-truth label, and it carries no
-- row-level security: access to it is all or nothing. The application reads the aggregate, never
-- the per-item detail, so it is granted the other three tables and not this one.
grant select on eval_item, eval_split, eval_result, prompt_version to quality_ro;
grant select on            eval_split, eval_result, prompt_version to app_rw;
grant usage on schema quality_report to quality_ro, quality_eval;
