# Documentation

Start with the [system overview](SYSTEM_OVERVIEW.md) for the current product and implementation
boundary. The [repository entry](../README.md) is the short introduction; [BOARD](../BOARD.md)
tracks construction. This index separates current guidance from dated evidence and the academic
baseline. A historical result describes its recorded version, not every later revision.
Dated delivery records retain their original verification requirements and outcomes. For T05,
the board records the subsequent merge and main-verification status.

## Current contracts and decisions

| Document | Use |
|---|---|
| [Reading contract](reading-contract.md) | Exact `reading/1` projections and delivery obligations; explicit transport profiles |
| [Access contract](access-contract.md) | `access/1` and `session/1`, authority, sessions, invitations, census and administration |
| [Intake contract](intake-contract.md) | `intake/1`, admitted reception versus later worker/preparation operations, profile limits and trust boundaries |
| [Intake workspace](intake-workspace.md) | Explicit `intake-workspace/1` queries, browser ownership, exact confirmation and bounded reconciliation |
| [Architecture decisions](../adr/README.md) | Status, scope and amendments of repository decisions |
| [Provenance](PROVENANCE.md) | Source and copy manifests; integrity and attribution limits |

## Reproduction and delivery evidence

Use the setup and limits of the chosen journey. Do not substitute the historical database,
identity selector or rehearsal from the root README. These records concern synthetic experiments,
not production deployment instructions.

| Delivery | Entry and supporting records |
|---|---|
| Integrated credential-free reading | [INC-01 T05](INC-01-T05.md), [PostgreSQL service T04](INC-01-T04.md), [foundation T01/T02](INC-01-T01-T02.md) |
| Viewer component and mocked harness | [Material viewer](material-viewer.md); not a substitute for database-backed integration |
| Access and authority whole journey | [INC-02 T06](INC-02-T06.md) |
| Access construction records | [T01 transport](INC-02-T01.md), [T02 identity](INC-02-T02.md), [T03 invitations](INC-02-T03.md), [T04 authenticated reading](INC-02-T04.md), [T05 administration](INC-02-T05.md) |
| Intake foundation | [INC-03 T01](INC-03-T01.md), including the original experiments and later acceptance checkpoints |
| Synthetic intake reception | [INC-03 T02](INC-03-T02.md) and its [coverage map](INC-03-T02-coverage.md) |
| Bounded synthetic extraction | [INC-03 T03](INC-03-T03.md#current-status), with scoped acceptance, qualified implementation CI, preserved correction history and remaining limits |
| Exact preparation and constitution | [INC-03 T04](INC-03-T04.md#current-status), accepted only in its bounded synthetic scope |
| Integrated intake workspace | [INC-03 T05](INC-03-T05.md), finite browser evidence and reproduction; accepted on 21 September 2026 under [ADR-039](../adr/ADR-039-intake-workspace.md) and merged through [PR #36](https://github.com/Farobertogu/ledgerdesk/pull/36); T06 has not started |
| L03 memory attribution | [Exclusive retained reference](L03-exclusive-reference.md) for the current qualified profile; [bounded diagnostics](L03-diagnostics.md) for the earlier observation method and recorded failures |

The [browser follow-up record](INC-02-T03.md#tracked-browser-follow-up) retains its closure
criteria; a later successful run is not resolution. R24 and the tracked browser incidents remain explicit limits
in the delivery records. Whole-increment or production acceptance must not be inferred from one
component's passing suite.

## Preserved academic baseline

- [Project proposal](PROPOSAL.md): August 2026 proposal, retained with its original claims and submission context.
- [Individual learning plan](LEARNING_PLAN.md): August 2026 academic plan and personal statements, not a current implementation inventory.

Their original bodies are preserved. Current-scope notes do not renew an approval, revise an
academic self-assessment or make the earlier design the authority for the new implementation.
The [transition explanation](SYSTEM_OVERVIEW.md#relationship-to-the-earlier-system) identifies
the material distinctions without creating another construction plan.
