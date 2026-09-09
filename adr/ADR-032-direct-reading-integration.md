# ADR-032 · Direct browser-to-terminal reading

**Status:** accepted · **Decision date:** 2026-09-09

## Context

T03 supplies a Next-rendered React viewer. T04 supplies the separate HTTP
terminal that owns admission through its response handoff. Forwarding an
already-authorized response through Next would introduce another handoff not
covered by that admission. Repackaging React and its CSS modules inside the
terminal is unnecessary for the synthetic integration.

## Decision

Keep `/material` in Next. Configure `LEDGERDESK_READING_SERVICE_ORIGIN` on that
server and pass only its validated destination to the browser. The browser
performs the two existing `reading/1` GET operations directly against the T04
terminal. It omits credentials, requests no storage and rejects redirects.
There is no Next proxy, alternate API profile, same-origin fallback or demo body.

Configure `LEDGERDESK_READING_UI_ORIGIN` independently on the terminal. Both
values require the exact `http://127.0.0.1:<port>` form, with a canonical explicit
port from 1024 through 65535 and no path, credentials, query or fragment.
An invalid terminal-side origin fails before connecting to storage; an absent
or invalid UI destination produces a closed setup page instead of a reader.

The terminal accepts browser Origin only when it exactly matches its configured
UI origin. It returns that origin, never `*`, in Access-Control-Allow-Origin,
adds Vary: Origin and does not permit credentialed CORS. Disallowed Origin is
rejected before reading preparation. No preflight or extra method is introduced:
the browser sends simple GET requests without custom authority headers.

CORS is not authentication. A non-browser client can omit or forge Origin and
remains subject to the same explicitly enabled, server-owned synthetic context
and policy. This is an isolated local trial, not a public identity mechanism.
Legacy cookies, client-supplied identities and an allowed Origin grant nothing.

Keep the T04 projection policy, persistence port, SQL schema and admission
mechanism unchanged. The Next material endpoints remain closed. Protected
material does not enter Next SSR, hydration or a proxy response. Only the public
terminal destination crosses the page's server/client boundary.

## Verification and limits

T05 uses a real production Next build, browser, terminal and disposable PG16
cluster. It checks actual response bodies, SQL receipts, coordinated remote
writers, browser errors, cache restrictions, restart and rendering. The earlier
mocked viewer tests remain component evidence, not integrated evidence.

The physical writer-free-expiry gap remains observable. Successful integration
does not certify full temporal conformity, production authentication or every
possible browser/OS/network interleaving. See `docs/INC-01-T05.md` for the 24
acceptance groups and the distinction between demonstrated trial behavior and
the outstanding contract.
