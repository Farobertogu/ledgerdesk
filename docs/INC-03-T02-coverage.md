# INC-03 T02: producer coverage register

Status: finite qualification completed locally at the named boundaries below;
verification wiring is implemented and locally checked; the stable acceptance review is still pending. This is
not an acceptance verdict. All data are synthetic. No remote CI run, real-data
permission or temporal conformity is implied. Earlier snapshots remain evidence
of their own source, not of every later change.

## Evidence addresses

Each alias denotes a directory under test-results/intake-t02/. Its
source-manifest.json, command records, runtime observations and manifest.json
identify the actual producer and resources. Counts include Node parent tests;
they are not counts of distinct product requirements.

| Alias | Exact run directory | Observed result |
|---|---|---|
| AUTH | intake-t02-2026-09-13T05-12-15-360Z-f433d507 | 8/8 current faculty, scope/purpose, treatment and profile controls |
| CAT | intake-t02-2026-09-13T04-55-12-351Z-b0ae7cb9 | 3/3 absent immutable operation catalog |
| TRANS | intake-t02-2026-09-13T04-34-51-483Z-da77b56a | 4/4 two principals and stopped committed work |
| NEUTRAL | intake-t02-2026-09-13T04-57-00-914Z-54a3c981 | 5/5 finite original/record/lookup public parity; shifted control detects signal |
| CHILD | intake-t02-2026-09-13T04-44-12-366Z-96541ff4 | 3/3 actual descendant-only original authority |
| FRAGMENT | intake-t02-2026-09-13T05-36-05-286Z-5c6c59cb | 3/3 fragment permission separation, not same-original provenance |
| STREAM | intake-t02-2026-09-13T04-40-51-393Z-d202f98b | 5/5 real incomplete sender, deadlines and competing upload/query |
| QUOTA | intake-t02-2026-09-13T04-45-17-068Z-03d12261 | 4/4 logical reception race and durable reserved-byte boundary |
| ATTEMPT | intake-t02-2026-09-13T04-47-02-132Z-6b874802 | 3/3 three generations across actual process restart |
| PRIV | intake-t02-2026-09-13T05-25-35-305Z-dd2c4c1b | 6/6 effective SQL roles, private object identity and no runtime mount |
| TX | intake-t02-2026-09-13T05-24-35-516Z-1e2bf712 | 10/10 actual finalization races, linkage, failed/lost response and writer control |
| COMMIT | intake-t02-2026-09-13T05-19-39-662Z-44ced27b | 3/3 actual receipt COMMIT reply loss with independently visible effect |
| ORDER | intake-t02-2026-09-13T05-15-54-827Z-bdeed25b | 14/14 four actual reply consumers, writer order and already-expired admission |
| RUNTIME | intake-t02-2026-09-13T05-17-09-456Z-639a9e37 | 31/31 runtime, exact bytes and verifier-entry observations |
| BOUNDS | intake-t02-2026-09-13T05-10-40-838Z-617b8f1e | 15/15 actual bounded and malformed requests |
| BASE | suites/verification-2026-09-13T03-54-53-854Z-42fd9f80-e426-44d4-af84-635f07fcab21 | 21 earlier source-identified groups; includes recovery and five access suites |

BASE's result identifies each child. The finite pass changes only three
production files relative to that snapshot: authority.ts, reception.ts and
service.ts, to authorize original treatment/faculty before selecting protected
reception metadata. Later runtime, authority, descendant, neutrality, transaction,
delivery and fragment controls exercise these consumers. SQL migrations, private
fencing, broker, supervisor, restore and legacy access consumers are unchanged.
Test/runner source changes are separately inventoried; a copied source hash does
not make an earlier run a final-source run. In particular, the shared digest
case added two bridge observations that prevented eight FENCE groups from
reaching their own cases. Unchanged fencing code did not make the older matrix
a working new composition. The renewed FENCE pass below supersedes that reuse
claim for these consumers, without invalidating earlier evidence for its source.

## Obligations and their remaining limits

| ID | Actual producer evidence | Qualification and limit |
|---|---|---|
| T02-01 | AUTH plus RUNTIME: accepted invitation, loader positive, master with grant but no exercise refused | Does not grant administrative authority by account label |
| T02-02 | RUNTIME and BOUNDS: exact received/returned bytes; actual wrong digest reaches the broker integrity path | Format worker entry is zero on mismatch. Bypassing the earlier digest check survives because the broker still rejects; this is redundant defense, not a missed contract violation |
| T02-03 | BOUNDS, STREAM, QUOTA, ATTEMPT | 1 MiB body/chunk limits, actual idle/total deadlines, second upload refusal while query completes, 32 receptions, 64 MiB durable reservations, generation 3 retained after restart. Advertised excess and parser framing are not a post-admission application-stream overrun. No physical-memory/disk/global-DoS guarantee |
| T02-04 | BOUNDS plus type-recognition mutation | Minimum verifier recognizes the bounded type; it does not extract workbook content |
| T02-05 | AUTH and BASE treatment-between-chunks; TX treatment before finalization | No later protected access after the corresponding writer. TLS reception, explicit application consumption and broker append remain distinct |
| T02-06 | AUTH, CAT, CHILD, PRIV | Wrong scope/purpose, grant-only, missing operation, removed treatment and actual descendant positive. Runtime cannot manufacture grants/control |
| T02-07 | RUNTIME, TX and independently reviewed serial R6 packets | Known effect is reconciled without new load faculty; query withdrawal hides it without deleting history. Independent R6 review covers its exact serial packets only |
| T02-08 | TRANS and TX; payload mutation | Two actual principals share a client key without sharing effects; concurrent finalizers use same/different keys and preserve one receipt/job. No mutation score inferred from multiple failing dependent tests |
| T02-09 | BASE partial/resumed/old-channel; ATTEMPT | Durable generation history survives restart; fourth generation refused. Retained old-incarnation/source checks remain separately measured |
| T02-10 | BASE lost private acknowledgments/commit; TX and COMMIT | Real precommit rollback, lost HTTP receipt reply and actual PostgreSQL receipt-COMMIT reply loss are separate experiments; sealed-without-receipt mutation is caught |
| T02-11 | BASE integrity/restart plus RUNTIME actual positive | Corrupt or missing original refuses delivery while retained history remains. Does not promise universal disaster recovery |
| T02-12 | BASE restore and source-fence matrix | Restore checks independently retained live anchor, current withdrawal, unavailable source and invalid/incomplete incoming set. The incoming manifest is not its own authority |
| T02-13 | PRIV plus BASE source/legacy guards | Runtime has no object mount: actual stat/chmod/write/rename see ENOENT for an object independently verified in the broker, followed by allowed identical GET. Broker 0400 write denial is scoped; broker-owner chmod and host compromise are not claimed prevented |
| T02-14 | AUTH, CHILD, FRAGMENT, NEUTRAL; whole-original mutation | Whole-original faculty is distinct from record and existing-fragment faculty. Same-original fragment lineage remains unexercised: T02 does not create the material/provenance link needed to prove that exact variant |
| T02-15 | ORDER, RUNTIME and delivery-evidence mutation | Profiles, record, operation lookup and original each exercise prior durable evidence, idle SQL, zero client bytes, actual blocked writer and transfer ordering. Initial expiry is not writer-free expiry after last evaluation |
| T02-16 | BASE temporal group | Four observed violations: reservation persistence, application capture, receipt/job persistence and original transfer. R24 remains open; a passing counterexample test means the violation was observed |
| T02-17 | AUTH, TRANS; deferred-dispatch mutation | Hidden profile omitted from JSON; committed unstarted work can be stopped without deleting receipt. SQL rejects an attempted dispatchable job; no processing route enabled |
| T02-18 | NEUTRAL and selection mutation | Actual paired timing and full public surface for absence/foreign/owned-record-only. Original selection count remains zero under denied faculty; removing this control is detected. No universal side-channel absence claim |
| T02-19 | Actual captured image source omission; coupled BASE; ordinary source-identified foundation/build measurement; eight CI wiring/export tests | Missing module fails real Node module loading before runtime/SQL initialization. Foundation composition passed in separately preserved invocations; four mandatory jobs and reading aggregator locally validated, not remotely executed |
| T02-20 | TRANS and TX | Cancel wins before finalization; stopped committed receipt reconciles; stale revision, foreign principal and late prior finalizer do not revive work |
| T02-21 | Failure controls and each actual child manifest | Early setup failure and evidence export failure retain failing status, attempt remaining exports and remove owned resources. This does not excuse incomplete future evidence |

## Independent 53-variant map: additive qualification

The preserved independent inventory contains 53 variants: nine composed packets,
34 separately exercised producers and ten previously pending rows at its
checkpoint. These are evidence categories, not percentages or 53 new runs.
The following additions do not rewrite that inventory or pretend that each
separate test was fed to the independent packet checker.

C = existing composed packet, within its identified window. R = a separately
exercised actual producer with the stated boundary. P/R = an exact part remains
pending despite a useful separately exercised control. For unchanged BASE rows,
the preserved inventory supplies exact source, child, command and limitation.

| Variant | Current evidence category / actual location | Remaining distinction |
|---|---|---|
| IC01/round-trip | C; RUNTIME and BASE | Exact 17-byte packet is not every supported original |
| IC02/at-limit | R; BOUNDS | Independent 1-MiB input, not the checker's particular fixture |
| IC02/over-limit | R; BOUNDS, STREAM | Declared excess refusal; post-admission application overrun not asserted |
| IC02/framing | R; BOUNDS | Actual TLS frames and positive; parser versus application kept separate |
| IC02/digest-mismatch | R; RUNTIME | BOM mismatch with actual 17-byte append and no format entry; not XLSX-specific packet |
| IC03/admitted | R; AUTH, RUNTIME | Existing accepted invitation, not a new checker packet |
| IC03/denied-capture | R; AUTH, BASE | Current treatment denied before capture |
| IC03/wrong-origin | R; BASE, BOUNDS | Ordinary HTTPS client, not browser CORS alone |
| IC04/compatible | C; serial R6 | Independent review closed for exact prior serial composition |
| IC04/incompatible | R; TX, payload mutation | Actual target/generation/revision and intention-payload distinctions |
| IC04/concurrent | R; TX | Actual finalizers now race, not just reservations |
| IC04/other-principal | R; TRANS | Two legitimately invited principals, same key, independent effects |
| IC05/receipt | C; serial R6 plus RUNTIME | Receipt and unstarted job remain separate |
| IC05/invalid-linkage | R; TX | Existing wrong artifact, wrong generation and stale revision each refused |
| IC06/partial | R; BASE, STREAM | Physical/input progress and durable history separately observed |
| IC06/resumed | R; BASE, ATTEMPT | Real continuation, retained prior attempts, no unsupported packet relabel |
| IC07/sealed-uncommitted | R; BASE, TX, mutation | Actual pre-receipt failure and no forged receipt from sealing |
| IC08/lost-response | R; TX | Destroyed HTTP receiver after durable receipt; no replayed effect |
| IC08/query-without-load | R; TX, RUNTIME | Current query authority, no new loading faculty required |
| IC08/query-denied | C; TX | Historical effect persists despite neutral disclosure refusal |
| IC08/uncertain | R; COMMIT and BASE | Actual business COMMIT reply loss distinct from private-phase COMMIT |
| IC09/late-generation | R; BASE, ATTEMPT, TX | Old private and old finalizer paths separately refused |
| IC10/cancel-first | R; TX, BASE | No receipt or revival after cancellation wins |
| IC10/finalize-first | R; TRANS | Stop unstarted job, retain receipt, repeat same intention |
| IC11/intact | C; RUNTIME | Real exact original positive |
| IC11/missing | R; BASE | Actual missing object reached under otherwise valid authority |
| IC11/query-only | C; AUTH | Record available without original object access |
| IC11/corrupt | R; BASE | Corrupt observed bytes separate from trusted original |
| IC12/restore | R; BASE | Restore producer/current independent anchor, not generic availability |
| IC12/post-backup-withdrawal | R; BASE | Current control outside restored set |
| IC12/control-unavailable | R; BASE | No fallback to restored authority |
| IC12/forged-manifest | R; BASE | Arriving set is not self-authorizing |
| IC12/restart | R; BASE, ATTEMPT | Actual new process identity, not same-memory reset |
| IC13/before-capture | R; AUTH | Valid positive and zero protected capture after withdrawal |
| IC13/between-chunks | R; BASE | No subsequent explicit application consumption |
| IC13/before-finalize | R; TX | Completed treatment withdrawal before finalize, no object event/effect; unrelated profile change positive |
| IC14/whole | C; RUNTIME, CHILD | Current exact/descendant authority, no root shortcut |
| IC14/record-only | C; AUTH, NEUTRAL | Retained record does not grant whole original |
| IC14/fragment-only | P/R; FRAGMENT | Permission separation passes; same-original lineage is not produced or proven |
| IC14/hidden-absent | R; NEUTRAL | State/body/headers/bytes and finite timing; detector limitation retained |
| IC15/prior-evidence | C; ORDER | Actual durable evidence, idle SQL and no client bytes |
| IC15/evidence-failure | R; BASE, delivery mutation | Omitted evidence caught at real governed output |
| IC15/writer-first | R; ORDER | Writer finishes first and each protected response is refused |
| IC15/handoff-first | R; ORDER | Real writer blocks behind actual admission until transfer |
| IC16/before-deadline | R; BASE, ORDER | Positive counterpart; not full temporal conformity |
| IC16/already-expired | R; ORDER | All four reply consumers deny a treatment expired before admission |
| IC16/writer-free-expiry | R; BASE | Observed violation, not a successful guarantee |
| IC17/migration | R; BASE | Real populated/coupled migrations and role guard inventory |
| IC17/isolation | R; PRIV, BASE | Effective identity and allowed counterparts, not theoretical permissions |
| IC17/overwrite | R; PRIV | No runtime object mount; ENOENT on existing broker target, not EACCES |
| IC18/profiles | R; AUTH | Hidden rows omitted; reception distinguished from processing |
| IC18/siblings | R; BASE coupled access | Same installed source-fence migration; prior suites not rerun without cause |
| IC18/safe-output | R; BASE, BOUNDS | Scoped observed bodies/HTML and diagnostics; no universal canary inventory claimed |

## Preserved limits and next decision

R24, BROWSER-I03 and BROWSER-J19 retain their closure requirements. A passing
run does not resolve their causes. Complete same-original fragment provenance
requires a later material-to-reception relationship and a positive fragment from
that exact original; matching text, names or identifiers must not fabricate it.
No T03/T04 capability was enabled to fill that gap.

Mandatory CI wiring is locally validated; final source/evidence packaging and
independent review of the finite implementation delta remain distinct from these execution results.
The evidence index includes failed runs and intermediate diagnostic mistakes.
A source hash establishes correspondence, not authenticity or reviewer acceptance.

## Local bridge and post-handoff correction: 2026-09-13

The eight consumers are fencing-probe, fence-sql, fence-loss, fence-ack,
fence-commit, fence-continuation, fence-ipc and fence-restore. They now admit
exactly the two read observations reached by the shared digest case: objects
and verifier. This does not enable arm-observer for those groups. The fixed
independent consumer fixture reads the actual shared requests and checks the
actual handler policy, malformed bodies/participants and both permission
regressions. Real runs reach their own named scenarios; list membership alone
is not their evidence. fence-coupled is not one of the affected consumers.

All paths below are under test-results/intake-t02/. Counts include the Node
parent; repeated copies of TAP in command/export logs are not additional runs.

| Renewed consumer / variant | Run directory | Result |
|---|---|---|
| runtime control | intake-t02-2026-09-13T08-54-08-839Z-e6cdc158 | 31/31 |
| fencing-probe; deliberately stalled append | intake-t02-2026-09-13T08-54-56-156Z-b90f5166 | 23/23 |
| fence-loss SQL, before terminal correction | intake-t02-2026-09-13T08-55-36-266Z-54e95bcc | 23/23 |
| fence-restore | intake-t02-2026-09-13T08-56-25-182Z-d7ad9a8a | 23/23 |
| fence-sql | intake-t02-2026-09-13T09-10-07-263Z-0ee7a317 | 30/30 |
| fence-loss runtime | intake-t02-2026-09-13T09-10-44-438Z-dfa5fa47 | 23/23 |
| fence-loss supervisor | intake-t02-2026-09-13T09-11-31-168Z-1590b19f | 23/23 |
| fence-ack append | intake-t02-2026-09-13T09-12-15-513Z-e388b77f | 23/23 |
| fence-ack seal | intake-t02-2026-09-13T09-12-50-717Z-1121480d | 23/23 |
| fence-ack read | intake-t02-2026-09-13T09-13-27-386Z-df8152ae | 23/23 |
| fence-ack close | intake-t02-2026-09-13T09-14-06-157Z-cfedffb3 | 23/23 |
| fence-commit rollback | intake-t02-2026-09-13T09-14-45-571Z-446c39c8 | 23/23 |
| fence-commit reply loss | intake-t02-2026-09-13T09-15-21-269Z-32ddecc9 | 23/23 |
| fence-continuation; treatment and session | intake-t02-2026-09-13T09-16-01-878Z-1d0e2110 | 24/24 |
| fence-ipc | intake-t02-2026-09-13T09-16-36-070Z-934d48eb | 23/23 |
| fence-loss SQL, after terminal correction | intake-t02-2026-09-13T09-18-54-629Z-8755e07e | 23/23 |

These renew the thirteen existing recovery variants plus fencing-probe. The
second SQL-loss run specifically exercises connection loss after the terminal
change, not a repeated aggregate for a larger count. Each source manifest pins
its composition. The first four runs precede the post-handoff correction; their
successful delivery/bridge branches are unchanged. Later recovery runs exercise
the corrected terminal. No full access composition or broad temporal campaign
was rerun without a changed dependency.

For effective control privilege evidence, the loss cases connect as
inc03_intake_control, verify session_user, reject a mismatched phase and perform
the allowed reconciliation only after the real worker/runtime closures. The
persisted completion records that actual role and backend. The SQL-only case
separately inventories six roles' rights and executes source-guard statements
with owning roles. Neither that catalog inventory nor the earlier runtime/reader
denials is relabeled as execution under the control login. The SQL-only phase
acknowledgments are fixtures, not physical closure evidence.

| Delivery-observation evidence | Run directory | Result / meaning |
|---|---|---|
| Existing receiver, unchanged terminal | intake-t02-2026-09-13T08-59-16-908Z-ac1b0d51 | 16/16; a real post-end INSERT failure already reaches the installed hook |
| Missing/throwing receiver, unchanged terminal | intake-t02-2026-09-13T09-06-21-027Z-f050912c | 15/18; two directed failures plus parent expose missing diagnostics |
| Corrected terminal, all four cases | intake-t02-2026-09-13T09-08-26-296Z-79217c57 | 18/18; positive plus installed, absent and throwing receivers |
| Receipt consumers renewed | intake-t02-2026-09-13T09-17-41-314Z-aaebf5c4 | Actual finalization, reconciliation and writer controls |
| Actual receipt COMMIT reply loss renewed | intake-t02-2026-09-13T09-18-24-202Z-f970882e | Durable effect remains independently visible |
| Drop only diagnostic fallback in captured source | intake-t02-2026-09-13T09-19-34-673Z-10836ca1 | Absent/throwing receiver cases fail; other scenarios pass |
| Re-enter destroy after observation in captured source | intake-t02-2026-09-13T09-20-24-398Z-22780346 | The four observation cases detect the extra terminal destroy |

The corrected experiment uses the real terminal/service and a PostgreSQL
trigger scoped to the exact paused delivery evidence. Its positive logs and
allows the INSERT; the negative logs the same attempted handed_off/17-byte row
and raises P0001. Before release: durable evidence, idle SQL/no transaction,
zero client bytes and an actual blocked writer. After release: actual 200 and
exact17 bytes, one end, unchanged receipt/work and prior evidence, zero transport
rows on failure, received safe diagnostics, closed backend and released writer.
The following real GET succeeds without repeating reception effects.

The existing installed hook was not silent. The demonstrated correction is the
missing/failing receiver and separation from response-error handling. A technical
status503 does not mean a second503 was sent. This is a bounded statement-failure
experiment, not universal log durability, total database outage, arbitrary
asynchronous receiver support or a new temporal guarantee. R24, fragment lineage,
BROWSER-I03 and BROWSER-J19 remain open. Focused independent review is pending.
