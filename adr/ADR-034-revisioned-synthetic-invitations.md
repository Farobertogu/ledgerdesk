# ADR-034 · Revisioned synthetic invitations

**Status:** accepted · **Decision date:** 2026-09-10

## Context

ADR-033 realizes master activation, sessions and controlled recovery. Invitations
are its next consumer, not a second identity stack. A recipient must accept the
current proposal without confusing email control, account identity, permission,
declared function or external accreditation.

## Decision

Extend the isolated `inc02_synthetic` realization additively with revisioned
invitations, attributable acceptance, ordinary accounts, grants, support,
person linkage, declared-function inputs and local incompatibility rules.
Preserve the predeclared master, session transport and `reading/1` boundaries.
Admission requires actual granting authority in the current snapshot, not a
browser role, the master office alone or a grant that merely permits exercise.

Add `amend_invitation` to `access/1`, bound to amendment of a pending concession.
It replaces proposed grants at the current revision; it cannot change the exact
recipient, family or expiration. Keep every proposal revision and accept exactly
one. The expanded invitation and capability projections carry readable current
terms. Both service and UI use these expanded closed shapes; older clients fail
closed rather than receiving a compatibility alias or silently losing fields.

Use `canon_m09_1` for new intent payloads. The namespace is the bound deployment,
stable principal, operation and client key. Object, typed path and revisions
belong in the compared payload, not the namespace. Retained T02 records keep
their original comparator; migration never executes their effects again.

Lock effective PostgreSQL object identifiers in one deterministic order before
Repeatable Read. Resolve account, issuer, grant, support and local constraints
inside that snapshot. Acceptance, account reuse/creation, positive grants,
proof consumption, receipt and required evidence commit together. Admission
remains held through the existing terminal handoff, with subsequent transport
observation. Writer-free expiry remains independently tested and unaccredited.

Ordinary accepted accounts can set their first password through the bound flow
or recover through ordinary exact-email control if that flow is lost. Recovery
does not restore withdrawn permissions or transfer the master office. Proof
account revision prevents an older recovery authorization from overwriting a
newer credential. The initial flow cannot replace a non-null verifier.

## Localized extension of ADR-033

This decision extends ADR-033's T02-only route inventory and
master-only recovery scope: the terminal gains the ten T03 routes, and ordinary
accepted accounts gain bounded recovery. ADR-033's master control-window rule,
credentialed transport, isolation and evidence constraints remain in force.
This decision does not retrospectively change that earlier decision's scope.

## Consequences and limits

- No public signup, unrestricted grant endpoint, authority CRUD or material
  delivery is introduced. `/people` and session-bearing reading remain closed.
- Local function declarations are consumed and marked as registered, not
  externally accredited. No latest-timestamp rule resolves organizational disputes.
- Control-owned declaration inputs are synthetic fixtures. Production admission,
  organizational accreditation and additional authority surfaces are not implemented.
- Mail uses the controlled local adapter, not SMTP or a durable delivery queue.
  An accepted reception is not proof of delivery; an invitation notice contains
  no usable authority.
- Proposed terms distinguish invitation expiry from grant lifetime. A grant is
  support-bound and remains subject to its current support and revocation.
- A common lock is deliberately conservative for this trial. Finite tests do
  not prove arbitrary throughput, all races or full temporal conformity.

Implementation and evidence: [INC-02 T03](../docs/INC-02-T03.md).
