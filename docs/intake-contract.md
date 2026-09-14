# Intake contracts and experimental reception

## Implemented boundary

The foundation retains pure validators, route metadata, a structural preparation
representation and test-contained feasibility. The reception implementation adds
nine handlers at the existing access terminal, only when an explicit validated
synthetic intake configuration is supplied. Without that configuration the
terminal refuses the intake prefix. Next does not proxy or serve these handlers.
Later processing and editorial handlers remain unmounted.

This implementation is accepted only within the bounded synthetic experimental
scope of the localized [T02 amendment to ADR-038](../adr/ADR-038-intake-foundation.md#amendments).
This is not a deployment instruction or full contract conformity. The reception
report and coverage register retain the exact acceptance limits and outstanding
evidence; passing tests do not authorize later processing or real data.

The contract is intake/1. Public text is English; literal source text, opaque
identifiers and retained fixtures are not translated. session/1 and reading/1
remain unchanged. Existing access intentions, including legacy_t02, are not
rewritten.

## Operation inventory

All paths below are under /api/intake. Only the nine T02 operations listed in
the reception section below have handlers; the others remain contract metadata.
No public or real-data deployment is enabled by this inventory.

| Operation | Method/path suffix | Binding requirement | First service |
|---|---|---|---|
| profiles | GET /profiles | Authorized visible profile/surface view | T02/T05 |
| reserve_reception | POST /receptions | CARGAR_MATERIAL, PERSONA, current exercise faculty, receiving responsibility and treatment | T02 |
| upload_original | POST /receptions/:id/attempts/:generation/original | Exact current reception continuation; not a bearer upload URL | T02 |
| finalize_reception | POST /receptions/:id/finalize | Completion of the same personal loading act, exact generation and available verified original | T02 |
| lookup_operation | POST /operations/lookup | Current permitted query, separate from creation faculty | T02 |
| resume_reception | POST /receptions/:id/resume | Explicit bounded continuation, authoritative absence and current loading/treatment | T02 |
| cancel_reception | POST /receptions/:id/cancel | Bounded stop of this work; not deletion or generalized detention | T02/T03 |
| reception | GET /receptions/:id | Receipt/progress view, not original-body permission | T02 |
| original | GET /receptions/:id/original | Whole-original read and treatment, before access and delivery | T02 |
| extraction | GET /extractions/:id | Exact processing-result view and scoped incidents | T03 |
| reserve_preparation | POST /preparation-attempts | Individually admitted preparation effect and exact antecedent views | T04 |
| upload_preparation | POST /preparation-attempts/:id/content | Exact preparation continuation; staged input, not controlled preparation | T04 |
| finalize_preparation | POST /preparation-attempts/:id/finalize | Current preparation faculty, exact input/resource/difference associations | T04 |
| preparation | GET /preparations/:id/revisions/:revision | Exact preparation view | T04 |
| resource | GET /preparations/:id/revisions/:revision/resources/:resource_id | Selected-resource association and current resource view | T04 |
| difference | GET /differences/:id | Exact before/after relation and permitted antecedent disclosure | T04 |
| propose | POST /preparations/:id/revisions/:revision/proposals | Preparation of a closed proposal, not constitution or approval | T04 |
| constitute | POST /constitutions | CONSTITUIR_CANDIDATA in person or by an exact authorized prior consequence | T04 |

The two internal interfaces are dispatch_extraction and accept_extraction_result
under intake-worker/1. The worker envelope cannot claim authenticated origin.
The supervisor and controlled service must bind the actual channel, admitted
operation, generation, input and current treatment independently of returned
metadata. A known historical result is not a new finalization.

One reception intention concerns one original. The transfer is one whole-body
attempt; no range resume, implicit retry, atomic multi-file batch or unsupported
format retention is inferred.

### Binding register: intake-binding/2

`src/contracts/intake_bindings.ts` now defines all eighteen route variants and
both worker ports individually. These are effect specifications, not new
permission IDs. `bindingConsistent` checks a resolved declaration against
separately supplied current server catalog data; a true result means **contract
consistency only**, never permission to execute or read. No client field,
retained hash, maintainer role or generic `authorized: true` grants authority.

The basis uses B1 §§2.4, 3.4 and 4.2–4.3, approved C2/C4 admission and
processing rules, and G11's unchanged effect comparison. M02/M04 describe a
realization; they do not amend approved modes. The previous validator already
compared against external `current` data. The previous positive fixtures,
however, obtained mode/effect from the registry and copied their signature to
`current`; they did not independently establish that the registry was correct.
The eight signature dimensions are objects, transitions, purpose, affected
people/services, observable surfaces, autonomy, limits and residues. Their
values must match the current admitted declaration. A changed signature is
not legalized by keeping the same operation name.

| Operation | Exact effect / parent | Mode and responsibility | Additional admission / allowed projection |
|---|---|---|---|
| profiles | Existing capability projection; visible intake surfaces only | Person; FN-ACCESO | Existing surface disclosure, four axes; omit non-revealable rows and hidden counts |
| reserve_reception | Reserve one original under CARGAR_MATERIAL | Person; FN-APROBACION of receiving scope | Exercise faculty, capture/conservation, exact route; reservation only |
| upload_original | Stage this exact reception attempt | Same personal loading act; receiving-scope responsibility; actual service executor separate | Exact intention/original/attempt, capture/conservation before first byte; no completed receipt claimed |
| finalize_reception | E_receipt: one receipt and a separately identified subsequent job | Completion phase of the same personal loading act | Current authority/treatment, exact verified original; queued work is not processing completed |
| resume_reception | New physical attempt for the unchanged logical operation | Person under CARGAR_MATERIAL; exact parent | Authoritative absence, declared retry allowance and unchanged logical budget; no automatic timeout retry |
| cancel_reception | Stop only uncompleted dependent work | Person under the exact reception; FN-APROBACION | Previously declared subtractive containment comparison; no deletion, rollback, permission or editorial change |
| lookup_operation | Query this principal's intention record partition | Person; VER_EL_REGISTRO, FN-ACCESO | Current query faculty, distinct from creating the effect; permitted historical result or neutral response |
| reception | Receipt/progress record, without original body | Person; VER_EL_REGISTRO, FN-ACCESO | Exact permitted record partition, no implied whole-original access |
| original | Whole original under LEER_PARTICION_GOBERNADA | Person; FN-ACCESO of the scope | Whole-container view, exhausted-purpose and read/deliver treatment; not derived from a citation |
| extraction | Exact extraction and visible component incidents | Person; governed partition, FN-ACCESO | Exact result population, source/body treatment where accessed; no unexamined-component success |
| reserve_preparation | Reserve exact preparatory effect | Person; existing internal prepare-candidate-material effect, FN-APROBACION | Individual M04-D02 comparison, exercise/support and selected antecedent read/modify/conserve; not loading faculty |
| upload_preparation | Stage only the admitted preparation attempt | Authorized consequence of reserve_preparation | Current exact parent/generation; payload is not yet a controlled preparation |
| finalize_preparation | Preserve one new preparation revision | Person; same individual preparation binding and exact reserved parent | Recheck source/resource/difference association, support and treatment; never overwrite old revision |
| preparation | Exact preparation and permitted differences | Person; governed partition, FN-ACCESO | Preparation view and separately permitted antecedents, no universal ancestor access |
| resource | Selected resource in an authorized preparation | Person; governed partition, FN-ACCESO | Both association and current selected-resource read/deliver; no arbitrary resource-ID endpoint |
| difference | Exact before/after act and permitted antecedents | Person; governed partition, FN-ACCESO | Pair-bound view; redact/deny protected causes and ancestors neutrally |
| propose | Freeze closed constitution proposal | Person; individual existing preparatory effect, FN-APROBACION | Exact preparation, indispensable closure, resources, differences and C9 disposition; no candidate/approval |
| constitute | CONSTITUIR_CANDIDATA, exact proposal or C9 outcome | Person **or** authorized consequence; FN-APROBACION | Current constitution faculty; in consequence mode exact actual prior act, not universal second confirmation |
| dispatch_extraction | Start exact admitted processing after receipt | Internal processing phase under intake-extraction-resolution/1; not another catalog loading act | Exact human origin, processing request/plan, job and assigned worker; current processing/read/destination authority; receipt alone is insufficient |
| accept_extraction_result | E_accept: accept that worker result and coverage | Completion phase of that admitted processing; no candidate or new loading act | Current read/treatment before bodies, exact result/lineage and acceptance before effect; no historical lookup reactivation |

Each declaration resolves the exact catalog `{id, revision, sha256}`, entry
`{id, revision}`, permission, support, scope, purpose, route, treatment and
admission record. Technical `predecessor` and actual express `authorization`
are different fields. Consequence-mode operations need an exact human act,
express authorization and target; a predecessor alone cannot fill those fields.
`faculty` is `exercise`, not `grant`.
Preparation is compared **individually** with the already admitted internal
effect; no new G11 class, generalized action or automatic CAT-08 extension is
asserted. If the actual comparison fails, the affected operation remains
unoffered and requires the specific catalog/adoption decision it lacks.

Resolution order for the real adapters is fixed here, not left to a future
permission-name guess:

1. Derive deployment, account/person, stable principal and current session on
   the server. Select the route's admitted binding and exact catalog entry;
   never interpret an arbitrary client act or permission as a dispatch target.
2. Resolve the entry's exact `permission_definition`, active revision and
   investiture requirement. Select current `grant_record` exercise authority,
   `scope_definition` purpose/containment and `support_definition` continuity
   through the existing authority evaluator, including actual investiture when
   required. A matching string or current table row is not sufficient alone.
3. Derive object scope/purpose and allowed record/material partitions from the
   controlled operation/object. Compare client selectors against these values.
   Resolve current route/profile, first capture, processing, conservation,
   destination and modification treatment as separate applicable gates.
4. Bind the actual parent/generation and admitted effect signature where
   applicable. FN-APROBACION is the receiving-scope responsibility before an
   approval exists; a vacancy follows the existing FN-AMBITO residual rule,
   never a fabricated approval investiture. Query authority stays independent.
5. Evaluate all material dependencies in the decision snapshot. Before any
   protected materialization, preserve the required access evidence and current
   admission. Recheck at the named commit/handoff point; no lock stops time.
   Use the existing evaluator and coordination discipline, not this validator
   as a second authorization engine.

No deployment declaration is seeded here. The contract supplies exact selector
types and per-operation resolution, not invented UUIDs. Actual catalog rows,
current grant/support evaluation, durable admission and effect/handoff remain
T02–T04 implementation. Own intake queries do not authorize B9 inspection of
another person's history, technical inspection or a new purpose. Such use needs
its separately admitted act/purpose and is outside these bindings.

#### Personal loading and subsequent processing

Version 2 has three closed branches: `act`, `personal_load_phase`, and
`admitted_processing_phase`. Reservation, upload, finalization, resumption and
cancellation preserve the same exact personal `load` context. It fixes person,
intention, original, format/configuration, destination, limits, session and
logical receipt-effect reference. The `phase` separately fixes technical
executor, reservation, attempt and predecessor. A reservation is not an act
already completed. Only finalization identifies the receipt's primary effect.

The two worker branches have no catalog `mode` of their own. Their origin
still records CARGAR_MATERIAL/PERSONA; the worker is not attributed as that
person or as a reviewer of its extraction. Their signature retains autonomy
as `fixed_processing_plan`, a behavior constraint of the internal operation,
not a sixth normative mode. The job fixes originating act, receipt, processing
request/plan, worker, generation, expiry, session dependence and a distinct
acceptance effect. Only acceptance includes an actual result reference.
Effect/person identities cannot be made distinct merely by changing the
revision or hash of an identical identifier.

`intake-extraction-resolution/1` is a versioned contract resolution of the
retained internal `analizar` operation, with technical records under
`conservar estados`; it is not a newly seeded permission or catalog admission.
It pins document hashes and sections of B1, C2/C4 and G11. The exact effect
comparison is implemented by `processingSignature` and constrained as follows:

| Dimension | Resolution within admitted processing | Deployment-specific obligation, still pending |
|---|---|---|
| Objects | Exact receipt/original and extraction job; acceptance also conserves result, coverage and component incidents | Resolve every reference to the actual controlled record and retained bytes |
| Transitions | Dispatch that bounded analysis, then separately accept its result; neither creates a receipt or candidate | Durable transition and effective generation/stop checks in T03 |
| Purpose | Same declared intake purpose, checked against current resolved purpose | Current scope/purpose and applicable permission evaluation |
| Affected parties | Exact human origin, actual service executor, assigned worker and declared destination; no fictitious human authorship | Authenticate executor and assigned worker; preserve responsibility of FN-APROBACION of receiving scope |
| Surfaces | Assigned worker channel, authorized operation status and extraction; no additional diagnostic or callback disclosure by implication | Actual channel/partition projection and protected handoff |
| Autonomy | Execute the fixed plan; no source discovery, macros, live links, alternative processor/destination, new conclusion, constitution or publication | Verify the selected route/capability is enabled for that exact behavior |
| Limits | Exact independently resolved plan-limit reference; input remains bounded by the original limit, not the larger output limit | Effective plan lifetime, resource enforcement and treatment destinations |
| Residues | Isolated original, bounded worker output and truthful technical evidence, including failure/omissions | Current retention, cleanup and authorized disclosure |

C2 §2.1 expressly separates permission to load from processing authorization;
C4 §2.5 allows a declared capability under human responsibility and preserves
snapshot/representation distinctions. G11 retains analysis/state conservation
but does not admit an expansion. Text/CSV use the common constraints; C4 adds
the spreadsheet-specific conditions, not universal format admission. The
resolution fixes this restricted signature, not operational admission. The
later initial-format approval is recorded under Experimental profile below.

Missing resolution, missing plan or unknown session dependency fails closed
as a contract declaration. Self-consistent supplied `current` fields cannot
widen the fixed processing signature. Actual `current` data still must come
from the existing server authority evaluator; this module neither authenticates
them nor permits a call because contract consistency succeeded.

`bindingRequirements` returns obligations, not an authorization decision.
Personal phases require the current origin session. A processing plan explicitly
chooses session-bound or independent-of-origin-session execution; both still
require current processing permission/support, service assignment, generation,
route/treatment and job expiry. No browser connection is required by inference;
no expired token or initial permission grants perpetual work. Missing a
dependency is not a permissive default. Known/incompatible/uncertain effects
require current query authority and never redispatch or reactivate work.
Revocation does not erase a legitimate receipt, and failed extraction does
not change receipt success into processing success.

Version 1 declarations/evidence remain in the preceding delivery. They are not
silently reinterpreted. This shape change does not alter intake/1, session/1,
reading/1, canonicalization or the existing intention namespace. The tests
include same-version semantic negatives; rejecting version 1 is a separate check.
Actual request-loss reconciliation, zero protected reads after withdrawal,
distinct durable effects and expiry-without-writer behavior still require real
T02/T03 boundaries. These contract vectors do not close R24.

`operationRequirements` distinguishes new execution, known effect, incompatible
load and uncertain effect. The latter three never create an effect. After a
lost constitution response, removing constitution faculty while preserving
query faculty permits recovery of the same effect. Removing query faculty
denies disclosure without erasing history. A payload conflict does not create
an object-specific intention namespace. Uncertainty requires reconciliation,
not a new generation inferred from timeout. These are contract vectors;
runtime withdrawal/reply-loss tests remain mandatory at first consumers.

## Wire rules and compatibility

Structured commands are at most 65,536 UTF-8 bytes. Decode strictly before
validation: no malformed UTF-8, duplicate keys, lone surrogates, BOM prefix,
floating/exponent integer tokens, negative zero or unsafe integers. Preserve
Unicode scalars and distinguish absent from null. Route selectors and integer
revision/generation selectors have separate checks.

Original transfer is application/octet-stream, at most 1,048,576 bytes.
Prepared payload transfer is bounded JSON under prepared-material/1, at most
8,388,608 bytes. These are separate channels, not larger credential bodies.
A valid staged payload is not a retained preparation.

POST is used for both transfer paths: no silent PUT/preflight expansion.
Actual requests must retain explicit trusted HTTPS origins, exact Origin/Host,
current session-bound CSRF, no-store and the accepted credentialed transport.
No wildcard, legacy cookie, proxy or credential-free fallback is introduced.
The future intake stream adapter must not broaden the existing access parser.

canonicalIntake accepts the existing scalar serializer as an explicit argument;
it neither duplicates canonicalValue nor imports the access dispatcher.
The typed envelope contains contract, variant, path, query, body and revisions.
The service-owned intention identity remains deployment + stable principal +
act/variant + client key. Object/revision stay in the compared payload, not a
new key namespace. A profile upgrade must not repeat an existing effect.

lookup_operation accepts a known operation ID, or an act/variant/client-key
lookup under the server-derived principal. It does not accept a client hash as
proof that a payload matches. This is a read query, not a new execution.
Incompatible payload comparison belongs to new execution/reconciliation of an
intention, against the previously controlled payload. No query authorizes
another effect or discloses a result without current query authority.

This refines the proposed lookup envelope: the optional client-compared
reference was removed rather than accepted as self-authenticating evidence.
The test prototype can compare a payload as an observation of its private
control record; that diagnostic method is not the public query handler.

## Preparation and outcome representation

prepared-material/1 separates exact preparation/input references, elements,
resource generations, explicit relations, differences, component observations
and inventory knowledge. Document numbers remain tagged lexical values;
formulas, cached values and number formats are separate. CSV header order and
duplicates, row text/ranges and table visibility/context can be represented.
A fresh consumer reads the serialized bytes without producer memory.

Structural checks detect dangling relations, duplicate resources, wrong
resource generations, mismatched difference pairs and misattributed incidents.
They do not certify all source meaning. Deleting an exception together with
its relation can remain structurally valid; the independent reference detects
that loss. A hash checked against metadata supplied by the same worker is not
authentication.

Current schema/association checks are not the real preparation producer.
Wrong-but-intact resources and valid acts for another revision pair must be
tested both at persistence and consumption against the independently admitted
operation. The exact A-17/g7 versus A-18/g9 birth scenario remains a T04 test.

### Explicit retained-profile conversion: trial-to-prepared/1

The pure converter now maps the retained trial, rather than asking T03/T04 to
invent that correspondence. It is not an operational importer. A mapped
`prepared-material/1` contains a required-for-this-converter `trial_mapping`
extension. The general structural profile remains readable for existing test
vectors; consumers expecting a mapped preparation must require that extension
and compare against their separately retained operation with
`mappingSourceMatches`. Removing it cannot downgrade that expectation.

`producerMapping` accepts the closed `{raw, extraction, runtime}` producer
envelope. `trialMapping` also accepts extraction or candidate records with
explicit retained context. A candidate-trial ID/revision alone is rejected:
the exact extraction, original, profile and preparation references, source
observations, resource bindings and applicable differences must be supplied.
All such context is data to validate, not self-authenticating evidence.

| Retained input properties | Destination and exact treatment |
|---|---|
| intake-trial/1 version, limits, text, csv, xlsx, exclusions, limitMeaning | Entire profile definition retained in mapping context; version/configuration shape checked. No dropped options or implicit operational adoption |
| Producer raw | Typed lossless retained JSON; not substituted for exact extraction. CSV parser raw and original row raw remain different observations. Workbook properties not interpreted by the cell projection remain present with the named raw-properties limitation |
| Producer runtime.node/sheetjs/rssBytes | Separate optional observed runtime record; RSS is a sample, never a resource ceiling. Wrapper rejects unknown envelope properties |
| extraction-trial schema/profile/original.name/bytes/sha256 | Retained verbatim plus exact original/source/profile references. Original hash must agree; no changed namespace, source bytes or authenticity inferred |
| outcome, coverage.claim/unsupported | Extraction component remains completed/partial within the syntactic profile; unsupported components have individual not_attempted/none observations and route_unoffered incidents. Exact names stay in incident detail and retained source |
| Text inventory.bytes/decodedCodePoints/elements/bomBytes | Entire inventory retained; original and decoded/BOM views remain separate |
| Text id/type/text/locator.original/byteRange/codePointRange | Text and exact byte antecedent mapped; complete typed source locator, including Unicode code-point range, retained and recoverable |
| CSV inventory.records/bomBytes/headerMode | Retained, without turning header labels into keys |
| CSV id/type/headers/rows.index/fields/raw/originalByteRange/locator | Ordered table rows, duplicated headings, literal fields, exact row text and half-open byte ranges mapped; original locator explanation retained |
| XLSX inventory.members/declaredExpandedBytes/observedExpandedBytes/parts/sheets/cells/dateSystem/semantics | All retained separately; neither package inventory nor successful cells establishes complete workbook meaning |
| Sheet id/type/name/sourceSheetId/visibility/merged/hiddenRows/columns | Core sheet context mapped. All original column attributes retained without dropping other attributes, including `@_customWidth`; explicit projection is limited to `minimum`, `maximum` and optional `hidden`/`width_lexical`. Retention does not imply projection or semantic interpretation of every attribute |
| Sheet autoFilter/declaredDimension/locator | Exact retained values and typed package-part location; not silently converted to a completeness or visibility claim |
| Cell address/sourceType/storedLexical/availability/adapterType/value/numberFormat/locator | Tagged projected value plus complete original observation. Empty non-formula cell and missing formula cache differ. Stored lexical, interpreted value and format remain independently recoverable |
| Formula storedExpression/attributes/cached.availability/lexical/sourceType | Formula and observed cache mapped separately; attributes and original cache record retained. No evaluation or recalculation; special/unknown semantics do not acquire fidelity |
| candidate-trial schema/candidate.unit/version/preparationId/preparationRevision/selected/canonicalSha256/state | Retained exact synthetic manifest; exact selection/revision checked. Synthetic state never becomes approval/publication; claimed hash is not provenance |
| candidate preparation.id/revision and canonical.elements/relations/resources | Exact prepared selection mapped, constrained by supplied antecedent and differences. No implicit latest revision |
| Relation from/to/scope/basis/preparationRevision | Endpoints/scope mapped as declared preparation context; basis and exact preparation revision retained. No claim that parser inferred the relation |
| Resource id/file/bytes/sha256 and element.resource | Original opaque IDs and safe trial-local filename retained; explicit correspondence to exact service artifact ID/generation/bytes/hash. IDs are not normalized. No filesystem read or delivery is authorized by conversion |
| Difference before/after/method/reason/affected/actor/recorded_at | Explicit mapped act with exact pair, explanatory change and attributed record. Missing/wrong pair cannot legitimate altered elements; final service must authenticate the actor and act |
| Producer error/detail | No preparation. Known codes map to unreadability, unoffered variant or technical failure; unknown codes stay unclassified with original code/detail, never epistemic insufficiency |

Retained JSON uses tagged null/boolean/string/number/array/object nodes. It
preserves absent versus null, strings without normalization, finite observed
numbers including negative zero, positional arrays and duplicate-header values.
Numeric observations are lexical strings in this encoding; the strict command
canonicalization remains unchanged. Duplicate object entries, malformed scalar
strings, non-JSON values, unknown structural members, more than twelve source
nesting levels or an encoded preparation exceeding 8 MiB are rejected. A
legitimate large extractor result may exceed the mapping envelope because both
source evidence and projection are retained; that is an explicit conversion
limit, not silently truncated coverage. No memory bound is inferred.

`projectTrial` preserves raw observations and computes the structural view;
`validatePreparation` checks agreement when the mapping extension is present.
`mappingSourceMatches` compares against a separately supplied original
operation/source/context. The caller must obtain those from controlled storage,
not from the arriving package. An attacker replacing both source and projection
can construct an internally valid package; the independent comparison must
reject it. Retaining a packet does not authenticate its producer or admit an
effect. Those actual producer/persistence checks remain T03/T04 and R2 work.

For a legitimate correction/synthesis, before/after, affected IDs, method,
reason, actor and recorded time are required. A matching difference record is
not a semantic proof that the edit is correct; it establishes the declared
transformation instead of pretending it was the original extraction. The
source remains unchanged. A valid act for another revision pair is rejected.
Source-observation retention may itself reveal excluded material, so the full
mapped envelope is **not a public candidate DTO**. A later projection must
select only currently permitted content; it must not send this evidence sidecar
to a reader merely because selected text is visible.

Each component retains execution, coverage, fidelity, limitations and causes.
Unknown/unexamined components cannot acquire coverage from successful siblings.
X07's unsupported component remains partial. Technical failure, unreadability
and a route not offered are distinct; none becomes lack of knowledge.

stdoutEncodingError describes retained bytes. Under output_limit, its cause
may be the supervisor's cut through a valid multibyte sequence. The primary
termination cause and diagnostic flags remain separate. A successful process,
accepted worker result, retained preparation and constituted candidate are
different facts.

## Experimental profile

The foundation registry remains operational: false. It fixes Node 22.16.0 and
the finite feasibility envelope. Live reception availability is a different,
currently authorized projection; it does not mutate that retained registry or
claim that an extraction worker exists.

On 2026-09-12 the owner approved the initial implementation target: UTF-8 text,
inert Markdown, CSV with comma delimiters and double quotes, and bounded
cell-oriented XLSX with explicit coverage and limitations. The approved bounds
are 1 MiB (1,048,576 bytes) per original, at most 8 sheets per XLSX and at most
10,000 cells total across its sheets, not per sheet. PDF/OCR belongs to a later
delivery. The profile exclusions remain: no active content, link following,
formula recalculation or general semantic-fidelity guarantee.

This target approval does not activate a capability, authorize real data,
accept ADR-038 or approve every technical constant or dependency version below.
Those retain their existing experimental and technical/ADR treatment until the
corresponding implementation and deployment obligations are met.

| Candidate | Observed scope | Not claimed |
|---|---|---|
| UTF-8 text / inert Markdown | Exact decoded text, BOM/localizer handling and inert source | Semantic dependency discovery or active Markdown |
| CSV | Explicit dialect, positional headers/fields, exact source ranges and declared limits | Automatic typing, executable formulas or arbitrary dialect inference |
| XLSX | Cell-oriented structure and cache/formula distinctions, scoped unsupported components and sheet/cell limits | Universal Excel, calculation, PDF, OCR or visual comprehension |

Candidate packages: csv-parse 7.0.2, SheetJS 0.20.3, fast-xml-parser 5.11.1,
yauzl 3.4.0. The original archive, lock and required licenses remain in the
test-only snapshot. A dependency audit is a dated advisory query, not proof
of universal safety or publisher authentication.

The observed envelope remains experimental; its original/sheet/cell bounds
also match the approved implementation target above: 1 MiB original; 8 MiB expanded ZIP,
128 entries, 8 sheets and 10,000 aggregate physical cells; CSV 1,000 records,
64 columns and 65,536 decoded UTF-16 field units per record. The independent
CSV parser buffer cap remains 262,144. Do not label these all as byte limits.

Parser bounds: 10 seconds, 128 MiB Node heap, 512 MiB container memory and no
container swap allowance, one CPU quota, 64 cgroup tasks, 128 descriptors,
64 MiB workspace plus 8 MiB temporary filesystem, one active parser, 8 MiB
stdout and 8 KiB stderr. Heap is not RSS; sampled memory is not a host-wide
physical maximum. Kernel/cgroup availability is checked before workloads.

The inode-pressure experiment additionally constrains its own workspace to
128 inodes, keeping all base memory/byte/process controls. This is a stricter
test variant, not a change to the candidate's base mount. The multibyte output
experiment uses calibrated 5/3-byte caps through the actual supervisor; the
separate exact 8 MiB/cap+1 cases remain. Neither experiment adopts operational
formats or certifies general hostile-code isolation. Failed lifecycle children
retain their failed/incomplete-evidence state even when their observer passes.

## Reception transport and states: intake-reception/1

The outer contract stays intake/1. The separate closed representations are
intake-reception/1 and intake-availability/1; the foundation response validator
is not widened to accept them. session/1, access/1 and reading/1 are unchanged.

| Operation | Successful response | Required distinction |
|---|---|---|
| reserve_reception | 202 for a new reservation; 200 for a known compatible intention | No receipt or job yet |
| upload_original | 200 after exact staged verification | Staging is not a receipt |
| finalize_reception | 200 with the committed receipt effect and non-dispatchable work | Completion of the personal load, not extraction acceptance |
| resume_reception | 202 for a new physical generation; 200 for a known compatible intention | Full retransmission; no reactivation of the predecessor |
| cancel_reception | 200 with stopped work and retained history | No original deletion or receipt rollback |
| profiles | 200 with currently revealable availability | Reception and processing availability are separate |
| reception / lookup_operation | 200 for the permitted record | Lookup is a query even though it uses POST |
| original | 200 and exact binary bytes for an admitted whole-original view | Record or fragment authority is insufficient |

The record contains the operation and reception selectors, monotone reception
revision, current attempt/generation, original identity/length/hash, configuration,
attempt expiry, classified state and availability observation. effect and work
are both absent or both present. A received state requires an effect; work is
not_started or stopped and always dispatchable: false. The record contains no
private path, credential, source-control catalog, extracted body or candidate.
Availability is an observation, not a promise that storage cannot fail afterward.

Unknown/non-revealable resources use the same closed 404 problem. Other closed
statuses are 400 (invalid input/framing), 403 (transport/session refusal),
409 (permitted conflict), 413 (input bound), 415 (media/profile mismatch),
429 (finite capacity) and 503 (unavailable control or technical failure).
Internal causes and input values are not copied into those bodies.

The terminal requires the exact HTTPS origin/host and session transport.
Every POST, including lookup and binary transfer, requires current CSRF.
Intention keys appear only on intention-bearing operations. JSON is bounded to
65,536 bytes and decoded strictly before canonical comparison. Binary transfer
uses application/octet-stream and an exact Content-Length; it is not multipart.
Duplicate sensitive headers, transfer/content encoding, Range, conditional cache
requests, aliases, unknown queries and later-operation paths are rejected.

Original delivery uses application/octet-stream, a fixed attachment filename,
exact Content-Length, nosniff and private, no-store. No signed object URL,
static original directory, fallback profile or Next proxy exists in this path.

## Current admission, retained effects and private work

The server resolves the stable account/person, current session/CSRF, existing
authority evaluator, complete intake-binding/2 catalog entry, scope/purpose,
receiving responsibility, executor and capture/read/conserve/process/deliver
treatment. A hash or well-formed client selector does not supply those facts.
The minimum verifier is an admitted processor even though it does not extract.

Metadata admission occurs before consuming a structured command and before its
reception is selected. Its prior evidence may therefore have null operation and
reception references. Later selection and effect evidence use the actual selected
references; they do not rewrite that earlier row. Pre-read evidence and delivery
evidence are distinct. An evidence status is the prepared HTTP status, not proof
of COMMIT or network completion; an external committed-state observation and an
actual transport event establish their respective facts.

After the irreversible handoff, failure to append its transport observation is
not a new response failure. The terminal reports `transport_observation` with
the controlled SQL/error code, source locations, prior evidence identifier,
attempted outcome/byte count and prepared response status. Its diagnostic status
does not replace the status already sent. No transport row or successful
observation is invented, no receipt is deleted and no effect is retried.

The synchronous technical failure receiver is used when installed. If absent
or throwing, the terminal emits the same safe record to application stderr with
an absent/failed receiver classification. Messages, SQL statements, authentication
fields and protected bodies are excluded. The observation failure never enters
the response-error path; admission closes in `finally` even if a synchronous
diagnostic sink throws. This signal is independent of the failed database write,
but is not durable transport evidence or a guarantee that an arbitrary external
log sink stores it. The measured SQL-statement failure does not mark every future
connection unhealthy: the next operation still needs a fresh healthy admission.
It does not move the irreversible point to eventual browser receipt or wait for
the browser to close before releasing the writer.

The intention namespace is deployment + stable principal + act/variant + client
key. Object, generation, revision and digest remain in the canonical compared
payload. Existing access intentions and their verification profiles are not
rewritten. Losing loading authority does not prevent a still-authorized query of
an existing receipt. Losing query authority refuses disclosure without deleting
the receipt. A different key cannot create a second receipt for that reception.
An uncertain outcome is not authoritative absence and does not authorize retry.

Private storage and verification use separate contained processes with no SQL
credentials. A durable phase outside a restored receipt set precedes private
dispatch. Its identity pins the participant, incarnation, object, generation,
evidence and permitted operations. Actual worker closure and durable terminal
acknowledgments precede phase retirement; a timeout or lost connection alone is
not quiescence. A fresh effect snapshot checks the source epoch after retirement.
Closed phase identities cannot be reopened or evicted to make space.

The current fence guards the enumerated authority/control sources, including
existing access tables, with statement-level guards. An unresolved phase refuses
dependent writers rather than allowing them to bypass it. That fail-closed
behavior can make other access work unavailable until controlled recovery. It
is a deliberate synthetic availability limit, not a production failover policy.

The broker/host and recovery supervisor remain trusted. Recovery requires
external evidence of the old process set's actual termination and current live
control independent of the arriving backup. Restoring historical reception data
does not restore permissions over newer revocations. There is no atomic file/SQL
transaction and no runtime overwrite/delete method for a sealed original.

## Limits of this reception realization

- Originals remain bounded to 1 MiB, chunks to 65,536 bytes, one active upload,
  32 retained receptions, three generations per reception and 64 MiB storage.
  Finite global capacity still permits contention; this is not universal DoS protection.
- UTF-8 and bounded XLSX container verification are reception checks. CSV
  extraction, workbook sheet/cell extraction limits and per-component coverage
  remain T03 obligations. No receipt claims they have run.
- Current readers and writers need their own real tests. The phase mechanism
  and timestamps do not establish writer-free temporal conformity. R24 remains
  an observed unresolved violation; it does not excuse a permission/fencing defect.
- The browser driver is test infrastructure, not the T05 interface. Existing
  BROWSER-I03 and BROWSER-J19 investigations remain open despite passing runs.
- No candidate, extraction result, approval, publication, real-data permission,
  operational format widening or accepted ADR amendment follows from these tests.

## Later first-consumer obligations

- T02: verification and review of the implemented loading/query bindings,
  first-receiver treatment, migration, streaming admission, receipt/evidence and
  protected original handoff support bounded experimental acceptance. See the
  reception report and coverage register for the observed R24 violations and
  unexercised same-original fragment lineage; neither is closed by acceptance.
- T03: actual durable worker, current admission before protected reads,
  generation/channel binding and controlled result acceptance.
- T04: actual preparation producer, source/resource/difference correspondence,
  independent internal mutation oracles, closed proposals and constitution.
- R24: writer-free expiry after the last evaluation and before each protected
  effect remains unclosed. Storage feasibility cannot resolve it.
- The initial format target is approved as stated above. T02/T03 must realize
  its admission, enforcement and truthful component coverage; approval does
  not make these experimental candidates operational or include PDF/OCR.

See [the foundation evidence](INC-03-T01.md) and
[the reception implementation and verification status](INC-03-T02.md).
