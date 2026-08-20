# Build board

Source of truth for build order: the specification's build plan, as amended — **25 verifiable increments**, order and dependencies only. **Working rule: one branch per card (`card/<ID>-<slug>`); a card merges to `main` only after its named tests are green and the owner has reviewed the PR (merge `--no-ff`).** Tags mark plan gates: `baseline-v1.0` (sealed), `demo-w7`, `freeze-a4`. `main` is protected: merge by PR with the `check` job green.

## In review

| Card | Increment | Branch | Closing evidence |
|---|---|---|---|
| I0b | Process gate: `adr_gate` step in CI · `FROZEN_PATHS` · PR template · protection of `main` | `card/I0b-process-gate` | a test PR touching a frozen path **without** an ADR comes out **red**, and the same PR **with** its accepted ADR comes out **green**; both runs linked from this card |

## In progress

*(empty)*

## Backlog (plan order)

| Card | Increment | Depends on | Closing evidence |
|---|---|---|---|
| I2 | Data spine: schema, RLS, migrations, template engine with ground truth | I0 | `test_RLS_*` green + `eval_item` populated with labels |
| I2b | Ledger with chain + append-only tests | I2 | `test_LEDGER_*` green — before any agent writes a row |
| I3 | App skeleton: auth, 3 roles, ticket CRUD, state machine | I2 | US-01 green + 3 navigable screens |
| I4 | LLM gateway + PII redaction + canary — before any agent | I2 | `test_SEC_pii_never_leaves`, `test_SEC_no_direct_sdk_import` |
| I5 | Pure algorithm + 14 edge cases + starvation property + sensitivity table | I2 | 14 named tests + `reports/weight_sensitivity.md` |
| I6 | Triage agent | I4, I5, I2b | US-02 + first ledger rows |
| I7 | KB + retrieval + draft agent + validator | I6 | US-03 with `grounded=true` |
| I7-bis | The complete gap cycle: typed gap record on GROUND escalation → versioned admission with provenance and human approver → re-run → closure by verification | I7, I2b | the three `test_KB_*` plus the two new FR-A15 tests green, and the two chained runs in the ledger with the `kb_admission` row between them |
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

## Done

| Card | Increment | Evidence |
|---|---|---|
| I0 | Repo spine: git, CI, ADR template, board, `status/`, minutes template | commit `73abba1` on `main` + CI run green |
| I1 | Documentary baseline: proposal, WBS, Gantt, stories layer 1/2, models | PR #1 merged `--no-ff`; tag `baseline-v1.0` on the merge commit |
