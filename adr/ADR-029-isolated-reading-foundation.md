# ADR-029 · Isolated reading foundation (INC-01 / T01–T02)

**Status:** accepted · **Decision date:** 2026-09-08

## Context and scope

T01/T02 follows three constraints: PostgreSQL 16 is a replaceable implementation behind
the reading port for an isolated trial with synthetic data, not the final database choice; the
UI prototype becomes a reference after INC-01 acceptance, with active integration in this
repository; experimental acceptance distinguishes demonstrated coverage from the full temporal
guarantee. Merging, deployment, real data, historical database operations and model calls are
outside this delivery's scope. This ADR records implementation choices, not acceptance of INC-01.

Base: commit `1c7cc17a168cabfe7f42cdce65a163a540fd860e`; clean tree before the first change.
Branch `card/INC-01-reading-foundation`; card remains in progress through T03–T05.
History, migrations and UI source are preserved. No legacy version reconstruction is required.

## Sources and contract

The construction plan supplies the INC-01 sequence. The existing reading specification and
backend integration mapping supply the contract requirements. Their source documents remain
unchanged. The [public reading contract](../docs/reading-contract.md) describes the implemented
profile and its obligations without requiring access to the original definition workspace.

The public profile is **reading/1**, with English identifiers and the exact route
`GET /api/v1/material/{unit_id}/versions/{version_id}` alongside `GET /api/v1/material`.
It preserves the product rules of the historical **t02-lectura/1** source profile; the wire formats
are not interchangeable. No translated route alias or production compatibility adapter is provided.
This trial exposes only its two GET operations, not the broader backend API.

The [source manifest](../tests/contracts/T02_sources/provenance.json) pins the unchanged schema
and examples by SHA-256. The [canonical profile mapping](../tests/contracts/reading_profile_mapping.mjs)
records identifier equivalence for tests. Source fixtures and the mapping are test assets only;
production code imports neither. Mapping changes identifiers, never original text or opaque IDs.

## Decision: composition, contract and current boundary

1. Keep a neutral `src/app/layout.tsx`. Apply the old `LegacyShell` only to its existing pages
   through explicit layouts and the home page. No legacy URLs/pages or API handlers are moved.
   Existing promotion path checks remain; add a directed import-boundary checker and negatives.
   The checker uses the already installed TypeScript parser in the dedicated `reading` CI job
   (after npm ci), not the dependency-free `check` job. Legacy algorithms and widgets are excluded
   in both directions, including orphan modules. Only the reviewed presentation-only Panel is
   shared and inspected from both graphs; the legacy timestamp formatter is not implicitly reusable.
2. Materialize the dependency-free contract in `src/contracts/material_reading.ts`, internal
   port declarations in `src/server/kb/reading.ts`, and trial configuration/HTTP in
   `src/server/reading/`. Browser types contain only projected data, never policy/DB credentials.
3. Preserve every T02 obligation: exact pair/original including Unicode and CR/LF; bounded
   synthetic profile without truncation; authorized projections and indispensable context;
   global vs local failures; neutral errors; `private, no-store`, no ETag/304/fallback;
   current restrictions on every read; durable minimal evidence before revelation and observed
   transport result after. Shape tests do not prove those semantic/runtime obligations.
4. Trial gate defaults closed (403). Enabling requires explicit local-synthetic configuration,
   a server-supplied synthetic subject/generation and loopback binding. Legacy cookie, claims,
   request headers/query/Host and `LEDGERDESK_DEV_IDENTITY` cannot create that context.
   Invalid configuration fails startup. Next production build mode is allowed for a local trial.
   The owned launcher is `ci/reading_start.mjs [port]`, always on 127.0.0.1. It validates before
   invoking Next: Next's Ready log can precede lazy application/instrumentation initialization.
   `src/proxy.ts` applies only syntax validation to the reading API before dynamic-parameter
   decoding, which otherwise turned malformed percent escapes into a framework 500. It never
   supplies identity or permission; handlers repeat validation.
   Its environment loader, `@next/env` 16.3.1, is a direct runtime dependency. The lockfile reuses
   the exact version already resolved for Next; no dependency version is upgraded.
5. `/material` is only a preparation surface. The two HTTP routes validate syntax and deny
   missing context. With valid context they still return **503**: no repository/policy/evidence/
   terminal realization exists yet. No material is served before T04 implements those parts.
6. PostgreSQL 16 will use an exclusive disposable cluster, own schema and runtime role.
   The running local PostgreSQL 17 is not that cluster and is not touched. T01/T02 make no DB
   connection. Do not use old `ci/db_check.sh`, `ci/app_check.sh`, `ci/gateway_check.sh` against
   that installation: they drop databases and cluster-wide roles. T04 must verify actual server,
   privileges, network/DSN and isolation before any migration/test, not trust a configuration label.
   `ci/reading-compose.yml` prepares a separate PG16 service/volume, explicit synthetic password
   and loopback port 55432. No container or volume is created by this delivery. The runtime role,
   schema and grants are T04, not the bootstrap owner; healthcheck is not an isolation proof.

## Retained readers and T04 tests

These five server-rendered pages bypass HTTP handlers; protecting the new API alone is insufficient:

| Page | Direct server reader |
|---|---|
| `/portal` | `listTickets` |
| `/queue` | `listTickets` |
| `/supervisor` | `listTickets`, `countTicketsByState` (including aggregates) |
| `/tickets/[id]` | `getTicket`, `evidenceFor` |
| `/promotion` | `attemptRowsFor` |

All reach the old `withAppSession`. T04 must prove that old readers/writers/roles/definers cannot
reach the new schema and that the new runtime cannot acquire legacy/owner privileges. Include
PUBLIC, membership/SET ROLE, views/functions/search_path, pooled context and other applicable
readers/jobs/APIs; this table is not an exhaustive list of all code able to issue SQL.
None of these five pages is retired here; a retired-route assertion is therefore not applicable.

## Verification and the terminal feasibility probe

Commands for this delivery (no real DB or external provider):

```text
npm run test:reading
node ci/reading_boundary_check.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.app.json
```

For a local production-mode build, explicitly set `LEDGERDESK_READING_TRIAL=0`,
`LEDGERDESK_DEV_IDENTITY=0`, `NEXT_TELEMETRY_DISABLED=1`, then run `npm run build` and
`node tests/reading/http_preparation.mjs`. The harness owns/stops its loopback Next processes;
a local TCP trap replaces DATABASE_URL to fail any legacy DB connection. It tests actual HTTP,
old-cookie refusal, startup gate and retained unauthenticated pages; not authenticated SQL reads.
It launches through `ci/reading_start.mjs`. `npm run test:reading` runs the four named suites;
`npm run test:reading:http` requires the build. GitHub's `reading` job is configured to run both
without PostgreSQL. Its remote result and branch protection are separate from local verification.
The current `main` protection requires `check`, `db` and `app`; adding `reading` as a required
check remains pending before merge. The branch protection settings are unchanged by this delivery.

The separate Node HTTP terminal probe uses synthetic in-memory control and causal pause points:
stable reading; invalidation committed before admission; invalidation requested while admission
is held; lost control; old generation; two intentionally unsafe variants detected by the client
and event-order oracle; expiration after the last check and observable Node buffering. It is
not the Next path, PostgreSQL durability, a real permission mechanism or the final terminal owner.
Report observed events/bytes and unproven boundaries separately; a reproduced temporal breach is
evidence of a limit, not a passed full guarantee. No callback or Response object proves physical
delivery. SQL commit, transport handoff and client receipt remain distinct.

## Consequences and next consumers

T03 adapts the viewer; T04 implements persistence/policy/prior evidence and controlled transport;
T05 tests their actual integration/restart/revocations. Browser and backend may develop against
the shared contract in parallel. All 24 LR-AC groups retain their declared scopes: cases checking
only shape, preparation HTTP or a Node probe do not close the corresponding full-product group.
Writer-free expiration is investigated without prescribing its result. If not demonstrated,
LR-AC21 remains partial and full conformity pending, even if the authorized experiment is accepted.
Synthetic preparation does not authorize real data or automatically authorize later increments.
