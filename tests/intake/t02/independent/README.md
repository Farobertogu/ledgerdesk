# Independent reception observation checks

Release: `t02-independent/6`. Packet: `intake-observation/1`, `interfaceRevision: 3`. Supported addenda: `3.2` and `3.3`; the exported default remains `3.2` for unchanged consumers. New phase/lineage evidence explicitly opts into `3.3`.

This is a read-only checker of captured observations against fixed cases and original bytes. It does not start services, resolve authority, execute SQL or attest that an observation producer is honest. Its self-tests contain explicitly invented observer records. Passing them proves discrimination of those records, not a working reception service.

## Release 6: prior upload with compatible reconciliation

The complete prior-upload window is supported for IC05/receipt and for the specific IC04/compatible journey consisting of a new subject finalization followed by compatible canonical reconciliation. Other case/variant compositions remain rejected. The R3.3 field map and fixed references are unchanged; no upload event is removed, relabelled or turned into a second seal.

All existing canonical namespace, literal wire/canonical bytes, executed incumbent comparison, durable correlation and one-receipt/one-job checks still run. The composed IC04 path additionally checks the first invocation against the prior window's actual finalizer, separate current replay admission and own query evidence, no replay original access/effect, completed first response before replay and returned operation/reception/original/effect/work identities against the same durable receipt and pending job. The replay's selected delivery still reaches the shared M07 postcondition. Prior authorization never authorizes current finalization or reconciliation.

The new tests consume both unchanged packets from the identified 03:18 real capture retained by the R5 second replay. The old R5 checker must continue to reject IC04 at its case-pair guard and accept IC05; R6 must complete both exported consumers. Each new negative has its exact real positive and retained failure data. Mutated packets and cloned unsupported-profile references are test illustrations, not new runtime evidence. Two profiles from one captured journey are not two independent service runs.

## Preserved release 5: qualified metadata and prior upload

Addendum 3.3 requires `phaseLineage: {metadata: [], priorUploads: []}` and an independent `references/CASE/VARIANT.phases.json`. `phase_lineage.mjs` verifies contained hashed JSON evidence references and raw-record joins. Addendum 3.2 keeps its earlier shape and rules; unknown addenda or adding phaseLineage to 3.2 are rejected.

Command metadata is qualified from actual SQL scope, evidence insertion, own-backend admission, consumed command and later selection. Honest null operation/reception/artifact/generation remain null. The exception applies equally to subject and other calls and never authorizes object access or handoff. An unsampled metadata connection has transactionOpen=null, not an idle flag copied from a later connection. A real own-backend sample is separately checked. The exercised C1 path has one complete command application-read record per metadata proof; a chunk-only record cannot stand in for the whole fixed command wire. No streaming-aggregation extension is implied.

IC05/receipt may use an independently fixed, separately inventoried prior binary-upload window while retaining the finalization before snapshot. Its selected seal needs actual bytes, current attempt, read_admission plus the specific durable verification plan, real seal dispatch/request identity, participant completion and artifact observation. Ordinary read_admission does not become write permission. The old non-subject capture_admission rule remains everywhere except that fully qualified exact seal. The current finalizer still needs fresh admission/read, its own new receipt/effect/unexecuted work and completed governed delivery. An earlier seal never grants current authority.

The producer-facing addendum defines the precise field map and required collection points. Existing C1 raw companions support explicit metadata mapping with the backend limitation declared. Existing C2 captures lack the earlier client and typed phase witnesses; their original packet remains rejected. Full synthetic prior-window controls are labelled as illustrations, never real-runtime results. They preserve original captures separately and identify their deliberately extended call/reference inventory.

## Preserved release 4: selected completed delivery

One shared postcondition checks every declared governed handoff with a completed linked HTTP response, for the subject and other calls, including error responses. The request boundary selects the response label; the handoff selects the exact evidence ID. Call, operation, reception, principal, delivery phase, closed transaction and observed ordering must agree. That selected preparation's HTTP status must equal the completed response status. A matching governed 409 or 500 is not rejected merely for being an error. No alternate unused row supplies credit for a selected mismatch.

This is not a comparison against COMMIT outcome. A committed preparation may remain unused when the final connection or clock check prevents its governed handoff. A separate problem response or missing client reply does not retroactively rewrite it. Interrupted/observation-failed events and no-reply responses do not earn the completed-delivery check; their existing case-specific requirements still apply. Generic nullable observation syntax is unchanged, but null cannot corroborate the status of this producer's selected completed response.

The postcondition runs after the existing case-specific checks on both normal and specialized dispatch returns. It therefore covers IC15's barrier-based subject helper, IC11/corrupt's safe-error delivery and the other-call path in request_boundary without duplicating the comparator or relaxing the prior admission/phase/time checks. Tests fix completed error preparations from the independently specified unavailable tuple, not from evaluated results. Temporal illustrations explicitly include the selected preparation before their final-clock observation; the measured deadline-crossing outcome stays unchanged.

R4 replays four exact source-pinned R3 counterexamples, preserves both prepared-but-not-delivered controls, and adds subject/other-call selection, governed-error, commitment, identity and ordering controls. Multiple preparation rows are allowed; only the actually selected row corroborates the handoff. These remain offline assertions, not attestation that a real collector recorded every preparation or the actual transport boundary.

## Preserved release 3: precise exclusions and temporal preconditions

Protected event classification is shared: open/read are reads; capture/append/seal/restore_write are writes. Every protected write is counted on a subject framing refusal, including old generations. Legitimate earlier partial activity keeps its case-specific time window.

An independently scoped other-call read needs committed read_admission evidence; capture/append/seal need committed capture_admission evidence. Applicable phase, successful evidence status, same call/object/generation/reception/principal, prior evidence and actual accepted SQL admission are separate checks. Admission must be observed at or after the server boundary and no later than the protected operation it justifies. Successful other-call handoff likewise cannot precede its actual admission. These millisecond comparisons corroborate the supplied ordering; they do not establish sub-millisecond physical exclusion or recorder authenticity.

The other-call restore_write exclusion is explicitly unsupported: the current profile does not bind a restore-controller/anchor/current-authority proof to that separate event. Capture evidence is not restoration authority. Such an event stays in the inventory and rejects at request.other-call-restore-exclusion-unsupported. This is not a finding that a legitimate restoration is unauthorized. Existing subject restoration remains governed by the separate R2 controller/anchor controls. Integration needing a lawful separate restoration must supply that exact bounded proof through an agreed interface, not invent a capture permission or drop the event.

Actual request identity uses client/server reversed address/port tuples and the per-connection request ordinal, not application labels or nearby timestamps. Duplicate tuples and ordinals fail even if labels/times differ; a persistent connection with distinct observed ordinals and different peers remain valid. Only explicit dotted IPv4-mapped spelling is normalized during comparison; raw strings remain unchanged in captured packets. Other address representations must be consistent. R3.2 has no additional socket-incarnation field to distinguish reuse of an identical tuple/ordinal: ambiguous reuse cannot earn a separate-call exclusion from a label alone.

Proved absence retains the actually selected reception, checked against the call's independently bound subject and, when non-null, its requested target. A genuinely unselected/not-started call can keep null; no reception/intention row is fabricated to satisfy this rule. Selected reception becoming null or an unrelated non-null ID does not pass.

Every old-handle append/seal probe credited as late must start no earlier than the observed successful resume response completion. That boundary is deliberately after actual resume, not just the start of its request. No earlier independent generation-fence event exists in this profile. A producer needing probes between the actual fence and response completion must supply an independently observed fence through a localized interface change. Probes need not wait for the subsequent retransmission or unrelated processing. Typed private failure and unchanged physical captures remain required.

OS startTicks retains the decimal-string input shape. Identity comparison strips redundant leading zeros using string operations, without converting to Number and without altering retained observations. Numerically equal spellings cannot establish replacement; reused PID with a genuinely distinct tick value remains valid, including values beyond safe-integer precision. This does not prove actual exit, process-tree completeness, PostgreSQL restart or FENCE-01 recovery.

## API and compatibility

`index.mjs` exports `MODULE_RELEASE`, `REQUIRED_OBSERVATION`, `OBSERVATION_PROFILE`, `supportedCases`, `supportedVariants`, `unsupportedVariants` and `assertCase(caseId, variant, observation, locations)`.

| Input | Current release |
|---|---|
| R1 or R2 packet | Explicitly rejected for revised acceptance; no insecure fallback |
| R3 without addendum, or R3.1 | Rejected; the required call and incumbent observations are not silently invented |
| R3.2, complete required observations | Checked under the case's explicit profile |
| Unknown case/variant or extra/missing shape fields | Rejected, never counted as covered |
| Earlier illustrative records | Adapted only by the isolated test fixture builder; no runtime adapter is exported |

The historical checker and its records remain preserved separately. `illustrative_revision3.mjs` deliberately constructs synthetic SQL and socket facts for offline examples; it must never be used to manufacture missing integration observations.

A successful assertion returns case, variant and executed assertion count. That count includes shape, file, reference and property checks; it is not a count of independent guarantees. IC16 also returns `temporalViolation` and `temporalConformity`. Preserve both in aggregation. A detected violation is not temporal conformity and does not close R24. Unknown outcomes and missing evidence do not default to successful observations.

## Supported case profiles

There are 53 named variants across 18 families. Each is conditional on its packet, fixed references and listed evidence, not unconditional family acceptance.

| Family | Variants |
|---|---|
| IC01 | round-trip |
| IC02 | at-limit; over-limit; framing; digest-mismatch |
| IC03 | admitted; denied-capture; wrong-origin |
| IC04 | compatible; incompatible; concurrent; other-principal |
| IC05 | receipt; invalid-linkage |
| IC06 | partial; resumed |
| IC07 | sealed-uncommitted |
| IC08 | lost-response; query-without-load; query-denied; uncertain |
| IC09 | late-generation |
| IC10 | cancel-first; finalize-first |
| IC11 | intact; missing; query-only; corrupt |
| IC12 | restore; post-backup-withdrawal; control-unavailable; forged-manifest; restart |
| IC13 | before-capture; between-chunks; before-finalize |
| IC14 | whole; record-only; fragment-only; hidden-absent |
| IC15 | prior-evidence; evidence-failure; writer-first; handoff-first |
| IC16 | before-deadline; already-expired; writer-free-expiry |
| IC17 | migration; isolation; overwrite |
| IC18 | profiles; siblings; safe-output |

Important boundaries:

- Over-limit checks advertised excess rejected before capture. Framing additionally checks actual parser/application-envelope refusal, not arbitrary streaming/ZIP expansion.
- Digest mismatch fixes baseline.xlsx and cache-discrepant.xlsx: same 4,564-byte length, different independent original identities. Declared, sent, consumed and staged bytes are separate observations.
- Resumed requires a real ten-byte interrupted prefix, retained predecessor, new physical generation/artifact, unchanged logical declaration, complete retransmission, quota observations and actual late append **and** seal failures. An unused reservation is not this case.
- Corrupt requires same-length changed stored bytes while trusted receipt integrity remains unchanged, an intact-read positive, independently permitted lookup and authorized access to the altered object. Its fixed unavailable JSON tuple may be delivered; “no altered original” does not mean “no error-response bytes.”
- Restart checks a pair of comparable observed process identities, known predecessor exit, replacement startup, preserved completed/incomplete data, a real old-handle failed write and unavailable-current-source refusal. Container/process labels, field order or changing identity representation cannot create a new process. It does not alone establish PostgreSQL-engine restart, process-tree completeness, power-loss durability or disaster recovery.
- IC04/concurrent does not manufacture actual overlap; producer barriers must establish it. IC14 tuple equality is not statistical timing evidence. IC17 consumes actual probes and preserved data, not a migration name.

## Files, identities and complete call scope

`locations` contains trusted absolute, disjoint `fixtureRoot` and `evidenceRoot`. Keep them read-only during assertions. Relative paths are contained; traversal, drive prefixes, alternate streams, descendant symlinks, nonregular and oversized files fail. This is not a sandbox against a privileged concurrent filesystem writer.

Sixteen originals are pinned in `references.mjs`. Opening and hashing actual bytes is mandatory. BOM, CRLF, Unicode and container serialization are not normalized.

R3 separates receptions, intentions, attempts, receipts, jobs and account/person associations:

- The selected reception is not a reservation/query/finalization intention.
- Receipts join their actual finalization intention, reception, account, person, effect, original and pending job.
- Account/person expectations come from a separate fixed setup reference. Neither universal equality nor universal inequality is required.
- All subject-call protected events are inspected across **every artifact and generation** for zero-access assertions. Positive exact-original checks may select the allowed original.
- Other-call exclusion requires a unique observed request boundary, matching socket endpoints/ordinal, independently fixed route/actor/object scope and relevant prior admission/evidence. An unidentified call or merely nearby timestamp is insufficient.
- Request class follows fixed route semantics: canonical acts, noncanonical queries, binary transfer and truly unresolved/refused envelopes. Queries do not acquire invented loading intentions.

Required request-boundary records cover every response and referenced call. A parsed request has matching connection/request ordinals. Early single-call correlation is allowed only with a single attempted call on that connection. Do not serialize live cookies, CSRF values or keys.

## Fixed reference files

Reference files live under fixtureRoot, are fixed **before** runtime execution, and must not be generated from its resolver, projector, returned digest, restored manifest or observations. Their provenance and freeze time require integration review. Offline examples are not substitute runtime expectations.

| File | Contents |
|---|---|
| `references/actors.json` | `executorRef`, `bindings: [{accountId, personId}]` |
| `references/<case>/<variant>.calls.json` | `calls: [{label, method, route, requestClass, principal, receptionId, allowedAccess}]`; each allowed access fixes kind/artifactId/generation |
| `references/IC04/<variant>.json`, IC05 equivalent | `executorRef`, `deployment`, independent `invocations` |
| `references/<case>/<variant>.intentions.json` | Same invocation reference shape when another case includes canonical operations, such as resume |
| `references/IC02/framing.json` | Fixed `framingCase` and reached `serverBoundary` expected by that negative |
| `references/IC11/corrupt.json` | Exact safe `unavailable` tuple: status, headers, body, bytes, sha256, bodyFile |
| `references/IC06/resumed.json` | Original logical `declaration` and independent `limits`, including exact treatment/limit references |
| `references/IC12/restart.json` | Current source/generation, incomplete reception ID and expected query tuple, plus `partialObjects.beforeFile/afterFile` naming actual evidence-root captures |
| Existing restore references | Backup ID/current source, independently retained manifest digest and member identities |
| Existing IC17 references | Fixed probes and populated preserved namespaces |
| Existing IC18/profiles reference | Fixed control rows/public response/routes, not returned expectations |
| Existing IC18/safe-output reference | Complete ordinary diagnostic paths and synthetic protected canaries |

Each invocation reference specifies label, stable account principal, client key, act, variant, target, canonical profile/key version, and `wireFile`/`canonicalFile`. The integer-only strict UTF-8 reader verifies the full contract, typed path, query, body and revisions. **The canonical hash is unkeyed; storedPayloadDigest is keyed SQL data. They are not equated or independently regenerated.** The actual SQL digest is joined to the actual incumbent; the observed canonical hash is compared to fixed canonical bytes.

A new namespace lookup is absent/new with null stored ID/digest. A later separate SQL correlation establishes a committed row, a freshly fenced proved absence after rollback/no-start, or uncertainty. Reservation IDs cannot fill an absent finalization. Successful replay additionally needs the executed incumbent-payload comparison. A new key may reconcile an existing reception effect with no new namespace row, but must select that receipt's real finalization and record the distinct known-comparison boundary. Uncertainty cannot become successful receipt or proved absence.

For early refusals without a comparator, use the actual request boundary and response; do not add a fictitious comparator/correlation. The canonical invocation profiles checked here require the independent reference and actual comparison/correlation; partial canonical invocation packets lacking those facts are rejected rather than completed. Redundant noncanonical records are optional, have null key/hash/profile fields and no comparison/correlation; the minimal preferred form omits them.

## Added observation evidence

The authoritative field shapes are validated in `request_boundary.mjs`, `revision3.mjs`, `byte_observations.mjs` and `variant_cases.mjs`.

- `ingress`: actual client framing/body facts, template versus exact-sent discriminator, matching parser/application facts and joint response/consumption/staging/effect outcome. Template identity never becomes authenticated-request identity. Sanitized authentication placeholders are exactly `[REDACTED]`. Parser rejection does not certify an application guard.
- `byteTransfers`: reservation declaration file, separate sent and consumed captures, actual read times and independent staged object capture. Empty consumption is zero bytes plus the empty digest and null capture/times. Different filenames are necessary but do not prove independent collection by themselves.
- `continuation`: before/after declaration and actual SQL quota observations, interrupted/resume/completed calls and typed late private commands. Attempt inventories used for quota sums must cover the complete named namespace; a partial case inventory cannot stand in for a global quota query.
- `objectFault`: separate actual before/changed object captures; trusted receipt integrity remains fixed. Missing and intact controls remain separate variants.
- `processes` and `startup`: actual OS or container-process-set identity, not chosen labels. Use the same identity representation across the pair. Restart also reads actual before/after partial-object evidence files named by its fixed reference. Unknown exit completion is not a proved restart.

Reference JSON, origins and flags are not authentication. A dishonest producer can fabricate a coherent packet; runtime recorder controls, independent SQL/object observations and directed service mutations remain necessary.

## Response labels and temporal evidence

Case labels include subject, lookup, cancel, hidden/absent/positive, fragment and positive/expired/subject for temporal controls. Added profiles use:

- Digest: subject mismatch, positive original, separately inventoried matching transfer.
- Framing: subject refusal plus positive reaching the same listener/component.
- Corrupt: subject unavailable, positive intact original, lookup permitted record.
- Resume: subject final original; interrupted, resume and completed calls selected by continuation.
- Restart: subject completed original, incomplete query, unavailable current-source query.

Temporal points remain handoff and receipt_commit. Actual subject-call terminal/effect events, client timing and durable deltas corroborate observations. A JSON route cannot inherit the binary route's evidence. Missing measurements, unknown transfer outcomes or not_measurable labels do not become conformity.

## Isolated execution

Run only through `run_self.mjs`, supplying:

1. An absolute exclusively owned evidence root.
2. The absolute read-only preserved original module sources directory.
3. The absolute read-only preserved probe directory.
4. The absolute read-only R2 source snapshot (release 2's sources directory).
5. The absolute read-only R2 independent probe directory.
6. The absolute read-only R2 independent followup directory.
7. The absolute read-only R3 author source snapshot (release 3's sources directory).
8. The absolute read-only R3 independent probe directory.
9. The absolute read-only R3 independent delivery-followup directory.
10. The absolute read-only R4 author source snapshot (release 4's sources directory).
11. The absolute read-only real C1/C2 seam-review evidence directory.
12. The absolute read-only R5 author source snapshot (release 5's sources directory).
13. The absolute read-only R5 second exact-real-replay directory, identified by its replay.json.
14. Optionally `r6`, to execute only the new composition tests before the complete final regression. Omit it for the full suite.

The wrapper creates a unique directory, snapshots this module, bounds the child to 120 seconds and 32 MiB output, preserves full stdout/stderr and source identities, and never deletes earlier evidence. It starts only node:test, not Docker, PostgreSQL, HTTPS or the product. Do not invoke the self-test without an owned output root.

The test-only migration and specimen builders construct reference inputs before applying each attacked observation. They deliberately identify their synthetic socket/SQL/process facts; they are never implementation adapters. Preserved probes also run against the identified historical checker, then against the corrected packet form with the attacked fact retained.

The release-3 replay verifies the exact release-2 manifest and all seventeen sources before importing it. Seven identified accepted attacks run unchanged against both releases with their original positive, fixed fixtures and captures. Evidence records source hashes and exact observation deltas; additional reviewed controls and new directed pairs cover applicable treatment, actual identity, truthful unselected null, late commands and numeric precision. No fixture or output is modified in the read-only audit roots.

The release-4 replay similarly verifies the exact release-3 manifest and all nineteen sources before importing it. Three JSON-success mismatches and the governed-error mismatch retain their exact original bytes and matched controls. Original and corrected outcomes are saved before assertions. The preserved corrupt-object illustration's selected preparation is corrected to its independently fixed 409 before evaluation, separately recorded from original packets; its attacked corruption facts and expected negative rules remain unchanged.

Each directed negative must reach its named assertion, not merely throw on a missing file, import error, process timeout or unrelated schema defect. Passing offline checks, numeric assertion counts and artificial source hashes cannot establish service correctness, isolation, complete recorder coverage or temporal compliance.
