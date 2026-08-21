# ADR-019 · Application role access to the ticket surface

**Status:** accepted · **Decision date:** 2026-08-21

## Context

The complete schema of ADR-018 created the four database roles and granted the application role (`app_rw`) only its quality-side read surface. No grant existed on `ticket`, `org`, `app_user`, `account` or `sla_policy` — the tables the application's consoles exist to serve — so the application could not start from a clean clone by applying migrations alone. The app-skeleton build surfaced a second gap in the same area: `ticket` had no write policy by role, so at the schema level a customer's claims could update any ticket of their organisation, and the only thing preventing it was an application-level check — the weaker of the two guarantee classes this repository uses.

## Decision

1. **Grants, minimal and named** (`0005_app_access.sql`): `select, insert, update` on `ticket`; `select` on `org`, `app_user`, `account`, `sla_policy`. No `delete` anywhere — nothing in the application deletes a ticket. No grant on `response` or `human_edit`: the draft/approval path arrives with the agent console's own migration.
2. **Ticket writes are staff-only at the schema.** A `ticket_write_is_staff` policy, **restrictive** and `for update`, limits updates to the `agent` and `supervisor` roles in both `using` and `with check`. `insert` stays open to tenant roles because raising a ticket is the customer's own act; `customer_own_rows` continues to narrow customer reads. The application-level role check remains as the second, weaker line.
3. **The dev-bootstrap scaffolding file is retired.** Access now comes from the migration set; the harness applies migrations and nothing else.

## Consequences

A clean clone plus `migrations/` in order is again sufficient for every consumer, application included. The golden schema (`ci/expected/schema.sql`) is regenerated in the same change — the both-directions diff would refuse anything less. The policy-name register in the migration test gains `ticket_write_is_staff`.
