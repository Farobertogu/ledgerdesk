# LedgerDesk

A grounded-answer platform over versioned knowledge corpora. Three commitments define the system:

1. **Grounded answers only.** Draft answers are produced solely from admitted, versioned sources (`kb_snapshot`); when the corpus has no answer, the system files a typed gap instead of improvising one.
2. **An append-only, hash-chained ledger.** Every decision leaves a row; the chain is head-anchored and enforced by the database, not by convention. Replay from the ledger requires no network.
3. **A pre-registered promotion gate.** Model-facing changes are promoted only through a statistical gate whose sample sizes, thresholds and splits are sealed before the first scored run.

Built generic, demonstrated specific: the demonstration instance is customer support for a hypothetical mid-size company (MidCo).

Capstone project — COIT20273 Software Design and Development Project, CQUniversity, Term 2 2026.

## Repository layout

| Path | Contents |
|---|---|
| `docs/` | proposal, learning plan, provenance |
| `adr/` | architecture decision records (ADRs) |
| `migrations/` | numbered SQL migrations, forward-only |
| `seed/` | seed data with fixed identifiers (two organisations) |
| `quality/` | the quality layer: schemas, generators, templates and their parameters |
| `status/` | weekly status updates |
| `reports/` | generated evidence (test reports, batteries, sensitivity tables) — created as artifacts land |
| `minutes/` | mentor meeting minutes |
| `BOARD.md` | build board — verifiable increments I0–I18 (+ I2b) |
| `ci/` | repository and database checks (run locally and in CI) |

## Conventions

- One branch per board card; a card merges to `main` only after its named tests are green and the owner has reviewed the diff (merge `--no-ff`).
- Tags mark plan gates: `baseline-v1.0`, `demo-w7`, freeze tag. History is never rewritten once a card is merged; corrections land as new dated commits.
- No licence file yet by owner decision; all rights reserved until decided.

## Status

Build order: **25 verifiable increments** on `BOARD.md`. I0 and I1 are done; the documentary baseline is sealed with the immutable tag `baseline-v1.0`. The process gate (I0b) is in review; first code card is I2 (data spine).
