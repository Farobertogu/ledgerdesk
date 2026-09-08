# Reading contract: reading/1

This document defines the English public interface for the synthetic INC-01 reading trial.
The shared types and validators live in [material_reading.ts](../src/contracts/material_reading.ts),
the internal delivery ports in [reading.ts](../src/server/kb/reading.ts), and the HTTP and trial
configuration in [server/reading](../src/server/reading/). The module is dependency-free and carries
only public JSON types. Authorization, persistence, delivery and viewer behavior remain separate
implementation obligations.

T01/T02 currently validates requests and closes the reading routes: invalid syntax returns 400,
missing internal trial context returns 403, and valid configured requests return 503 until T04
provides the actual service. The success shapes below define the consumer contract; they do not
claim that material is already served. [ADR-029](../adr/ADR-029-isolated-reading-foundation.md)
records the isolation and startup decisions, while [the verification record](INC-01-T01-T02.md)
distinguishes completed checks from pending work.

## Source equivalence

`reading/1` is the English implementation of the historical `t02-lectura/1` trial profile. Its
field names, enum labels, error titles and detail route are deliberately changed. The profiles
preserve the same product rules but are not wire-compatible. There is no production adapter or
alias for the historical translated detail route. This profile covers only the two reading
operations below, not the broader backend API.

The [source manifest](../tests/contracts/T02_sources/provenance.json) records the unchanged source
schema and authored examples with their original SHA-256 pins. The
[canonical bilingual mapping](../tests/contracts/reading_profile_mapping.mjs) is the single
identifier-equivalence definition used by contract tests. It does not translate opaque IDs,
original titles, locators, conditions or source text. The source files and mapping are offline
test evidence, never production imports or fallback responses. Authored expected examples are
not observations of a running service.

## Requests and identity

Both operations use GET without a body or query parameters:

| Operation | Route | Logical input |
|---|---|---|
| List the declared trial population | `/api/v1/material` | `{}` |
| Read an exact version | `/api/v1/material/{unit_id}/versions/{version_id}` | `{ unit_id, version_id }` |

The logical input is extracted from the route; it is not a GET payload. Extra fields, query
parameters, malformed escapes and ambiguous segmentation are rejected before looking up material.
IDs are nonempty opaque strings. They do not encode authority, editorial meaning or global order,
and decoded values are never interpreted as SQL, filesystem paths or instructions. The server
must verify that the requested version belongs to the requested unit in the permitted context.
A crossed pair is unavailable; an older version is never redirected or replaced by its successor.
Material version identity is distinct from the API profile and internal technical revisions.

The server resolves the declared trial deployment and scope, synthetic subject, reading surface,
purpose, current time and applicable restrictions. The route fixes the action. A client cannot
grant itself authority through IDs, headers, cookies, roles, query parameters or interface controls.
The trial is explicitly enabled on a local synthetic environment and bound to loopback; this is
not production authentication. Every read, including direct server access, requires current checks.

## Closed response shapes

Every success contains `contract: "reading/1"`. A list is
`{ contract, items: ReferenceView[], existence_signal: boolean }`; detail is
`{ contract, projection: Projection }`. `Projection` is a closed discriminated union:

| Variant | Required fields | Permitted content |
|---|---|---|
| `REFERENCE` | `kind`, `reference`, `metadata` | Exact pair and individually authorized metadata |
| `EXCERPT` | Reference fields plus `original_language`, `fragments` | One to eight explicitly delimited exact fragments |
| `CONTENT` | Reference fields plus `original_language`, `original_text` | Complete exact textual original of the requested version |

`reference` contains only `unit_id` and `version_id`. A fragment contains `fragment_id` and `text`,
with optional `locator`. Metadata permits only `title`, `locator`, `editorial_state`,
`classification` and `reading_conditions`; all are structurally optional and separately authorized.
Objects reject additional fields. No projection carries hidden bodies, document hashes, private
policy keys, owners, successor identities, redaction reasons, internal access levels, offsets or
the total length of withheld material.

The server forms the projection before crossing into the client. An access level is a maximum,
not an instruction for the browser to hide fields or a grant over related material. Metadata that
is indispensable for meaning must be present and authorized. If it cannot be disclosed, the server
may deliver a lower projection only if that projection is also authorized and faithful; otherwise
the result is unavailable. A rule cannot be presented without an indispensable exception.

The list contains the complete identifiable authorized population within the declared synthetic
universe. It contains only `REFERENCE` views, ordered by visible `(unit_id, version_id)` using a
stable ordinal comparison after authorization and projection. Hidden objects do not introduce
gaps, reserved slots, counts or changes in order. A local inability to determine disclosure excludes
only the affected object; the remaining authorized list retains its successful response.

`existence_signal` is a separately authorized, generic indication of relevant presence within this
fixed list scope. It gives no identity or count. Several objects can contribute only one signal;
`false` does not establish that hidden material is absent. An object with no permitted disclosure
does not affect the list, signal or permitted observable behavior. Existence-only disclosure never
confirms a requested identity in detail: absence, no disclosure, local indeterminacy, existence-only
access and unavailable indispensable context share the same neutral 404.

## Editorial state and classification

The seven editorial states are `CANDIDATE`, `REJECTED`, `APPROVED_UNPUBLISHED`, `PUBLISHED`,
`SUSPENDED`, `SUPERSEDED` and `WITHDRAWN`. Review workflow, visibility and current applicability
are separate concepts. A state label does not perform an editorial act or authorize disclosure.
Historical reading can include states other than `PUBLISHED` when authorized and accompanied by
the conditions necessary to represent future, suspended, superseded or withdrawn material faithfully.

Classification has three required axes whenever it is present:

| Axis | Values |
|---|---|
| `substantive_function` | `DEFINITIONAL`, `NORMATIVE`, `OPERATIONAL`, `FACTUAL` |
| `validity_basis` | `SCOPE_ADOPTION`, `APPLICABLE_EXTERNAL_AUTHORITY`, `VERIFIABLE_ATTESTATION`, `NON_AUTHORITATIVE_REFERENCE` |
| `application_scope` | `REUSABLE_WITH_CONDITIONS`, `SITUATED` |

Structural validation checks the declared values; it does not ratify a classification, make an
incompatible combination valid or turn pending classification into an approved fact.

## Exact originals and trial limits

`original_language` is `es` or `en` in this trial. It names the source text's language, not the
interface language or a production language restriction. Changing interface controls must leave
the selected pair, authorized title and original unchanged. The original is the exact decoded
character sequence, including accents, Unicode representation, leading or repeated spaces and
CR/LF endings. JSON escaping may change transport representation without changing that sequence.
Do not trim, normalize, correct or translate the source. A textual original is not a reconstructed
PDF or Word binary.

Each fragment is an explicit, authorized selection that must match an exact substring of its
original and preserve indispensable context. A schema does not select boundaries or prove that
the selection is faithful. No summarizer, extraction algorithm or automatic declassification is
introduced by this contract.

The synthetic profile permits at most 16 list references, eight fragments, 100000 characters per
text or locator, 256 per title or reading condition, and 128 per ID. IDs require at least one
character; an excerpt requires at least one fragment. Lengths count Unicode code points, not
UTF-16 units or HTTP bytes. These are trial-only structural limits. Prepare the visible universe
to fit them; an oversized visible projection requires correcting the trial or versioning the
contract before serving it. Neither text nor lists may be truncated, and hidden population must
not determine a public capacity error. No global totals, pagination, `latest` lookup or free query
are part of this profile.

## Errors and transport

A producer emits only `{ type: "about:blank", title, status, code }` with these exact combinations:

| HTTP | Code | Title | Meaning |
|---|---|---|---|
| 400 | `REQUEST_NOT_ADMITTED` | `Invalid request` | Invalid public request shape |
| 403 | `UNAUTHENTICATED` | `Unauthenticated` | Required internal context is missing, checked before object lookup |
| 404 | `UNAVAILABLE` | `Unavailable` | No identifiable, faithful projection can be delivered |
| 503 | `TECHNICAL_FAILURE` | `Technical failure` | A global inability to perform the operation, independent of the requested ID |

There is no public `detail`, `instance`, stack, SQL, private cause, policy revision or hidden
resource identifier. Global repository or policy infrastructure failure is established independently
of whether a requested object exists; it never becomes an empty successful list or a stored/demo
fallback. Local indeterminacy remains a local refusal with protected internal cause and governance
debt. Policy checks follow unit policy, inheritance and explicit general policy without bypassing
an express denial to find a broader grant. Public bodies, headers and other measured behavior must
not disclose the hidden refusal cause.

All responses use `Cache-Control: private, no-store`; successes use `application/json` and errors
use `application/problem+json`. Material is not delivered through ETag/304 reuse, redirects, public
caches or offline fallback. Missing trial context uses 403 without inventing a 401 challenge.
Error titles are fixed for the profile regardless of interface language.

Strict producer validation and tolerant Problem Details consumption are distinct. The consumer
ignores unknown extensions without displaying or returning them and checks the actual HTTP status
against the body. Incoherent status/code/title combinations or unusable responses become a
presentation failure, never permission to recover an earlier body.

## Delivery and viewer obligations

T04 must coordinate admission, current restrictions and minimal durable evidence before revealing
material. SQL must finish with a known commit while admission remains held through the controlled
transport handoff; external I/O must not hold the SQL transaction open. Internal evidence records
minimal decision metadata, never the material body. Receipts and transport observations belong to
server ports and are not client payload fields or client authority. The observed result is recorded
afterward; unknown byte counts remain unknown. A prepared payload, callback, `Response` object or
two database reads alone does not establish safe delivery.

Revocation, expiration, loss of control and pauses across preparation and delivery require measured
tests against the actual terminal implementation. SQL commit, transport handoff and client receipt
are different events. The current Node probe does not establish PostgreSQL durability, control over
Next delivery, physical buffer fencing or the complete temporal guarantee. LR-AC21 remains partial
until its required boundary is demonstrated.

T03 must render received text as inert text with spaces and line endings preserved. It must not
execute HTML/Markdown, scripts or external loads from text or locators. List loading, permitted
empty results, local filter misses, no selection, detail loading, available detail and errors are
interface states separate from editorial state. A 503 is never an empty list.

Only a response matching the active unit, version, context generation and request sequence may be
shown. Context changes invalidate old lists, details and pending requests; a new refusal clears
previous material from the active surface. Cancellation cannot recall bytes already received, and
later restrictions do not rewrite the history of a legitimate earlier delivery. SSR, hydration,
prefetch, browser logs and service workers obey the same projection boundary. Local filtering uses
only received titles and references. A manual retry performs a fresh authorized read.

The 24 LR-AC acceptance groups retain their original scopes. Contract shape and source-equivalence
tests do not demonstrate policy execution, contextual fidelity, persistence, rendering, timing or
the integrated T03–T05 path. Synthetic acceptance does not authorize real data, deployment or later
increments. Adding the `reading` CI job to required `main` checks remains pending before merge.
