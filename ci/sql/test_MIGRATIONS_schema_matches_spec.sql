-- test_MIGRATIONS_schema_matches_spec
--
-- The clean-database state produced by the migration set must carry every object the record
-- publishes. Each assertion names what is missing, so a failure is a repair instruction rather
-- than a puzzle. The comparison is by named object; the full both-directions schema diff lands
-- with the diff against ci/expected/schema.sql in ci/db_check.sh.

do $$
declare missing text;
begin
  select string_agg(name, ', ' order by name) into missing
  from unnest(array[
    'public.org','public.app_user','public.account','public.sla_policy','public.ticket',
    'public.response','public.human_edit','public.prompt_version','public.eval_split',
    'public.eval_item','public.eval_result','public.kb_article','public.audit_event',
    'public.kb_gap','public.ledger_entry','public.ledger_checkpoint','public.kb_admission',
    'quality_report.eval_outcome']) as t(name)
  where to_regclass(name) is null;
  if missing is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: missing tables: %', missing;
  end if;
end $$;

do $$
declare missing text;
begin
  select string_agg(r, ', ' order by r) into missing
  from unnest(array['app_rw','quality_ro','quality_gen','quality_eval']) as t(r)
  where not exists (select 1 from pg_roles where rolname = r);
  if missing is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: missing roles: %', missing;
  end if;
end $$;

do $$
declare
  expected text;
  actual   text;
begin
  foreach expected in array array[
    'ledger_class=agent_call,start,promotion_attempt,modification_event,commitment,prereg_anchor,agreement_r3,kb_admission,checkpoint',
    'agent_kind=triage,draft,validate,evolve,system',
    'user_role=customer,agent,supervisor',
    'kb_gap_state=OPEN,NOT_DOCUMENTABLE,CLOSED',
    'ticket_state=NEW,TRIAGED,DRAFTED,AWAITING_AGENT,SENT,ESCALATED,RESOLVED,CLOSED,REOPENED,TRIAGE_FAILED'
  ] loop
    select string_agg(e.enumlabel, ',' order by e.enumsortorder) into actual
      from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = split_part(expected, '=', 1);
    if actual is distinct from split_part(expected, '=', 2) then
      raise exception 'test_MIGRATIONS_schema_matches_spec: type % is [%], expected [%]',
        split_part(expected, '=', 1), coalesce(actual, '<absent>'), split_part(expected, '=', 2);
    end if;
  end loop;
end $$;

do $$
declare missing text;
begin
  select string_agg(c, ', ' order by c) into missing
  from unnest(array['ledger_agent_call_complete','ledger_agent_identity',
                    'ledger_agreement_r3_has_split','ledger_nonmodel_costs_zero',
                    'ledger_hash_shape','checkpoint_hash_shape','audit_hash_shape',
                    'eval_outcome_hash_shape','fk_checkpoint_row','no_autosend',
                    'fk_kb_gap_opened','fk_kb_gap_closing']) as t(c)
  where not exists (select 1 from pg_constraint where conname = c);
  if missing is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: missing constraints: %', missing;
  end if;
end $$;

do $$
declare missing text;
begin
  select string_agg(p, ', ' order by p) into missing
  from unnest(array['tenant_isolation','customer_own_rows','agent_writes','response_tenant_select',
                    'ledger_writer_insert','ledger_tenant_select','ledger_quality_select',
                    'tenant_isolation_kb_article','tenant_isolation_audit',
                    'tenant_isolation_kb_gap','tenant_isolation_kb_admission']) as t(p)
  where not exists (select 1 from pg_policies where policyname = p);
  if missing is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: missing policies: %', missing;
  end if;
end $$;

-- customer_own_rows must stay RESTRICTIVE: as a permissive policy it is OR-ed with tenant
-- isolation and the per-customer restriction silently stops applying.
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'ticket'
                    and policyname = 'customer_own_rows'
                    and permissive = 'RESTRICTIVE') then
    raise exception 'test_MIGRATIONS_schema_matches_spec: customer_own_rows went back to PERMISSIVE (it would be OR-ed with tenant_isolation and cancel the per-customer restriction)';
  end if;
end $$;

do $$
declare missing text;
begin
  select string_agg(g, ', ' order by g) into missing
  from unnest(array['trg_ledger_no_update','trg_ledger_no_truncate','trg_ledger_link',
                    'trg_audit_no_update','trg_audit_no_truncate','trg_audit_link',
                    'trg_prompt_version_immutable','trg_kb_gap_state_guard',
                    'trg_checkpoint_no_update','trg_checkpoint_no_truncate',
                    'trg_eval_outcome_no_update','trg_eval_outcome_no_truncate']) as t(g)
  where not exists (select 1 from pg_trigger where tgname = g and not tgisinternal);
  if missing is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: missing triggers: %', missing;
  end if;
end $$;

do $$
declare missing text;
begin
  select string_agg(i, ', ' order by i) into missing
  from unnest(array['ticket_queue_idx','response_ticket_idx','ledger_ticket_idx',
                    'ledger_start_unique_per_attempt','ledger_terminal_unique_per_attempt',
                    'ledger_one_child_per_head','audit_one_child_per_head']) as t(i)
  where to_regclass('public.' || i) is null;
  if missing is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: missing indexes: %', missing;
  end if;
end $$;

do $$
declare unprotected text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into unprotected
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('ticket','response','ledger_entry','kb_article','audit_event','kb_gap','kb_admission')
     and not c.relrowsecurity;
  if unprotected is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: row level security is off on: %', unprotected;
  end if;
end $$;

-- Row-level security enabled with zero policies denies everything: it is the exact defect the
-- schema ADR exists to close, and it would come back in green without this assertion.
do $$
declare naked text;
begin
  select string_agg(format('%s.%s', n.nspname, c.relname), ', ' order by c.relname) into naked
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if naked is not null then
    raise exception 'test_MIGRATIONS_schema_matches_spec: row level security on with ZERO policies on: % (that denies everything)', naked;
  end if;
end $$;

do $$
begin
  if has_schema_privilege('app_rw', 'quality_report', 'usage') then
    raise exception 'test_MIGRATIONS_schema_matches_spec: app_rw holds usage on the report schema';
  end if;
  if not has_schema_privilege('quality_ro', 'quality_report', 'usage')
     or not has_schema_privilege('quality_eval', 'quality_report', 'usage') then
    raise exception 'test_MIGRATIONS_schema_matches_spec: the quality roles lack usage on the report schema';
  end if;
  if has_table_privilege('app_rw', 'eval_item', 'SELECT') then
    raise exception 'test_MIGRATIONS_schema_matches_spec: app_rw reads eval_item (every body of the corpus and every ground-truth label)';
  end if;
end $$;

-- Two sentences of the record turned into mechanism.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'ledger_entry' and c.relforcerowsecurity) then
    raise exception 'test_MIGRATIONS_schema_matches_spec: ledger_entry gained force row level security; the chaining trigger would stop seeing the whole head (the omission is deliberate)';
  end if;
  if pg_has_role('app_rw','quality_ro','USAGE') or pg_has_role('quality_ro','app_rw','USAGE') then
    raise exception 'test_MIGRATIONS_schema_matches_spec: app_rw and quality_ro share membership; ledger_quality_select using(true) would be OR-ed in and dissolve the tenant isolation of the ledger';
  end if;
end $$;

-- The seed states each knowledge-base body twice: once as text and once inside its hash. Nothing
-- else reconciles the two copies.
do $$
begin
  if exists (select 1 from kb_article
              where body_sha256 <> encode(sha256(convert_to(body, 'UTF8')), 'hex')) then
    raise exception 'test_MIGRATIONS_schema_matches_spec: a kb_article body_sha256 does not reconcile against its body';
  end if;
end $$;
