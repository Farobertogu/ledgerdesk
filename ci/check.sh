#!/usr/bin/env bash
# Repository checks — run locally and in CI. Steps: structure, schema, branch_name, adr_gate.
set -euo pipefail
fail() { echo "CI FAIL: $1"; exit 1; }

# --- structure ---
for f in README.md BOARD.md docs/PROVENANCE.md adr/TEMPLATE.md adr/README.md minutes/TEMPLATE.md CODEOWNERS FROZEN_PATHS .github/pull_request_template.md ci/check.sh ci/db_check.sh migrations/README.md; do
  [ -f "$f" ] || fail "missing $f"
done
ls status/*.md >/dev/null 2>&1 || fail "no weekly status file in status/"
ls ci/sql/test_*.sql >/dev/null 2>&1 || fail "no SQL tests in ci/sql/"
grep -q "## Backlog" BOARD.md || fail "BOARD.md missing Backlog section"
echo "structure OK"

# --- schema: the published schemas are frozen paths; this is their executable cover. Two of them
#     now: the sealed manifest, and the typed gap channel that the boundary's fourth row names.
command -v node >/dev/null 2>&1 || fail "node is not on PATH (the schema cases need it)"
node ci/schema_check.mjs || fail "test_SPLITS_schema_accepts_and_rejects / test_GAP_channel_schema_accepts_and_rejects"

# --- seam: the module boundary of ADR-007 and the LLM chokepoint of ADR-008, checked rather than
#     trusted. Static: no database, no install, no build, so it runs in this job and not the others.
node ci/seam_check.mjs || fail "test_ARCH_seam_holds"

# --- algorithm: the priority and the escalation rule are pure functions of a feature vector, so
#     their tests need no database, no model and no install — they belong in this job. The list is
#     explicit so that the reconciliation after the run fails the build if a test file exists in
#     tests/alg/ and is not named here. The ORDER of the list buys nothing: `node --test` sorts the
#     files it is given, whatever order they arrive in — measured, not assumed. Nothing in these
#     three suites depends on an order, which is why the correction is a comment and not a change.
#
#     The tests import TypeScript directly and are stripped by the runtime, so the engine floor of
#     package.json is a requirement here and not a preference. Checked, so that an older runtime
#     reports itself instead of failing as an unreadable syntax error inside a module.
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && b<6)) { console.error("node >= 22.6 required (package.json engines)"); process.exit(1); }' \
  || fail "node runtime below the declared engine"

ALG_TESTS="tests/alg/test_ALG_edge_cases.mjs tests/alg/test_ALG_escalation_clauses.mjs tests/alg/test_ALG_no_starvation_property.mjs tests/alg/test_ALG_db_order_matches_heap_order.mjs tests/alg/test_ALG_replay_is_reproducible.mjs tests/alg/test_ALG_policy_matcher_is_deterministic.mjs tests/alg/test_ALG_features_quantised_to_storage.mjs tests/alg/test_ALG_features_sentinels.mjs tests/alg/test_ALG_features_null_when_the_step_has_not_run.mjs"
# shellcheck disable=SC2086
node --experimental-strip-types --test $ALG_TESTS || fail "the algorithm tests did not pass"

# The simulation harness and the report generator are not production paths. They hold a heap that
# only exists to measure things, and they reach for node:crypto to seed it — neither belongs inside
# a request. The rule is cheap to state and impossible to remember, so it is checked: nothing the
# application renders or serves may import either of them.
if grep -REl "from ['\"].*alg/(simulation|sensitivity)(\.ts)?['\"]|@/alg/(simulation|sensitivity)" src/app src/components src/server 2>/dev/null | grep -q .; then
  grep -REn "alg/(simulation|sensitivity)" src/app src/components src/server 2>/dev/null || true
  fail "test_ARCH_harness_is_not_a_production_path: the application imports the simulation harness"
fi

for f in tests/alg/test_*.mjs; do
  case " $ALG_TESTS " in
    *" $f "*) ;;
    *) fail "$f exists and is not in the ALG_TESTS list" ;;
  esac
done

# The sensitivity report is generated, so it is regenerated here and compared instead of believed.
# A hand-edit and a stale file fail identically, which is the point: nothing in reports/ is written
# by a person.
node --experimental-strip-types src/alg/sensitivity.ts --check --out reports/weight_sensitivity.md \
  || fail "reports/weight_sensitivity.md is stale or was edited by hand (regenerate with: node --experimental-strip-types src/alg/sensitivity.ts)"

echo "test_ARCH_harness_is_not_a_production_path OK"
echo "algorithm OK (14 published edge cases, the escalation clauses, and reports/weight_sensitivity.md regenerated and diffed)"

# --- agent contract: the envelope validator, and the demonstration dataset it judges.
#
#     These need no database, no model and no server: the validator is a pure function of text, and
#     the dataset is a file. They run here so that a change to either fails in the fastest job
#     rather than in the one that builds a database first.
TRIAGE_TESTS="tests/triage/test_TRIAGE_envelope_rejects_missing_block.mjs tests/triage/test_TRIAGE_envelope_rejects_foreign_blocks.mjs tests/triage/test_TRIAGE_envelope_never_lenient.mjs tests/triage/test_TRIAGE_run_registry_claims_without_awaiting.mjs tests/triage/test_TRIAGE_demo_dataset_is_authored_for_its_beats.mjs tests/triage/test_SEC_prompt_injection_escalates.mjs"
# shellcheck disable=SC2086
node --experimental-strip-types --test $TRIAGE_TESTS || fail "the agent contract tests did not pass"

for f in tests/triage/test_*.mjs; do
  case " $TRIAGE_TESTS " in
    *" $f "*) ;;
    *) fail "$f exists and is not in the TRIAGE_TESTS list" ;;
  esac
done

# --- the drafting cycle's contracts: two more strict envelopes, and the conjunction that decides
#     whether an answer may be shown to anybody. All pure functions of text, so they belong in the
#     fastest job: no database, no model, no server.
#     The nine promotion files join them for the same reason and pay a second one: the writer of a
#     promotion attempt is dependency-free above the seam and its view model imports nothing outside
#     src/alg/, so both load under a bare `node --experimental-strip-types`. Their halves that DO need
#     a database — the writer against a live schema, and the rendered page — run in the app job, and
#     the SQL invariant runs in the db job. Three jobs, and the split is declared rather than
#     discovered: this job installs nothing and builds no database, which is exactly what makes it
#     the right home for a contract.
AGENT_TESTS="tests/agents/test_AGENT_envelopes_share_a_root_contract.mjs tests/agents/test_SEC_identifiers_survive_the_redactor.mjs tests/agents/test_DRAFT_envelope_refuses_ungrounded_citations.mjs tests/agents/test_VALIDATE_envelope_rejects_a_policy_judgement.mjs tests/agents/test_ALG_grounding_is_a_conjunction.mjs tests/agents/test_SEC_admission_channel_refuses_out_of_contract.mjs tests/agents/test_PROMO_writer_refuses_out_of_alphabet.mjs tests/agents/test_PROMO_row_is_internally_coherent.mjs tests/agents/test_PROMO_capsule_is_the_signed_combination.mjs tests/agents/test_PROMO_attempt_id_is_derived_and_org_qualified.mjs tests/agents/test_PROMO_state_and_toolchain_are_transcribed_not_invented.mjs tests/agents/test_PROMO_reconciliation_is_set_equality.mjs tests/agents/test_PROMO_panel_states_only_what_it_can_name.mjs tests/agents/test_PROMO_panel_makes_no_prohibited_claim.mjs tests/agents/test_PROMO_pending_milestones_are_real_and_dated.mjs"
# shellcheck disable=SC2086
node --experimental-strip-types --test $AGENT_TESTS || fail "the drafting contract tests did not pass"

for f in tests/agents/test_*.mjs; do
  case " $AGENT_TESTS " in
    *" $f "*) ;;
    *) fail "$f exists and is not in the AGENT_TESTS list" ;;
  esac
done

# The published agent schema is generated from `agents/triage/schema.ts` and committed, exactly as
# reports/weight_sensitivity.md is. It matters more than a report does: `prompt_version.schema_hash`
# is the digest of THAT FILE, so a hand-edit would make every prompt registration name a contract
# the process does not hold. A stale file and an edited one fail identically.
node --experimental-strip-types -e '
  import("./agents/triage/schema.ts").then(async (schema) => {
    const { readFileSync } = await import("node:fs");
    let onDisk;
    try {
      onDisk = readFileSync(schema.AGENT_IO_SCHEMA_PATH, "utf8");
    } catch {
      console.error(schema.AGENT_IO_SCHEMA_PATH + " is missing");
      process.exit(1);
    }
    if (onDisk !== schema.AGENT_IO_SCHEMA_TEXT) {
      console.error(schema.AGENT_IO_SCHEMA_PATH + " differs from agents/triage/schema.ts; regenerate it instead of editing it");
      process.exit(1);
    }
    console.log("test_TRIAGE_published_schema_is_current OK (sha256 " + schema.AGENT_IO_SCHEMA_SHA256.slice(0, 12) + ")");
  }).catch((error) => { console.error(error); process.exit(1); });
' || fail "test_TRIAGE_published_schema_is_current"

# The typed gap channel is published the same way and for the same reason: the document is authored
# in `src/alg/gap_channel.ts` and the file in `quality/schemas/` is its serialisation, so a receiver
# never has to open a file to learn its own contract — a server bundle does not carry the
# repository's directory layout. A hand-edit and a stale file fail identically here.
node --experimental-strip-types -e '
  import("./src/alg/gap_channel.ts").then(async (channel) => {
    const { readFileSync } = await import("node:fs");
    let onDisk;
    try {
      onDisk = readFileSync(channel.GAP_CHANNEL_SCHEMA_PATH, "utf8");
    } catch {
      console.error(channel.GAP_CHANNEL_SCHEMA_PATH + " is missing");
      process.exit(1);
    }
    if (onDisk !== channel.GAP_CHANNEL_SCHEMA_TEXT) {
      console.error(channel.GAP_CHANNEL_SCHEMA_PATH + " differs from src/alg/gap_channel.ts; regenerate it instead of editing it");
      process.exit(1);
    }
    if (channel.GAP_CHANNEL_TOTAL_BYTES > channel.GAP_CHANNEL_RECORD_MAX_BYTES) {
      console.error("the per-field caps sum to " + channel.GAP_CHANNEL_TOTAL_BYTES + " bytes, above the declared " + channel.GAP_CHANNEL_RECORD_MAX_BYTES);
      process.exit(1);
    }
    console.log("test_GAP_channel_published_schema_is_current OK (" + channel.GAP_CHANNEL_TOTAL_BYTES + " of " + channel.GAP_CHANNEL_RECORD_MAX_BYTES + " bytes declared, " + channel.GAP_CHANNEL_OPEN_CONTENT_MAX_BYTES + " of them open content)");
  }).catch((error) => { console.error(error); process.exit(1); });
' || fail "test_GAP_channel_published_schema_is_current"

echo "agent contract OK (three strict envelope validators agreeing on one root contract, the grounding conjunction, the injection corpus, the two published schemas diffed, and the demonstration dataset checked against the complete rule of eight clauses)"

# --- the promotion surface: four static rules, each printing its own name.
#
#     test_ARCH_no_route_writes_a_promotion_attempt
#
#     `ledger_writer_insert` reads ONLY `org_id` — no `role`, no `sub`, and there is no analogue of
#     `ticket_write_is_staff` for the ledger. So an HTTP route that filed a promotion attempt would
#     let ANY app_rw session whose organisation claim matched write one: a customer's cookie would be
#     enough. The row is filed by an operator mandate against the rehearsal database, once, by hand.
#     `src/server/` is included as well as `src/app/`: a route reaches the writer just as easily
#     through a server module as directly.
#
#     The pattern matches a quoted module SPECIFIER after from/import/require, not a mention: the
#     composition root explains in prose why `derivedUuid` moved and names the writer while doing it,
#     and a rule that fired on prose would be a rule people delete.
PROMO_IMPORT='(from|import|require)[[:space:]]*\(?[[:space:]]*["'"'"'][^"'"'"']*ledger/promotion_row'
if grep -REn "$PROMO_IMPORT" src/app src/server 2>/dev/null | grep -q .; then
  grep -REn "$PROMO_IMPORT" src/app src/server 2>/dev/null || true
  fail "test_ARCH_no_route_writes_a_promotion_attempt: the application imports the promotion writer"
fi
echo "test_ARCH_no_route_writes_a_promotion_attempt OK (the writer is reached only by seed/promotion_capsule.mjs)"

#     test_ARCH_promotion_panel_is_read_only
#
#     A control that opened, retried or promoted anything would invite an examiner to ask for it to
#     be pressed, and what would answer is not built — worse, the presenter says out loud in the same
#     ten minutes that the evolution loop running live is one of three declared omissions.
#     One narrow exemption, literal and reasoned: `error.tsx` must carry `use client` because the
#     framework only accepts an error boundary as a client component. A boundary is not a control —
#     it renders a refusal, it does not offer an action — and this panel's boundary deliberately has
#     no reset button, which is the one control that would matter here. The MARKUP patterns below
#     still fire inside `error.tsx`, so a button smuggled into it fails this check exactly as it
#     would anywhere else in the segment.
if [ -d src/app/promotion ]; then
  if grep -REn --exclude=error.tsx "use client" src/app/promotion 2>/dev/null | grep -q .; then
    grep -REn --exclude=error.tsx "use client" src/app/promotion 2>/dev/null || true
    fail "test_ARCH_promotion_panel_is_read_only: a component outside the error boundary is interactive"
  fi
  if grep -REn "<form|action=|method=|onClick" src/app/promotion 2>/dev/null | grep -q .; then
    grep -REn "<form|action=|method=|onClick" src/app/promotion 2>/dev/null || true
    fail "test_ARCH_promotion_panel_is_read_only: the promotion screen carries a control"
  fi
  [ -f src/app/promotion/error.tsx ] \
    || fail "test_ARCH_promotion_panel_is_read_only: the refusal to render has no named screen (src/app/promotion/error.tsx)"
  echo "test_ARCH_promotion_panel_is_read_only OK (no controls; the refusal has its own screen)"
else
  fail "test_ARCH_promotion_panel_is_read_only: src/app/promotion/ does not exist"
fi

#     test_ARCH_promotion_panel_reads_as_the_tenant
#
#     `ledger_quality_select` is `using (true)` and sees the chain of every organisation in the
#     cluster. A screen that reached for `quality_ro` would put every tenant's rows in front of an
#     examiner, live, in the beat whose whole argument is discipline.
#
#     `src/server/db.ts` is exempt BY NAME and this is the reason, written beside the exemption in the
#     same style the branch_name exemptions are: it is the one legitimate `new Pool` in `src/`, it is
#     the module every console statement goes through, and a literal grep with no exemption would fail
#     the build against the tree's own composition root. Named exemptions are safe because adding one
#     is a visible decision in a diff.
#
#     Like the rule above, it matches USE and not mention: the reader's header names `quality_ro` in
#     order to refuse it, in backticks, and a rule that fired on the sentence explaining a refusal
#     would be a rule that punishes the documentation of a decision. What it looks for is the role
#     being switched to, quoted as a value, or put in a connection string — and any second pool.
PROMO_ROLE_USE='(role[[:space:]]+quality_ro|["'"'"']quality_ro["'"'"']|user=quality_ro|new[[:space:]]+Pool)'
PROMO_OFFENDERS="$(grep -REln "$PROMO_ROLE_USE" src/app src/server 2>/dev/null | grep -v '^src/server/db\.ts$' || true)"
if [ -n "$PROMO_OFFENDERS" ]; then
  echo "$PROMO_OFFENDERS"
  fail "test_ARCH_promotion_panel_reads_as_the_tenant: a module names quality_ro or opens a pool of its own"
fi
echo "test_ARCH_promotion_panel_reads_as_the_tenant OK (one pool, in src/server/db.ts, and quality_ro nowhere in src/)"

#     test_PROMO_panel_type_scale_is_projectable
#
#     The chain table's scale is built for somebody half a metre from a laptop. On a projector,
#     `precondition_underpowered` at eleven monospaced pixels stops being evidence and becomes a
#     smudge the presenter has to read aloud — which is a rescue. The three strings the outcome, the
#     failing conjunct and the four verdicts are rendered with are named constants, and this is what
#     inspects them.
node -e '
  const { readFileSync } = require("node:fs");
  const page = "src/app/promotion/page.tsx";
  const source = readFileSync(page, "utf8");
  const forbidden = ["text-[11px]", "text-xs"];
  const scales = ["OUTCOME_SCALE", "FAILING_CONJUNCT_SCALE", "VERDICT_SCALE"];
  for (const name of scales) {
    const found = source.match(new RegExp("const " + name + " = \x27([^\x27]*)\x27"));
    if (!found) { console.error(page + " does not declare " + name + " as a string constant"); process.exit(1); }
    for (const scale of forbidden) {
      if (found[1].includes(scale)) {
        console.error(name + " renders at " + scale + ", which is not readable in projection");
        process.exit(1);
      }
    }
  }
  console.log("test_PROMO_panel_type_scale_is_projectable OK (" + scales.join(", ") + " declared and inspected)");
' || fail "test_PROMO_panel_type_scale_is_projectable"

#     test_PROMO_published_payload_schema_is_current_or_declared_absent
#
#     The trigger's own comment points a reader at quality/schemas/ledger_class/<class>.schema.json,
#     and that comment travels into the committed dump. Neither file is written by this card:
#     quality/schemas/ is a frozen path and paying it costs an accepted, dated ADR in the same pull
#     request plus a row-validation test in the db job. What IS built is the contract as data and its
#     serialiser, so the day somebody pays it the check is already here — and until then the deferral
#     has to be written in the writer's own header, where a reader of that file will find it. A
#     hand-edited file and a stale one fail identically.
node --experimental-strip-types -e '
  import("./agents/ledger/promotion_row.ts").then(async (writer) => {
    const { readFileSync } = await import("node:fs");
    const contracts = [writer.PROMOTION_ATTEMPT_PAYLOAD_CONTRACT, writer.START_PAYLOAD_CONTRACT];
    // The deferral has to be declared in the writer HEADER, so the header is what is searched.
    // Reading the whole file made this a tautology: PAYLOAD_SCHEMA_DEFERRAL is defined further down
    // in that same file, so the literal was present however the header was edited, and the check
    // passed with the declaration deleted. Sliced at the first close of a block comment.
    const source = readFileSync("agents/ledger/promotion_row.ts", "utf8");
    const header = source.slice(0, source.indexOf("*/") + 2);
    let written = 0;
    for (const contract of contracts) {
      const at = writer.schemaPathFor(contract);
      let onDisk = null;
      try { onDisk = readFileSync(at, "utf8"); } catch { onDisk = null; }
      if (onDisk === null) continue;
      written += 1;
      if (onDisk !== writer.contractAsJsonSchemaText(contract)) {
        console.error(at + " differs from the contract in agents/ledger/promotion_row.ts; regenerate it instead of editing it");
        process.exit(1);
      }
    }
    if (written === 0 && !header.includes(writer.PAYLOAD_SCHEMA_DEFERRAL)) {
      console.error("neither class schema is written and agents/ledger/promotion_row.ts no longer declares the deferral");
      process.exit(1);
    }
    console.log("test_PROMO_published_payload_schema_is_current_or_declared_absent OK (" +
      (written === 0 ? "deferred, and the deferral is declared in the writer" : written + " schema file(s) diffed") +
      ", contract " + writer.promotionRulesetHash().slice(0, 12) + ")");
  }).catch((error) => { console.error(error); process.exit(1); });
' || fail "test_PROMO_published_payload_schema_is_current_or_declared_absent"

#     One module owns the reconciliation, and the Decision Audit Log card CONSUMES it rather than
#     writing a second one. Two implementations of "starts == terminals" is two answers to a
#     conservation law, and the one on screen would be whichever module the page happened to import.
RECONCILERS="$(grep -REln "export function reconcileAttempts" src agents quality 2>/dev/null | wc -l | tr -d ' ')"
[ "$RECONCILERS" = "1" ] \
  || { grep -REln "export function reconcileAttempts" src agents quality 2>/dev/null || true; \
       fail "test_PROMO_one_reconciler: reconcileAttempts is declared in $RECONCILERS modules, and it owes exactly one"; }
echo "test_PROMO_one_reconciler OK (set equality by attempt is declared once, in src/alg/promotion_panel.ts)"

echo "promotion surface OK (no route writes an attempt, the panel is read-only and reads as the tenant, and the payload contract is either published and diffed or deferred in writing)"

# --- branch_name: every branch except main must match card/<ID>-<slug>, ID from BOARD.md.
#     Named exemptions, literal and enumerated:
#       i1-documentary-baseline   — merged before this rule existed.
#       housekeeping/license      — repository housekeeping, not a board card, so it has no card ID.
#       housekeeping/error-codes  — the same: a rename of every error code to English changes how the
#                                   system reads and nothing about what it does, so no board card
#                                   describes it and none should be invented to give it an ID.
#       housekeeping/tanda-a-ratifications
#                                 — decision records only. A ratification writes down what was
#                                   already true and changes no behaviour, so it belongs to no card.
#       housekeeping/board-sync-plan
#                                 — the board and README brought up to date with the plan of record:
#                                   done cards moved, five cells re-transcribed, six new cards listed.
#                                   Synchronisation of what is projected, not work on any one card.
#       housekeeping/weekly-status-w35
#                                 — the weekly status of the formal channel: overdue gates recorded
#                                   with dates, the evidence gap declared, the expected cost of the
#                                   networked run stated in advance. A record, not work on a card.
#     These stay literal and enumerated rather than becoming a `housekeeping/*` pattern: a pattern
#     would let any branch opt out of naming its card, and what makes an exemption safe is that
#     adding one is a visible decision in a diff.
BRANCH="${GITHUB_HEAD_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')}"
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "HEAD" ] \
   && [ "$BRANCH" != "i1-documentary-baseline" ] && [ "$BRANCH" != "housekeeping/license" ] \
   && [ "$BRANCH" != "housekeeping/error-codes" ] \
   && [ "$BRANCH" != "housekeeping/tanda-a-ratifications" ] \
   && [ "$BRANCH" != "housekeeping/board-sync-plan" ] \
   && [ "$BRANCH" != "housekeeping/weekly-status-w35" ]; then
  echo "$BRANCH" | grep -Eq '^card/[A-Za-z0-9][A-Za-z0-9-]*$' || fail "branch '$BRANCH' does not match card/<ID>-<slug>"
  REST="${BRANCH#card/}"
  C1="${REST%%-*}"
  C2="$(printf '%s' "$REST" | cut -d- -f1-2)"
  if grep -Eq "^\| \*?\*?${C2}\*?\*? \|" BOARD.md; then ID="$C2"
  elif grep -Eq "^\| \*?\*?${C1}\*?\*? \|" BOARD.md; then ID="$C1"
  else fail "no card ID matching '$C1' or '$C2' found in BOARD.md for branch '$BRANCH'"
  fi
  echo "branch_name OK (card $ID)"
fi

# --- adr_gate: a PR that touches frozen scope must add or reference an accepted ADR.
#     The evaluation is a FUNCTION, so the exact code path that guards PRs is the one the
#     self-test below proves able to turn red. Every line read from a file is stripped of a
#     trailing CR first: on a Windows checkout FROZEN_PATHS can arrive with CRLF endings, and
#     an unstripped pattern like "migrations/<CR>" matches no changed path — the gate then
#     said "no frozen path touched" on a PR that touched one. A gate that cannot fire on the
#     machine where the work is written protects nothing. (Card I22.)
adr_gate_eval() {
  # $1 = file listing the changed paths, one per line · $2 = the frozen-paths file
  # $3 = base dir the ADR paths resolve against · $4 = ADR number from the PR body, or empty
  ag_changed="$(tr -d '\r' < "$1")"
  [ -n "$ag_changed" ] || { echo "adr_gate: empty change list (fail-closed)"; return 1; }
  ag_hit=""
  while IFS= read -r p || [ -n "$p" ]; do
    p="${p%$'\r'}"
    case "$p" in ''|\#*) continue;; esac
    if printf '%s\n' "$ag_changed" | grep -q "^$p"; then ag_hit="$p"; break; fi
  done < "$2"
  if [ -z "$ag_hit" ]; then echo "adr_gate OK (no frozen path touched)"; return 0; fi
  ag_ok=""
  for f in $(printf '%s\n' "$ag_changed" | grep -E '^adr/ADR-[0-9]{3}-.*\.md$' || true); do
    if [ -f "$3/$f" ] && grep -q '^\*\*Status:\*\* accepted' "$3/$f" \
       && grep -Eq '\*\*Decision date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}' "$3/$f"; then ag_ok=yes; fi
  done
  if [ -z "$ag_ok" ] && [ -n "$4" ]; then
    f="$(ls "$3"/adr/ADR-"$4"-*.md 2>/dev/null | head -1 || true)"
    if [ -n "$f" ] && grep -q '^\*\*Status:\*\* accepted' "$f" \
       && grep -Eq '\*\*Decision date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}' "$f"; then ag_ok=yes; fi
  fi
  if [ -z "$ag_ok" ]; then
    echo "adr_gate: PR touches frozen path '$ag_hit' without an accepted ADR (add adr/ADR-NNN-<slug>.md with Status accepted, or an 'ADR: NNN' line in the PR body)"
    return 1
  fi
  echo "adr_gate OK (frozen path '$ag_hit' covered by ADR)"
  return 0
}

# --- adr_gate self-test: prove the gate can turn RED before trusting any of its greens.
#     The fixtures are written with CRLF endings ON PURPOSE — the exact corruption a Windows
#     checkout produces, and the one that used to make the gate pass silently. Three cases:
#     a frozen hit with no ADR must go red; the same hit with an accepted ADR must pass; an
#     untouched frozen set must pass. This step runs EVERYWHERE — locally on Windows and in
#     the CI job — so the red case is reproduced on both by every single build.
AG_TMP="$(mktemp -d)"
printf 'migrations/\r\nquality/schemas/\r\n'                          > "$AG_TMP/frozen"
printf 'migrations/0099_selftest.sql\r\nREADME.md\r\n'                > "$AG_TMP/changed_hit"
printf 'README.md\r\n'                                                > "$AG_TMP/changed_miss"
printf 'migrations/0099_selftest.sql\nadr/ADR-099-selftest.md\n'      > "$AG_TMP/changed_covered"
mkdir -p "$AG_TMP/adr"
printf '**Status:** accepted\n**Decision date:** 2026-01-01\n'        > "$AG_TMP/adr/ADR-099-selftest.md"
if adr_gate_eval "$AG_TMP/changed_hit" "$AG_TMP/frozen" "$AG_TMP" "" >/dev/null; then
  rm -rf "$AG_TMP"
  fail "adr_gate selftest: a frozen hit with no ADR did NOT turn red — the gate cannot fire"
fi
adr_gate_eval "$AG_TMP/changed_covered" "$AG_TMP/frozen" "$AG_TMP" "" >/dev/null \
  || { rm -rf "$AG_TMP"; fail "adr_gate selftest: a covered frozen hit was refused"; }
adr_gate_eval "$AG_TMP/changed_miss" "$AG_TMP/frozen" "$AG_TMP" "" >/dev/null \
  || { rm -rf "$AG_TMP"; fail "adr_gate selftest: an untouched frozen set was refused"; }
rm -rf "$AG_TMP"
echo "adr_gate selftest OK (the red case fires on a missing ADR; CRLF-proof on both sides)"

#     The live gate runs only in PR context (GITHUB_BASE_REF set); the self-test above always ran.
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  git fetch -q origin "$GITHUB_BASE_REF" --depth=1 2>/dev/null || git fetch -q origin "$GITHUB_BASE_REF" || true
  # Endpoint diff: works on shallow clones (no merge-base needed). An empty diff in PR context is an error, never a pass.
  AG_CHANGED_FILE="$(mktemp)"
  git diff --name-only "origin/${GITHUB_BASE_REF}" HEAD 2>/dev/null > "$AG_CHANGED_FILE" || true
  [ -s "$AG_CHANGED_FILE" ] || { rm -f "$AG_CHANGED_FILE"; fail "adr_gate: could not compute the PR diff against ${GITHUB_BASE_REF} (fail-closed)"; }
  NNN=""
  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ] && command -v jq >/dev/null 2>&1; then
    NNN="$(jq -r '.pull_request.body // ""' "$GITHUB_EVENT_PATH" | grep -oE 'ADR: [0-9]{3}' | head -1 | grep -oE '[0-9]{3}' || true)"
  fi
  adr_gate_eval "$AG_CHANGED_FILE" FROZEN_PATHS "." "$NNN" || { rm -f "$AG_CHANGED_FILE"; fail "adr_gate red — see the line above"; }
  rm -f "$AG_CHANGED_FILE"
else
  echo "adr_gate skipped (not a PR context; the selftest above still ran)"
fi

echo "repo checks OK"
