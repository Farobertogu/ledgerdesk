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

**Amendment status:** accepted
**Amendment decision date:** 2026-09-14

This localized amendment changes the unmounted boundary for nine reception/query
operations only, within the documented synthetic experimental scope of I03-T02.
The foundation decision above remains the accepted historical decision. This
separate acceptance does not complete INC-03 or authorize later processing.

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

This amendment preserves R24's four observed writer-free expiry violations,
the unexercised same-original fragment provenance, the two browser diagnostic
follow-ups and the unknown cause of the historical L03 failure. It authorizes
no real data, public deployment, automatic failover or new format. Its acceptance
uses the identified actual service, coupling, failure, recovery and resource
evidence within those limits; offline checker self-tests are not service tests.

See [the reception contract](../docs/intake-contract.md) and
[its implementation/evidence status](../docs/INC-03-T02.md).

### Bounded extraction — proposed 2026-09-15

**Amendment status:** accepted
**Amendment decision date:** 2026-09-19

This localized acceptance covers only I03-T03's documented bounded synthetic extraction.
The original foundation and reception decisions retain their separate dates and scope.
The historical heading records when this amendment was proposed, not its current status.

Add separately admitted extraction after receipt; keep receipt, worker dispatch,
result acceptance and protected disclosure as different effects. Use the closed
`intake-worker/3` channel and explicit `intake-reception/2` and
`intake-availability/2` projections without changing stored `intake/1` intention
semantics. A promoted job cannot be reported as historical non-started work.

Reuse the identified isolated text/Markdown, CSV and bounded XLSX adapters.
Current authority must precede protected body reads and every new dependent
effect. Channel binding and integrity do not certify semantic fidelity. Keep
the original generation separate from retry generation; reconcile uncertain
and known effects before new execution, and conserve failed/partial/unknown
observations honestly. No confirmed preparation or candidate is created here.

Acceptance is based on the identified worker/service path, resource observations,
coupled regressions and complementary independent reviews recorded in
[the T03 report](../docs/INC-03-T03.md#current-status). Implementation CI
[35399188463](https://github.com/Farobertogu/ledgerdesk/actions/runs/35399188463) passed
all 14 jobs and produced actual current-image qualified Linux memory evidence. The
documentary acceptance commit still requires its own final-head CI before merge.
R24, browser follow-ups, the unknown historical quota cause, real-data and production
restrictions are unchanged. Passing CI alone is not the owner's acceptance.

The worker carries the observation object directly, not an escaped nested JSON
string. Its exact complete reply remains protected raw evidence. Version 2 is
not an implicit alternate decoder. The bounded extraction transport reserves
40 MiB for raw stdout, 16 MiB for normalized content, 56 MiB in total, a 64 KiB
failure projection within that normalized allocation, an 80 MiB private frame,
and 16 MiB plus 64 KiB for the protected HTTP projection. Original, archive,
sheet, cell and parser-execution limits do not change. Preparation quotas and
historical profiles do not inherit these transport-specific bounds.

The trusted private transport has a separate 1 GiB cgroup with no additional
swap, 256 MiB V8 heap per server/relay and the existing CPU/PID limits. This
accounts for simultaneous framed input, base64 decoding, relay serialization,
bounded artifact bytes and charged file cache. The analyzer remains at 512 MiB
and 128 MiB V8 heap. The effective settings and actual cgroup high-water/counter
observations must accompany full-path results; a passing sample is not a proof
that every admissible object completes below a universal memory peak.

A completed extraction whose normalization exceeds its bound retains its raw
observation and a separately identified normalization failure. A supervisor
output limit remains the primary cause even when truncation makes the retained
bytes undecodable. Neither an intact artifact nor a larger transport allocation
authenticates its provenance or demonstrates semantic completeness. Physical
budget and coupled-consumer evidence remain implementation exit conditions.

The synthetic populated restore retains exact historical output rows against
an independently stored control cut. It does not fabricate a new sealing PID,
disable association triggers or restore access/control state from the archive.
Restored objects use their own physical location and a current namespace/anchor
binding, while original manifests and accepted effect identities stay intact.
This is not an automatic import endpoint or a universal backup-capacity claim.

Actual process-death experiments distinguish loss before SQL staging, loss after
staging and loss of the acceptance reply. Reconciliation of a known result uses
current query authority without re-execution. An unconfirmed predecessor cannot
become a new attempt just because its owner process ended. Separate participant
recovery and final coupled verification remain required before review closure.

#### Correction clarification — 2026-09-19

These clarifications were proposed with correction R2 and are included in the
bounded acceptance above; they do not alter the earlier foundation/reception scope.

Reserve the finite 56 MiB per-attempt conservation obligation atomically before
protected input or launch, within a 256 MiB extraction aggregate. Retain pending,
uncertain and sealed-before-SQL obligations; settle durable actual bytes once,
including failed results. Do not erase history to admit another attempt. This
accounting is not an OS disk quota, analyzer scratch or original-object budget.

Use compact exact text/ranges for dense text normalization rather than expanding
transport limits. Provide a closed useful metadata-only view without reading
protected bodies; keep original and extraction permissions independent. Exercise
nonempty resources/indispensable relations through a labeled instrumented
producer and independent association expectations, not a claim of native image
extraction or a T04 preparation producer.

Actual controller loss and unresolved private-participant replacement remain
fail-closed when closure is unconfirmed. A reachable replacement cannot inherit
authority or invent a stopped predecessor. The qualified L03 mechanism is reused;
historical or Windows-host results are not qualification of the current T03 image.
The separate Linux execution and its exact image/proof are recorded in the current
T03 report. This bounded acceptance does not close R24, accept universal memory or
hostile-host guarantees, implement preparation/constitution, or authorize real data.

### Exact preparation and constitution — proposed 2026-09-19

**Amendment status:** proposed
**Amendment decision date:** pending acceptance

This localized proposal changes the unmounted preparation/constitution boundary
only for T04's bounded synthetic implementation. The foundation, reception and
extraction decisions above keep their historical acceptance and scope. Local
implementation and green tests do not accept this amendment.

Compose eight preparation handlers and the explicit preparation-profile lookup
at the existing terminal only when `intake-preparation/1` is enabled. Keep
`intake/1`, `session/1`, `reading/1` and old intentions unchanged. Add closed
`preparation-content/1`, `prepared-material/2` and command/response shapes with
separate canonical digest domains. No automatic profile fallback, approval,
publication, search or preparation UI is introduced.

Conserve the exact selected preparation, antecedents, resources, indispensable
relations, scoped coverage/causes and pair-bound differences immutably. Current
admission precedes protected bodies; independent controlled source records, not
arriving hashes, establish provenance. A documented nonliteral transformation
keeps its antecedents and differences without claiming verbatim origin or inherited
approval. A valid schema or a constructor mutation detected by a test is not a
general guarantee of semantic sufficiency or defense against all producer errors.

Use individual M04-D02 effect comparisons and the existing current authority
engine. Loading faculty is not a fallback. Keep actual prior human authorization,
express consequence target, issuer/support, service executor and current
treatment distinct. The controlled prior-act input is consumed, not newly
authored through an unapproved route. Unresolved admission closes the operation.

Constitution fixes the inspected preparation revision and logical item. C9
compares authorized content, conditions and context with the explicit judgment;
repetition records a relationship, a successor remains explicit, and unresolved
identity/duplicate outcomes retain their typed FN-AMBITO destination vacancy.
Ordered item locks and SQL uniqueness constrain different keys and re-proposals
to one effect. Lost responses reconcile the same historical effect under current
consultation, even if creation faculty has been withdrawn. Revoked consultation
hides the result without erasing it or re-executing anything.

Use additive data/control migrations and finite original-preserving recovery.
Restoring preparation data cannot restore authority. Stage and payload limits
are independently 8 MiB, with a 64 MiB retained pool; commands and structural
ceilings remain explicit. An oversized selected closure is refused honestly,
not narrowed, truncated or enabled by extraction's larger transport budget.
No universal physical-memory or backup-capacity guarantee follows.

R24 remains an observed temporal nonconformity at the new preparation, proposal,
constitution and delivery seams. Writer coordination does not stop time. The
experimental exception does not excuse authentication, permissions, isolation or
protected pre-read failures and does not authorize real data. Browser follow-ups
and historical unknown causes stay open. T05/T06 and production are outside this
amendment. See [the implementation and finite evidence](../docs/INC-03-T04.md).
