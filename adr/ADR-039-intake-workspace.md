# ADR-039: Bounded intake workspace

**Status:** accepted within the bounded synthetic trial
**Decision date:** 2026-09-21 (Australia/Sydney)

## Context

ADR-038 separately admits reception, extraction and exact preparation in a synthetic deployment. It does not supply their integrated browser workspace. A visible action must remain an offer from the server, not an authority decision in a component. An interrupted command must remain recoverable without silently repeating its effect.

## Decision

1. Mount `/access/intake` in the existing clean Next composition. Keep the explicit `session/1` HTTPS transport, exact origin and CSRF protections, and the terminal's final protected handoff. Do not introduce a proxy, legacy identity or fallback profile.
2. Add `intake-workspace/1` as a separately selected query representation on the existing profile, reception, extraction and operation-lookup paths. Retain the shapes and consumers of the existing reception and preparation profiles. Queries disclose only currently authorized context, content and offers; executing an offer still requires fresh admission.
3. Keep one controller for requests, local item/revision identity, drafts and response adoption. The five presentation views consume snapshots and callbacks, never independent requests or authority rules. Reuse the existing intake presentation without its simulated domain store.
4. Observe the exact session before and after each sensitive response and preserve local-context checks across awaits. A late response cannot replace a newer item's view or confirmation. Clearing a view does not undo a previously committed server effect.
5. Retain only bounded per-tab locators, operation identities and payload fingerprints in session storage. Do not retain bodies, names, drafts or credentials. Storage failure prevents dispatch. Explicit reconciliation uses current query authority; it is not a new command, and absence does not disprove a historical effect.
6. Support only the declared text/Markdown, CSV and bounded XLSX interactions. Capture text as the exact current field's UTF-8 bytes. Preparation keeps exact antecedents, selected units, necessary context, component limitations and checkable differences. Confirmation uses the exact inspected proposal; candidate, related and blocked results remain distinct from approval or publication.
7. A stop halts applicable work, not the independent right to read an already conserved original. The private-phase SQL permits that read only for the exact sealed receipt artifact, retaining current admission, source, generation, namespace and deadline checks. It does not reopen upload, finalization or processing. Discard removes only unsent local drafts.
8. Add two required workspace verification jobs alongside every retained producer. Preserve failure evidence through the existing closed-shape public exporter. Require directed positive/negative observations of disclosure, session/item changes, lost responses and actual handoff, not only static rendering.

## Localized extension of ADR-038

The preparation amendment's statement that it introduces no preparation UI remains true of that delivery. This decision adds its bounded consumer and the named query representation; it does not retrospectively expand that acceptance or enable later editorial operations. The original worker, preparation and constitution algorithms remain the authority for their effects. Resource downloads use existing exact-resource admission and do not claim native SVG, PDF or OCR support.

## Consequences and limits

The controller is the only request owner, so components cannot independently fetch protected data. Session storage is a locator, not authenticity, authority, payload preservation or a background retry queue. Drafts can be lost on reload. A second tab has no synchronization guarantee.

R24 remains an observed writer-free expiry nonconformity. The workspace records its own adverse temporal observation; it does not inherit conformity from earlier consumers. Authentication, disclosure and isolation failures are not excused by R24. BROWSER-I03/J19 and the unexplained development response-body failure remain open. The scope is synthetic and does not authorize real data, production, approval, publication or whole-increment acceptance.

See [the workspace contract](../docs/intake-workspace.md) and [the implementation evidence](../docs/INC-03-T05.md). The owner accepted this bounded synthetic scope on 2026-09-21 after independent technical review and [implementation CI 35599086923](https://github.com/Farobertogu/ledgerdesk/actions/runs/35599086923) passed all nineteen jobs for `b987108d39407e6f9f3f9836b48107640aef67f0`. The subsequent documentary head must pass its own complete workflow before merge. [PR #36](https://github.com/Farobertogu/ledgerdesk/pull/36) records the final-head, merge and actual-main evidence only as observed. This decision does not start T06.
