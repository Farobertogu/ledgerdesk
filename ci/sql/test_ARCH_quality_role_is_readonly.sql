-- test_ARCH_quality_role_is_readonly
--
-- The role quality_ro holds no write privilege on any table. The only write privileges on the
-- quality side are quality_gen -> eval_item and quality_eval -> eval_result, and the test fails
-- if a third one appears: it detects the GROWTH of the exception set, not merely the purity of
-- one role.

do $$
declare found text;
begin
  select string_agg(format('%s on %s', privilege_type, table_name), ', ' order by table_name, privilege_type)
    into found
    from information_schema.role_table_grants
   where grantee = 'quality_ro'
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');
  if found is not null then
    raise exception 'test_ARCH_quality_role_is_readonly: quality_ro holds write privileges: %', found;
  end if;
end $$;

do $$
declare found text;
begin
  select string_agg(format('%s -> %s (%s)', grantee, table_name, privilege_type), ', '
                    order by grantee, table_name, privilege_type)
    into found
    from information_schema.role_table_grants
   where grantee in ('quality_gen','quality_eval')
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');
  if found is distinct from 'quality_eval -> eval_result (INSERT), quality_gen -> eval_item (INSERT)' then
    raise exception 'test_ARCH_quality_role_is_readonly: the quality-side write exceptions are [%], expected exactly quality_gen -> eval_item and quality_eval -> eval_result',
      coalesce(found, '<none>');
  end if;
end $$;
