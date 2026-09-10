# ADR-036 · Effective administration views

**Status:** accepted · **Decision date:** 2026-09-11

## Context

The service exposes separate implementation, enablement, authorization and
execution states. Filtering all non-executable capabilities in the interface
loses legitimate information. Conversely, expanding the view with internal
diagnostics would disclose facts that the original projection intentionally
withholds. General granting options also do not establish authority over a
particular invitation or accepted grant.

## Decision

Keep capability disclosure on the server. Omit non-revealable surface rows before
constructing the public response. Do not add public disclosure flags, hidden
counts, diagnostic strings or auxiliary hidden identifiers. A closed explanation
is a deterministic summary of the four already-public axes, not a second policy
evaluation. Display all four axes independently, including non-executable but
disclosed capabilities.

Extend the closed invitation view with object-bound action offers after its
existing inspection check. Bind each offer to its target and revision. Consult
the existing authority evaluator, and share the administrative predicates with
the executing routes. A recipient may inspect terms without receiving any action
offer. Preparing an amendment still requires valid proposed replacement terms;
offering an action is not a credential or a promise that a future request will
succeed. Every mutation rechecks current authority, state, revision and input.
There is no arbitrary-object action lookup endpoint.

Hide amendment and withdrawal controls when their offers are absent. Keep
acceptance visible but disabled without its current offer, proof and local
readiness. A zero-action view remains readable. Share acceptance eligibility
without flattening ordered authorization, revision and lifecycle checks into a
boolean; withdrawal faculty does not include the already-withdrawn flag.

Use the existing access page, invitation lifecycle, scoped census and direct
authenticated material reader. Next still serves only public interface code and
transport configuration. Preserve the original credential-free profile and
reading/1 payloads. There is no proxy, authority editor, impersonation, generic
grant endpoint, demo role provider or unrestricted account directory.

Keep pending requests in memory with the exact intention key and payload,
including derived expiry and expected revision. A lost or invalid response is
unconfirmed, not failed or successful. Reconcile with the exact request; query a
recorded operation only when its identifier is actually known. Do not recreate
the payload on retry or infer success from a refreshed view.

A separately verified current session can retire an uncertain provisional
sign-in attempt when entering the authenticated context. Keep its missing
result explicitly unconfirmed and allow sign-out of the observed session.
Failed observations, unrelated uncertain effects and same-context attempts do
not qualify. Switching access tabs cannot silently abandon reconciliation.

Associate presentation work with a local lifetime and the exact observed session,
not account identity or its revision. Discard delayed views after a local context
change or an observed session replacement. Recheck the session around invitation
reads and after capability/census responses. These observations are not a claim
of instantaneous cross-tab synchronization or atomic browser/server observation.
Refresh checks current state; execution remains server-authorized.
Preserve the local-context check across the awaited session observation. Local
cancellation does not claim a session mismatch. Test both absence of stale
content and the positive content that would otherwise have been adopted.

## Localized extension of ADR-035

Implement the bounded administration presentation previously left to T05: effective
capabilities, controlled invitation actions and the already-authorized nominal
census. The two additional closed DTO fields require paired service/UI deployment;
old or foreign shapes fail validation rather than being silently accepted. No
previous identity, reading, evidence or authority constraint is relaxed.

## Consequences and limits

- The four axes, disclosure, an action offer and an executed effect remain distinct.
- Administrative data is fetched only after browser-side session establishment;
  credentials, private identities and census data are absent from the initial HTML.
- The census displays only the existing account identifier and nominal name.
  Its opaque revision fingerprint is not displayed as chronology or reused as
  expected_revision, cursor validation or an authorization decision.
- Local session/proof replacement, reload or navigation discards in-memory
  secrets and pending UI state. A missing receipt must not be described as an
  operation that did not happen. No durable browser secret store is introduced.
- Temporal comparison is finite evidence under the declared detector, not a
  universal side-channel proof. R24 remains an observed writer-free expiry
  failure. New views have their own directed tests and do not inherit conformity.
- BROWSER-I03 and BROWSER-J19 remain open. Passing again does not identify or
  correct their causes. T06, real data and production use remain outside scope.

Implementation and evidence: [INC-02 T05](../docs/INC-02-T05.md).
