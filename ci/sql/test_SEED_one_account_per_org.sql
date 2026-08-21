-- test_SEED_one_account_per_org
--
-- Nothing in the schema links an app_user to an account, so the intake path resolves a customer's
-- account from their organisation. That resolution is exact only while an organisation has exactly
-- one account, and this is where that condition stops being an assumption: the day a second
-- account is seeded for an organisation, the build goes red HERE, and the intake mapping is named
-- as the first thing to revisit rather than discovered as a wrong ticket months later.
--
-- The application refuses the ambiguous case at run time as well (E_ACCOUNT_AMBIGUOUS). This test
-- and that refusal are the two halves of one decision: the deferral of a real customer-to-account
-- mapping is declared, and both the seed and the intake path fail loudly if it stops holding.
--
-- All three directions are checked. "No organisation has more than one account" is also true of an
-- empty table, and "every organisation has one" is trivially true with no organisations, so
-- neither statement alone would prove anything about a seed that loaded nothing.

do $$
declare
  orgs          int;
  orgs_with_one int;
  overloaded    int;
begin
  select count(*) into orgs from org;
  if orgs < 2 then
    raise exception 'test_SEED_one_account_per_org: % organisation(s) seeded; two are required for tenant isolation to be demonstrable', orgs;
  end if;

  select count(*) into overloaded
    from (select org_id from account group by org_id having count(*) > 1) many;
  if overloaded <> 0 then
    raise exception 'test_SEED_one_account_per_org: % organisation(s) hold more than one account; the intake path resolves a customer''s account from their organisation and can no longer do so unambiguously', overloaded;
  end if;

  select count(distinct org_id) into orgs_with_one from account;
  if orgs_with_one <> orgs then
    raise exception 'test_SEED_one_account_per_org: % of % organisations have an account, so the zero above proves nothing', orgs_with_one, orgs;
  end if;
end $$;
