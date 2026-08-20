#!/usr/bin/env bash
# Repository structure check — run locally or in CI.
set -e
fail() { echo "CI FAIL: $1"; exit 1; }
for f in README.md BOARD.md docs/PROVENANCE.md adr/TEMPLATE.md adr/README.md minutes/TEMPLATE.md CODEOWNERS; do
  [ -f "$f" ] || fail "missing $f"
done
ls status/*.md >/dev/null 2>&1 || fail "no weekly status file in status/"
grep -q "## Backlog" BOARD.md || fail "BOARD.md missing Backlog section"
echo "repo structure OK"
