# ADR-025 · A real model provider enters, the SDK exemption becomes a directory, and the directory is made unreachable except from the wiring

**Status:** accepted · **Decision date:** 2026-08-22

**On the number.** The shared sequence is described in ADR-023 and ADR-024; 024 is taken by the retrieval and drafting decisions that land in the same branch, and this takes **025**.

## Context

Every model call this system has made has been answered by a fixture. That was the right default and remains the default: the fixture is deterministic, it needs no network, and every check in the repository depends on both of those properties. What it is not is evidence that the pipeline works against a real provider, and the drafting agent is the first component where the difference is interesting — a triage verdict is four fields a fixture can fabricate convincingly, whereas a grounded reply to a real enquiry, built from real sources and checked against them, is the thing the whole system claims to produce.

The seam was built for this. `agents/gateway.ts` takes a provider as configuration and the provider contract is one function from a typed request to a typed response; the composition root chooses which one. **No re-wiring is required to bring a real provider in.** What stood in the way was a check.

`ci/seam_check.mjs` permits a provider SDK to be imported in exactly one file, `agents/gateway.ts`. That rule was written before the gateway existed, deliberately, so that the first violation would be caught rather than grandfathered — and it worked exactly as intended: the first thing that genuinely needs it is a real adapter, which is not the gateway and must not become one. The gateway's shape is *redact, attest, price, call, record*; a vendor client belongs behind that, not inside it.

Widening a security check is a decision with a record, not an edit somebody makes to get a build green. This is that record.

## Decision

### 1 · The exemption becomes a directory, and a second rule replaces what the narrowing gave

A provider SDK may be imported from `agents/gateway.ts` **and** from anything under `agents/providers/**`.

On its own that is a loosening. It is paired with an assertion that makes the result stricter than the single file was:

> **`agents/providers/**` may be imported only from the composition root, `src/server/agents.ts`.**

So the gateway remains the only **caller** of a provider — it receives one as configuration — and no handler, page, runner or algorithm can reach past it to pick one up. *One file may import the SDK* becomes *the SDK lives in a directory nothing can reach except the wiring*, which is a narrower guarantee stated as two rules instead of one.

Both are checked statically, on every pull request, in the job that needs no database and no install. `test_SEC_no_direct_sdk_import` keeps its name and gains a directory; `test_SEC_providers_only_from_composition_root` is new.

**Two scopes are excluded and the exclusions are declared rather than left quiet.**

`tests/` is outside the second rule. A test imports a fixture provider directly in order to assert what it answers, which is the whole point of a fixture and is not a runtime path: nothing under `tests/` is built, served or deployed. The rule covers `src/` and `agents/`, which is everything that runs.

Siblings inside `agents/providers/` may compose freely. What the rule forbids is a caller from **outside** the directory reaching past the wiring; a router that dispatches between two fixtures is the directory doing its own job.

### 2 · Selection by environment, and a refusal rather than a fallback

`LEDGERDESK_PROVIDER` ∈ { `fixture`, `real` }, defaulting to `fixture`.

An unrecognised value is **refused at startup**, not treated as the default. A typo in a deployment variable that silently produced a fixture-answering production process is the kind of failure nobody finds until a customer reads an answer no model wrote.

`real` requires `ANTHROPIC_API_KEY` in the environment and refuses to start without it, with a typed message naming what is missing. The key is read by the SDK from the environment and is never passed through this tree, so it cannot reach a stack frame, a log line, a detail bag or a row.

**CI and all five batteries run on the fixture, always.** They are determinism and zero network, and a suite whose verdict depends on a remote service is not a suite. The real provider is for a rehearsal and for the demonstration.

### 3 · The models, and the constraint that chose them

ADR-004's shape is followed: the cheap model does the two narrow, high-volume jobs — a classification and a yes/no check — and the strong one writes the reply a person will read.

| Agent | Model | Input (USD/1M) | Output (USD/1M) |
|---|---|---|---|
| triage | `claude-haiku-4-5` | 1.00 | 5.00 |
| validate | `claude-haiku-4-5` | 1.00 | 5.00 |
| draft | `claude-opus-4-6` | 5.00 | 25.00 |

*Source: the vendor's published list prices as of the decision date. They are configuration and they move; what must not move silently is the arithmetic, which is why they are declared in one place and converted in one place.*

**Why this pairing and not the newest generation, which is the interesting part.** On the current generation the sampling parameters were removed from the request and are rejected outright — a request carrying `temperature` returns a 400. This system sends `temperature: 0` on every call and that is not a preference: it is the condition that makes the same seed a fixed point, which is what makes a re-run after a crash a cache hit rather than a second opinion, and it is recorded in the reproducibility block of every ledger row.

An adapter that quietly dropped the parameters to make the call succeed would produce rows whose `sampling` column names a temperature that never governed anything — a lie in the one column set that exists so a result can be re-obtained. So the adapter **enumerates** the models it serves, every one of them accepts the parameters the row records, and a request for anything else is refused before it leaves. That is a smaller catalogue than the API offers, and the constraint driving it is this system's own.

**Prices are held in Australian dollars at a fixed rate of 1.55 AUD per USD**, declared as a constant. A ceiling that moved with an exchange rate would cut at a different number every morning, and the consumption figure recomputed from the chain would be a sum of amounts converted at whatever rate applied when each row was written. The price of a fixed rate is that the figure approximates a real invoice, which is what a demonstration budget is anyway.

A model with no entry in `pricing` dies on its first call with `E_MODEL_PRICE_UNKNOWN`, **which is the design** and not a gap: a call that cannot be charged honestly is a call that is not made.

### 4 · Two things the API does not have, declared rather than discovered

**There is no seed.** `ProviderRequest.seed` travels into the cache key and into the ledger row, where it means *this is the nth time we asked this question*. The far side never sees it. That is correct behaviour for the retry loop — the point of moving the seed is to move the cache key — and it is **not** a claim that the provider was asked to sample differently. Nothing downstream reads it as one; it is written down so nobody starts.

**A refusal is an outcome, not an exception on the wire.** A policy decline arrives as HTTP 200 with no usable content. The adapter raises it so the cycle treats it as a failed attempt, rather than parsing an empty answer into a schema violation and blaming the contract. An answer cut off at `max_tokens` is raised for the same reason: it cannot be a valid envelope and no seed will change that.

### 5 · The rehearsal procedure, in the card and not in a note

The demonstration's closing act needs two runs chained in one ledger: a question asked against a corpus that cannot answer it, material admitted, the same question asked again and answered. Rehearsing it without a network means replaying that chain, and **a replay can only reproduce what a real run put there**.

So the procedure is:

1. **One run WITH network** (`LEDGERDESK_PROVIDER=real`), which seeds the chain: the pre-admission cycle, the admission, the post-admission cycle — two `state_hash` values in one run, with the admission row between them by `seq`.
2. **The rehearsal without network** (`LEDGERDESK_REPLAY=1`), which reproduces against that chain.

**Rehearsing against a chain that holds only the pre-admission run fails by design**, with `E_REPLAY_CACHE_MISS`, and that sentence belongs in the card rather than in a footnote — it is the failure a rehearsal the night before would hit, at the point where there is no time to work out why.

**And the branch that runs entirely on fixtures does not get this for free either.** A fixture is deterministic, so a replay of a fixture run reproduces perfectly — but the chain it replays is a chain of fixture answers, and a rehearsal that shows those is a rehearsal of the fixture. Whichever branch is chosen, a chain has to exist before it can be replayed.

## Consequences

**Easier.** The drafting agent can be pointed at a real model without touching the gateway, the runners, the algorithm or the schema — the composition root reads an environment variable and hands over a different function. The identity of what answered travels into `toolchain.model_sdk` on every row, read from the installed package rather than from a string somebody has to remember to edit.

**Harder.** `@anthropic-ai/sdk` is now a declared dependency, so a clean clone installs it whether or not it will be used. The adapter's model catalogue is a list that has to be maintained against a moving API, and the thing that makes it a list rather than a pass-through — the sampling constraint — has to be re-checked whenever a model is added.

**Now mandatory.** A file that imports a provider SDK belongs in `agents/providers/`, and a file that imports from `agents/providers/` is `src/server/agents.ts` or it is a test. Widening either rule again is another record. A model added to the adapter must accept the sampling parameters the ledger row records, or the row it produces is not a reproducibility block.
