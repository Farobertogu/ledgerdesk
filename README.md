# LedgerDesk

LedgerDesk is an open-source web system for working with governed knowledge within a declared
organizational scope. Its design connects exact, versioned material with people's information
needs, authorized human case handling and a separate editorial path into the reusable corpus.
Receiving a file, preparing content, approving a version, publishing it and closing a case are
distinct operations; none silently performs the next.

The system is being built through end-to-end increments in this repository. Earlier code,
academic documents, commits and pull requests remain part of its history, not an alternative
definition of the current product.

## Current implementation

Status at 20 September 2026:

| Delivery | Available within its accepted experimental scope |
|---|---|
| INC-01 | Integrated synthetic material reading: browser, HTTP terminal, PostgreSQL, permitted projections and prior evidence |
| INC-02 | Synthetic activation, sessions, invitations, scoped authority, census, authenticated material reading and administration |
| INC-03 T01–T02 | Intake contracts and bounded profile experiments; isolated synthetic reception, conservation and recovery of originals |
| INC-03 T03 | Separately authorized bounded text/Markdown, CSV and XLSX extraction, protected result queries and explicit recovery; synthetic scope only |
| INC-03 T04 | Exact preparation and candidate constitution, with retained antecedents, differences and distinct candidate/related/blocked results; no approval or publication |

INC-03 T05 adds the [intake workspace](docs/INC-03-T05.md) on this working branch.
Its executed delivery is separate from the accepted rows above; independent review, ADR-039
acceptance and publication remain separate steps.

`/material` is the integrated credential-free trial viewer; `/access/material` is the
session-bearing viewer. Their profiles are explicit and never selected by automatic fallback.
The terminal performs the protected handoff, without a Next proxy or legacy material.
Intake's accepted reception routes require their own
explicit synthetic configuration. Bounded worker processing is separately admitted under the
[T03 extraction profile](docs/INC-03-T03.md#current-status). Exact preparation and constitution
have their own [T04 profile](docs/INC-03-T04.md#current-status). The T05 consumer at
`/access/intake` uses direct, explicit session transport; no operation is enabled merely
because its contract exists.

These deliveries do **not** authorize real data or production use. Writer-free expiry has an
observed temporal nonconformity (R24); the two tracked browser failures remain open. Successful
checks do not close them. PDF/OCR, the full knowledge-response journey and later editorial/case
capabilities are not claimed as implemented here.

## Start here

- [System overview](docs/SYSTEM_OVERVIEW.md): purpose, current capabilities, pending work and the transition from the earlier implementation.
- [Documentation index](docs/README.md): current contracts, reproduction guides, dated evidence and academic baseline.
- [Build board](BOARD.md): current increment and retained historical cards.
- [Architecture decisions](adr/README.md): decisions and dated amendments, each with its own status and scope.
- [Provenance](docs/PROVENANCE.md): retained sources, manifests and attribution limits.

For isolated reproduction, use [integrated reading](docs/INC-01-T05.md#reproduction),
[the access whole journey](docs/INC-02-T06.md#execution-and-evidence) or
[synthetic intake reception](docs/INC-03-T02.md), [bounded extraction](docs/INC-03-T03.md),
[exact preparation](docs/INC-03-T04.md) or [the intake workspace](docs/INC-03-T05.md#reproduction).
Their configurations are separate from the
historical database and identity selector below. Do not use that historical setup to start
the new system. These journeys use synthetic documents and accounts; they require neither
external mail nor model calls.

## Development conventions

- One branch per board card; review the diff and the final commit's required checks before an authorized merge.
- Preserve merged history. Corrections are new commits, not rewritten evidence.
- Keep contract validity, implementation, measured evidence and acceptance separate. A green test does not expand the accepted scope.

## Historical implementation reference

<details>
<summary>August 2026 implementation, setup and rehearsal notes</summary>

The following records the earlier system. Its roadmap, multi-organization seed, identity
selector, model provider and rehearsal are historical, not the setup or requirements of
the current increments. The database-check commands can drop cluster-wide roles: do not
run them against a shared or historical database as part of a new-system trial.

### Earlier system description

A grounded-answer platform over versioned knowledge corpora. Three commitments define the system:

1. **Grounded answers only.** Draft answers are produced solely from admitted, versioned sources (`kb_snapshot`); when the corpus has no answer, the system files a typed gap instead of improvising one.
2. **An append-only, hash-chained ledger.** Every decision leaves a row; the chain is head-anchored and enforced by the database, not by convention. Replay from the ledger requires no network.
3. **A pre-registered promotion gate.** Model-facing changes are promoted only through a statistical gate whose sample sizes, thresholds and splits are sealed before the first scored run.

Built generic, demonstrated specific: the demonstration instance is customer support for a hypothetical mid-size company (MidCo).

Capstone project — COIT20273 Software Design and Development Project, CQUniversity, Term 2 2026.

### Historical repository layout

| Path | Contents |
|---|---|
| `docs/` | proposal, learning plan, provenance |
| `adr/` | architecture decision records (ADRs) |
| `migrations/` | numbered SQL migrations, forward-only |
| `seed/` | seed data with fixed identifiers (two organisations) |
| `src/` | the three consoles: Next.js App Router, TypeScript, Tailwind |
| `agents/` | the model chokepoint, the ledger writer, the agent contracts and their providers |
| `tests/` | the algorithm and agent-contract tests, and the integration tests that speak HTTP to the running consoles |
| `quality/` | the quality layer: schemas, generators, templates and their parameters |
| `status/` | weekly status updates |
| `reports/` | generated evidence (test reports, batteries, sensitivity tables) — created as artifacts land |
| `minutes/` | mentor meeting minutes |
| `BOARD.md` | build board — verifiable increments I0–I18 (+ I2b) |
| `ci/` | repository and database checks (run locally and in CI) |

### Historical console setup

A PostgreSQL 16 instance is the only prerequisite. The port below is the one the development
container publishes; adjust it for another instance.

```sh
export PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=postgres

psql -d postgres -c 'create database ledgerdesk_dev'
for f in ci/sql/00_platform_shim.sql migrations/0*.sql seed/orgs.sql; do
  psql -v ON_ERROR_STOP=1 -d ledgerdesk_dev -f "$f"
done

npm ci
DATABASE_URL="postgresql://postgres:postgres@localhost:55432/ledgerdesk_dev" \
  LEDGERDESK_DEV_IDENTITY=1 npm run dev
```

`LEDGERDESK_DEV_IDENTITY=1` is what makes the development identity selector exist. Without it no
request carries claims and the API answers 401 — the build fails closed, which is the behaviour a
deployment should have. The selector is not authentication and is not offered as any; the flag is
what keeps it from reaching an environment where that distinction would matter.

`ci/sql/00_platform_shim.sql` recreates what the managed platform provides — the claim readers the
policies call — so that a bare server behaves the way the deployment target does.

The four checks, each runnable locally and each the same command CI runs:

```sh
bash ci/check.sh                        # repository structure, schemas, seam, algorithm, agent contracts
PGPORT=55432 bash ci/db_check.sh        # migrations applied clean, schema diff, database tests
PGPORT=55432 bash ci/app_check.sh       # consoles built and started, application tests
PGPORT=55432 bash ci/gateway_check.sh   # the model chokepoint, against a real database
```

All three database scripts drop the cluster-wide roles the migration set creates, so a development
database that holds grants on those roles has to be dropped before any of them will run.

**Every check runs on the fixture provider, always** — determinism and no network. See below.

### Historical model provider

`LEDGERDESK_PROVIDER` selects the far side of the one path to a model:

| Value | What answers | Used for |
|---|---|---|
| `fixture` (default) | a deterministic function of the request, never a network | every check, every battery, CI |
| `real` | the vendor's API, through `agents/providers/anthropic.ts` | a rehearsal and the demonstration |

`real` requires `ANTHROPIC_API_KEY` in the environment and refuses to start without it. The key is
read by the SDK from the environment. This configuration is not a general proof that secrets
cannot appear in diagnostics. An unrecognised value for `LEDGERDESK_PROVIDER` is refused at
startup rather than treated as the default. ADR-025 records the historical provider decision,
models and prices; it is not a current pricing reference.

### Historical offline rehearsal

Replay reads its answers from the chain: under `LEDGERDESK_REPLAY=1` the provider is never invoked,
and a lookup that misses is `E_REPLAY_CACHE_MISS` rather than a call. That is what makes "replay
from the ledger requires no network" true in the present tense.

**A replay can only reproduce what a real run put there**, so the order is:

```sh
# 1 · load the frozen dataset and check the corpus is where the demonstration expects it
node seed/demo_load.mjs

# 2 · one run WITH network, which seeds the chain
LEDGERDESK_PROVIDER=real ANTHROPIC_API_KEY=... npm run dev     # then drive the beats

# 3 · the rehearsal, with the network unplugged
LEDGERDESK_REPLAY=1 npm run dev
```

The closing act is a question the corpus cannot answer, material admitted, and the same question
answered — **one chain with two `state_hash` values and the admission row between them by `seq`**.
Rehearsing against a chain that holds only the first half fails by design, with
`E_REPLAY_CACHE_MISS`. Run step 2 through both halves before relying on step 3.

The branch that runs entirely on fixtures does not get this for free either: a fixture is
deterministic, so a replay of a fixture run reproduces perfectly — but what it reproduces is a chain
of fixture answers. Whichever provider is chosen, a chain has to exist before it can be replayed.

`node seed/demo_load.mjs --status` reports where each demonstration ticket stands, what the corpus
holds, which snapshot each organisation reads under, and **how much SLA margin is left on the
tightest beat**.

#### Dataset age

**Load the dataset within twenty minutes of the first beat.** `created_at` is stamped at load time
and the escalation rule reads the clock: the shortest first-response policy a demonstration ticket
can land on is thirty minutes, so a dataset loaded an hour early has already breached, and the beat
written to show a knowledge gap shows an SLA breach instead — correctly, and for a reason that has
nothing to do with what is being demonstrated.

The dataset test freezes the instant to one minute after creation; that test does not exercise
an aged dataset. The rehearsal procedure therefore checks dataset age with `--status`, which
alarms past twenty minutes. It reports an age rather than a margin for any beat that has not been
triaged, because until triage assigns a policy there is no margin to report: an earlier version
computed one against the tightest policy the tier could land on, which on the premium tier is
fifteen minutes against an alarm floor of fifteen, so the alarm sat at its own threshold from the
moment of a correct load and could never warn. Once a beat is triaged the policy is real and the
column shows the margin against it, with the fifteen-minute floor doing what a floor is for.

#### Rehearsal variants

An admission cannot be repeated — the advance refuses a snapshot that already exists — and a gap
record cannot be reopened, because its uniqueness is over the ticket, the query and the corpus, and
a re-run asks the same question. Each beat has two variants and a rehearsal spends one. A third
rehearsal of the same beat needs new data, with its own row in the dataset and its own passage
through the dataset test.

```sh
# the documents the gap beat admits, ready to paste into the form (no database needed)
node seed/demo_load.mjs --material

# put every pointer back to the seeded corpus. It DELETES NOTHING: the gap records and the
# admissions of the previous rehearsal are the evidence of the cycle and they stay.
node seed/demo_load.mjs --rewind

# a dry run over a corpus that already exists — walk the act without spending a variant
node seed/demo_load.mjs --stage kb-2026-08-01
```

The admission itself is **not** a script and there is no mode that performs one. The database ties
the approver to the session that executed it, so a component — which carries an organisation, a role
and no subject — cannot admit anything at all. Somebody signed in as a supervisor presses the
control on the ticket screen, which is what makes the approver on the panel afterwards mean
something.

### Historical conventions

- One branch per board card; a card merges to `main` only after its named tests are green and the owner has reviewed the diff (merge `--no-ff`).
- Tags mark plan gates: `baseline-v1.0`, `demo-w7`, freeze tag. History is never rewritten once a card is merged; corrections land as new dated commits.

### Historical status

Build order: **31 verifiable increments** on `BOARD.md`. Thirteen cards are merged: the repo spine and process gate, the documentary baseline (sealed with the immutable tag `baseline-v1.0`), the data spine with its append-only ledger, the app skeleton, the LLM gateway, the pure algorithm, the triage agent, retrieval and drafting, the complete knowledge-gap cycle — rehearsed end to end — the `adr_gate` hardening whose red case fires on every build, and the Act-1 stage lines. Every error code the system raises is spelled in English (ADR-027). In progress: the promotion capsule, which files a rejected promotion attempt with its failing conjunct named and renders it read-only at `/promotion`. Next on the board: the AI-disclosure notice with its human route, the agent console and the instrument scaffolding.

</details>

## License

Released under the MIT License — see [`LICENSE`](LICENSE).
