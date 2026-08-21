# ADR-023 · The triage verdict gets columns, and the composition of the triage cycle gets its declared bounds

**Status:** accepted · **Decision date:** 2026-08-22

**On the number, in full.** `adr/README.md` records that ADR-001…ADR-017 were taken during the design phase and are being curated into this directory, and that new decisions continue the sequence — so **the sequence is shared with a decision record that is not entirely on disk yet**, and the files present are a subset of the indices already taken. Indices 001 through 022 are spoken for: 001–017 by the design-phase decisions awaiting curation, 018–021 by the accepted files here, and 022 by a repository-process decision recorded outside this directory and not yet copied in.

This ADR therefore takes **023**, the next free index in the shared sequence. Picking 022 would have been the next free index *among the files*, which is a different and wrong question: `ci/check.sh` resolves an ADR reference by globbing `adr/ADR-NNN-*.md` and taking the first match, so two files sharing an index would make the `adr_gate` verify whichever one the glob happened to return first — and it would start doing that on the day the other 022 is copied in, in a build that has nothing to do with either decision.

## Context

Six increments are built and the flow between them does not compose. The state machine publishes `NEW → TRIAGED` and `NEW → TRIAGE_FAILED` and refuses both on the HTTP surface, because their guards belong to a component rather than to a console (`src/server/states.ts`, `test_APP_state_machine_enforced_server_side`). The chokepoint can call a model, price it and chain the row, and states in its own header that it does not validate the agent envelope. The rule is a pure function of a feature vector whose fields nothing produces. The queue's composite priority is computed and stored nowhere.

Four of those gaps are gaps in the schema, and this is the migration that closes them. The rest of this record states the decisions that the code of the same increment leans on and that would otherwise live only as comments — a decision written in one file is a decision the next reader has to reconstruct from the file.

`migrations/` is frozen scope, so this record precedes the merge rather than describing it afterwards. It amends the schema that ADR-018 registered, and with it the committed dump `ci/expected/schema.sql`, which `ci/db_check.sh` compares in **both** directions: an object of the database absent from the record fails the build exactly as an object of the record absent from the database does.

## Decision

### 1 · `ticket.priority numeric(9,6) null check (priority between 0 and 1)`

The stored composite score. The algorithm fixes the score at `PRIORITY_DECIMALS = 6` before it becomes an ordering key, so the column carries six decimal places and the in-process comparator and a sorted column cannot disagree on the last digit of a float.

The score is a convex combination — every term is normalised onto `[0,1]` and the weights are rejected unless they sum to 1 — so its range is `[0,1]` by construction. The **type** does not say so and cannot: `numeric(9,6)` would accept 42. The **check** is what states it, and a range the database enforces is a range a later writer cannot quietly leave.

`numeric(7,6)` was the alternative and is equivalent in practice; the three spare integer digits cost nothing in a variable-precision numeric and leave room for a weighting scheme that is not a distribution to be found by the check rather than by an overflow. The choice is recorded here so the dump and the record agree about which one landed.

### 2 · `ticket.escalation_reason` and `ticket.escalation_clause`

The escalation rule produces two values and both are stored. The **reason** is one index from a closed alphabet of eight and is what a report counts. The **clause** is the stable name of the predicate that fired and is what an auditor re-runs. They are in one-to-one correspondence today, and the rule's type does not promise they always will be — one reason may come to carry more than one clause — so neither is derived from the other.

This closes, by a column, the question the app skeleton left open: an escalated ticket had nowhere to record **why**, and the state alone cannot say. The reason for a decision that sent work to a person is not something the system should have to reconstruct.

`text` with a check constraint, not an enum. The alphabet is closed at eight, a ninth index is a dated decision rather than a builder's choice, and the two shapes differ exactly there: a check constraint is rewritten inside a transaction with its own record, whereas an enum value is added irreversibly and never removed. The check transcribes `ESCALATION_REASONS` literally.

**The invariant is one-directional:**

```sql
check (status <> 'ESCALATED' or (escalation_reason is not null and escalation_clause is not null))
```

A ticket in `ESCALATED` carries both. A ticket that has **left** `ESCALATED` keeps what it carried — an escalation a supervisor then resolved is still an escalation that happened, and a constraint that cleared the record on the way out would destroy the only column-level evidence that a person was ever asked to look. `test_SQL_escalated_requires_reason` measures all three directions.

**A ninth index is reserved and not taken.** `INCONSIST` — a conflict between two sources that both claim to answer — is named here as reserved by this dated decision. It enters only with its own ADR, its own tally and a rewrite of the check above. The alphabet of eight does not change, and the comment on the rule says so rather than saying "no ninth".

### 3 · `ticket.body_sha256` and `ticket_body_sha256_idx`

Lowercase hex of the sha256 of the body exactly as it is persisted, computed in Node by the intake, and the key the collapse of duplicate submissions is decided on.

**Nullable, and not backfilled.** Computing the digest for existing rows in SQL would require `pgcrypto`, which is an extension this schema does not otherwise need, and adding one to backfill four seed rows is a poor trade. The consequence is declared rather than discovered: **a row with a null digest never participates in the collapse, on either side of it** — it is never found as the incumbent and no new submission is ever folded into it.

The index is `(org_id, body_sha256, created_at desc)` because the lookup is always "the most recent row of this organisation carrying this digest", and the ordering is the half of that sentence that an index on the two equality columns alone would leave to a sort.

### 4 · `grant insert on prompt_version to app_rw`

The same shape of gap as ADR-020 and ADR-021, found the same way: by building the first component that needed it. `ledger_entry.prompt_version_id` is `NOT NULL` and references `prompt_version`, so no model call can be recorded until the prompt it ran under is a row; 0001 granted `app_rw` SELECT on that table and nothing else. The role the schema names as the writer of agent calls could read prompts and could not register the one it was about to run under.

INSERT only. Everything else is already refused by mechanism — the immutability trigger rejects any UPDATE other than `promoted_at`, and DELETE and TRUNCATE are revoked — and promotion is a later increment's gate, which needs no grant here.

### 5 · The closed set of decision actions for `audit_event`

`audit_event.action` has carried exactly one alphabet so far: the typed failure codes of the chokepoint, filed when a control fires. A triage cycle also has to file something that is **not** a failure — the verdict that sent a ticket to a person — and writing `TICKET_ESCALATED` into the same column without saying so would silently turn a register of errors into a register of two unrelated things.

So a **second closed set** is declared, disjoint from the first, and it has two members:

| Action | Written when |
|---|---|
| `TICKET_TRIAGED` | a triage cycle produced a verdict and wrote it to the ticket |
| `TICKET_ESCALATED` | a triage cycle escalated a ticket, under a named reason and clause |

`detail` carries the reason, the clause, every clause evaluated with whether it fired, the ruleset hash in force and the instant of evaluation. It never carries any part of the body — the same rule the failure alphabet already lives under, for the same reason: an append-only table is a poor place to discover a customer's words.

The row is written **by the application's own client, inside the transaction that writes the ticket**. The alternative — filing it afterwards through the chokepoint's store, which holds a second pool and a second transaction — leaves a crash between the two showing an escalated ticket with no record of the decision. `app_rw` already holds insert and sequence usage on `audit_event` from ADR-021, and the chaining trigger links whatever writer arrives.

The legitimate alternative, recorded because it was live: defer the audit row to the audit-log surface increment and let the columns be the only record. It is rejected because the columns are overwritable — a ticket reopened and escalated a second time overwrites the first verdict — and an append-only chain is exactly the shape that survives that.

### 6 · The envelope validator is stricter than the published schema, deliberately

`agents/schemas/agent_io.schema.json` publishes the agent output contract with `required: [schema_version, agent, confidence]`. Read literally, an envelope of exactly those three keys is valid, and it also satisfies, word for word, the guard the state machine publishes on `NEW → TRIAGED`: *"triage returned a schema-valid object carrying its confidence"*. A ticket would move to `TRIAGED` with its category, severity and sentiment left empty.

The validator therefore accepts a **strict subset** of what the schema accepts, and the three additional conditions are declared here rather than discovered in a diff:

1. `agent` must be `triage` — an envelope from another agent is not a triage verdict however well-formed it is;
2. the `triage` block must be **present and complete**: category, severity and sentiment, all three;
3. a `draft` or `validate` block must be **absent** — an envelope carrying another agent's work is refused rather than partially consumed.

Hardening never accepts what the schema rejects, so the published contract remains the outer bound and no consumer of the schema is made wrong by this.

The parse is strict in the other sense too: `JSON.parse` over the **whole** response text, with no fence stripping, no prose trimming and no recovery. A validator that repairs its input is a validator that decides what the model meant.

`E_SCHEMA` is the code for every one of those refusals. It belongs to neither of the two existing registers — `GATEWAY_ERROR_CODES` describes what the path to the model refused to do, `APP_ERROR_CODES` describes what an HTTP request did wrong — so a third, agent-layer register is created at `agents/triage/errors.ts` and is closed on the same terms as the other two.

### 7 · `E_REPLAY_CACHE_MISS` joins the chokepoint's register

`GATEWAY_ERROR_CODES` is closed and is lengthened only by a recorded decision. This is that decision.

The chokepoint gains a build flag, `replay`. Under it the cache is mandatory, the provider is **never** invoked, and a lookup that misses is a typed refusal rather than a call. That is what makes true, in the present tense, the sentence the README already carries — *"Replay from the ledger requires no network"* — and it is what lets a demonstration be rehearsed with the network unplugged.

The code is raised by the chokepoint, so it lives in the chokepoint's register and not in the agent-layer one.

### 8 · The machine actor's claims

The triage cycle runs under `{org_id, role: 'agent'}` and **no `sub`**. This is the execution of the decision already signed on the reopening edge — *the customer supplies the event; staff or the system executes the transition* — for a transition whose executor is the system.

The policies on `ticket` read `role` and `org_id` and nothing else on the write path (`ticket_write_is_staff`, `tenant_isolation`, `customer_own_rows`); `auth.uid()` is nullable and is not consulted on an UPDATE. A nil UUID in `sub` would be a false identity — a claim that some user did this — where an absent one is the truth: no person took this edge. The alternatives, a seeded system user or a fourth role, both touch frozen schema and would need their own record.

### 9 · `restarts` is counted from the chain, and no `start` row is written per boot

`ledger_entry.restarts` exists to say how many times the process behind a row had been restarted, and until this increment nothing set it: every row carried 0, perpetually, which is a column that lies rather than a column that is empty.

The instruction this increment was built from asked for a `class = 'start'` row at each boot of the process, with `restarts` counted from those rows. That is **not adopted**, because `migrations/0002_ledger.sql` §5 already publishes what the class means, and it means something else:

> A start is the opening of a promotion attempt, not the launch of a run: the row is written at the moment the attempt reserves budget, before the first generation of that attempt. Its terminal is the `promotion_attempt` row with the same `attempt_id`. The consumption counter reads starts, never terminals: an abort does not refund budget.

A row per boot would therefore put starts with no terminals into a table the promotion gate reads as attempts, and into the figure the consumption counter recomputes. The published contract of a row class governs; amending it is a dated decision of its own, not a side effect of wiring an agent.

**What is adopted instead:** the count is recomputed from the run itself, the way every other figure in this system is recomputed from the chain rather than held in a variable. The first writer into a run records 0; a later process reads the highest value the run already carries and records one more. No new rows, no new class, and the column stops lying.

**The residual, stated:** two processes writing into one run at the same time would both read the same highest value and both record the same restart count. The runner serialises the cycles of a run in-process and one process holds one run, so this cannot arise today; if multi-process writers ever arrive, the counter is one of the things that has to be revisited with them, and it is named here so it is not rediscovered.

If the owner does want a boot row, it is an amendment to the published class contract in 0002 §5 and belongs in its own record.

## Consequences

**Easier.** A queue can be ordered by a stored score rather than by a score recomputed per render. An escalation can be reported on, counted and re-run from columns alone. A double-clicked submission collapses instead of opening a second ticket. The writer of agent calls can register its own prompt, which is the last thing standing between a clean clone and a first real ledger row.

**Harder.** Four columns and a constraint are now part of the schema of record, so `ci/expected/schema.sql` is regenerated with this migration and any future change to them is a numbered migration behind its own record. Any writer that moves a ticket into `ESCALATED` must supply both the reason and the clause — including test fixtures, which is a real cost paid once and the point of the constraint.

**Now mandatory.** A ninth escalation index is a dated decision with its own ADR and its own rewrite of the check. A new decision action for `audit_event` is an amendment of the set in §5. A change to the published agent schema changes its digest and therefore the prompt registration that carries it. Rows written before this migration carry a null `body_sha256` and never take part in the collapse.
