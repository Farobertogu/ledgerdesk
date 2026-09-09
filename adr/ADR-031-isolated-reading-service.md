# ADR-031 · Isolated reading service and controlled delivery

**Status:** accepted · **Decision date:** 2026-09-09

## Context

INC-01 T04 needs executable authorization, exact persistence and prior access
evidence for `reading/1`. PostgreSQL 16 is the authorized synthetic trial engine,
not the final engine selection. A SQL commit is not an irreversible HTTP handoff.
The trial must not reuse the retained application's identity, pool or schema.

## Decision

Keep projection policy independent of storage and framework. Refine the reading
obligations with `ReadingPersistencePort`: admission, coherent preparation with
known evidence commit, transport observation, release and control-loss handling.
`PgReadingStore` is the only production reading module allowed to import `pg`.
The composition entry point chooses it; the HTTP terminal does not import the
adapter. Replacing the engine requires re-running the adapter, policy, durability
and transport tests; the interface alone establishes none of those properties.

Initialize a fresh `inc01_synthetic` cluster with a separate `reading_trial`
schema. This is not a migration of the retained schema. Use a non-owner reader
and a distinct writer. Neither can assume the schema owner, bypass row security,
create roles or databases, or inherit the retained `app_rw` role. Runtime writes
are append-only access evidence and transport observations. Original records are
immutable. All operational policy and control changes go through two fixed-search-
path privileged functions sharing the delivery admission lock.

One terminal owns the deployment through a lifetime advisory lock. Each read
takes a separate session advisory lock, then performs `REPEATABLE READ`
preparation and evidence insertion with `synchronous_commit=on`. The evidence
commit finishes before material reaches HTTP. The session lock survives commit
and remains held until the terminal observes finish, interruption or uncertainty.
No SQL transaction waits on network I/O. A writer that arrives during admitted
delivery waits; its change becomes effective at its own committed revision, not
when its request first arrives. Subsequent reads use that revision.

Serve only the two `reading/1` GET operations on a loopback Node HTTP terminal.
The launch context is server-owned and synthetic; browser identity headers and
retained cookies grant nothing. Use neutral public Problems, `private, no-store`,
no ETag, no compression and no application streaming. Private decisions and
evidence identifiers never enter public DTOs.

Store exact original strings and document data in PostgreSQL `json`, without
converting them to `jsonb` or extracting their strings inside SQL. The adapter
uses canonical JSON-encoded text keys for opaque unit/version IDs. This preserves
escaped NUL and unpaired UTF-16 code units accepted by the public JSON contract,
as well as spaces, line endings and Unicode normalization form. These are exact
decoded strings, not a claim to retain an uploaded file's encoding or byte stream.
PostgreSQL documents why `text` and `jsonb` would narrow this string domain:
[JSON types](https://www.postgresql.org/docs/16/datatype-json.html).

## Consequences and limits

The operational inventory is closed: policy replacement, generation, activation
and five treatment prerequisites use the shared writer boundary. Administrative
seed/import/schema work is offline privileged maintenance, not a covered live
writer. Direct superuser mutation, arbitrary process suspension, automatic
failover and loss-of-control physical fencing are not established by this trial.

Writer-free expiration remains partial. A real-clock experiment pauses the emitter
after its clock check and observes material handed off after the deadline. Passing
that experiment records the limitation, not temporal compliance. Expiration already
observed before the check is re-prepared and refused neutrally. This does not close
the remaining check-to-handoff interval or prove clock synchronization.

Node's `finish` means handoff to the underlying system, not human receipt.
Unknown received-byte counts remain null. Failed observation storage stops further
delivery; the durable intent is not retroactively labeled successful. PostgreSQL
session loss destroys active responses when observed; this is not a proof against
an emitter paused before it can observe that loss.

T04 uses a standalone terminal, not an authorized DTO returned through Next's
`Response` adapter. The existing Next reading routes continue to fail closed.
T05 must connect the viewer with an admission owner covering the final emitter;
proxying a previously authorized response would not preserve this boundary.

## Verification

See [T04 evidence and review scope](../docs/INC-01-T04.md) for the executable
SQL/HTTP cases, prior-stage regressions, timing protocol and remaining coverage.
No real data, model call, editorial workflow, deployment or T05 acceptance is
introduced by this decision.
