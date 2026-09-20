# Intake workspace

The bounded synthetic workspace adapts the existing intake presentation to the real reception, extraction and preparation services at `/access/intake`. Its implementation, measured coverage and remaining limits are recorded in [INC-03 T05](INC-03-T05.md). Implementation and local execution are not independent acceptance or production authorization. [ADR-039](../adr/ADR-039-intake-workspace.md) remains proposed.

## Query profile

`intake-workspace/1`, selected by `Accept: application/vnd.ledgerdesk.intake-workspace+json`, is a separate read representation on existing query paths. It does not widen `intake/1`, `intake-reception/2` or `intake-preparation/1`. The session transport remains `session/1` with exact HTTPS origin and CSRF on POST, no proxy and no fallback.

| Request | Selection | Admission and result |
|---|---|---|
| `GET /api/intake/profiles` | Current session, no caller context | Existing profile authority, admitted singleton context and deployment, revealable profile configuration. A `receive` offer uses the common current reception preconditions, not a fabricated load or dry-run reservation. Actual execution rechecks all load/phase conditions. |
| `GET /api/intake/receptions/:id` | Owned reception | The unchanged reception/2 projection plus separately evaluated original/extraction offers in the same admitted authority snapshot. Reading reception metadata does not grant those actions. |
| `GET /api/intake/extractions/:id` | Owned extraction | The unchanged extraction projection plus a preparation offer only for accepted content under all three existing reservation/upload/finalization admissions. Metadata-only access never exposes that action. |
| `POST /api/intake/operations/lookup`, `kind: preparation_effect` | `variant`, `client_key` | Deployment and principal come from the server; act comes from the admitted variant. Current own-record authority reconciles the durable editorial effect without requiring new preparation/constitution authority or replaying a body. |
| Same path, `kind: preparation_attempt` | `attempt_id`, exact `document` artifact | Own-record authority and current treatment. Returns current reserved/staged/finalized state, not a historical reservation reinterpreted as upload completion. No staged bytes or original declarations. |
| Same path, `kind: preparation_inspection` | Exact `preparation` reference | Current own-record, preparation and difference reading admission before materialization. Separately evaluated proposal/resource offers do not authorize subsequent execution or delivery. |
| Same path, `kind: proposal_inspection` | Exact `proposal` reference | Own-record and preparation reading admission, then the exact retained preparation/difference checks. Resource descriptors do not authorize resource bytes. No new proposal, effect, constitution or latest-revision substitution. |

POST bodies contain `profile: intake-workspace/1` and the listed closed fields. No intention header is allowed on these queries. Unknown selectors and unauthorized records receive neutral unavailable responses. A neutral absence is not evidence that an earlier effect never happened.

The proposal query commits its read-admission evidence before reading the proposal body, validates its retained reference and selection, then uses the existing preparation materializer. All successful query responses use the existing durable delivery evidence and admission-held terminal handoff. The writer-free interval after the last clock evaluation remains the observed R24 obligation, not a solved temporal guarantee.

## Presentation boundary

The five views receive immutable snapshots and callbacks from one controller. They do not fetch, decide authority or turn displayed actions into lasting permission. Selection, drafts, pending intentions and sensitive-response adoption belong to the controller. The demo's appearance is reused without its synthetic domain store or local admission rules.

Captured text becomes the exact UTF-8 encoding of the current field value. No trimming, Unicode normalization, BOM or final newline is added. This does not claim byte preservation of an earlier clipboard or file. CSV and XLSX retain positional/lexical inspection; there is no cell editor or formula evaluation.

## Bounded preparation interactions

| Representation | Information displayed | Explicit human declaration | Request and retained effect |
|---|---|---|---|
| Extracted text | Exact text and source coordinates | Select existing elements; optional exact correction with a reason | A separate preparation document; the retained-source producer remains responsible for constructing the revision. Neither original nor extraction is overwritten. |
| CSV/XLSX | Positional fields, lexical values, formula and stored result separately, source coordinates and applicable sheet metadata | Select existing table elements and supply required context | Same preparation operation; no cell editor, recalculate operation or inferred fidelity claim. |
| Classification | Function, basis and scope, initially unresolved | Choose each axis or give an explicit unresolved reason; declare examination and coverage | Human request fields, not extraction results or automatically granted approval. |
| Context | Existing dependencies and component observations | Add bounded conditions/dependencies with selected endpoints and a change explanation | The request identifies its exact antecedent and differences; server construction checks retained-source correspondence. |
| Confirmation | Exact retained preparation, proposal and returned disposition | Review and explicitly confirm the particular proposal; an existing target requires an explicit comparison-evidence selection | Connected to real proposal inspection and constitution. Candidate, relationship and blocked outcomes are distinct. No approval or publication action is introduced. |

## Sensitive response adoption inventory

The controller is the only consumer. Each actual protected request uses an exact-session observation before and after the response, a local context epoch, a bounded body and its declared representation. A native browser fetch retains the global receiver. These common mechanisms do not by themselves certify each call site; directed browser observations remain required.

| Adoption site | Bound identity | Directed consumer |
|---|---|---|
| Session and context/profile | Exact session, current local epoch, deployment and origin | W23 startup-session and context-profile |
| Reception reserve/upload/staged-query/finalize/refresh/stop | Local item key, intention key/payload fingerprint, exact receipt/original | W23 six actual response sites and stop; W18 independently checks stop effect and retained-original rights |
| Extraction | Receipt's work ID and current item epoch | W23 extraction-refresh |
| Reception recovery and original inspection/download | Exact receipt or operation key and original reference | W23 reference/intention recovery, original-inspection and original-download |
| Preparation reservation/upload/finalization | Item, frozen request, exact extraction and staged artifact | W24 three command responses and explicit continuation-finalization |
| Preparation effect/attempt recovery | Deployment/principal/variant/key or exact artifact; query admission, not new-effect admission | W24 reserved/prepared effects and staged-attempt recovery |
| Retained preparation/difference and proposal | Exact preparation, proposal and current item/session | W24 preparation inspection, proposal creation, post-creation inspection, proposed-effect recovery, post-recovery inspection and direct review inspection; W26 late A versus reviewed B |
| Constitution and its recovered result | Exact inspected proposal and original effect identity | W24 constitution and constituted-effect recovery; W13 loss reconciliation with constitution authority withdrawn |
| Exact resource download | Retained preparation, resource ID, bytes/digest and current session | W21 permitted/denied bytes and W28 retained successful response after session replacement |

The per-tab journal contains only bounded locators, operation/profile, intention keys and request fingerprints. It never stores names, bodies, credentials, responses or preparation drafts. Local drafts live in memory. A failed journal write stops the effect; refreshing does not replay a command. Reconciliation is an explicit query and a historical reservation is not proof of current staging.

## Stop, discard and navigation

Stopping work does not erase a receipt or its original, revoke reading authority or pretend an uncertain effect failed. Reading a sealed conserved original after a stop remains separately admitted; new upload, finalization and processing do not become available. The controller preserves the known reception reference when recording the stop.

After stop, a durable receipt and a sealed attempt retain eligibility for the separately authorized original-inspection offer. A stopped reception without that received original has no such offer. Current original-reading authority is still evaluated; metadata access or stopped state grants none. The mounted stop case inspects and downloads through this offer, then repeats after refresh and reconciliation, preserving the same receipt without restarting processing.

Discard applies only to unsent local data. It neither deletes durable preparations nor replaces a pending intention. Reconciliation is explicit. Preparation and confirmation focus their mounted heading; Back returns to the origin row when present and to the filter when that row is absent. Language and theme changes do not translate or modify source content.

## Verification boundary

The executed preparation slice uses the actual Next/browser/HTTPS/PostgreSQL path: a corrected human preparation and its difference, exact proposal/candidate, related and collision outcomes, visible Markdown/CSV/XLSX inspection, and lost staging/proposal/constitution responses. A withdrawn constitution faculty does not prevent authorized reconciliation of its previously recorded effect. CSV fields remain positional and multiline; XLSX formula and observed cache `24.00` remain separate without recalculation. Partial extraction remains partial in preparation.

The finite U01–U12 map and exact executed revisions live in the delivery record. Common guards are not substituted for per-site observations. Browser cases hold actual successful terminal responses; they do not fabricate protected content or authority. Each stale-session case has a successful unchanged-session control. The negative observes cleared protected regions and no unintended follow-on request, not merely a warning.

One development run reported a browser response-body retrieval failure after a 200 response; its cause remains undetermined and subsequent passes do not close it. R24 and the previously tracked browser issues remain open. No production data or operational publication is enabled.
