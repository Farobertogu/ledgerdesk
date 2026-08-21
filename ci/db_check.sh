#!/usr/bin/env bash
# ci/db_check.sh — apply the migration set to a clean database and run the named SQL tests.
#
# Connection comes from the standard environment (PGHOST, PGPORT, PGUSER, PGPASSWORD,
# PGDATABASE) with the defaults of the CI service container. Two databases are used: the first
# is applied, digested and dropped, the second is applied from scratch, and the two digests must
# agree — that is what turns forward-only from a discipline into a measured fact. The applied
# schema is then diffed against the committed one, in both directions, and the tests run against
# the second database.
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

fail() { echo "DB CHECK FAIL: $1" >&2; exit 1; }

# This script drops databases and CLUSTER-WIDE roles, three of which are the managed platform's
# own. Running it against anything but a throwaway cluster has to be deliberate.
case "$PGHOST" in
  localhost|127.0.0.1|postgres) ;;
  *) [ "${LEDGERDESK_ALLOW_DESTRUCTIVE:-}" = "yes" ] \
       || fail "db_check.sh drops cluster databases and roles; PGHOST='$PGHOST' is not local. Export LEDGERDESK_ALLOW_DESTRUCTIVE=yes if it really is a disposable cluster." ;;
esac

MAINT_DB="$PGDATABASE"
DB_A="ledgerdesk_check_a"
DB_B="ledgerdesk_check_b"
# The four roles the migration set creates are cluster-wide, not per-database: a second clean
# application needs them gone first. The three platform roles come from the shim.
ROLES="app_rw quality_ro quality_gen quality_eval anon authenticated service_role"

# Derived from disk, never a hand-kept list: a migration nobody adds to an array is a migration
# that never runs, in a repository whose whole discipline is one numbered file per change.
MIGRATIONS="$(ls migrations/[0-9][0-9][0-9][0-9]_*.sql | sort)"
[ -n "$MIGRATIONS" ] || fail "no numbered migrations in migrations/"

# The test list stays explicit because the order is part of it; the reconciliation at the end
# fails the build if a test file exists and is not named here.
TESTS="test_MIGRATIONS_schema_matches_spec test_ARCH_quality_role_is_readonly test_RLS_ticket_org_isolation test_RLS_customer_cannot_read_other_customer test_SEED_one_account_per_org test_LEDGER_append_only test_LEDGER_class_payload test_SQL_escalated_requires_reason test_GEN_corpus_loads_into_eval_item_with_labels"

# -X: a developer's ~/.psqlrc is read after -v and could reopen ON_ERROR_STOP. It is the one
# place where the user's environment could change the verdict.
maint() { psql -X -v ON_ERROR_STOP=1 -q -d "$MAINT_DB" -c "$1" >/dev/null; }
run_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$1" -f "$2"; }

command -v psql    >/dev/null 2>&1 || fail "psql is not on PATH"
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is not on PATH"
command -v node    >/dev/null 2>&1 || fail "node is not on PATH (the corpus generator needs it)"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && b<6)) { console.error("node >= 22.6 required (package.json engines)"); process.exit(1); }' \
  || fail "node runtime below the declared engine"

if node --experimental-strip-types -e '' >/dev/null 2>&1; then
  NODE_TS="node --experimental-strip-types"
else
  NODE_TS="node"
  echo "   note: --experimental-strip-types unavailable; using bare node (type stripping is on by default from 23.6)"
fi

reset_cluster() {
  maint "drop database if exists $DB_A"
  maint "drop database if exists $DB_B"
  for r in $ROLES; do maint "drop role if exists $r"; done
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; reset_cluster >/dev/null 2>&1 || true' EXIT

apply_all() {
  db="$1"
  run_sql "$db" ci/sql/00_platform_shim.sql || fail "the platform shim did not apply to $db"
  for m in $MIGRATIONS; do
    # psql without --single-transaction applies statement by statement, which 0002 needs: it adds
    # a value to an enum and then uses it, and PostgreSQL refuses that inside one transaction.
    run_sql "$db" "$m" || fail "migration $m did not apply on a clean database"
  done
}

# Three kinds of dump noise are filtered, everything else is compared verbatim: comments;
# the \restrict/\unrestrict guard lines whose token pg_dump randomises per dump; and the
# top-level session preamble (SET .../set_config), which describes the dumping client, not the
# schema - pg_dump 17 emits SET transaction_timeout where 16 does not.
schema_dump() { pg_dump --schema-only --no-owner -d "$1" | grep -v '^--' | grep -v '^$' | grep -Ev '^\\(un)?restrict ' | grep -Ev '^SET |^SELECT pg_catalog\.set_config'; }

echo "== applying the migration set to a clean database"
reset_cluster
maint "create database $DB_A"
apply_all "$DB_A"
schema_dump "$DB_A" > "$WORK/schema_a.sql"
DIGEST_A="$(sha256sum "$WORK/schema_a.sql" | cut -d' ' -f1)"
echo "   first application OK (digest ${DIGEST_A:0:12})"

reset_cluster
maint "create database $DB_B"
apply_all "$DB_B"
schema_dump "$DB_B" > "$WORK/schema_b.sql"
DIGEST_B="$(sha256sum "$WORK/schema_b.sql" | cut -d' ' -f1)"
echo "   second application OK (digest ${DIGEST_B:0:12})"

if [ "$DIGEST_A" != "$DIGEST_B" ]; then
  diff -u "$WORK/schema_a.sql" "$WORK/schema_b.sql" || true
  fail "test_MIGRATIONS_forward_only_is_deterministic: two clean applications produced different schema digests"
fi
echo "test_MIGRATIONS_forward_only_is_deterministic OK"

# The both-directions comparison against the published schema. The committed dump is the record:
# an object of the record absent from the database fails the build, and so does an object of the
# database absent from the record. The exception list is empty by construction — the diff is literal.
if [ "${LEDGERDESK_WRITE_EXPECTED:-}" = "yes" ]; then
  mkdir -p ci/expected
  cp "$WORK/schema_b.sql" ci/expected/schema.sql
  echo "   ci/expected/schema.sql regenerated from this run (review the diff before committing it)"
elif [ ! -f ci/expected/schema.sql ]; then
  fail "test_MIGRATIONS_schema_matches_spec: ci/expected/schema.sql is missing. Generate it from a clean application with LEDGERDESK_WRITE_EXPECTED=yes bash ci/db_check.sh, using the same pg_dump version CI uses, and commit it."
else
  diff -u ci/expected/schema.sql "$WORK/schema_b.sql" \
    || fail "test_MIGRATIONS_schema_matches_spec: the applied schema differs from the committed one (diff in both directions above)"
  echo "test_MIGRATIONS_schema_matches_spec OK (schema diff against ci/expected/schema.sql)"
fi

echo "== seeding two organisations"
run_sql "$DB_B" seed/orgs.sql || fail "seed/orgs.sql did not apply"

echo "== generating the corpus"
CORPUS_DIR="$WORK/corpus"
CORPUS_DIR_TWIN="$WORK/corpus_twin"
CORPUS_DIR_THIRD="$WORK/corpus_third"
BUILT_AT="2026-08-21T00:00:00.000Z"
GEN_ARGS="--seed 20260821 --templates quality/templates --params quality/params/corpus.ci.json --built-at $BUILT_AT"

# The exit codes are the contract: each one names the test it belongs to instead of collapsing
# into "the generator exited non-zero".
# shellcheck disable=SC2086
if $NODE_TS quality/gen/corpus.ts $GEN_ARGS --out "$CORPUS_DIR"; then :; else
  rc=$?
  case $rc in
    1) fail "test_GEN_corpus_deterministic_from_triple: parameters or reproducibility" ;;
    2) fail "test_GEN_corpus_manifest_reconciles_with_bodies: the manifest does not reconcile" ;;
    3) fail "test_GEN_corpus_headroom_four_disjoint_sets: margin or disjointness" ;;
    *) fail "the corpus generator exited with $rc" ;;
  esac
fi

# shellcheck disable=SC2086
$NODE_TS quality/gen/corpus.ts $GEN_ARGS --out "$CORPUS_DIR_TWIN" >/dev/null \
  || fail "test_GEN_corpus_deterministic_from_triple: the second run of the same triple failed"

cmp -s "$CORPUS_DIR/corpus.json"   "$CORPUS_DIR_TWIN/corpus.json" \
  || fail "test_GEN_corpus_deterministic_from_triple: two runs of the same triple emitted different corpora"
cmp -s "$CORPUS_DIR/manifest.json" "$CORPUS_DIR_TWIN/manifest.json" \
  || fail "test_GEN_corpus_deterministic_from_triple: two runs of the same triple emitted different manifests"

# A third run varies exactly what must NOT matter: the build timestamp and the spelling of the
# templates path. The corpus and the partition have to be identical; only the signature moves,
# because the timestamp is inside its scope.
$NODE_TS quality/gen/corpus.ts --seed 20260821 --templates ./quality/templates \
  --params quality/params/corpus.ci.json --built-at 2027-01-01T00:00:00.000Z \
  --out "$CORPUS_DIR_THIRD" >/dev/null \
  || fail "test_GEN_corpus_deterministic_from_triple: the third run failed"

cmp -s "$CORPUS_DIR/corpus.json" "$CORPUS_DIR_THIRD/corpus.json" \
  || fail "test_GEN_corpus_deterministic_from_triple: the corpus depends on built_at or on how --templates was spelled"

node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const same = (k) => JSON.stringify(a[k]) === JSON.stringify(b[k]);
for (const k of ["kinds", "input_sha256", "canonical_order", "seed", "run_id"]) {
  if (!same(k)) throw new Error(k + " differs between two runs of the same triple");
}
if (a.corpus.corpus_sha256 !== b.corpus.corpus_sha256) throw new Error("corpus_sha256 differs");
if (a.manifest_sha256 === b.manifest_sha256) {
  throw new Error("manifest_sha256 is identical although built_at changed: the timestamp is inside the signature");
}
' "$CORPUS_DIR/manifest.json" "$CORPUS_DIR_THIRD/manifest.json" \
  || fail "test_GEN_corpus_deterministic_from_triple: the partition or the signature does not behave as declared"
echo "test_GEN_corpus_deterministic_from_triple OK"

# Independent verification of the emitted artefacts: it never calls the generator, so it cannot
# pass by asking the producer whether it did its job.
node -e '
const fs = require("fs"), { createHash } = require("crypto");
const h = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const m = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const by = new Map(c.map((i) => [i.item_id, i]));
if (by.size !== c.length) throw new Error("duplicate item_id in corpus");
for (const i of c) if (h(i.body) !== i.body_sha256) throw new Error("body hash " + i.item_id);
if (m.corpus.n_items !== c.length) throw new Error("n_items does not match the corpus");
const K = ["selection", "report", "ood", "blind_label"];
const seen = new Set();
for (const k of K) {
  const e = m.kinds[k];
  if (!Array.isArray(e.item_ids) || e.item_ids.length !== e.n) throw new Error(k + ": |item_ids| != n");
  if (new Set(e.item_ids).size !== e.n) throw new Error(k + ": duplicate item_ids");
  for (const id of e.item_ids) {
    if (!by.has(id)) throw new Error(k + ": " + id + " not in corpus");
    if (seen.has(id)) throw new Error("not disjoint: " + id);
    seen.add(id);
  }
}
if (m.headroom.margin < 1 || m.headroom.margin < m.headroom.min_margin_items) throw new Error("headroom margin");
' "$CORPUS_DIR/corpus.json" "$CORPUS_DIR/manifest.json" \
  || fail "test_GEN_corpus_manifest_reconciles_with_bodies / test_GEN_corpus_headroom_four_disjoint_sets"
echo "test_GEN_corpus_manifest_reconciles_with_bodies OK"
echo "test_GEN_corpus_headroom_four_disjoint_sets OK"

# A contract of four exit codes of which only one is ever exercised is a contract on paper.
expect_exit() {
  want="$1"; shift
  set +e
  "$@" >/dev/null 2>&1
  got=$?
  set -e
  [ "$got" = "$want" ] || fail "test_GEN_corpus_exit_codes_are_reachable: expected exit $want, got $got"
}
# shellcheck disable=SC2086
expect_exit 3 $NODE_TS quality/gen/corpus.ts --seed 1 --templates quality/templates \
  --params quality/params/corpus.ci.oversized.json --out "$WORK/exit3a"
# shellcheck disable=SC2086
expect_exit 3 $NODE_TS quality/gen/corpus.ts --seed 1 --templates quality/templates \
  --params quality/params/corpus.ci.thin.json --out "$WORK/exit3b"
# shellcheck disable=SC2086
expect_exit 1 $NODE_TS quality/gen/corpus.ts --seed 1 --templates quality/templates \
  --out "$WORK/exit1"
echo "test_GEN_corpus_exit_codes_are_reachable OK"

# The corpus and manifest reach SQL as a generated prelude with dollar-quoted contents, run in
# the same psql session as the test that reads them. A shell backtick in a \\set would go through
# cmd.exe on Windows and never expand the variable - this way there is no shell in the path at all.
PRELUDE="$WORK/corpus_prelude.sql"
if grep -q 'LDJ' "$CORPUS_DIR/corpus.json" "$CORPUS_DIR/manifest.json"; then
  fail "the LDJ dollar-quote tag collides with generated content"
fi
{
  printf 'create temp table ledgerdesk_corpus_src as select $LDJ$'
  cat "$CORPUS_DIR/corpus.json"
  printf '$LDJ$::jsonb as doc;\n'
  printf 'create temp table ledgerdesk_manifest_src as select $LDJ$'
  cat "$CORPUS_DIR/manifest.json"
  printf '$LDJ$::jsonb as m;\n'
  # The test switches to the generator role mid-session; the temp tables are owned by the
  # superuser that created them and die with the session, so a blanket grant is safe.
  printf 'grant select on ledgerdesk_corpus_src, ledgerdesk_manifest_src to public;\n'
} > "$PRELUDE"

echo "== database tests"
for t in $TESTS; do
  case "$t" in
    test_GEN_corpus_loads_into_eval_item_with_labels)
      psql -X -v ON_ERROR_STOP=1 -q -d "$DB_B" -f "$PRELUDE" -f "ci/sql/$t.sql" || fail "$t" ;;
    *)
      run_sql "$DB_B" "ci/sql/$t.sql" || fail "$t" ;;
  esac
  echo "$t OK"
done

for f in ci/sql/test_*.sql; do
  b="$(basename "$f" .sql)"
  case " $TESTS " in
    *" $b "*) ;;
    *) fail "ci/sql/$b.sql exists and is not in the TESTS list" ;;
  esac
done

echo "db checks OK"
