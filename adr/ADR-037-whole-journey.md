# ADR-037 · Declared initial faculties and whole-journey acceptance

**Status:** accepted · **Decision date:** 2026-09-11

## Context

The exact predeclared master can activate, but the credential-only bootstrap
does not materialize its initial administration. Inserting grants in the test
would bypass the operation that the integrated journey needs to establish.
The office permits initial administration and explicitly scoped granting; it
does not imply material approval, investiture or unrestricted reading.

## Decision

Install additive isolated migration `004_bootstrap.sql` for the new full-journey
profile. Before the master exists, deployment setup supplies one immutable
declaration bound to the exact master address, holder and existing preparation
root. The runtime can read it but cannot create, amend or delete it. The database
rejects installation after activation. There is no public bootstrap/grant route.

Materialize that declaration only inside the existing admitted first-activation
transaction. Reuse the current authority evaluator and check the named
permission, scope and support revisions, current applicability, expiry and
incompatibility. The trial permits explicit `invite` and `read_people` exercise
faculties and explicit granting selectors; it does not grant material exercise
from the office. No wildcard, inferred permission or automatic investiture is
created. Governing acts that require investiture retain that requirement.

Commit the account, person link, initial grants, consumed proof, intention and
activation evidence together. A unique declaration/account record and deferred
evidence foreign key prevent an unlinked successful bootstrap. Grants retain
the declaration identifier as their source. Retries reconcile the original
intention; login and recovery never execute bootstrap or replenish grants.

This is the explicit initial-administration exception, not an exception to
ordinary invitation acceptance. Subsequent invitation gains retain the existing
proof, current-terms, eligibility, acceptance and evidence checks. SQL write
privilege alone is not an admission rule.

## Localized extension of ADR-033 and ADR-034

Complete credential-only first activation with the declared initial faculties
above. Do not change the public access DTOs, ordinary invitation/recovery routes,
session transport or reading/1. Old isolated schemas remain credential-only;
installing 004 on a populated deployment preserves existing facts and does not
retroactively create grants. A populated deployment needing new authority must
use its separately admitted process, not repeat initialization.

## Acceptance artifact and limits

Use one bounded build containing byte-exact `/access`, `/access/material`, their
components and applicable root layout, CSS, PostCSS and Next configuration.
Exercise those routes over container-local HTTPS against the real terminal and
PostgreSQL 16. Keep the ordinary full-application build and retained-reader
regressions separately. This is not a production deployment of the complete app.

The demonstration starts with external synthetic catalogs, root, support, person
determinations, material/policy and nominal-population input. It does not claim
to implement the admission/editing tools for those declarations. Accounts,
invitations, acceptance, credentials, grants and withdrawal in the principal
journey must come from their real producers.

Report implemented behavior, experimental evidence and unresolved guarantees
separately. The clock-to-transport counterexample remains an observed failure,
not a requirement waived by this decision. Keep R24 and the two existing browser
follow-ups open. No real data, production readiness, external mail or full
temporal conformity is authorized.

Implementation and acceptance map: [T06](../docs/INC-02-T06.md).
