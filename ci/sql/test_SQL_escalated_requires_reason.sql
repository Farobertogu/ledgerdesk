-- test_SQL_escalated_requires_reason
--
-- The invariant 0008 adds, measured in all three of its directions.
--
--   · a ticket in ESCALATED carries BOTH the reason and the clause, and neither alone will do;
--   · a ticket that LEAVES ESCALATED keeps what it carried — the constraint is one-directional on
--     purpose, because an escalation a supervisor resolved is still an escalation that happened,
--     and clearing the record on the way out would destroy the only column-level evidence that a
--     person was ever asked to look;
--   · a state that is not ESCALATED is under no obligation at all, which is what lets every ticket
--     in the system exist before anything has triaged it.
--
-- The alphabet is checked as a closed set: all eight values are accepted and a ninth is not. That
-- ninth is not hypothetical — INCONSIST is reserved by ADR-023 §2 and will arrive one day, and
-- when it does this test is where the rewrite of the check has to be noticed.
--
-- Everything runs as the owner, which row-level security does not apply to. That is deliberate:
-- the question here is what the SCHEMA refuses, and a policy filtering the rows away first would
-- make a refused write look identical to an invisible one.

do $$
declare
  v_org      uuid := '11111111-1111-4111-8111-111111111111';
  v_account  uuid := '1acc0000-0000-4000-8000-000000000001';
  v_customer uuid := '1a000000-0000-4000-8000-000000000001';
  v_ticket   uuid := '0c0e0001-0000-4000-8000-00000000000f';
  v_reason   text;
  v_clause   text;
  v_status   text;
  v_count    int;
begin
  delete from ticket where id = v_ticket;

  insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, dedupe_key)
  values (v_ticket, v_org, v_account, v_customer,
          'escalation invariant fixture', 'a body', 'sqltest-escalated-requires-reason');

  -- 1 · NEW carries nothing, and is not asked to.
  select status, escalation_reason, escalation_clause into v_status, v_reason, v_clause
    from ticket where id = v_ticket;
  if v_status <> 'NEW' or v_reason is not null or v_clause is not null then
    raise exception 'test_SQL_escalated_requires_reason: a fresh ticket is % with reason %', v_status, v_reason;
  end if;

  -- 2 · ESCALATED with neither.
  begin
    update ticket set status = 'ESCALATED' where id = v_ticket;
    raise exception 'test_SQL_escalated_requires_reason: ESCALATED was accepted with no reason and no clause';
  exception when check_violation then null;
  end;

  -- 3 · ESCALATED with a reason and no clause. The clause is what an auditor re-runs; a reason
  --     without it is a tally nobody can reproduce.
  begin
    update ticket set status = 'ESCALATED', escalation_reason = 'SLA' where id = v_ticket;
    raise exception 'test_SQL_escalated_requires_reason: ESCALATED was accepted with a reason and no clause';
  exception when check_violation then null;
  end;

  -- 4 · ESCALATED with a clause and no reason. The reason is what a report counts.
  begin
    update ticket set status = 'ESCALATED', escalation_clause = 'sla_breached' where id = v_ticket;
    raise exception 'test_SQL_escalated_requires_reason: ESCALATED was accepted with a clause and no reason';
  exception when check_violation then null;
  end;

  -- 5 · A reason outside the closed alphabet, whatever else is right about the row.
  begin
    update ticket
       set status = 'ESCALATED', escalation_reason = 'INCONSIST', escalation_clause = 'sources_disagree'
     where id = v_ticket;
    raise exception 'test_SQL_escalated_requires_reason: a ninth reason was accepted without its own migration';
  exception when check_violation then null;
  end;

  -- 6 · The eight the rule publishes, every one of them accepted.
  v_count := 0;
  for v_reason in select unnest(array['CONF','SENT','TIER','RETRY','SLA','GROUND','POLICY','LANG'])
  loop
    update ticket
       set status = 'ESCALATED', escalation_reason = v_reason, escalation_clause = 'a_named_clause'
     where id = v_ticket;
    v_count := v_count + 1;
  end loop;
  if v_count <> 8 then
    raise exception 'test_SQL_escalated_requires_reason: % of the eight reasons were accepted', v_count;
  end if;

  -- 7 · Leaving ESCALATED keeps the record. The supervisor's edge is the one that does this.
  update ticket set status = 'RESOLVED' where id = v_ticket;
  select escalation_reason, escalation_clause into v_reason, v_clause from ticket where id = v_ticket;
  if v_reason is null or v_clause is null then
    raise exception 'test_SQL_escalated_requires_reason: resolving an escalation cleared why it escalated';
  end if;

  -- 8 · And the record may be cleared once the ticket is not escalated: the invariant binds one
  --     state and not the column's whole life.
  update ticket set escalation_reason = null, escalation_clause = null where id = v_ticket;

  -- 9 · The stored priority is a score, and a score is in [0,1].
  begin
    update ticket set priority = 1.5 where id = v_ticket;
    raise exception 'test_SQL_escalated_requires_reason: a priority above 1 was accepted';
  exception when check_violation then null;
  end;
  begin
    update ticket set priority = -0.000001 where id = v_ticket;
    raise exception 'test_SQL_escalated_requires_reason: a negative priority was accepted';
  exception when check_violation then null;
  end;

  update ticket set priority = 0.812500 where id = v_ticket;
  update ticket set priority = 0 where id = v_ticket;
  update ticket set priority = 1 where id = v_ticket;

  delete from ticket where id = v_ticket;
end $$;

-- The index the intake's collapse reads. Its absence would not fail any query, it would make one
-- slow — which is the kind of regression that never announces itself.
do $$
begin
  if not exists (select 1 from pg_indexes where tablename = 'ticket' and indexname = 'ticket_body_sha256_idx') then
    raise exception 'test_SQL_escalated_requires_reason: ticket_body_sha256_idx is missing, so the collapse lookup has no index';
  end if;
end $$;
