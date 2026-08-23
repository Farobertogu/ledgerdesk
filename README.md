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
holds, and which snapshot each organisation reads under.

## Conventions

- One branch per board card; a card merges to `main` only after its named tests are green and the owner has reviewed the diff (merge `--no-ff`).
- Tags mark plan gates: `baseline-v1.0`, `demo-w7`, freeze tag. History is never rewritten once a card is merged; corrections land as new dated commits.

## Status

Build order: **25 verifiable increments** on `BOARD.md`. I0 and I1 are done; the documentary baseline is sealed with the immutable tag `baseline-v1.0`. The process gate (I0b) is in review; first code card is I2 (data spine).

## License

Released under the MIT License — see [`LICENSE`](LICENSE).
