# Access foundation: access/1 and session/1

## Boundary

`access/1` defines closed English intentions and projections for the current
identity increment. `session/1` is its accepted synthetic HTTPS browser transport
under ADR-032. Neither
is a replacement for the `reading/1` material DTO. The executable definitions
are in `src/contracts/access.ts`, `access_transport.ts`, `access_security.ts`
and `access_context.ts`; independent examples are in `tests/access/examples.mjs`.

T02 and T03 provide the operational synthetic producer in `src/server/access/terminal.ts`
and a minimal UI at `/access`. The original T01 fixture remains a transport test.
The import check permits only the explicit runtime adapters and keeps the UI
away from server identity and legacy SQL. The producer requires the isolated
configuration described in [T02](INC-02-T02.md); it is not enabled as a Next API
route. Unimplemented route admission stays closed. A schema does not confer authority.

## Route bindings and first producers

All paths below have the prefix `/api/access/v1`. The executable route table
contains their exact request and success-response shapes. A POST body is not a
server identity context. The bound deployment, actor, subject, purpose, policy,
function and admissible treatment come from the current server-side flow.

Invitation issue/acceptance and withdrawal are person-initiated, attributable
operations. Authentication endpoints are bounded support treatments, not new
substantive acts; issuing a proof, verifier or session is the recorded consequence
of that permitted flow. Mail delivery inherits its exact originator and treatment
limits, not independent authority to act. Projections inherit the recipient's
current route/object/purpose policy. An externally declared root is consumed
through the admitted deployment declaration, not fabricated by an activation
request. No service identity occupies a human function or supplies independent
verification. These mode distinctions remain separate from route and schema names.

| Route key | Method and suffix | Parent act or permitted treatment; effect | Responsible function and admission conditions | First producer |
|---|---|---|---|---|
| reception | GET `/reception` | Bounded pre-authentication reception; prepare provisional cookie/CSRF, no account data | Current synthetic deployment and reception treatment, bounded per-peer requests; no account or authority creation | T02 |
| activation_challenge | POST `/activation/challenges` | Credential activation reception; accept a bounded attempt, not a delivery claim | Service/infrastructure custody under an admitted deployment declaration, exact predeclared master address and reception/mail profile | T02 |
| activate_master | POST `/activation/complete` | Credential activation; establish the verifier for the predeclared office account | Bound proof, address, purpose, revision, one-time consumption and prior evidence; no first-visitor ownership or new investiture | T02 |
| login | POST `/sessions` | Authentication treatment; create and rotate an opaque server session | Service identity treatment; current account restriction, bounded verification, CSRF and evidence. No client role or scope | T02 |
| logout | POST `/sessions/logout` | Authentication treatment; invalidate this server session | Current session, independent CSRF; coordinated invalidation, durable effect/evidence, cookie expiry after effect | T02 |
| recovery_challenge | POST `/recovery/challenges` | Credential recovery reception; accept a bounded attempt | Bound account/deployment recovery profile; no public address enumeration or attacker-triggered account lockout | T02 |
| recover_credential | POST `/recovery/complete` | Credential recovery; replace the verifier and invalidate old sessions | Exact-purpose proof and permitted recovery route. Does not revive grants, invitations, investitures or signatures | T02 |
| issue_invitation | POST `/invitations` | Issue invitation / propose permission gain; persist exact nominative terms, no usable grant | Responsible issuer with current **granting**, not merely exercising/reading, authority; family, subordinate scope, support, expiry and incompatibilities | T03 |
| amend_invitation | POST `/invitations/:invitation_id/amend` | Amend the same pending concession; retain old terms and increment revision, no positive grant | Current issuer, granting authority and local constraints; exact revision; cannot change recipient, family or expiration | T03 |
| invitation_view | GET `/invitations/:invitation_id` | Projection of the invitation's own terms, not a public directory | Exact-email provisional flow or authorized session; current recipient view and treatment. Identifier alone reveals nothing | T03 |
| invitation_challenge | POST `/invitations/:invitation_id/challenges` | Invitation email-control reception; bounded delivery attempt | Invitation-bound address and purpose, controlled mailbox, resend limit; indistinguishable unauthorized/absent projection | T03 |
| verify_invitation_email | POST `/invitation-proofs/:challenge_id/verify` | Verify exact-email control for this invitation flow | Attempts, expiry and replay controls; does not accept terms, establish person identity or authorize corpus access | T03 |
| accept_invitation | POST `/invitations/:invitation_id/accept` | Accept the exact proposed concession; one atomic account/grant/acceptance/proof/evidence effect | Recipient's verified bound flow; recheck current revision, email, issuer support, grant scope, local incompatibilities and deployment. Existing account is reused | T03 |
| initial_credential | POST `/account/initial-credential` | Credential establishment for a newly accepted account lacking a verifier | Provisional flow must resolve that exact accepted account. No account selector, account creation, replacement of an existing verifier or grant gain. Existing accounts use login/recovery | T03 |
| withdraw_invitation | POST `/invitations/:invitation_id/withdraw` | Withdraw the pending concession intention, not an accepted grant | Responsible competent grantor and current revision/scope/support; does not rewrite accepted effects | T03 |
| withdraw_grant | POST `/grants/:grant_id/withdraw` | Asymmetric permission withdrawal | Competent grantor within subordinate scope, reason, revision and evidence; immediate coordination without recipient acceptance, not desinvestiture | T03 |
| current_session | GET `/session` | Project current verified session status and CSRF challenge | Server session/restriction and recipient treatment; never return the session credential | T02 |
| capabilities | GET `/capabilities` | Truthful self-description of the implemented deployment and recipient view | Service delivery and access policy. Omit non-revealable capabilities; implementation, enablement, authorization and executability remain distinct | T02 |
| people | GET `/people` | View the protected administration census | Access function and scoped census permission; authorized population before order/count/cursor. Not a resolver directory, ranking or global master view | T04 |
| operation_result | GET `/operations/:operation_id` | Reconcile an existing intention's current permitted result, not execute it again | Inherits the exact originator operation and stable provisional/session binding; reauthorize projection after withdrawal. No cached secret replay | T03 |

Every row additionally requires the current route policy, class/adoption/capability
admission and first-receiver treatment. Authentication support is treatment, not
a fabricated substantive act. Proposed operation keys do not extend the product
act catalogue. An independently valid external authority declaration is not
disproved by the absence of its registration endpoint.

Post-bootstrap investiture registration/revalidation/termination, organizational
frontier/risk declarations and a general access-request route have **no proposed
operational endpoint here**. Their explicit admission conditions remain with
their actual consumers. No generic `/execute`, unrestricted authority CRUD,
impersonation, direct positive grant or first-visitor bootstrap exists.

## Wire, revision and result rules

- Concrete route selection occurs before decoding. Unknown routes and methods
  do not select a different policy. Path IDs are opaque, case-sensitive,
  validated without Unicode or case normalization. The implemented profile rejects
  percent-encoded paths rather than providing equivalent aliases.
- POST uses UTF-8 `application/json`, no compression, no duplicate singleton
  security headers and a bounded body. `decodeAccess` rejects invalid UTF-8,
  duplicate keys (including escaped aliases), unpaired surrogates, excessive
  depth and noncanonical/unsafe integer numbers. Decoding and `validateAccess`
  are both required. Read and limit bytes at the first receiver, not after
  buffering an unbounded body. T02 implements the HTTP receiver.
- GET has no body. Implemented routes reject queries. The deferred census accepts only the `cursor` query selector; the
  first page uses the empty cursor. Other query fields are rejected. Its
  continuation is opaque and bound to the permitted population/snapshot, not
  a client offset into all accounts. No cursor is an authority credential.
- `accessSchema` exports closed JSON Schema shapes. The executable validator
  also checks well-formed strings, exact safe integers and capability
  consistency/uniqueness. Schema-only validation is insufficient.
- Exact email is preserved; the shape check is deliberately not a full mail
  deliverability or legal-identity check. Proof resolves the exact stored
  address and purpose. A syntactically valid grant selector does not prove an
  admitted permission, support or scope. T03 rejects duplicate/conflicting
  grant intentions and resolves selectors against the current admitted catalogue.
- New-object creation has uniqueness, not a fictitious previous revision.
  Existing invitation acceptance/withdrawal and grant withdrawal require the
  exact `expected_revision`. Stored times are integer Unix milliseconds; an
  expiry value does not authorize its requested lifetime.
- The `/people` response's `revision` is an opaque numeric population fingerprint,
  not a monotonic revision counter. It is a compact projection of the server's
  population/authority digest and carries no chronological or ordering meaning:
  a greater value does not mean a newer census. Never use it as `expected_revision`,
  an authorization decision, or a cursor-validity check. Equality is not proof of
  an identical snapshot, because the public fingerprint is truncated. Continuation
  is validated separately against server-held cursor state, including the full
  population digest and the exact account/session binding. This exception does not
  change the object revision rules for invitations, grants or other mutations.
- Side-effecting intentions use `x-ledgerdesk-intent`, a fresh opaque identifier
  with the same bounded syntax as route IDs. The receiving operation persists
  its stable namespace and HMAC of the canonical payload; a different payload conflicts.
  A retry reauthorizes the current result, never replays a secret or silently
  rebinds to a different account. T02/T03 implement persistence and reconciliation.
  New payloads use `canon_m09_1`: Unicode scalar key order, unchanged strings,
  ordered arrays, distinct absence/null and exact safe integer values. Contract,
  variant, typed path, query and body are included; object and revision are in
  the payload, not the stable namespace. Existing T02 receipts retain their old
  comparator. See [T03](INC-02-T03.md) for vectors and the populated migration test.
- A challenge's generic `accepted` acknowledges reception, not account
  existence or delivered mail. Its opaque challenge ID and one-time code
  travel through the controlled, bound test mailbox. Codes are entered in a
  request body, not placed in URLs, HTML, logs or a public debug inbox.
- `completed` is emitted only after the durable effect and required evidence.
  `accepted` on an operation receipt is not completion. `not_completed` is a
  known final failure, not a network timeout. Loss of the response leaves the
  client uncertain until reconciliation; it must not manufacture any receipt.
  Session/CSRF-bearing responses are freshly authorized, not replayable
  idempotency output. Logout/recovery invalidate rather than restore powers.
- Errors are closed `application/problem+json` bodies with a matching HTTP
  status/type/title/code. `unauthenticated` and `forbidden` both use 403 but
  are distinct; a forbidden administrative action does not log out the user.
  404 protects absence/NONE; a conflict/reason is exposed only if revealable.
  503 is inability to establish a result, not ordinary denial. No input echo.

The bounds (16 KiB wire body, depth 12, 32 grants per proposal, 100 census rows
per page, 64 projected capabilities and bounded strings) are local realization
limits for this trial. They neither enlarge authority nor settle production
capacity. No silent truncation is permitted. A producer that exceeds a bound
must not return an apparently complete projection; batching/pagination or a
declared failure is required at its first consumer.

## Transport and confidentiality

Trusted configuration fixes `session/1`, the HTTPS UI origin and the HTTPS
terminal origin. The implementation currently accepts only the explicit trial
hosts. It rejects omitted/unknown configuration, paths, userinfo, query strings,
fragments, noncanonical ports, shared-host and cross-site substitutions. It is
not a production DNS configuration API.

The terminal validates its configured Host and the exact allowed Origin before
body processing. Forwarded headers cannot replace either. Cookie lookup rejects
duplicate session cookies and does not recognize legacy identity. Credentialed
CORS permits no wildcard and all responses are no-store. Bounded preflight
allows POST with content-type and x-ledgerdesk-csrf, optionally
x-ledgerdesk-intent; actual operation-specific body, method, intent and CSRF
checks remain mandatory. Missing, `null` and foreign origins fail closed.

`preflightHeaders(config)` supplies the response's exact POST/header allowlist
and a 60-second `Access-Control-Max-Age`; the receiving fixture uses this shared
function, not a second allowlist. That bounded browser preflight cache does not
authorize a subsequent operation. Each actual request still passes current
Origin, session, CSRF and operation admission. The preflight response remains
HTTP `no-store`.

Browser CORS rejection and server Origin admission are separate observations.
The direct Node HTTPS probe uses the same terminal, trusted certificate, current
cookie and CSRF as the successful browser flow. Allowed-Origin positive controls
surround foreign/missing/`null`-Origin refusals. A non-browser client can supply
an arbitrary Origin: this header check is not authentication, and does not replace
valid credentials or authorization.

The session cookie is opaque, host-only, Secure, HttpOnly, Path=/, no Domain,
SameSite=Strict. It contains no role, scope or frozen permission. Rotation and
revocation are server facts. JavaScript may receive an independent CSRF token,
never the cookie credential. T02 stores the provisional CSRF with its flow and
the authenticated CSRF with its session. Login rotates both and invalidates the
provisional flow. The original in-memory T01 fixture remains independently tested.

Keep credential-free INC-01 regressions intact. Its `Reader` still omits
credentials; the existing Origin suite's two assertions and mutation M5 are
unchanged. New-profile tests require inclusion and independently attack Origin,
CSRF, wildcard responses, cookie duplication and profile downgrade. Both run
in the required `reading` CI job. No uncredentialed retry follows a session denial.

Host isolation is not port isolation. Do not run an unrelated service under
`api.inc02.test`; a host cookie also reaches another port there. A compromised
allowed UI can act with the user's session, even if it cannot read the cookie.
This design does not defeat a privileged local process. Cross-site cookies
require another assessment; SameSite=None is not an automatic solution.

## Authentication realization and finite configuration

The trial selects `@node-rs/argon2` 2.2.0, Argon2id v19, 65,536 KiB,
3 passes, parallelism 1, 32-byte output and the library's fresh 16-byte salt.
Use the maintained verifier, not a new password scheme. The measured test
checks correct/wrong passwords, salt uniqueness and no Unicode normalization
on Windows and Linux. These small-sample timings are not a production throughput
or side-channel claim. T02 enforces input bounds and two concurrent KDF operations,
with no unbounded queue. It validates stored PHC parameters before expensive work.
Unknown accounts and unsupported verifiers use a fixed supported decoy and cannot
authenticate. Unsupported stored parameters are never passed to the KDF.

The explicit `access-trial/1` fixture chooses 1,800-second sessions,
300-second proofs, 86,400-second invitation lifetimes, 5 proof attempts,
5 login attempts per (email, socket peer) per 300-second window,
16,384-byte bodies, 30-second resend spacing, 3 resends and 2 transaction retries.
The schema rejects missing, unknown, nonfinite and inconsistent configuration.
T02/T03 implement the actual limits, expiry, rotation and secure random generation.
Attempt exhaustion must not let an unverified caller permanently lock out an
account. Codes/session secrets use 32 cryptographically random bytes; persist
only the appropriate verifier/reference, never a raw code in ordinary evidence.
No external SMTP, actual credential or real person's address is in this delivery.

The T02 realization also caps login work per email at ten times `loginAttempts`
(50 with the fixture above), across socket peers, in an independently started
window of the same duration. Both successful and unsuccessful admitted attempts
consume a slot. A request refused by the peer budget does not consume the
aggregate budget or extend either window. The email object lock serializes both
budget checks with the decision. A fresh flow, cookie, intention or service
restart does not reset persisted limits. Only the terminal's socket address is
used; forwarded headers are not trusted and no reverse proxy is supported here.

This changes the original five-per-email realization, not the production policy.
It isolates one exhausted peer while retaining a finite distributed-guessing
ceiling; it is not universal protection against denial of service. Peers sharing
a public address share a budget. Exhausting the 50-attempt aggregate still
temporarily denies all peers, including a correct password, with `rate_limited`.
A continuing attacker may exhaust later windows. Limits never set account
restriction, replace a verifier or invalidate an existing session. Recovery mail
and proof limits retain their separate behavior; this is not a general anti-abuse
or production capacity assessment.

`invitationSeconds` is required and bounded to 1–604,800 seconds in this trial
configuration. The fixture's 24-hour selection and the seven-day configuration
ceiling are realization bounds, not production invitation policy. They are
independent of the short-lived email-control proof and session limits.
`invitationExpiryAllowed` tests the issuance condition using integer Unix
milliseconds: `issuedAt < expires_at <= issuedAt + invitationSeconds * 1000`.
It compares the difference rather than constructing a potentially unsafe sum.
The request shape still checks only timestamp syntax, not a requested lifetime.

T03 must call this check against the server's issuance time before persisting an
invitation. On acceptance it must recheck the stored absolute expiry against the
current server time, together with revision and authority, in the same decision.
Resending a message, renewing a proof or recovering credentials does not reset
that expiry. T03 applies this predicate when issuing and accepting, and rechecks
the absolute deadline. Amendment cannot prolong it.

## Persistence and invalidation

Use a dedicated synthetic database for the INC-02 facts consumed in one
decision. Keep the original `inc01_reader`/`inc01_synthetic` contract intact.
The INC-02 owner is NOLOGIN; runtime roles have no ownership,
membership escalation, BYPASSRLS, CREATE or inherited PUBLIC privileges.
Separate account/session effect access, permitted reading and evidence append
paths. T02 implements identity DDL and effective bilateral privilege probes;
authenticated material reading remains T04.

T02 uses database `inc02_synthetic`, NOLOGIN owner `inc02_owner`, effect runtime
`inc02_runtime`, deployment controller `inc02_control` and a separate test-only
inspection credential. Runtime table grants are explicit; account identity and
restriction updates, control functions, ownership, public-schema creation and
evidence modification are denied. The master insertion trigger checks the
predeclared address and person. T03 adds its grant/support tables; there is still
no `inc02_reader` or session-derived material delivery.
The runtime credential is a trusted service credential, not an end-user role;
SQL isolation alone does not establish person-level authorization.
No existing user's database or historical container is a migration target.

Required facts: deployment/root declaration; account; attributable person link;
verifier; server session; exact-purpose proof; invitation and grant revision;
acceptance/support/withdrawal; full investiture declaration; incompatibility
inputs; idempotent intention; protected evidence. Do not collapse account and
person or investiture and permission into `admin`. `access_context.ts` preserves
the complete investiture fields and distinguishes reception, provisional,
session and service contexts. Its types are not an authority deserializer.

Acquire a common persistent deployment guard before opening the decision's
consistent snapshot. Use shared admission for effects and exclusive admission
for invalidating changes, with a predeclared lock order and no mid-operation
upgrade. After acquisition, resolve the current session, account, support,
grant, applicable investiture, person-level independence, capability and route/
material/treatment policy together. No startup-only context or unrelated
snapshot can supply authority. Implement this common kernel at T02/T03's first
consumers; an allow-all placeholder is not an acceptable dependency on T04.

Every participating invalidator belongs to that coordination domain: account
restriction, session revocation, support/permission withdrawal, investiture
revision/expiry handling, capability, route/executor generation, policy,
treatment/processor, retention, containment, material and configuration changes.
Persist invalidating effects, revisions and evidence together. No asynchronous
outbox window can preserve old permissions. The trial may serialize only after
an explicit equivalence/limits assessment, not by silently replacing this design.

Acceptance establishes/reuses the unique account, exact grants, acceptance,
proof consumption and evidence atomically. Technical failures leave no partial
grant. Recovery does not change authority. A person with two accounts is not
two independent people. Missing investiture blocks its dependent act; a current
but externally unaccredited declaration has its distinct marking. Master
activation conveys neither global reading nor approval.

Commit is not handoff. Required access evidence precedes the terminal's handoff;
transport observation follows it. `handed_off` records the terminal's synchronous
response handoff, not socket delivery or human receipt; interruption is distinct.
No SQL transaction stays open while awaiting
browser/network activity. Hold the appropriate coordination until the protected
boundary, with time rechecked there. Expiry without a writer remains a separate,
unaccredited temporal condition. This transport proof does not close it.

## Implemented versus conditional

| Capability | This delivery | Remaining first consumer |
|---|---|---|
| Closed contract parsing/validation, profile selection and transport guards | Nine T02 and ten T03 routes integrated; other admission remains closed | T04 consumers |
| Same-site HTTPS cookie/CSRF/CORS/TLS isolation | Real synthetic Next/terminal/PG/browser journey | Production deployment assessment |
| Password library/configuration | Bounded verifier, decoy, rate limits and persisted lifecycle | Production capacity assessment |
| Master activation/session/capability projection | Implemented, with current server-derived invitation options | Broader truthful capability surfaces |
| Invitations, accepted gains, withdrawal and initial verifier | Real isolated T03 producer and connected minimal UI | Integrated administration in T05 |
| Current authority and authenticated material reading | Current invitation grant/support/scope/function and incompatibility checks implemented; material integration closed | T04 integration |
| Census and administration UI | Contract only, not an implemented screen | T04/T05 |
| Post-bootstrap authority-management routes | Admission conditional; no route | Actual admitted consumer, not inferred from an entity |
| Real data, external mail, production authentication or full temporal conformity | Not authorized or demonstrated | Separate conditions and evidence |

The T03 closed DTO extension is explicit: `invitation_view` includes current
state, readable `terms` and accepted grant references/revisions; `capabilities`
includes `invitation_options`. Terms include grant/support/scope revisions,
support-bound grant expiry and any consumed function declarations, marked as
not externally accredited. No optional field is silently dropped for an older
client: deploy the paired service/UI, and fail closed on mismatched projections.
There is no new alias, credential format or `reading/1` change.

## Technical references

Cookie port limits: [RFC 6265 §8.5](https://httpwg.org/specs/rfc6265.html#section-8.5).
Prefix/attribute semantics: [Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
Schemeful same-site relationship: [Site](https://developer.mozilla.org/en-US/docs/Glossary/Site).
Password choice: [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
and the [maintained binding](https://github.com/napi-rs/node-rs/tree/main/packages/argon2).
These describe technical mechanisms, not product authority or production acceptance.
