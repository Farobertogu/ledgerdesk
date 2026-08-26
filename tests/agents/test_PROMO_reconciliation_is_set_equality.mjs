// test_PROMO_reconciliation_is_set_equality
//
// `starts == terminals` is published in two clauses at once: *"for every `start` row of the run there
// is exactly one `promotion_attempt` with its `attempt_id` and a terminal `outcome`, and
// `count(start) == count(terminals)`"*. Set equality satisfies both; two counts satisfy only the
// second, so the strong reading is the only correct one.
//
// The failure two counts miss is cheap to produce and impossible to see: nothing ties a terminal to
// its opening — the two unique indexes are independent and there is no foreign key between them,
// measured — so `start(A)` beside `terminal(B)` balances at one and one while the run holds an attempt
// that never ended and an attempt that never began. That is exactly the peek-and-abort signature the
// invariant exists to catch.
//
// And a row claiming to be a terminal while carrying an outcome outside the three published ones is
// NOT a terminal. Counting it would turn an invalid row into evidence of conservation: the line would
// read green because of the row that should have turned it red.
//
// **One module owns this function.** The Decision Audit Log card renders the same line and CONSUMES
// this, rather than reimplementing it; a check in `ci/check.sh` fails the build if the symbol is
// declared in more than one module.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconcileAttempts } from '../../src/alg/promotion_panel.ts';

const A = 'aaaa0000-0000-4000-8000-00000000000a';
const B = 'bbbb0000-0000-4000-8000-00000000000b';

function start(attempt_id, seq = 1) {
  return {
    kind: 'start',
    attempt_id,
    run_id: 'r',
    seq,
    ticket_id: null,
    output: { attempt_id },
    verified: true,
  };
}

function terminal(attempt_id, outcome = 'REJECTED', seq = 2) {
  return {
    kind: 'terminal',
    attempt_id,
    run_id: 'r',
    seq,
    ticket_id: null,
    output: { attempt_id, outcome },
    verified: true,
  };
}

test('a matched pair reconciles', () => {
  const line = reconcileAttempts([start(A), terminal(A)]);
  assert.equal(line.verdict, 'reconciled');
  assert.equal(line.starts, 1);
  assert.equal(line.terminals, 1);
  assert.deepEqual(line.dangling, []);
  assert.deepEqual(line.orphan, []);
  assert.deepEqual(line.invalid, []);
});

test('a start of A beside a terminal of B does NOT reconcile, and both are named', () => {
  const line = reconcileAttempts([start(A), terminal(B)]);

  // The two counts agree. This is the case that makes counting the wrong measurement.
  assert.equal(line.starts, 1);
  assert.equal(line.terminals, 1);

  assert.equal(line.verdict, 'not reconciled');
  assert.deepEqual(line.dangling, [A]);
  assert.deepEqual(line.orphan, [B]);
});

test('a start with no terminal is reported by name', () => {
  const line = reconcileAttempts([start(A)]);
  assert.equal(line.verdict, 'not reconciled');
  assert.deepEqual(line.dangling, [A]);
  assert.equal(line.terminals, 0);
});

test('a terminal whose outcome is outside the three published ones is not a terminal', () => {
  const line = reconcileAttempts([start(A), terminal(A, 'MAYBE')]);
  assert.equal(line.verdict, 'not reconciled');
  assert.equal(line.terminals, 0, 'an invalid row was counted as evidence of conservation');
  assert.deepEqual(line.invalid, [A]);
  assert.deepEqual(line.dangling, [A]);

  for (const outcome of ['PROMOTED', 'REJECTED', 'ABORTED']) {
    assert.equal(reconcileAttempts([start(A), terminal(A, outcome)]).verdict, 'reconciled', outcome);
  }
});

test('the empty set has a state of its own and it is not green', () => {
  const line = reconcileAttempts([]);
  assert.equal(line.starts, 0);
  assert.equal(line.terminals, 0);
  assert.notEqual(line.verdict, 'reconciled', 'zero attempts read as a conservation law holding');
  assert.equal(line.verdict, 'nothing filed');
});

test('two attempts, one sound and one dangling, name only the dangling one', () => {
  const line = reconcileAttempts([start(A, 1), terminal(A, 'REJECTED', 2), start(B, 3)]);
  assert.equal(line.verdict, 'not reconciled');
  assert.equal(line.starts, 2);
  assert.equal(line.terminals, 1);
  assert.deepEqual(line.dangling, [B]);
  assert.deepEqual(line.orphan, []);
});
