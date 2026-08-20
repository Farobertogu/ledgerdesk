-- ci/sql/00_platform_shim.sql · what the managed platform provides, recreated for a bare server.
--
-- This is a CI fixture and NOT part of the migration set: on the deployment target the auth
-- schema, its two claim readers and the three platform roles already exist before the first
-- migration runs. The migrations grant to and revoke from them, so a bare PostgreSQL instance
-- needs them in place first. Nothing here is a schema decision; keeping it out of migrations/
-- is what lets the migration set stay equal to the published schema in both directions.
--
-- What this shim does NOT reproduce, so that "green in CI" is never read as "green on the target":
--   · the platform's default privileges, which grant broadly to its own roles on new objects;
--   · the full form of auth.uid(), which on the target also reads request.jwt.claim.sub;
--   · anything the platform's connection pooler sets per session beyond the claims.

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
      -- service_role carries BYPASSRLS on the target: a shim that made it a plain role would let
      -- every RLS test pass in a world where the service role can do nothing.
      if r = 'service_role' then
        execute format('create role %I bypassrls', r);
      else
        execute format('create role %I', r);
      end if;
    end if;
  end loop;
end $$;
