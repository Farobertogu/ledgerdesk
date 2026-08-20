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

grant select on ticket to app_rw;
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

reset role;
rollback;
