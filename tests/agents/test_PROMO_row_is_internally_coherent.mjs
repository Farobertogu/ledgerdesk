// test_PROMO_row_is_internally_coherent
//
// A row that contradicts itself, measured against the database, is a row the database accepts.
//
// Two of these were run against a live schema before this file was written, and both went in: an
// `outcome: 'PROMOTED'` whose `delta_positive` said `"FAIL"` and whose `failing_conjunct` was null,
// and a `REJECTED` naming `delta_positive` while that conjunct said `"PASS"`. The first is a
// promotion with a failed conjunct — precisely what the fail-closed rule of ADR-012 exists to close
// — and the second puts on screen, as the conjunct that failed, one that approved. The trigger ties
// only `failing_conjunct = null` to `PROMOTED` and nothing else, so everything below lives here or
// nowhere.
//
// The last clause is the sharpest one in the capsule. There are four `prompt_version` rows in the
// rehearsal bank, none of them `evolve`, none with `promoted_at`: nobody has proposed a candidate. So
// the attempt names the incumbent on both sides and the second conjunct's reason SAYS SO — and the
// value and the reason come out of one constant, so the rule below can only fire on a caller that
// wrote them separately.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CAPSULE_POWER,
  NO_CANDIDATE_PROPOSED,
  POWER_KEYS,
  appendPromotionPair,
} from '../../agents/ledger/promotion_row.ts';
import {
  INCUMBENT,
  emptyReader,
  refused,
  refusingReader,
  refusingStore,
  validPair,
} from './promotion_fixture.mjs';

const WRITER = 'agents/ledger/promotion_row.ts';

const OTHER = '7a1a9e00-0000-4000-8000-000000000001';

async function file(pair) {
  const store = refusingStore();
  const reader = refusingReader();
  try {
    return await appendPromotionPair(store, reader, pair);
  } finally {
    assert.equal(store.calls, 0, 'the store was called with an incoherent row');
    assert.equal(reader.calls, 0);
  }
}

/** All four conjuncts passing, each with the evidence its kind requires. */
function allPass() {
  return {
    conjuncts: {
      paired_significant_at_alpha: { verdict: 'PASS', reason: '' },
      delta_positive: { verdict: 'PASS', reason: '' },
      battery_in_force_green: { verdict: 'PASS', reason: '' },
      query_index_within_cmax: { verdict: 'PASS', reason: '' },
    },
    evidence: {
      paired_significant_at_alpha: { kind: 'split', split_id: '5e100000-0000-4000-8000-000000000001' },
      delta_positive: { kind: 'prompt_version', prompt_version_id: OTHER },
      battery_in_force_green: { kind: 'battery', round: 'B1', date: '2026-10-04' },
      query_index_within_cmax: { kind: 'split', split_id: '5e100000-0000-4000-8000-000000000001' },
    },
  };
}

test('(a) PROMOTED is refused unless all four conjuncts pass', async () => {
  const { conjuncts, evidence } = allPass();
  conjuncts.delta_positive = { verdict: 'FAIL', reason: 'the candidate did not win' };
  delete evidence.delta_positive;

  const pair = validPair({
    evidence,
    terminal: {
      conjuncts,
      candidate_prompt_version_id: OTHER,
      failing_conjunct: null,
      outcome: 'PROMOTED',
      interpretation: 'POWERED-CONCLUSIVE',
    },
  });
  const error = await refused(() => file(pair), 'PROMOTED with a failed conjunct');
  assert.equal(error.detail.key, 'outcome');
});

test('(a2) a null failing conjunct outside PROMOTED, and a named one inside it, are both refused', async () => {
  const nulled = validPair({ terminal: { failing_conjunct: null } });
  assert.equal((await refused(() => file(nulled), 'null under REJECTED')).detail.key, 'failing_conjunct');

  const { conjuncts, evidence } = allPass();
  const named = validPair({
    evidence,
    terminal: {
      conjuncts,
      candidate_prompt_version_id: OTHER,
      failing_conjunct: 'delta_positive',
      outcome: 'PROMOTED',
      interpretation: 'POWERED-CONCLUSIVE',
    },
  });
  assert.equal(
    (await refused(() => file(named), 'named under PROMOTED')).detail.key,
    'failing_conjunct',
  );
});

test('(b) a failing conjunct that names a conjunct whose verdict is PASS is refused', async () => {
  const { conjuncts, evidence } = allPass();
  conjuncts.battery_in_force_green = { verdict: 'FAIL', reason: 'the battery has expired' };
  delete evidence.battery_in_force_green;

  const pair = validPair({
    evidence,
    terminal: {
      conjuncts,
      candidate_prompt_version_id: OTHER,
      failing_conjunct: 'delta_positive',
      outcome: 'REJECTED',
      interpretation: 'INFORMATIVE-NULL',
    },
  });
  const error = await refused(() => file(pair), 'naming a conjunct that passed');
  assert.equal(error.detail.key, 'failing_conjunct');
  assert.equal(error.detail.conjunct, 'delta_positive');
});

test('(c) precondition_underpowered has exactly one interpretation', async () => {
  for (const interpretation of ['INFORMATIVE-NULL', 'POWERED-CONCLUSIVE']) {
    const pair = validPair({ terminal: { interpretation } });
    const error = await refused(() => file(pair), `underpowered read as ${interpretation}`);
    assert.equal(error.detail.key, 'interpretation');
  }
});

test('(d) aborted_before_evaluation belongs to an ABORTED row that names its reason', async () => {
  const wrongOutcome = validPair({
    terminal: { failing_conjunct: 'aborted_before_evaluation', abort_reason: 'canary' },
  });
  assert.equal(
    (await refused(() => file(wrongOutcome), 'aborted conjunct under REJECTED')).detail.key,
    'outcome',
  );

  const noReason = validPair({
    terminal: {
      failing_conjunct: 'aborted_before_evaluation',
      outcome: 'ABORTED',
      interpretation: 'UNDERPOWERED',
    },
  });
  assert.equal(
    (await refused(() => file(noReason), 'aborted with no reason')).detail.key,
    'abort_reason',
  );
});

test('(e) no PASS without named evidence, and in this state no conjunct can have any', async () => {
  const { conjuncts } = allPass();
  const pair = validPair({
    evidence: {},
    terminal: {
      conjuncts,
      candidate_prompt_version_id: OTHER,
      failing_conjunct: null,
      outcome: 'PROMOTED',
      interpretation: 'POWERED-CONCLUSIVE',
    },
  });
  const error = await refused(() => file(pair), 'PASS with no evidence');
  assert.ok(String(error.detail.key).startsWith('conjuncts.'), `named ${error.detail.key}`);

  // And the evidence has to be of the right kind: a split does not stand in for a prompt version.
  const wrongKind = validPair({
    evidence: { ...allPass().evidence, delta_positive: { kind: 'split', split_id: 'x' } },
    terminal: {
      conjuncts,
      candidate_prompt_version_id: OTHER,
      failing_conjunct: null,
      outcome: 'PROMOTED',
      interpretation: 'POWERED-CONCLUSIVE',
    },
  });
  assert.equal(
    (await refused(() => file(wrongKind), 'evidence of the wrong kind')).detail.key,
    'conjuncts.delta_positive',
  );
});

test('(f) the two identifiers and the reason of the second conjunct cannot disagree', async () => {
  // Equal identifiers while the reason says nothing about an absent candidate.
  const silent = validPair();
  silent.terminal.conjuncts.delta_positive.reason = 'the candidate did not win by enough';
  assert.equal(
    (await refused(() => file(silent), 'equal identifiers, silent reason')).detail.key,
    'candidate_prompt_version_id',
  );

  // The reason declares an absent candidate while the identifiers differ.
  const contradictory = validPair({ terminal: { candidate_prompt_version_id: OTHER } });
  assert.equal(
    (await refused(() => file(contradictory), 'no-candidate reason, different identifiers')).detail
      .key,
    'candidate_prompt_version_id',
  );

  // And a PASS on that conjunct with equal identifiers is refused too: a comparison of one thing
  // against itself cannot pass.
  const passing = validPair();
  passing.terminal.conjuncts.delta_positive.verdict = 'PASS';
  await refused(() => file(passing), 'delta_positive PASS against itself');
});

test('four unevaluable conjuncts leave two names a failure can carry, and no others', async () => {
  for (const failing_conjunct of [
    'paired_significant_at_alpha',
    'delta_positive',
    'battery_in_force_green',
    'query_index_within_cmax',
  ]) {
    const pair = validPair({ terminal: { failing_conjunct } });
    const error = await refused(() => file(pair), `all UNEVALUABLE naming ${failing_conjunct}`);
    assert.equal(error.detail.key, 'failing_conjunct');
  }

  // The other of the two is legal on its own terms, and fails for the ABORTED pairing instead.
  const aborted = validPair({ terminal: { failing_conjunct: 'aborted_before_evaluation' } });
  assert.equal((await refused(() => file(aborted), 'aborted')).detail.key, 'outcome');
});

test('power carries the six keys of the supersession, its unit, and no invented number', async () => {
  assert.deepEqual([...POWER_KEYS], ['delta', 'ci_low', 'ci_high', 'ci_unit', 'mde_n', 'mdi']);

  for (const key of POWER_KEYS) {
    const power = { ...CAPSULE_POWER };
    delete power[key];
    const pair = validPair({ terminal: { power } });
    const error = await refused(() => file(pair), `power without ${key}`);
    assert.equal(error.detail.key, 'power');
  }

  const superseded = validPair({
    terminal: { power: { delta: null, ci: null, mde_n: null, mdi: null } },
  });
  assert.equal((await refused(() => file(superseded), 'the superseded shape')).detail.key, 'power');

  const unit = validPair({ terminal: { power: { ...CAPSULE_POWER, ci_unit: 'percent' } } });
  assert.equal((await refused(() => file(unit), 'ci_unit out of alphabet')).detail.key, 'ci_unit');

  // The one that matters: a number where nothing has been measured. Zero is the tempting value and
  // is the worst one — an `mde_n` of zero reads as infinite power and a `delta` of zero reads as a
  // measured null, which is the claim UNDERPOWERED exists to forbid.
  for (const key of ['delta', 'ci_low', 'ci_high', 'mde_n', 'mdi']) {
    const pair = validPair({ terminal: { power: { ...CAPSULE_POWER, [key]: 0 } } });
    const error = await refused(() => file(pair), `power.${key} = 0 with no scored run`);
    assert.equal(error.detail.key, `power.${key}`);
  }
});

test('the capsule row itself is coherent, and the writer files it', async () => {
  const appended = [];
  const store = {
    async append(runId, orgId, build) {
      const row = build(appended.length === 0 ? null : { seq: appended.length, cum_tokens: 0, row_hash: 'a'.repeat(64) });
      appended.push(row);
      return { id: String(appended.length), seq: row.seq, prev_hash: 'GENESIS', row_hash: 'b'.repeat(64), ts: row.ts };
    },
    async spentMicroAud() { return 0; },
    async findCached() { return null; },
    async close() {},
  };

  const filed = await appendPromotionPair(store, emptyReader(), validPair());
  assert.equal(filed.action, 'filed');
  assert.equal(appended.length, 2);
  assert.equal(appended[0].class, 'start');
  assert.equal(appended[0].agent, 'system');
  assert.equal(appended[1].class, 'promotion_attempt');
  assert.equal(appended[1].agent, 'evolve');
});

test('the writer names no figure where the specification has none', () => {
  const source = readFileSync(WRITER, 'utf8');

  // Five of the six members of `power` are JSON null in this state, and the file must say so with
  // the word `null` rather than with a number that would read as a measurement.
  for (const key of ['delta', 'ci_low', 'ci_high', 'mde_n', 'mdi']) {
    assert.match(
      source,
      new RegExp(`^\\s*${key}: null,`, 'm'),
      `CAPSULE_POWER.${key} is not JSON null in the writer`,
    );
    assert.doesNotMatch(
      source,
      new RegExp(`^\\s*${key}: -?\\d`, 'm'),
      `${key} is assigned a number somewhere in the writer`,
    );
  }

  assert.equal(CAPSULE_POWER.mdi, null);
  assert.equal(CAPSULE_POWER.mde_n, null);
  assert.equal(typeof CAPSULE_POWER.ci_unit, 'string');

  // And the constant that decides both sides of the comparison is one constant.
  assert.ok(
    NO_CANDIDATE_PROPOSED.reason.includes(NO_CANDIDATE_PROPOSED.marker),
    'the marker is not a slice of the reason, so the two can drift apart',
  );
  assert.equal(NO_CANDIDATE_PROPOSED.candidateFrom(INCUMBENT), INCUMBENT);
});
