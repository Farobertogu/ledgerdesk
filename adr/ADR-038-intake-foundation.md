# ADR-038: Intake contracts and bounded feasibility

**Status:** accepted
**Decision date:** 2026-09-13

## Context

The next construction step needs an explicit intake contract and evidence about
original storage and parser containment before operational handlers are built.
An isolated session transport and reading projection already exist; neither
admits a material-loading or editorial action automatically.

## Decision

Keep intake in a separate, unmounted contract boundary. Use the existing
session transport requirements and command canonicalization profile through
explicit adapters. Do not change access/1, session/1 or reading/1.

Use intake-binding/2 to separate personal loading phases, bounded internal
processing phases and other act bindings. CARGAR_MATERIAL remains PERSONA.
Receipt completion and later extraction acceptance are distinct protected
effects; a queued job is not completed processing. Technical executors,
originating people, predecessors and express authorizing acts remain separate.
Resolve the complete processing signature through the source-pinned
intake-extraction-resolution/1, not through the operation name alone. This is
contract resolution, not a new permission, catalog amendment or format adoption.
Preserve legitimate consequence-mode constitution and all current admission
checks. An unresolved processing/session/treatment dependency is not offered.

Use a versioned, structurally validated preparation representation. Its exact
references, resource associations, per-component observations and differences
are not authentication or a general semantic-fidelity guarantee. An independent
operation/reference must constrain the real producer and consumer.

Evaluate strict UTF-8 text/inert Markdown, declared CSV and bounded cell-oriented
XLSX using the identified adapter snapshot. These are experimental candidates:
the operational format scope is not adopted by this ADR. PDF/OCR
remain unoffered in this package.

Keep test-only storage/control prototypes outside production imports. Use
PostgreSQL 16 and private original-object volumes in isolated synthetic runs.
A complete object and a control commit are separate facts; reconcile both after
interruption. Do not claim an atomic filesystem/PostgreSQL transaction.

Run parsers as non-root processes in a separate, read-only image with only the
selected synthetic input mounted, no runtime network membership, no additional
capabilities, no-new-privileges, the runtime's syscall policy and finite cgroup,
workspace, descriptor, wall-time and output limits. Node permission checks
remain an additional scoped control, not the hostile-code boundary.

## Consequences

- No intake route, material permission, real job or candidate is enabled.
- The initial administrator does not acquire material authority.
- Current authorization before protected reads and effects remains mandatory in
  the real services. Test observers are not public views.
- R24 remains an observed temporal failure. This decision does not authorize
  real data, operational deployment or full temporal conformity.
- Existing identities, intentions, canonical profiles and historical data remain
  unchanged. A future shared implementation change needs its coupled tests.
- The versioned binding contract defines each effect and exact server catalog
  resolution separately from live authorization. No missing deployment
  admission is filled with a permissive stub or a new permission by name.
- The explicit retained-profile converter preserves all source observations
  alongside its mapped structural view. That sidecar is protected evidence,
  not a public candidate response. Actual persistence and disclosure must use
  independently controlled antecedents and current authority.
- Acceptance requires the owner's explicit decision; a successful experiment
  or CI run alone does not authorize acceptance.

See [the contract](../docs/intake-contract.md) and
[the evidence and remaining work](../docs/INC-03-T01.md).

## Amendments

### 2026-09-13 — Bounded durable reception

**Amendment status:** proposed
**Amendment decision date:** pending acceptance

This localized proposal changes the unmounted boundary for nine reception/query
operations only. The foundation decision above remains the accepted historical
decision; this proposal is not its automatic acceptance.

Compose the isolated reception terminal explicitly behind the existing access
terminal's current session transport. Keep it absent by default and synthetic
only. Use intake-reception/1 and intake-availability/1 without modifying access/1,
session/1, reading/1 or the retained foundation envelopes. Do not mount worker,
preparation, constitution or editorial operations.

Retain the exact original in a private object service. Separate reservation,
staging/seal, SQL receipt commit, subsequent unstarted work and protected response
handoff. There is no file/SQL atomicity or implicit retry. Preserve the stable
intention namespace and current query authorization when recovering known effects.

Use the existing authority evaluator and source-coordinated SQL admission, plus
durable private-phase control outside restored receipt data. Keep dependent
authority/control writes closed while private work remains unresolved. Observe
actual child closure, retain closed phase identities, and check the source epoch
in the new effect snapshot after retiring a phase. SQL/HTTP connection loss is
not proof that private work stopped. Controlled recovery is deliberately narrow;
the trusted broker/host and recovery supervisor are not claimed to be hostile.

The minimum form verifier is separate from substantive extraction and needs
current treatment before input. A receipt does not certify workbook extraction
coverage, semantic fidelity, a candidate or editorial approval. Retain current
whole-original authorization and separate pre-read and pre-handoff evidence.

This proposal preserves the observed R24 violation and the two browser diagnostic
follow-ups. It authorizes no real data, public deployment, automatic failover or
new format. Its review requires the identified actual service, coupling, failure,
recovery and resource evidence; offline checker self-tests are not service tests.

See [the reception contract](../docs/intake-contract.md) and
[its implementation/evidence status](../docs/INC-03-T02.md).
