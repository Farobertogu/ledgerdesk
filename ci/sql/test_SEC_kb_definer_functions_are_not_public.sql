-- test_SEC_kb_definer_functions_are_not_public
--
-- Every callable `security definer` function in this schema is unreachable by PUBLIC.
--
-- **Why this is a sweep of `pg_proc` and not a list.** A list would cover the functions somebody
-- remembered to add to it, and the failure this test exists for is precisely the one nobody
-- remembers: `create function` grants EXECUTE to PUBLIC by default, so a privileged function is,
-- on the day it is written, a privilege escalation available to every role in the cluster unless the
-- author says otherwise. Nobody had said otherwise for three migrations. A sweep covers the function
-- somebody adds tomorrow without anybody having to think about this file again.
--
-- The consequence before it was closed, stated because it was measured rather than supposed, by
-- execution in a transaction that was rolled back: EVERY ROLE IN THE CLUSTER — the application role,
-- and `anon` with no session at all — could write articles into another organisation's corpus and
-- move that organisation's snapshot pointer, with no approver, no admission and no row in any chain.
-- THE PLANTED DOCUMENT ENTERED CITABLE, because the original advance read an absent flag as `true`,
-- so what an intruder put in somebody else's corpus was quotable to their customers.
--
-- The sentence said "the application role" until it was re-measured, and that understated it in both
-- directions: no session was needed to do it, and what arrived was not inert.
--
-- **Trigger functions are outside the sweep, and the exclusion is declared rather than quiet.** A
-- trigger function is not callable: invoking one directly raises "trigger functions can only be
-- called as triggers", so its EXECUTE privilege grants nobody anything. What that privilege does
-- gate is `create trigger`, which the migrations perform as the owner. Revoking it would buy no
-- property and would change the conditions under which every existing trigger was created, which is
-- not a trade any card should make for a guarantee it already has.
--
-- The second half is the other direction: a revocation that also took away what the application
-- legitimately needs would be a migration that passes this test and breaks the product.

-- --- no callable definer function is reachable by PUBLIC ------------------------------------------
do $$
declare
  offender text;
begin
  select string_agg(signature, ', ' order by signature) into offender
    from (
      select p.oid::regprocedure::text as signature
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prosecdef
         and p.prorettype <> 'pg_catalog.trigger'::regtype
         and (
           -- A null ACL is the default the language applies, and the default grants EXECUTE to
           -- PUBLIC. It is the case this test was written for, so it is named first.
           p.proacl is null
           or exists (
             select 1 from aclexplode(p.proacl) a
              where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         )
    ) as public_definers;

  if offender is not null then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: % executable by PUBLIC', offender;
  end if;
end $$;

-- --- and every definer function is accounted for, so a sweep of nothing cannot pass ---------------
do $$
declare
  n integer;
begin
  select count(*) into n
    from pg_proc p
    join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public'
     and p.prosecdef
     and p.prorettype <> 'pg_catalog.trigger'::regtype;

  if n < 6 then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: only % callable definer function(s) found; the sweep is looking at the wrong thing', n;
  end if;
end $$;

-- --- the application still reaches the three it is supposed to reach, and no more ------------------
do $$
declare
  gap_open  text := 'kb_gap_open(uuid,uuid,uuid,text,text,boolean,text,text,uuid,date,text,uuid[],bigint)';
  advance   text := 'kb_snapshot_advance(bigint,jsonb)';
  close_new text := 'kb_gap_close_by_verification(uuid,uuid)';
  advance_old text := 'kb_snapshot_advance(uuid,text,text,jsonb,bigint)';
  close_old   text := 'kb_gap_close_by_check(uuid,bigint)';
  mark        text := 'kb_gap_mark_not_documentable(uuid,text)';
begin
  if not has_function_privilege('app_rw', gap_open, 'execute') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw cannot open a gap record, so no escalation can emit one';
  end if;
  if not has_function_privilege('app_rw', advance, 'execute') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw cannot advance a snapshot, so nothing can be admitted';
  end if;
  if not has_function_privilege('app_rw', close_new, 'execute') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw cannot close a gap by verification, so no gap can ever close';
  end if;

  -- The one the hardening exists for. Granting the application the ORIGINAL advance would hand back
  -- the exact hole this migration closed: it takes the organisation and both snapshots as arguments,
  -- so a caller holding EXECUTE can write into any tenant it can name.
  if has_function_privilege('app_rw', advance_old, 'execute') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw can execute the original advance, which accepts an organisation from its caller';
  end if;
  if has_function_privilege('app_rw', close_old, 'execute') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw can execute the unverified closure';
  end if;
  if has_function_privilege('app_rw', mark, 'execute') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw can mark a gap not documentable, which no console offers';
  end if;
end $$;

-- --- the admission is readable and stays that way -------------------------------------------------
do $$
begin
  if not has_table_privilege('app_rw', 'kb_admission', 'select') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw cannot read kb_admission, so the panel that exhibits the cycle is empty';
  end if;
  -- No INSERT, today or ever. An admission the application could write directly is an admission with
  -- no approver tied to the session that made it, and that tie is the whole of what makes a human
  -- approver mean anything.
  if has_table_privilege('app_rw', 'kb_admission', 'insert') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw can insert an admission, so an admission has a second producer';
  end if;
  if has_table_privilege('app_rw', 'kb_admission', 'update') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw can update an admission';
  end if;
  if has_table_privilege('app_rw', 'kb_admission', 'delete') then
    raise exception 'test_SEC_kb_definer_functions_are_not_public: app_rw can delete an admission';
  end if;
end $$;
