# ADR-035 · Authenticated material reading

**Status:** accepted · **Decision date:** 2026-09-10

## Context

The invitation service has real accounts, current grants, support and declared
functions. A separate material policy cannot substitute for those facts, and a
session checked in another database cannot establish a coherent reading decision.
The two transport profiles need the same projection, not two implementations of
what a reference, excerpt or original means.

## Decision

Add session-bearing material reading and the scoped people census to the existing
synthetic HTTPS terminal. The terminal remains the final handoff owner. Next
serves the empty interface and validated transport coordinates, not material,
identity claims, cookies, CSRF values or a proxy body. `/access/material` uses
`session/1` explicitly. `/material` retains the credential-free INC-01 profile;
neither profile is a fallback for the other.

Reuse the unchanged `reading/1` contract and reading policy/projector. Derive the
material and policy table definitions from the INC-01 SQL source; do not copy its
roles, control tables, privileged functions or 10404 admission domain. Add the
derived tables under `material_trial` inside `inc02_synthetic`, with a separate
owner and reader role. The identity runtime cannot select material, and the reader
cannot select passwords, emails or CSRF values or modify identity/authority.

Resolve session, account, grants, support, applicable investiture, surface and
material policy after shared admission and inside one Repeatable Read transaction.
The existing authority kernel computes the operational ceiling; it does not
manufacture a material-policy grant. No master-office shortcut or second evaluator
is introduced. Commit required evidence before handoff. Keep admission in 20202
through handoff, with no SQL transaction open during transport waiting. Store the
subsequent transport observation separately. Participating invalidators use the
same domain; 20203 remains the object-lock domain.

Keep declaration, operational applicability and external accreditation separate.
Event-based revalidation requires a current satisfied event. Conflicting grades or
purposes have no automatic newest-wins rule: resolution must identify an applicable
declaration for the exact permission and scope. Person independence compares
currently authorized people, not accounts or models; this kernel predicate does
not open a multi-person approval workflow.

The census uses control-supplied nominal names with their own source reference,
never an email fallback or a new profile-editing endpoint. Authorize the population
before ordering, counting, paging or fetching names. Store cursor state server-side;
return only a random opaque token and store its keyed digest. Bind continuation to
the current account, exact session, generation, population/query revision and expiry.
An invalid continuation is a neutral unavailable result, not another person's page.

Require an independently supplied expected generation when the material extension
is installed. Its stored ready flag cannot attest to currency after restoration.
Missing/mismatched control closes the extended service; missing material treatment
readiness closes material/census use without disabling an otherwise admitted
identity session. This is a synthetic reconciliation boundary, not production
disaster recovery or an external authority-verification system.

## Localized extension of ADR-034

This decision opens `/api/access/v1/people` and session-bearing `reading/1` in the
isolated trial, replacing only ADR-034's statement that those surfaces remain
closed. It does not open authority CRUD, editorial approval, unrestricted grants,
public registration or legacy identity. ADR-032's direct terminal handoff and
ADR-033/034's identity, invitation and evidence constraints remain in force.

## Consequences and limits

- The additive migration preserves existing accounts, invitations, acceptances,
  grants, intent receipts and evidence. No historical database is migrated or reset.
- Synthetic control inputs are configuration fixtures, not an organizational
  determination or proof of accreditation. Public role/declaration management and
  the complete administration interface remain separate work.
- Readiness and capability visibility have explicit, independently tested meanings.
  A forbidden material operation does not itself log out a current session.
- The declared timing detector is finite exploratory evidence, not a proof that
  all adversaries or future workloads observe no timing difference.
- Writer-free expiry is not fully accredited. A suspension after the last clock
  check demonstrates a late handoff in the trial; this is a failure of that temporal
  property, not excused by passing cooperating-writer tests.
- No real data, SMTP, paid service, production rollout or full INC-02 acceptance
  follows from this implementation.

Implementation and evidence: [INC-02 T04](../docs/INC-02-T04.md).
