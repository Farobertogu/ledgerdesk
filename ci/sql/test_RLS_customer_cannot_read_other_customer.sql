-- test_RLS_customer_cannot_read_other_customer
--
-- Role isolation inside one tenant: a customer sees their own tickets and not those of another
-- customer of the same organisation. This is what the RESTRICTIVE form of customer_own_rows buys;
-- with a permissive policy the rule is OR-ed with tenant isolation and every customer sees the
-- whole organisation.
--
-- The second customer and their ticket are seeded INSIDE this transaction and rolled back, so the
-- counts that test_RLS_ticket_org_isolation asserts do not move and the seed stays as published.

begin;

insert into app_user (id, org_id, role, locale) values
  ('1a000000-0000-4000-8000-000000000004',
   '11111111-1111-4111-8111-111111111111', 'customer', 'en-AU');

insert into ticket (id, org_id, account_id, customer_id, subject, body_raw,
                    sla_policy_id, dedupe_key)
values ('aaaa0003-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111',
        '1acc0000-0000-4000-8000-000000000001',
        '1a000000-0000-4000-8000-000000000004',
        'Copy of last invoice',
        'Could you resend the invoice for February?',
        '5a1a0000-0000-4000-8000-000000000002', 'nf-invoice-copy');

grant select on ticket to app_rw;
set local role app_rw;

-- the first customer of the first organisation
select set_config('request.jwt.claims',
  '{"org_id":"11111111-1111-4111-8111-111111111111","role":"customer","sub":"1a000000-0000-4000-8000-000000000001"}',
  true);

do $$
declare mine int; theirs int; total int;
begin
  select count(*) into mine   from ticket where customer_id = '1a000000-0000-4000-8000-000000000001';
  select count(*) into theirs from ticket where customer_id = '1a000000-0000-4000-8000-000000000004';
  select count(*) into total  from ticket;
  if mine <> 2 then
    raise exception 'test_RLS_customer_cannot_read_other_customer: the customer sees % of their own 2 tickets', mine;
  end if;
  if theirs <> 0 or total <> 2 then
    raise exception 'test_RLS_customer_cannot_read_other_customer: the customer sees % ticket(s) of another customer of the SAME organisation (total visible: %)', theirs, total;
  end if;
end $$;

-- and the agent of that same organisation still sees all three: the restriction is by ROLE, not
-- a general narrowing
select set_config('request.jwt.claims',
  '{"org_id":"11111111-1111-4111-8111-111111111111","role":"agent","sub":"1a000000-0000-4000-8000-000000000002"}',
  true);

do $$
declare total int;
begin
  select count(*) into total from ticket;
  if total <> 3 then
    raise exception 'test_RLS_customer_cannot_read_other_customer: the agent sees % of the 3 tickets of the organisation', total;
  end if;
end $$;

reset role;
rollback;
