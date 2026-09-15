# System overview

Status reference: 15 September 2026. This overview summarizes the current design and its
implementation boundary. It is not a replacement construction plan or a claim that every
designed capability is available. [BOARD](../BOARD.md) tracks delivery; the contracts and dated
records linked below specify and evidence the implemented profiles.

## Purpose and deployment scope

LedgerDesk is an open-source web system for using and maintaining governed knowledge within a
declared logical scope. A deployment serves one such scope, which can be smaller than an entire
organization. Independent scopes use independent deployments; cross-scope federation is not
implied. This logical boundary does not prescribe one physical infrastructure topology, and
controlling infrastructure does not itself confer product authority. Open source does not mean
the deployment's documents, identities or case records are public.

The designed workflow connects reusable knowledge, people's information needs, authorized human
handling and editorial work. A turn may contain social interaction, product help, one or more
substantive needs, a continuation, or a permitted operation. Those are not interchangeable:
conversation alone neither grants a capability nor admits its text into the corpus.

## Material, knowledge and human work

The corpus is not every file received or every case recorded. Original files, extraction results,
preparation revisions, exact candidate versions, approvals and publication have distinct roles.

1. Reception conserves the received original under an admitted route and purpose.
2. Processing records what a declared route actually recovered, including component-level
   limitations and causes. A completed process is not automatically a usable result.
3. Preparation can correct or transform that result while retaining exact antecedents and
   checkable differences. A constituted candidate fixes the selected preparation and resources;
   it must not follow an editable "latest" pointer.
4. Review and approval apply to exact content and declared conditions. They do not follow merely
   from a signature label, successful parser, schema-valid package or hash.
5. Publication is a separate authorized act that makes eligible material available under its
   current conditions. An index rebuild or case closure is not publication.

Conditions, indispensable exceptions, relationships and source locations matter alongside text.
Preserving all characters while attaching the wrong exception can still misrepresent a rule.
Structural validation and integrity checks do not prove semantic sufficiency or authentic
provenance. A preparation's alterations must remain distinguishable from the extractor's result.

When a need requires human handling, closure is attributable to the authorized, assigned person
for the explicit scope covered. Silence, timeout, a passing probe or lack of assignment does not
close it. Closure is fallible and contestable; it does not require universal unanimity or an
invented recipient-acceptance gate. The disposition of possible reusable knowledge is separate:
a case may legitimately produce no candidate, and a whole case file does not become the corpus.

These are design commitments. The full needs/cases/editorial journey is not yet implemented by
the accepted reading, access and reception increments.

## Authority and truthful presentation

The server evaluates current identity, scoped authority, purpose and applicable treatment before
protected actions. Account, person, office, permission and actual ability to execute remain
distinct. A master account is not universal reading or approval authority. A button or opaque
identifier selects an operation; it does not authorize it.

Reading is a permitted projection of an exact unit/version, not delivery of a hidden body for the
browser to redact. Reference, excerpt and content have different disclosure boundaries; even an
existence signal requires authority. Unavailable indispensable context can require a lower
projection or refusal. A refusal must not reveal protected causes through explanatory labels.

The interface represents what the server actually offers. Non-revealable capabilities are omitted
from the payload, not sent as hidden rows. Responses from a replaced session are not adopted into
the new view. A forbidden operation does not itself terminate a valid session, and unresolved
operation outcomes are reconciled rather than silently repeated.

See the [reading contract](reading-contract.md) and [access contract](access-contract.md) for the
implemented response shapes, transport profiles and remaining limits.

## What is implemented

| Area | Accepted experimental delivery | Boundary |
|---|---|---|
| Exact material reading | INC-01, browser → dedicated HTTP terminal → PostgreSQL, with prior evidence and directed revocation tests | Synthetic trial; full temporal conformity remains incomplete |
| Identity and authority | INC-02, activation, session lifecycle, invitations and scoped grants, census and administration | Declared synthetic deployment; no general authority editor, external mail or production authentication claim |
| Authenticated material | INC-02 T04/T06, using the existing `reading/1` projection with session-derived context | Explicit `session/1` profile, not a proxy or automatic fallback |
| Intake foundation | INC-03 T01, contracts, bounded text/Markdown, CSV and XLSX profile experiments, conservation/recovery and containment experiments | Acceptance is specific to the recorded synthetic scope; not universal format fidelity or isolation |
| Reception of originals | INC-03 T02, nine admitted handlers under explicit isolated configuration | Does not activate worker-result acceptance, preparation, candidate constitution or publication |

The credential-free `/material` viewer and session-bearing `/access/material` viewer coexist
explicitly; neither falls back to the other. Next serves the interface; the dedicated terminal
retains the controlled handoff. There is no
Next API proxy that silently substitutes a legacy identity or material source. Intake routes are
admitted separately; a contract entry for a future operation does not make that operation live.

For evidence and reproduction, use [INC-01 T05](INC-01-T05.md), [INC-02 T06](INC-02-T06.md),
[INC-03 T01](INC-03-T01.md), [INC-03 T02](INC-03-T02.md) and its
[coverage map](INC-03-T02-coverage.md). Counts describe their identified runs and test populations,
not an interchangeable total of product guarantees.

## What remains open

- The remainder of INC-03: operational worker processing, preparation and exact constitution,
  their integration and whole-increment acceptance. T01/T02 acceptance does not complete these.
- Later construction increments for knowledge response, human handling, editorial publication
  and the remaining designed capabilities. They follow the existing plan, not the old card order.
- R24: writer-free expiry has produced an observed nonconformity between final evaluation and a
  protected effect. This is not merely an unrun test. New consumers need their own observations;
  the exception does not excuse authentication, permissions or isolation failures.
- BROWSER-I03 and BROWSER-J19: intermittent failures with no established cause. Additional green
  runs do not demonstrate a correction. Any later decision to stop investigating must describe
  an accepted residual risk, not a technical fix.
- Real data and production readiness. No accepted experiment authorizes crossing this boundary.
  Format and resource limits are those of their declared profile, not universal format support.

The [L03 retained-reference qualification](L03-exclusive-reference.md) was merged in PR #32 and
passed both the final PR and actual-main workflows. It attributes the controlled memory experiment
within that qualified profile. It does not identify a unique cause for the historical false/137
observation, prove universal containment or close R24 or the browser incidents.

## Relationship to the earlier system

This is the same GitHub repository and history, not a fresh repository with erased work. Retained
code is assessed and adapted as an increment needs it; it does not silently supply requirements,
identity or authority to the new paths. The interface already built is likewise an implementation
resource to validate against current contracts, not a separate definition of the product.

The [August proposal](PROPOSAL.md) described a grounded-answer platform demonstrated on customer
support, including a sealed statistical promotion gate. Its knowledge-gap flow used verification
of a later query as a closure criterion. The current design separates human case closure from that
probe: closure is an attributable authorized act, and any reusable result follows a distinct
candidate → approval → publication path. This is a change in the closure rule, not a claim that
the earlier proposal said closure itself published content.

The [learning plan](LEARNING_PLAN.md) and proposal retain their August bodies, including their
original academic claims and approval wording. Their new scope notes do not ratify those claims
or revise the academic submission. Historical implementation instructions remain locally marked
in the root README and board. Current contracts and accepted scoped decisions guide new work.

## Basis and navigation

The product summary follows the approved decision groups A1/A3/A4/B4/B6 §2 (deployment),
E1/E2/E3/E4/E5/E7 §2.1 (turns and needs), C2/C3/C4/C7/C8/C11/C12 §2.1 (ingestion),
C6 (approval, publication and closure), I1/I2/I3/I5/I6/I8/I9/I11/I14/I16/K2 §2.3
(human closure), and J1/J3/J4/J5/J7 §2.1 (case outcomes and corpus). This synopsis does
not replace their detailed rules or introduce new approval requirements.

Public implementation references are the three contracts above, the
[ADR index](../adr/README.md), [delivery records](README.md#reproduction-and-delivery-evidence)
and [board](../BOARD.md). [Provenance](PROVENANCE.md) distinguishes retained source evidence
from source authentication and implementation acceptance.
