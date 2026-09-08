# ADR-030 · Ephemeral material reading viewer

**Status:** accepted · **Decision date:** 2026-09-09

## Context

INC-01 T03 needs a real contract consumer without depending on the unfinished
reading service or inheriting the reference interface's demonstration data.

## Decision

`/material` mounts a client component when the isolated trial is enabled. The
disabled page and server-side gate remain in place. No original text, identity,
demo fixture or legacy provider enters server-rendered viewer props.
The framework may render the empty shell on the server; material is fetched only
after the component mounts in the browser.

The viewer consumes `reading/1` through GET requests with credentials omitted,
redirects rejected and caching disabled. It validates response shape, exact
selected reference and `no-store` before display. Request epochs and sequences
reject late responses even if cancellation is ignored. Refusal or invalid input
clears both list and detail; retry obtains a fresh list. Leaving the page or hiding
the document clears ephemeral state. A fresh server render remounts the viewer.

The library uses a side list and reading pane, mobile list/back navigation,
keyboard focus restoration and expandable metadata. Scoped styles preserve the
warm dark/light palette and serif reading hierarchy without importing the old
layout, demo context or editorial controls. System font stacks avoid new font
downloads; this is not a pixel-identical copy of the reference interface.

Control localization never changes returned metadata or original text. Text and
locators remain inert text nodes with preserved whitespace. Excerpts stay separate;
a reference-only response never fabricates a body. Filtering searches only the
received references and does not perform another request.

Errors require `application/problem+json`; a Problem body under `application/json`
is unusable. Unknown Problem extensions remain tolerated and are not displayed.

## Consequences

Clearing on tab hide is a provisional trial choice, not a permanent product
requirement. A reader returning from another tab loses the selected document and
receives a fresh list. Revisit this interaction with the real service; no claim is
made that tab hiding changes authority or that clearing state securely erases memory.

## Verification and limits

Controller tests cover races, cancellation, exact-reference validation, refusal,
duplicates, cache policy and code-point preservation. Browser tests exercise the
production Next build, with synthetic HTTP responses intercepted only in tests.
The unmocked service must still fail honestly until T04 exists. These checks do
not demonstrate persistence, authorization policy, physical delivery or temporal
conformity. T04 and T05 remain separate deliverables.

No background polling, storage of originals, model calls or deployment is added.
Browser state invalidation is not a substitute for server revocation/admission.
