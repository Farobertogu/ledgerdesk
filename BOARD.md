# Build board

Source of truth for build order: the specification's build plan (§17) — verifiable increments, order and dependencies only. **Working rule: one branch per card; a card merges to `main` only after its named tests are green and the owner has reviewed the diff (merge `--no-ff`).** Tags mark plan gates: `baseline-v1.0`, `demo-w7`, freeze tag.

## In progress

| Card | Increment | Depends on | Closing evidence |
|---|---|---|---|
| I0 | Repo spine: git, CI, ADR template, board, `status/`, minutes template | — | dated commit history + green CI |

## Backlog (plan order)

| Card | Increment | Depends on | Closing evidence |
|---|---|---|---|
| I1 | Documentary baseline: proposal, WBS, Gantt, stories layer 1/2, models | — (parallel to I0) | `docs/PROPOSAL.md` + tag `baseline-v1.0` |
| I2 | Data spine: schema, RLS, migrations, template engine with ground truth | I0 | `test_RLS_*` green + `eval_item` populated with labels |
| I2b | Ledger with chain + append-only tests | I2 | `test_LEDGER_*` green — before any agent writes a row |
| I3 | App skeleton: auth, 3 roles, ticket CRUD, state machine | I2 | US-01 green + 3 navigable screens |
| I4 | LLM gateway + PII redaction + canary — before any agent | I2 | `test_SEC_pii_never_leaves`, `test_SEC_no_direct_sdk_import` |
| I5 | Pure algorithm + 14 edge cases + starvation property + sensitivity table | I2 | 14 named tests + `reports/weight_sensitivity.md` |
| I6 | Triage agent | I4, I5, I2b | US-02 + first ledger rows |
| I7 | KB + retrieval + draft agent + validator | I6 | US-03 with `grounded=true` |
| I8 | Agent console: edit/approve/send + `human_edit` capture | I7 | US-05 + `approved_by` as a DB constraint |
| I9 | Decision Audit Log surface | I2b, I6 | US-07 + `test_LEDGER_hash_chain_*` |
| I10 | Sealed splits + `quality/eval` + stats sidecar + Model Quality | I9, I2 | sealed `splits.json` + accuracy with CI on report |
| I11 | Blind human sample + kappa + OOD probe | I10 | validity table: kappa, synthetic vs OOD accuracy |
| I12 | Negative battery | I10 | `reports/negative_battery.md` green in CI, with round + date |
| I13 | Promotion gate + evolution agent + Prompt Versions | I12 | US-08: delta with CI + lineage |
| I14 | Supervisor dashboard + Ops & Cost | I9, I10 | US-06 + NFRs measured, not asserted |
| I15 | Accessibility (axe-core, 3 flows, WCAG 2.2) + usability evaluation → ADR | I8 | accessibility report + usability report |
| I16 | Security hardening: STRIDE table, rate limit, breaker, injection corpus, dependency audit | I4, I8 | STRIDE table with a test per row |
| I17 | Packaging: README ≤5 commands, timed install from clean clone, replay mode without network, `env.lock`, release notes | I14 | recorded clean run |
| I18 | Script, rehearsals, video, freeze tag, story map | I17 | rehearsal video + tag + `story_test_report.md` |

**Critical path:** I0 → I2 → I2b → I3 → I4 → I6 → I7 → I8 → I17 → I18. **Quality lane (parallel, never conceded):** I9 → I10 → I11 → I12 → I13. **Ordering rules:** I2b before I6 · I4 before any agent · I5 before I6.

*Note: a dated amendment to the build plan is in preparation (schema ADR; split of I11 into I11a/I11b; internal sub-order of I10). Cards will be updated when it is accepted; until then this board mirrors the plan as published.*

## Done

*(empty)*
