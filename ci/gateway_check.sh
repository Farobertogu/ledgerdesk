#!/usr/bin/env bash
# ci/gateway_check.sh — the checks of the model chokepoint, against a real database.
#
# The four properties this script exists to measure are properties of the whole path — redaction,
# ceiling, cache and the ledger row — and three of the four are only meaningful against the real
# schema. The ceiling is recomputed from the chain rather than from a counter in memory, the cache
# IS the chain read back by input digest, and the row has to satisfy constraints and a trigger that
# no fake can reproduce without becoming a second implementation of them. So a database is applied
# from the migration set, and the tests run against it.
#
# Connection comes from the standard environment (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE),
# with the defaults of the CI service container. The database this script builds is its own and is
# dropped on the way out; ci/db_check.sh and ci/app_check.sh keep using theirs.
set -euo pipefail

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGDATABASE="${PGDATABASE:-postgres}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "GATEWAY CHECK FAIL: $1" >&2; exit 1; }

# Like its two siblings, this script drops a database and CLUSTER-WIDE roles, three of which belong
# to the managed platform. Pointing it at anything but a throwaway cluster has to be deliberate.
case "$PGHOST" in
  localhost|127.0.0.1|postgres) ;;
  *) [ "${LEDGERDESK_ALLOW_DESTRUCTIVE:-}" = "yes" ] \
       || fail "gateway_check.sh drops cluster databases and roles; PGHOST='$PGHOST' is not local. Export LEDGERDESK_ALLOW_DESTRUCTIVE=yes if it really is a disposable cluster." ;;
esac

MAINT_DB="$PGDATABASE"
GW_DB="${LEDGERDESK_GATEWAY_DB:-ledgerdesk_gateway}"
ROLES="app_rw quality_ro quality_gen quality_eval anon authenticated service_role"

# Derived from disk for the same reason the other two derive it: a migration nobody adds to a list
# is a migration that never runs.
MIGRATIONS="$(ls migrations/[0-9][0-9][0-9][0-9]_*.sql | sort)"
[ -n "$MIGRATIONS" ] || fail "no numbered migrations in migrations/"

# Explicit, because the order is part of it. The reconciliation after the run fails the build if a
# test file exists in tests/gateway/ and is not named here.
TESTS="tests/gateway/test_SEC_pii_never_leaves.mjs tests/gateway/test_SEC_cache_is_tenant_isolated.mjs tests/gateway/test_SEC_security_events_are_recorded.mjs tests/gateway/test_GW_budget_cuts_off.mjs tests/gateway/test_GW_cache_hit_skips_call.mjs tests/gateway/test_GW_provider_faults_are_typed.mjs tests/gateway/test_GW_ledger_row_satisfies_contract.mjs"

maint() { psql -X -v ON_ERROR_STOP=1 -q -d "$MAINT_DB" -c "$1" >/dev/null; }
run_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$1" -f "$2"; }

command -v psql >/dev/null 2>&1 || fail "psql is not on PATH"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"
[ -d node_modules/pg ] || fail "dependencies are not installed; run npm ci first"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && b<6)) { console.error("node >= 22.6 required (package.json engines)"); process.exit(1); }' \
  || fail "node runtime below the declared engine"

teardown() {
  maint "drop database if exists $GW_DB" >/dev/null 2>&1 || true
  for r in $ROLES; do maint "drop role if exists $r" >/dev/null 2>&1 || true; done
}
trap teardown EXIT

echo "== applying the migration set and the seed"
maint "drop database if exists $GW_DB"
for r in $ROLES; do
  maint "drop role if exists $r" \
    || fail "the cluster role '$r' could not be dropped: another database in this cluster still holds grants that depend on it. A local development database is the usual reason; drop it and run this again."
done
maint "create database $GW_DB"

run_sql "$GW_DB" ci/sql/00_platform_shim.sql || fail "the platform shim did not apply"
for m in $MIGRATIONS; do
  # Statement by statement, not --single-transaction: 0002 adds a value to an enum and then uses
  # it, which PostgreSQL refuses inside one transaction.
  run_sql "$GW_DB" "$m" || fail "migration $m did not apply on a clean database"
done
run_sql "$GW_DB" seed/orgs.sql || fail "seed/orgs.sql did not apply"

export DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${GW_DB}"

echo "== gateway tests"
# One at a time. The files share one cluster and one seeded tenant, and a suite whose verdict
# depends on the scheduler is a suite that will be green on one machine and red on another.
# shellcheck disable=SC2086
node --experimental-strip-types --test --test-concurrency=1 $TESTS \
  || fail "the gateway tests did not pass"

for f in tests/gateway/test_*.mjs; do
  case " $TESTS " in
    *" $f "*) ;;
    *) fail "$f exists and is not in the TESTS list" ;;
  esac
done

echo "gateway checks OK"
