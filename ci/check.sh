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
AGENT_TESTS="tests/agents/test_AGENT_envelopes_share_a_root_contract.mjs tests/agents/test_SEC_identifiers_survive_the_redactor.mjs tests/agents/test_DRAFT_envelope_refuses_ungrounded_citations.mjs tests/agents/test_VALIDATE_envelope_rejects_a_policy_judgement.mjs tests/agents/test_ALG_grounding_is_a_conjunction.mjs tests/agents/test_SEC_admission_channel_refuses_out_of_contract.mjs"
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
#     These stay literal and enumerated rather than becoming a `housekeeping/*` pattern: a pattern
#     would let any branch opt out of naming its card, and what makes an exemption safe is that
#     adding one is a visible decision in a diff.
BRANCH="${GITHUB_HEAD_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')}"
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "HEAD" ] \
   && [ "$BRANCH" != "i1-documentary-baseline" ] && [ "$BRANCH" != "housekeeping/license" ] \
   && [ "$BRANCH" != "housekeeping/error-codes" ] \
   && [ "$BRANCH" != "housekeeping/tanda-a-ratifications" ] \
   && [ "$BRANCH" != "housekeeping/board-sync-plan" ]; then
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
