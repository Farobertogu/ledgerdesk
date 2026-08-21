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

# --- schema: the sealed-manifest schema is a frozen path; this is its executable cover.
command -v node >/dev/null 2>&1 || fail "node is not on PATH (test_SPLITS_schema_accepts_and_rejects needs it)"
node ci/schema_check.mjs || fail "test_SPLITS_schema_accepts_and_rejects"

# --- seam: the module boundary of ADR-007 and the LLM chokepoint of ADR-008, checked rather than
#     trusted. Static: no database, no install, no build, so it runs in this job and not the others.
node ci/seam_check.mjs || fail "test_ARCH_seam_holds"

# --- algorithm: the priority and the escalation rule are pure functions of a feature vector, so
#     their tests need no database, no model and no install — they belong in this job. The list is
#     explicit because the order is part of it; the reconciliation after the run fails the build if
#     a test file exists in tests/alg/ and is not named here.
ALG_TESTS="tests/alg/test_ALG_edge_cases.mjs tests/alg/test_ALG_escalation_clauses.mjs tests/alg/test_ALG_no_starvation_property.mjs tests/alg/test_ALG_db_order_matches_heap_order.mjs"
# shellcheck disable=SC2086
node --experimental-strip-types --test $ALG_TESTS || fail "the algorithm tests did not pass"

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

echo "algorithm OK (14 published edge cases, the escalation clauses, and reports/weight_sensitivity.md regenerated and diffed)"

# --- branch_name: every branch except main must match card/<ID>-<slug>, ID from BOARD.md.
#     Single named exemption: i1-documentary-baseline (merged before this rule existed).
BRANCH="${GITHUB_HEAD_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')}"
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "HEAD" ] && [ "$BRANCH" != "i1-documentary-baseline" ]; then
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
#     Runs only in PR context (GITHUB_BASE_REF set); locally it is skipped.
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  git fetch -q origin "$GITHUB_BASE_REF" --depth=1 2>/dev/null || git fetch -q origin "$GITHUB_BASE_REF" || true
  # Endpoint diff: works on shallow clones (no merge-base needed). An empty diff in PR context is an error, never a pass.
  CHANGED="$(git diff --name-only "origin/${GITHUB_BASE_REF}" HEAD 2>/dev/null || true)"
  [ -n "$CHANGED" ] || fail "adr_gate: could not compute the PR diff against ${GITHUB_BASE_REF} (fail-closed)"
  FROZEN_HIT=""
  while IFS= read -r p; do
    case "$p" in ''|\#*) continue;; esac
    if printf '%s\n' "$CHANGED" | grep -q "^$p"; then FROZEN_HIT="$p"; break; fi
  done < FROZEN_PATHS
  if [ -n "$FROZEN_HIT" ]; then
    OK=""
    for f in $(printf '%s\n' "$CHANGED" | grep -E '^adr/ADR-[0-9]{3}-.*\.md$' || true); do
      if [ -f "$f" ] && grep -q '^\*\*Status:\*\* accepted' "$f" && grep -Eq '\*\*Decision date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}' "$f"; then OK=yes; fi
    done
    if [ -z "$OK" ] && [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ] && command -v jq >/dev/null 2>&1; then
      NNN="$(jq -r '.pull_request.body // ""' "$GITHUB_EVENT_PATH" | grep -oE 'ADR: [0-9]{3}' | head -1 | grep -oE '[0-9]{3}' || true)"
      if [ -n "$NNN" ]; then
        f="$(ls adr/ADR-${NNN}-*.md 2>/dev/null | head -1 || true)"
        if [ -n "$f" ] && grep -q '^\*\*Status:\*\* accepted' "$f" && grep -Eq '\*\*Decision date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}' "$f"; then OK=yes; fi
      fi
    fi
    [ -n "$OK" ] || fail "adr_gate: PR touches frozen path '$FROZEN_HIT' without an accepted ADR (add adr/ADR-NNN-<slug>.md with Status accepted, or an 'ADR: NNN' line in the PR body)"
    echo "adr_gate OK (frozen path '$FROZEN_HIT' covered by ADR)"
  else
    echo "adr_gate OK (no frozen path touched)"
  fi
else
  echo "adr_gate skipped (not a PR context)"
fi

echo "repo checks OK"
