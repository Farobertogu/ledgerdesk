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
| `src/` | the three consoles: Next.js App Router, TypeScript, Tailwind |
| `agents/` | the model chokepoint, the ledger writer, the agent contracts and their providers |
| `tests/` | the algorithm and agent-contract tests, and the integration tests that speak HTTP to the running consoles |
| `quality/` | the quality layer: schemas, generators, templates and their parameters |
| `status/` | weekly status updates |
| `reports/` | generated evidence (test reports, batteries, sensitivity tables) — created as artifacts land |
| `minutes/` | mentor meeting minutes |
| `BOARD.md` | build board — verifiable increments I0–I18 (+ I2b) |
| `ci/` | repository and database checks (run locally and in CI) |

## Running the consoles

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

## Which model answers

`LEDGERDESK_PROVIDER` selects the far side of the one path to a model:

| Value | What answers | Used for |
|---|---|---|
| `fixture` (default) | a deterministic function of the request, never a network | every check, every battery, CI |
| `real` | the vendor's API, through `agents/providers/anthropic.ts` | a rehearsal and the demonstration |

`real` requires `ANTHROPIC_API_KEY` in the environment and refuses to start without it. The key is
read by the SDK from the environment; it is never passed through this tree, so it cannot reach a
stack frame, a log line, a detail bag or a row. An unrecognised value for `LEDGERDESK_PROVIDER` is
refused at startup rather than treated as the default — a typo that silently produced a
fixture-answering production process is a failure nobody finds until a customer reads an answer no
model wrote. ADR-025 carries the decision, the models and the prices.

## Rehearsing the demonstration without a network

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
`E_REPLAY_CACHE_MISS`, and it fails at the point in the evening where there is no time to work out
why. Run step 2 through both halves before relying on step 3.

The branch that runs entirely on fixtures does not get this for free either: a fixture is
deterministic, so a replay of a fixture run reproduces perfectly — but what it reproduces is a chain
of fixture answers. Whichever provider is chosen, a chain has to exist before it can be replayed.

`node seed/demo_load.mjs --status` reports where each demonstration ticket stands, what the corpus
holds, which snapshot each organisation reads under, and **how much SLA margin is left on the
tightest beat**.

### The clock, and it is not a recommendation

**Load the dataset within twenty minutes of the first beat.** `created_at` is stamped at load time
and the escalation rule reads the clock: the shortest first-response policy a demonstration ticket
can land on is thirty minutes, so a dataset loaded an hour early has already breached, and the beat
written to show a knowledge gap shows an SLA breach instead — correctly, and for a reason that has
nothing to do with what is being demonstrated.

**No test can catch this and none pretends to.** The dataset test freezes the instant to one minute
after creation, which is the right thing for it to do and makes it structurally incapable of seeing
an aged dataset. **The defence is the procedure, and `--status` measures the one thing that decides
whether the procedure was followed: the AGE of the dataset**, alarming past twenty minutes — the same
twenty this section is about. It reports an age rather than a margin for any beat that has not been
triaged, because until triage assigns a policy there is no margin to report: an earlier version
computed one against the tightest policy the tier could land on, which on the premium tier is
fifteen minutes against an alarm floor of fifteen, so the alarm sat at its own threshold from the
moment of a correct load and could never warn. Once a beat is triaged the policy is real and the
column shows the margin against it, with the fifteen-minute floor doing what a floor is for.

### A rehearsal spends a variant

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

## Conventions

- One branch per board card; a card merges to `main` only after its named tests are green and the owner has reviewed the diff (merge `--no-ff`).
- Tags mark plan gates: `baseline-v1.0`, `demo-w7`, freeze tag. History is never rewritten once a card is merged; corrections land as new dated commits.

## Status

Build order: **31 verifiable increments** on `BOARD.md`. Thirteen cards are merged: the repo spine and process gate, the documentary baseline (sealed with the immutable tag `baseline-v1.0`), the data spine with its append-only ledger, the app skeleton, the LLM gateway, the pure algorithm, the triage agent, retrieval and drafting, the complete knowledge-gap cycle — rehearsed end to end — the `adr_gate` hardening whose red case fires on every build, and the Act-1 stage lines. Every error code the system raises is spelled in English (ADR-027). In progress: the promotion capsule, which files a rejected promotion attempt with its failing conjunct named and renders it read-only at `/promotion`. Next on the board: the AI-disclosure notice with its human route, the agent console and the instrument scaffolding.

## License

Released under the MIT License — see [`LICENSE`](LICENSE).
