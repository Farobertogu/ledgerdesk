# Build board

Source of truth for build order: the specification's build plan, as amended — **25 verifiable increments**, order and dependencies only. **Working rule: one branch per card (`card/<ID>-<slug>`); a card merges to `main` only after its named tests are green and the owner has reviewed the PR (merge `--no-ff`).** Tags mark plan gates: `baseline-v1.0` (sealed), `demo-w7`, `freeze-a4`. `main` is protected: merge by PR with the `check` **and `db`** jobs green — the `db` job is where every closing test of a data card actually runs.

## In review

*(empty)*

## In progress

| Card | Increment | Branch | Closing evidence |
|---|---|---|---|
| I7-bis | The complete gap cycle: typed gap record on GROUND escalation → versioned admission with provenance and human approver → re-run → closure by verification | `card/I7-bis-the-gap-cycle` | the ten `test_KB_*` green — seven in `tests/app`, one in `ci/sql`, plus `test_SEC_snapshot_advance_refuses_a_foreign_organisation` and `test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing` — and the two halves of one chain in the ledger with the `kb_admission` row between them by `seq` |

## Backlog (plan order)

| Card | Increment | Depends on | Closing evidence |
|---|---|---|---|
| I8 | Agent console: edit/approve/send + `human_edit` capture | I7 | US-05 + `approved_by` as a DB constraint |
| I9 | Decision Audit Log surface | I2b, I6 | US-07 + `test_LEDGER_hash_chain_*` |
| I10 | Sealed splits + `quality/eval` + stats sidecar + Model Quality — **five-step internal order: `0004` migration → derivator run → pre-registration anchor row → sealing → first scored run; any permutation invalidates the run** | I9, I2, I11a | sealed `splits.json` (four disjoint kinds) + accuracy with clan-aware CI on report |
| I10b | Calibration channel r = 3: rollouts at temperature > 0, per-item agreement; run by the evaluator, never by production | I10, I2b | `agreement_r3` rows in the chain + the r = 3 multiplier counted against the query budget |
| I11a | Blind sheet and rater commitments: de-identification generator · flipped-parameter sentinels at the pre-registered k · blind labelling of the n = 150 · label-vector and temporal-firewall commitment rows — **before I10** | I2, I2b | `test_GEN_blind_sheet_is_clean` and `test_GEN_sentinels_planted_at_preregistered_k` green + two commitment rows in the chain, dated before any scored run |
| I11b | Validity of the labelling: test-retest kappa (30–40 items, shuffled order, washout ≥ 14 days) · OOD accuracy · validity table | I10, I11a, its own calendar window | validity table with kappa, test-retest kappa, flipped-sentinel rate and synthetic vs OOD accuracy |
| I12 | Negative battery: properties B1–B3 (null operator ⇒ FPR ≈ α · no-leak world does not fire · report anti-leak) | I10 | `reports/negative_battery.md` green in CI, with round + date |
| I13 | Promotion gate + evolution agent + Prompt Versions | I12 | US-08: delta with clan-aware CI + lineage |
| I13b | Modification hook `gating = on/shadow`: counting, shadow arm, descriptive with CI | I13, I2b | `modification_event` rows with `gating_arm` and typed verdict + the descriptive with CI in `reports/` |
| I14 | Supervisor dashboard + Ops & Cost | I9, I10 | US-06 + NFRs measured, not asserted |
| I15 | Accessibility (axe-core, 3 flows, WCAG 2.2 criteria named) + usability evaluation → ADR | I8 | accessibility report + usability report |
| I16 | Security hardening: STRIDE table, rate limit, breaker, injection corpus, dependency audit | I4, I8 | STRIDE table with a test per row |
| I17 | Packaging: README ≤5 commands, timed install from clean clone, replay mode without network, `env.lock`, release notes | I8, I14 | recorded clean run |
| I18 | Script, rehearsals, video, freeze tag, story map | I17 | rehearsal video + tag + `story_test_report.md` |

**Critical path:** I0 → I2 → I2b → I3 → I4 → I6 → I7 → I7-bis → I8 → I9 → I10 → I14 → I17 → I18.
**Quality lane (parallel, never conceded):** I9 → I11a → I10 → I10b → I11b → I12 → I13 → I13b, with I14 hanging off I9 and I10.
**Ordering rules:** I2b before I6 · I4 before any agent · I5 before I6 · **I11a before I10**.

**Rehearsal procedure for the closing act, on the board rather than in a note.** It was written on
I7 and outlives it: the card it now governs is I7-bis, and after that I18. A replay can only
reproduce what a real run put there. So: load the dataset (`node seed/demo_load.mjs`), take **one
run with the network** through *both* halves — the question the corpus cannot answer, the admission,
the same question answered — and only then rehearse with `LEDGERDESK_REPLAY=1`. The evidence is one
chain with two `state_hash` values and the admission row between them by `seq`; a second run would
be two chains, and nothing orders two chains relative to each other. **Rehearsing against a chain
that holds only the pre-admission run fails by design**, with `E_REPLAY_CACHE_MISS`, at the point in
the evening where there is no time left to work out why. The commands are in `README.md`.

**Seed last, and seed after the LAST merge.** The networked run is valid only for the tree it ran on.
The cache is keyed on `state_hash`, `state_hash` carries `ruleset_hash`, and `ruleset_hash` moves
with almost any hardening — this card moved it twice, for a normaliser and a retrieval filter, and
`adr/ADR-026` §10 declares the consequence in as many words. So a merge landing after the seeding run
invalidates the seeded chain **silently**: nothing turns red, no test can see it, and the first
symptom is `E_REPLAY_CACHE_MISS` on the central beat of Act 1. I8 and I9 sit between this card and
the demonstration on the critical path, which is exactly the window this rule exists for. Re-seeding
is not free either: it spends a dataset variant, and each beat has two.

**And do not run the checks against the seeded database.** `ci/db_check.sh`, `ci/app_check.sh` and
`ci/gateway_check.sh` each drop and rebuild their database *and the cluster-wide roles*. Running any
of them between the seeding run and the rehearsal destroys the chain the rehearsal replays — and
destroys it the same silent way, because a dropped database produces no failure until something asks
it for a row that used to be there.

## Done

| Card | Increment | Evidence |
|---|---|---|
| I0 | Repo spine: git, CI, ADR template, board, `status/`, minutes template | commit `73abba1` on `main` + CI run green |
| I1 | Documentary baseline: proposal, WBS, Gantt, stories layer 1/2, models | PR #1 merged `--no-ff`; tag `baseline-v1.0` on the merge commit |
| I0b | Process gate: `adr_gate` in CI · `FROZEN_PATHS` · PR template · protection of `main` | PR #2 merged; evidence pair on PR #3: **red** [run 32401784489](https://github.com/Farobertogu/ledgerdesk/actions/runs/32401784489) (frozen path without ADR) → **green** [run 32401951976](https://github.com/Farobertogu/ledgerdesk/actions/runs/32401951976) (same path covered by ADR-018) |
| I2 | Data spine: schema, RLS, migrations, template engine with ground truth — absorbed I2b under ADR-018 | PR #3 merged `--no-ff` after an adversarial review (33 fixes + 32 hardenings, six dated amendments in ADR-018); thirteen database and generator tests green on two platforms: CI [run 32413806720](https://github.com/Farobertogu/ledgerdesk/actions/runs/32413806720) and a local PostgreSQL 16 container |
| I2b | Ledger with chain + append-only tests — delivered inside I2 | same PR: `test_LEDGER_append_only` and `test_LEDGER_class_payload` green (chain monotonicity, one-child-per-head, truncate locks, per-class payload contract: 8 positive + 42 negative cases) |
| I4 | LLM gateway + PII redaction + canary | PR #5 merged `--no-ff` after the adversarial round (five per-rule canaries, in-flight budget reservation, tenant-isolated ledger-as-cache, security events to the audit chain); 30 gateway tests green on [run 32497995412](https://github.com/Farobertogu/ledgerdesk/actions/runs/32497995412) |
| I5 | Pure algorithm + published edge cases + starvation + sensitivity table | PR #6 merged after the adversarial round (recoverability-ordered precedence, anchor-instant dedupe keys, provable starvation inequality, pinned arrival stream); 28 algorithm tests green on [run 32498907223](https://github.com/Farobertogu/ledgerdesk/actions/runs/32498907223) |
| I3 | App skeleton: auth, 3 roles, ticket CRUD, state machine — with signed decisions D1 (`ESCALATED → RESOLVED`, supervisor-only) and D2 (reopening: the customer supplies the event, staff or the system executes the transition) | PR #4 merged `--no-ff` after a two-front adversarial review; `test_US01_ticket_created_and_acknowledged` + the exhaustive state-machine suite ({console: 3, guarded: 16, illegal: 81}) — 12 tests green in the `app` CI job on [run 32491151569](https://github.com/Farobertogu/ledgerdesk/actions/runs/32491151569) |
| I6 | Triage agent: the composition module — envelope validator, feature adapter, policy matcher, component transitions, the triage runner and its integration test | PR #7 merged `--no-ff` after the adversarial round (strict envelope validation, the verdict columns with their one-directional invariant, a synchronous run registry, ledger-first write ordering); US-02 and the first real `agent_call` rows, with `test_INT_triage_ticket_to_chain` green on [run 32509274244](https://github.com/Farobertogu/ledgerdesk/actions/runs/32509274244) |
| I7 | KB + retrieval + draft agent + validator: the versioned snapshot pointer, deterministic retrieval, the two agents and their envelopes, the grounding conjunction, the draft cycle and the read-only evidence panel | PR #8 merged `--no-ff` after the adversarial round (migration 0009 and the `kb_snapshot_head` pointer under ADR-024, a binary-collated total retrieval order, a grounding conjunction the model can only veto, one transaction across both writes, the provider seam under ADR-025); US-03 with `grounded=true`, and all three jobs green on [run 32528161952](https://github.com/Farobertogu/ledgerdesk/actions/runs/32528161952) |
