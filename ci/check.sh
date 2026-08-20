#!/usr/bin/env bash
# Repository checks — run locally and in CI. Steps: structure, branch_name, adr_gate.
set -e
fail() { echo "CI FAIL: $1"; exit 1; }

# --- structure ---
for f in README.md BOARD.md docs/PROVENANCE.md adr/TEMPLATE.md adr/README.md minutes/TEMPLATE.md CODEOWNERS FROZEN_PATHS .github/pull_request_template.md; do
  [ -f "$f" ] || fail "missing $f"
done
ls status/*.md >/dev/null 2>&1 || fail "no weekly status file in status/"
grep -q "## Backlog" BOARD.md || fail "BOARD.md missing Backlog section"
echo "structure OK"

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
