# ADR-033 · Persistent synthetic deployment access

**Status:** proposed · **Decision date:** pending acceptance

## Context

ADR-032 admits the `session/1` transport alongside credential-free `reading/1`.
The transport fixture alone does not establish an account, verify a password or
resolve current session authority. These are the first consumers of INC-02 T02.

## Decision

Realize T02 in an isolated PostgreSQL 16 database, `inc02_synthetic`, with a
NOLOGIN owner, a constrained runtime role and a separate deployment-control
credential. No legacy database is migrated. The preparation root and reception
treatment are supplied by deployment control before credential consumption.
The root's attributable fields are validated; their external truth is not
certified by this service. Only the exact predeclared office account can activate.

Add GET `/api/access/v1/reception` to `access/1` as a bounded support treatment.
It prepares a host-only provisional cookie and independent persisted CSRF token.
It creates neither an account nor an authority. The existing eighteen route
bindings remain intact. Only the nine T02 routes have an HTTP producer here.

Use the maintained bounded Argon2id verifier for both real and decoy login work.
Persist account, proof, session, intentions, limits and required evidence.
Session secrets and email codes are HMAC-verifiable, not recoverable credentials
in ordinary evidence. Recovery is restricted to the existing master account
and a currently authorized deployment-control window; ordinary invitation and
recovery authority remain later consumers. It never transfers the office.

Bound login attempts per (email, socket peer), with a separate per-email ceiling
of ten times that allowance. With the synthetic fixture these are five and fifty
attempts in independently started 300-second windows. One exhausted peer cannot
spend the remaining aggregate allowance. This raises the former five-per-email
ceiling rather than eliminating distributed-guessing limits. Shared-address users
and exhaustion of the aggregate still permit temporary denial; continuing abuse
may exhaust subsequent windows. No account restriction or credential change is
caused by those counters. This trial bound is not a production anti-abuse policy.

Acquire deployment admission before consuming credential bodies and before the
decision snapshot. Serialize the object after admission, then use Repeatable
Read. Commit effects and evidence together. Retain admission through the
terminal's synchronous handoff; append a separate observation afterward.
There is no SQL transaction while receiving a body or awaiting network activity.
The finite invalidator inventory is logout, technical recovery and the control
functions for restriction and deployment availability. This does not claim
coordination of unimplemented grant, material or policy writers.

Keep the minimal access UI in Next and make requests directly to the terminal.
The demonstration runs entirely inside a disposable container, with trusted
same-site HTTPS names confined there. No host certificate store, hosts file,
real email system, public port or user database is changed.

## Consequences

- `reading/1`, its credential-free assertions and material viewer remain intact.
- T02 is not a production identity deployment or a complete access-control engine.
- A replayed intention cannot replay a login secret. Activation/recovery receipts
  are reconciled under the current flow and policy; lost responses are uncertain
  until checked. A different payload under the same intention conflicts.
- The controlled mailbox is an injected local adapter, not an SMTP service or
  durable delivery queue. `accepted` is reception, never delivery confirmation.
- Directed writer-free expiry tests do not establish full temporal conformity.
- Timing comparisons are falsifiable finite experiments, not constant-time or
  universal non-enumeration proofs.

Implementation, reproduction commands and limitations: [T02](../docs/INC-02-T02.md).
