-- 0005_app_access.sql — application role access (ADR-019).
--
-- 0001 created app_rw with grants only on the quality-side read surface; nothing granted the
-- application a single privilege on the tables its consoles exist to serve. The build of the
-- app skeleton surfaced it: without these grants the application cannot start from a clean
-- clone by applying migrations alone. Access lives here, in a numbered migration behind a
-- dated ADR — never in harness scaffolding.

grant select, insert, update on ticket to app_rw;
grant select on org, app_user, account, sla_policy to app_rw;
-- No delete anywhere: nothing in the application deletes a ticket. No grant on response or
-- human_edit: the draft/approval path is the agent console's increment, and it arrives with
-- its own migration.

-- Ticket writes belong to the organisation's staff. customer_own_rows already narrows what a
-- customer can SELECT; this policy closes the write path at the schema, where the guarantee
-- belongs — the application-level role check remains as the weaker, second line. RESTRICTIVE,
-- so it ANDs with tenant_isolation instead of widening it; INSERT stays open to every tenant
-- role because raising a ticket is the customer's own act (FR-A02).
create policy ticket_write_is_staff on ticket
  as restrictive
  for update
  using ((auth.jwt() ->> 'role') in ('agent', 'supervisor'))
  with check ((auth.jwt() ->> 'role') in ('agent', 'supervisor'));
