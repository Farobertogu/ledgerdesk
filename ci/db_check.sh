#!/usr/bin/env bash
# ci/db_check.sh — apply the migration set to a clean database and run the named SQL tests.
#
# Connection comes from the standard environment (PGHOST, PGPORT, PGUSER, PGPASSWORD,
# PGDATABASE) with the defaults of the CI service container. Two databases are used: the first
# is applied, digested and dropped, the second is applied from scratch, and the two digests must
# agree — that is what turns forward-only from a discipline into a measured fact. The tests then
# run against the second one.
#
# Every failure names the test that failed. A silent skip is never a pass.
set -euo pipefail

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGDATABASE="${PGDATABASE:-postgres}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MAINT_DB="$PGDATABASE"
DB_A="ledgerdesk_check_a"
DB_B="ledgerdesk_check_b"
# The four roles the migration set creates are cluster-wide, not per-database: a second clean
# application needs them gone first. The three platform roles come from the shim.
ROLES="app_rw quality_ro quality_gen quality_eval anon authenticated service_role"

MIGRATIONS="migrations/0001_core.sql migrations/0002_ledger.sql migrations/0003_kb_admission.sql migrations/0004_eval_outcome.sql"
TESTS="test_MIGRATIONS_schema_matches_spec test_ARCH_quality_role_is_readonly test_RLS_ticket_org_isolation test_LEDGER_append_only test_LEDGER_class_payload test_GEN_corpus_loads_into_eval_item_with_labels"

fail() { echo "DB CHECK FAIL: $1" >&2; exit 1; }
maint() { psql -v ON_ERROR_STOP=1 -q -d "$MAINT_DB" -c "$1" >/dev/null; }
run_sql() { psql -v ON_ERROR_STOP=1 -q -d "$1" -f "$2"; }

command -v psql    >/dev/null 2>&1 || fail "psql is not on PATH"
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is not on PATH"
command -v node    >/dev/null 2>&1 || fail "node is not on PATH (the corpus generator needs it)"

if node --experimental-strip-types -e '' >/dev/null 2>&1; then
  NODE_TS="node --experimental-strip-types"
else
  NODE_TS="node"
fi

reset_cluster() {
  maint "drop database if exists $DB_A"
  maint "drop database if exists $DB_B"
  for r in $ROLES; do maint "drop role if exists $r"; done
}

apply_all() {
  db="$1"
  run_sql "$db" ci/sql/00_platform_shim.sql || fail "the platform shim did not apply to $db"
  for m in $MIGRATIONS; do
    # Applied statement by statement and not wrapped in one transaction: 0002 adds a value to an
    # enum and then uses it, which PostgreSQL refuses inside the transaction that added it.
    run_sql "$db" "$m" || fail "migration $m did not apply on a clean database"
  done
}

schema_dump() {
  pg_dump --schema-only --no-owner -d "$1" | grep -v '^--' | grep -v '^$'
}
schema_digest() {
  schema_dump "$1" | sha256sum | cut -d' ' -f1
}

echo "== applying the migration set to a clean database"
reset_cluster
maint "create database $DB_A"
apply_all "$DB_A"
DIGEST_A="$(schema_digest "$DB_A")"
schema_dump "$DB_A" > /tmp/schema_a.sql
echo "   first application OK (digest ${DIGEST_A:0:12})"

reset_cluster
maint "create database $DB_B"
apply_all "$DB_B"
DIGEST_B="$(schema_digest "$DB_B")"
schema_dump "$DB_B" > /tmp/schema_b.sql
echo "   second application OK (digest ${DIGEST_B:0:12})"

if [ "$DIGEST_A" != "$DIGEST_B" ]; then
  echo "== schema diff between the two applications (first 80 lines):"
  diff /tmp/schema_a.sql /tmp/schema_b.sql | head -80 || true
  fail "test_MIGRATIONS_forward_only_is_deterministic: two clean applications produced different schema digests ($DIGEST_A vs $DIGEST_B)"
fi
echo "test_MIGRATIONS_forward_only_is_deterministic OK"

echo "== seeding two organisations"
run_sql "$DB_B" seed/orgs.sql || fail "seed/orgs.sql did not apply"

echo "== generating the corpus"
CORPUS_DIR="$(mktemp -d)"
CORPUS_DIR_TWIN="$(mktemp -d)"
BUILT_AT="2026-08-21T00:00:00.000Z"
GEN_ARGS="--seed 20260821 --templates quality/templates --params quality/params/corpus.ci.json --built-at $BUILT_AT"

# shellcheck disable=SC2086
$NODE_TS quality/gen/corpus.ts $GEN_ARGS --out "$CORPUS_DIR" \
  || fail "the corpus generator exited non-zero (1 parameters or reproducibility, 2 manifest reconciliation, 3 headroom)"
# shellcheck disable=SC2086
$NODE_TS quality/gen/corpus.ts $GEN_ARGS --out "$CORPUS_DIR_TWIN" >/dev/null \
  || fail "the corpus generator exited non-zero on its second run"

cmp -s "$CORPUS_DIR/corpus.json"   "$CORPUS_DIR_TWIN/corpus.json" \
  || fail "test_GEN_corpus_deterministic_from_triple: two runs of the same triple emitted different corpora"
cmp -s "$CORPUS_DIR/manifest.json" "$CORPUS_DIR_TWIN/manifest.json" \
  || fail "test_GEN_corpus_deterministic_from_triple: two runs of the same triple emitted different manifests"
echo "test_GEN_corpus_deterministic_from_triple OK"
echo "test_GEN_corpus_manifest_reconciles_with_bodies OK (generator exit 0)"
echo "test_GEN_corpus_headroom_four_disjoint_sets OK (generator exit 0)"

export LEDGERDESK_CORPUS_JSON="$CORPUS_DIR/corpus.json"

echo "== database tests"
for t in $TESTS; do
  run_sql "$DB_B" "ci/sql/$t.sql" || fail "$t"
  echo "$t OK"
done

echo "db checks OK"
