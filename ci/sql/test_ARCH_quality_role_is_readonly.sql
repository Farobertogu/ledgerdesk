-- test_ARCH_quality_role_is_readonly
--
-- The role quality_ro holds no write privilege on any table. The only write privileges on the
-- quality side are quality_gen -> eval_item and quality_eval -> eval_result, and the test fails
-- if a third one appears: it detects the GROWTH of the exception set, not merely the purity of
-- one role.
--
-- The source of truth is has_table_privilege and not the grant catalogue, because what the seam
-- is made of is effective power: a privilege reached through PUBLIC or through role membership
-- counts exactly the same and no grant statement names it.

do $$
declare found text;
begin
  select string_agg(format('%s on %I.%I', p.priv, n.nspname, c.relname), ', '
                    order by n.nspname, c.relname, p.priv)
    into found
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p(priv)
   where c.relkind in ('r','p')
     and n.nspname in ('public','quality_report')
     and has_table_privilege('quality_ro', c.oid, p.priv);
  if found is not null then
    raise exception 'test_ARCH_quality_role_is_readonly: quality_ro holds write privileges: %', found;
  end if;
end $$;

do $$
declare found text;
begin
  select string_agg(format('%s -> %s.%s (%s)', g.grantee, n.nspname, c.relname, p.priv), ', '
                    order by g.grantee, n.nspname, c.relname, p.priv)
    into found
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['quality_gen','quality_eval']) as g(grantee)
   cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p(priv)
   where c.relkind in ('r','p')
     and n.nspname in ('public','quality_report')
     and has_table_privilege(g.grantee, c.oid, p.priv);
  if found is distinct from 'quality_eval -> public.eval_result (INSERT), quality_gen -> public.eval_item (INSERT)' then
    raise exception 'test_ARCH_quality_role_is_readonly: the quality-side write exceptions are [%], expected exactly quality_gen -> eval_item and quality_eval -> eval_result',
      coalesce(found, '<none>');
  end if;
end $$;
