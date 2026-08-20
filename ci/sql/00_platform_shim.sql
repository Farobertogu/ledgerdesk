-- ci/sql/00_platform_shim.sql · what the managed platform provides, recreated for a bare server.
--
-- This is a CI fixture and NOT part of the migration set: on the deployment target the auth
-- schema, its two claim readers and the three platform roles already exist before the first
-- migration runs. The migrations grant to and revoke from them, so a bare PostgreSQL instance
-- needs them in place first. Nothing here is a schema decision; keeping it out of migrations/
-- is what lets the migration set stay equal to the published schema in both directions.

create schema if not exists auth;
grant usage on schema auth to public;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;
