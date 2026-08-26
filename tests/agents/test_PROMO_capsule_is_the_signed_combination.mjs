// test_PROMO_capsule_is_the_signed_combination
//
// The card signs one row, and this file is the byte comparison that keeps it that row.
//
// `BOARD.md:20` and ADR-023 name it: the REJECTED terminal with
// `failing_conjunct = precondition_underpowered`, plus its `start`. The map's rung P1 prints the four
// reasons IN CONJUNCT ORDER — no scored run · no candidate · battery not built · no report slice —
// and its rung P2 crosses them by declaring the first and the fourth evaluable once sealed splits and
// a first scored run land, which leaves the second and the third where they are. Three independent
// documents, one mapping.
//
// The order is part of the contract and not presentation: an examiner reading the specification has
// to find the same four names in the same sequence on the screen, or the screen is a translation
// rather than evidence of the row.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CAPSULE_CI_UNIT,
  CAPSULE_CONJUNCTS,
  CAPSULE_FAILING_CONJUNCT,
  CAPSULE_INTERPRETATION,
  CAPSULE_OUTCOME,
  CAPSULE_POWER,
  CONJUNCT_NAMES,
  NO_CANDIDATE_PROPOSED,
  appendPromotionPair,
  capsulePair,
} from '../../agents/ledger/promotion_row.ts';
import {
  CODE_SHA,
  INCUMBENT,
  ORG_A,
  STATE,
  TOOLCHAIN,
  TS,
  refused,
  refusingReader,
  refusingStore,
  validPair,
} from './promotion_fixture.mjs';

/** The signed table, written out here so that a change to the writer has to change this file too. */
const SIGNED = [
  [
    'paired_significant_at_alpha',
    'UNEVALUABLE',
    'no scored run has been recorded, so the paired test has nothing to run on',
  ],
  [
    'delta_positive',
    'UNEVALUABLE',
    'no candidate generation has been proposed; the attempt names the incumbent on both sides',
  ],
  [
    'battery_in_force_green',
    'UNEVALUABLE',
    'the negative battery has not been built, so no round and date can be in force',
  ],
  [
    'query_index_within_cmax',
    'UNEVALUABLE',
    'no report split has been sealed, so the query index has nothing to be counted against',
  ],
];

test('the four conjuncts are the signed pairs, in the published order, byte for byte', () => {
  assert.deepEqual([...CONJUNCT_NAMES], SIGNED.map(([name]) => name));

  const pair = capsulePair({
    claims: { org_id: ORG_A },
    incumbent_prompt_version_id: INCUMBENT,
    code_sha: CODE_SHA,
    ts: TS,
    state: STATE,
    toolchain: TOOLCHAIN,
  });

  const written = pair.terminal.conjuncts;
  assert.deepEqual(Object.keys(written), SIGNED.map(([name]) => name));

  for (const [name, verdict, reason] of SIGNED) {
    assert.equal(written[name].verdict, verdict, `${name}: verdict`);
    assert.equal(written[name].reason, reason, `${name}: reason`);
    assert.deepEqual(Object.keys(written[name]), ['verdict', 'reason'], `${name}: shape`);
    // And the constant is the same object the module publishes, not a second copy of it.
    assert.equal(CAPSULE_CONJUNCTS[name].reason, reason);
  }

  // The second conjunct's reason IS the constant that produces the candidate identifier. There is no
  // second place to write either of them.
  assert.equal(written.delta_positive.reason, NO_CANDIDATE_PROPOSED.reason);
  assert.equal(pair.terminal.candidate_prompt_version_id, INCUMBENT);
  assert.equal(pair.terminal.incumbent_prompt_version_id, INCUMBENT);
});

test('the terminal is REJECTED, underpowered, with the precondition named', () => {
  assert.equal(CAPSULE_FAILING_CONJUNCT, 'precondition_underpowered');
  assert.equal(CAPSULE_OUTCOME, 'REJECTED');
  assert.equal(CAPSULE_INTERPRETATION, 'UNDERPOWERED');

  const pair = capsulePair({
    claims: { org_id: ORG_A },
    incumbent_prompt_version_id: INCUMBENT,
    code_sha: CODE_SHA,
    ts: TS,
    state: STATE,
    toolchain: TOOLCHAIN,
  });

  assert.equal(pair.terminal.failing_conjunct, 'precondition_underpowered');
  assert.equal(pair.terminal.outcome, 'REJECTED');
  assert.equal(pair.terminal.interpretation, 'UNDERPOWERED');

  // `power` names its six keys; five of them are JSON null and the sixth is a declared convention.
  assert.deepEqual(Object.keys(pair.terminal.power).sort(), [...Object.keys(CAPSULE_POWER)].sort());
  assert.equal(pair.terminal.power.ci_unit, CAPSULE_CI_UNIT);
  for (const key of ['delta', 'ci_low', 'ci_high', 'mde_n', 'mdi']) {
    assert.equal(pair.terminal.power[key], null, `power.${key} carries a figure`);
  }

  // The start says what it reserved, and it reserved nothing: this capsule runs no generation.
  assert.equal(pair.start.budget_reserved, 0);
  assert.equal(pair.start.started_at, TS);
  assert.equal(pair.start.code_sha, CODE_SHA);
  assert.equal(pair.start.attempt_id, pair.terminal.attempt_id);
  assert.equal(pair.scored_run, null);
  assert.deepEqual(pair.evidence, {});
});

test('four unevaluable conjuncts under any other failing conjunct are refused', async () => {
  const store = refusingStore();
  const reader = refusingReader();
  const pair = validPair({ terminal: { failing_conjunct: 'delta_positive' } });

  const error = await refused(
    () => appendPromotionPair(store, reader, pair),
    'the capsule with a conjunct named as the failure',
  );
  assert.equal(error.detail.key, 'failing_conjunct');
  assert.equal(store.calls, 0);
  assert.equal(reader.calls, 0);
});
