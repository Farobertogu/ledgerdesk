-- test_RLS_ticket_org_isolation
--
-- Two organisations are seeded, so this is a real test and not a decorative one: the application
-- role, carrying the claims of one organisation, must see that organisation's tickets and none of
-- the other's.
--
-- The SELECT grant below is harness scaffolding. The migration set declares the four roles and
-- the two quality-side write exceptions; it does not carry the application's own table grants,
-- so the test grants itself the read it needs and then verifies that what isolates the rows is
-- the POLICY and not the absence of a grant. The whole test runs inside a transaction that is
-- rolled back, so it leaves no undeclared privilege behind.

begin;

grant select, insert on ticket to app_rw;
grant select, update on response to app_rw;
set local role app_rw;

select set_config('request.jwt.claims',
  '{"org_id":"11111111-1111-4111-8111-111111111111","role":"agent","sub":"1a000000-0000-4000-8000-000000000002"}',
  true);

do $$
declare mine int; theirs int; total int;
begin
  select count(*) into mine   from ticket where org_id = '11111111-1111-4111-8111-111111111111';
  select count(*) into theirs from ticket where org_id = '22222222-2222-4222-8222-222222222222';
  select count(*) into total  from ticket;
  if mine <> 2 then
    raise exception 'test_RLS_ticket_org_isolation: the first organisation sees % of its own 2 tickets', mine;
  end if;
  if theirs <> 0 or total <> 2 then
    raise exception 'test_RLS_ticket_org_isolation: the first organisation sees % tickets of the second (total visible: %)', theirs, total;
  end if;
end $$;

select set_config('request.jwt.claims',
  '{"org_id":"22222222-2222-4222-8222-222222222222","role":"agent","sub":"2b000000-0000-4000-8000-000000000002"}',
  true);

do $$
declare mine int; theirs int; total int;
begin
  select count(*) into mine   from ticket where org_id = '22222222-2222-4222-8222-222222222222';
  select count(*) into theirs from ticket where org_id = '11111111-1111-4111-8111-111111111111';
  select count(*) into total  from ticket;
  if mine <> 2 then
    raise exception 'test_RLS_ticket_org_isolation: the second organisation sees % of its own 2 tickets', mine;
  end if;
  if theirs <> 0 or total <> 2 then
    raise exception 'test_RLS_ticket_org_isolation: the second organisation sees % tickets of the first (total visible: %)', theirs, total;
  end if;
end $$;

-- with no claims at all the role sees nothing: the policy fails closed
select set_config('request.jwt.claims', '', true);

do $$
declare total int;
begin
  select count(*) into total from ticket;
  if total <> 0 then
    raise exception 'test_RLS_ticket_org_isolation: a role without claims sees % tickets', total;
  end if;
end $$;

-- The tenant policy on ticket is FOR ALL, so the write path has to be exercised too: a policy
-- without an explicit with check uses its using clause as one, and the insert must be refused.
select set_config('request.jwt.claims',
  '{"org_id":"11111111-1111-4111-8111-111111111111","role":"agent","sub":"1a000000-0000-4000-8000-000000000002"}',
  true);

do $$
begin
  begin
    insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, sla_policy_id)
    values ('aaaa9999-0000-4000-8000-000000000001',
            '22222222-2222-4222-8222-222222222222',
            '2acc0000-0000-4000-8000-000000000001',
            '2b000000-0000-4000-8000-000000000001',
            'cross-tenant write', 'should never land',
            '5a1a0000-0000-4000-8000-000000000003');
  exception when others then
    if position('row-level security' in sqlerrm) > 0 then return; end if;
    raise exception 'test_RLS_ticket_org_isolation: the cross-tenant INSERT was refused with "%" rather than by the policy', sqlerrm;
  end;
  raise exception 'test_RLS_ticket_org_isolation: the first organisation could INSERT a ticket into the second';
end $$;

-- response carries no tenant column of its own: its isolation runs through the ticket, and the
-- update path is where it matters, because a constant assignment needs no read privilege at all.
select set_config('request.jwt.claims',
  '{"org_id":"22222222-2222-4222-8222-222222222222","role":"agent","sub":"2b000000-0000-4000-8000-000000000002"}',
  true);

do $$
declare crossed int; own int;
begin
  update response set final = 'cross-tenant edit'
   where id = '4e500001-0000-4000-8000-000000000001';
  get diagnostics crossed = row_count;

  update response set final = 'own-tenant edit'
   where id = '4e500002-0000-4000-8000-000000000001';
  get diagnostics own = row_count;

  if crossed <> 0 then
    raise exception 'test_RLS_ticket_org_isolation: the second organisation updated % response row(s) of the first', crossed;
  end if;
  if own <> 1 then
    raise exception 'test_RLS_ticket_org_isolation: the second organisation could not update its own response (% rows), so the previous zero proves nothing', own;
  end if;
end $$;

reset role;
rollback;
