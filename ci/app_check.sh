#!/usr/bin/env bash
# ci/app_check.sh — the application checks: a clean database, the consoles built and running, and
# the tests of the card exercised against both at once.
#
# The tests in tests/app/ are integration tests in the literal sense: they speak HTTP to a server
# that speaks SQL to a database with the real schema and the real policies applied. Nothing is
# stubbed, because the two properties the card owes — a ticket acknowledged with its tracking
# number in NEW, and a state machine enforced on the server — are both properties of that whole
# path and of no piece of it alone.
#
# Connection comes from the standard environment (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE),
# with the defaults of the CI service container. The database this script builds is its own and is
# dropped on the way out; ci/db_check.sh keeps using its own.
set -euo pipefail

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGDATABASE="${PGDATABASE:-postgres}"

PORT="${LEDGERDESK_PORT:-3123}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "APP CHECK FAIL: $1" >&2; exit 1; }

# Like db_check.sh, this script drops a database and CLUSTER-WIDE roles, three of which belong to
# the managed platform. Pointing it at anything but a throwaway cluster has to be deliberate.
case "$PGHOST" in
  localhost|127.0.0.1|postgres) ;;
  *) [ "${LEDGERDESK_ALLOW_DESTRUCTIVE:-}" = "yes" ] \
       || fail "app_check.sh drops cluster databases and roles; PGHOST='$PGHOST' is not local. Export LEDGERDESK_ALLOW_DESTRUCTIVE=yes if it really is a disposable cluster." ;;
esac

MAINT_DB="$PGDATABASE"
APP_DB="${LEDGERDESK_APP_DB:-ledgerdesk_app}"
ROLES="app_rw quality_ro quality_gen quality_eval anon authenticated service_role"

# Derived from disk for the same reason db_check.sh derives it: a migration nobody adds to a list
# is a migration that never runs.
MIGRATIONS="$(ls migrations/[0-9][0-9][0-9][0-9]_*.sql | sort)"
[ -n "$MIGRATIONS" ] || fail "no numbered migrations in migrations/"

# Explicit, so that the reconciliation after the run fails the build if a test file exists in
# tests/app/ and is not named here. The ORDER of the list decides nothing: see below.
#
# test_APP_composition_root_serves_two_orgs has to run FIRST, and that is a real requirement — the
# triage runtimes are cached for the life of the server process, so "two organisations starting at
# the same instant" is a state that exists exactly once, before anything else has triaged anything.
# **It runs first because of its NAME, not because of this list**, and that is the whole of the
# guarantee: the runner sorts the files, and `test_APP_composition_root...` sorts before every other
# name in this directory today. A test file added tomorrow whose name sorts before it would take that
# state away, silently, and the composition-root suite would start measuring a process that had
# already built a runtime. Nothing checks this. It is written here because the day it breaks, this
# comment is the only place that says what broke.
#
# **This list does NOT decide the order the files run in, and a run of the gap-cycle card proved it.**
# The runner sorts them: passed in the order below, the suites came back alphabetically, every time.
# So the list is a reconciliation — a file that exists and is not named here fails the build — and
# nothing more. The one claim above that survives is accidental: `test_APP_composition_root...`
# happens to sort first as well.
#
# What that costs, and how it is paid: the files that admit material move the snapshot pointer, and
# four files that sort after them read the corpus under the label the seed wrote. Ordering cannot fix
# it because ordering is not ours to set, so **every file that moves the pointer puts it back**, in an
# `after` hook, through `restoreCorpusHead` — which also flushes the server's cached label, because a
# pointer moved behind its back is exactly what the staleness guard exists to refuse.
#
# Each of those files also holds a beat of its own — an enquiry lexically disjoint from every other
# beat's document — so that admitting one answer does not make another file's question answerable.
# test_KB_cycle_chains_two_runs_with_the_admission_between_them measures that disjointness with the
# database's own analyser.
TESTS="tests/app/test_APP_composition_root_serves_two_orgs.mjs tests/app/test_US01_ticket_created_and_acknowledged.mjs tests/app/test_APP_state_machine_enforced_server_side.mjs tests/app/test_APP_intake_dedupe_collapses_to_incumbent.mjs tests/app/test_APP_recordstage_escalates_without_model.mjs tests/app/test_APP_escalation_atomic_with_triage.mjs tests/app/test_APP_retry_seed_from_persisted_counter.mjs tests/app/test_INT_triage_ticket_to_chain.mjs tests/app/test_KB_seeded_articles_survive_redaction.mjs tests/app/test_KB_retrieval_order_is_total.mjs tests/app/test_SEC_retrieval_is_tenant_isolated.mjs tests/app/test_US03_draft_generated_with_grounded_context.mjs tests/app/test_APP_draft_atomic_with_validation.mjs tests/app/test_SEC_draft_never_reaches_customer_without_approval.mjs tests/app/test_KB_gap_emitted_on_ground_escalation.mjs tests/app/test_KB_gap_record_refused_without_evidence_owner_or_date.mjs tests/app/test_KB_admission_advances_snapshot_and_links_ledger.mjs tests/app/test_KB_gap_closes_only_by_verification.mjs tests/app/test_SEC_admitted_body_is_clean_before_it_enters_the_corpus.mjs tests/app/test_SEC_non_citable_material_is_never_retrieved.mjs tests/app/test_KB_gap_commitment_names_live_users_of_its_organisation.mjs tests/app/test_KB_gap_reasked_under_a_moved_corpus_reuses_the_standing_record.mjs tests/app/test_KB_cycle_chains_two_runs_with_the_admission_between_them.mjs"

maint() { psql -X -v ON_ERROR_STOP=1 -q -d "$MAINT_DB" -c "$1" >/dev/null; }
run_sql() { psql -X -v ON_ERROR_STOP=1 -q -d "$1" -f "$2"; }

command -v psql >/dev/null 2>&1 || fail "psql is not on PATH"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"
[ -x node_modules/next/dist/bin/next ] || [ -f node_modules/next/dist/bin/next ] \
  || fail "dependencies are not installed; run npm ci first"

SERVER_PID=""
teardown() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  maint "drop database if exists $APP_DB" >/dev/null 2>&1 || true
  for r in $ROLES; do maint "drop role if exists $r" >/dev/null 2>&1 || true; done
}
trap teardown EXIT

echo "== applying the migration set, the seed and the application grants"
maint "drop database if exists $APP_DB"
for r in $ROLES; do
  maint "drop role if exists $r" \
    || fail "the cluster role '$r' could not be dropped: another database in this cluster still holds grants that depend on it. A local development database is the usual reason; drop it and run this again."
done
maint "create database $APP_DB"

run_sql "$APP_DB" ci/sql/00_platform_shim.sql || fail "the platform shim did not apply"
for m in $MIGRATIONS; do
  # Statement by statement, not --single-transaction: 0002 adds a value to an enum and then uses
  # it, which PostgreSQL refuses inside one transaction.
  run_sql "$APP_DB" "$m" || fail "migration $m did not apply on a clean database"
done
run_sql "$APP_DB" seed/orgs.sql || fail "seed/orgs.sql did not apply"
# Not a migration, and the header of the file says why. Until it is one, this is where the
# application's privileges are visibly applied rather than assumed.

export DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${APP_DB}"
export LEDGERDESK_BASE_URL="http://127.0.0.1:${PORT}"

# The development identity selector exists only where a build asks for it. The tests need it on;
# the probe at the end of this script needs it off, which is the only way to measure that the
# build fails closed rather than to assert it in a comment.
export LEDGERDESK_DEV_IDENTITY=1

echo "== building the consoles"
node node_modules/next/dist/bin/next build || fail "next build"

echo "== starting the consoles on port $PORT"
node node_modules/next/dist/bin/next start --port "$PORT" &
SERVER_PID=$!

# The tests wait for readiness themselves; this loop exists so that a server which never comes up
# fails as "the server did not start" instead of as a test timeout somewhere else.
await_server() {
  for _ in $(seq 1 60); do
    if [ -n "$(curl -sf "${LEDGERDESK_BASE_URL}/api/health" 2>/dev/null || true)" ]; then return 0; fi
    kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited before it became ready"
    sleep 1
  done
  fail "the server did not answer /api/health within 60s"
}
await_server
echo "   server ready"

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

echo "== application tests"
# One file at a time. They share one server and one database, and several of them are about facts of
# that whole database at a moment — how many rows the chain holds for a ticket, whether any ticket
# anywhere is resting in a state with no exit, and what happens when a write to `ticket` is refused
# by an injected trigger that is necessarily global to the table. A suite whose verdict depends on
# the scheduler is a suite that is green on one machine and red on another.
#
# Type stripping is on for the same reason the chokepoint's suite has it: these tests recompute
# values — a state digest, a ruleset digest, an identifier, a redaction — using the very modules the
# server used, rather than transcribing what those modules produce. A transcription would pass on
# the day the module changed and the server started writing something else.
#
# The output is captured and searched for `not ok` as well as being checked for an exit code, and
# that belt-and-braces is not paranoia — it is a fault this script actually had. Node's runner
# reports a suite whose `after` hook threw as `not ok`, counts none of its subtests as failures, and
# **exits 0**. This script printed "app checks OK" over a red suite, which is the worst outcome a
# check can have: a green build containing a failure nobody will look for again.
TEST_LOG="$(mktemp)"

# shellcheck disable=SC2086
if node --experimental-strip-types --test --test-concurrency=1 $TESTS 2>&1 | tee "$TEST_LOG"; then :; else
  rm -f "$TEST_LOG"
  fail "the application tests did not pass"
fi

if grep -Eq '^(not ok|# fail [1-9])' "$TEST_LOG"; then
  grep -E '^not ok' "$TEST_LOG" >&2 || true
  rm -f "$TEST_LOG"
  fail "the application tests reported a failure the exit code did not (a suite or a hook failed)"
fi
rm -f "$TEST_LOG"

for f in tests/app/test_*.mjs; do
  case " $TESTS " in
    *" $f "*) ;;
    *) fail "$f exists and is not in the TESTS list" ;;
  esac
done

# test_ARCH_dev_identity_is_opt_in
#
# The same build, started without the flag. A control nobody has watched fail is a claim, so the
# server is restarted with LEDGERDESK_DEV_IDENTITY absent and asked the two questions that matter:
# an ordinary request must carry no claims, and the selector must refuse to issue a session.
echo "== the development identity selector, with its flag absent"
stop_server
env -u LEDGERDESK_DEV_IDENTITY node node_modules/next/dist/bin/next start --port "$PORT" &
SERVER_PID=$!
await_server

CODE="$(curl -s -o /dev/null -w '%{http_code}' "${LEDGERDESK_BASE_URL}/api/tickets")"
[ "$CODE" = "401" ] \
  || fail "test_ARCH_dev_identity_is_opt_in: without the flag a request carried claims (/api/tickets answered $CODE, expected 401)"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"user_id":"1a000000-0000-4000-8000-000000000001"}' "${LEDGERDESK_BASE_URL}/api/session")"
[ "$CODE" = "403" ] \
  || fail "test_ARCH_dev_identity_is_opt_in: without the flag the selector still issued a session (/api/session answered $CODE, expected 403)"

echo "test_ARCH_dev_identity_is_opt_in OK"

echo "app checks OK"
