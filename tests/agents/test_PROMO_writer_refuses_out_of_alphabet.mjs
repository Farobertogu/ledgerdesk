// test_PROMO_writer_refuses_out_of_alphabet
//
// What "fail-closed" has to mean for this row, measured.
//
// The database checks that the eight keys of a `promotion_attempt` are present and not JSON null and
// that `failing_conjunct` is null only under `PROMOTED`. It checks nothing about their VALUES: run
// against a live schema, `outcome:"MAYBE"`, `conjuncts:{}`, `failing_conjunct:"banana"` and
// `interpretation:"GOOD"` are all writable today. So the four alphabets are closed by the writer, or
// they are not closed at all — and every case below asserts not only that the row was refused but
// that **the database was never asked**, because a refusal that arrives from PostgreSQL arrives as
// `E_LEDGER_ROW_INCOMPLETE` from inside a transaction, naming nothing about which key was wrong.
//
// The store and the reader are spies that fail the assertion if they are called. That is what makes
// the last case of the file — an invalid terminal beside a perfectly valid start — the decisive one:
// it is the case that proves the pair is validated WHOLE before the first row is written, which is
// what the writer's header claims and what makes the non-atomic pair tolerable.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CONJUNCT_NAMES,
  CONJUNCT_REASON_MAX_BYTES,
  PROMOTION_ATTEMPT_REQUIRED_KEYS,
  PROMOTION_PAIR_KEYS,
  START_REQUIRED_KEYS,
  appendPromotionPair,
} from '../../agents/ledger/promotion_row.ts';
import { refused, refusingReader, refusingStore, validPair } from './promotion_fixture.mjs';

const WRITER = 'agents/ledger/promotion_row.ts';

/** One attempt to file `pair`, with spies that fail if the writer reaches past its own checks. */
async function file(pair) {
  const store = refusingStore();
  const reader = refusingReader();
  try {
    return await appendPromotionPair(store, reader, pair);
  } finally {
    assert.equal(store.calls, 0, 'the store was called');
    assert.equal(reader.calls, 0, 'the chain was read');
  }
}

test('every required key of the terminal, absent, is refused by name', async () => {
  for (const key of PROMOTION_ATTEMPT_REQUIRED_KEYS) {
    const pair = validPair();
    delete pair.terminal[key];
    const error = await refused(() => file(pair), `terminal without ${key}`);
    assert.equal(error.detail.key, key);
  }
});

test('every required key of the terminal, carrying JSON null, is refused by name', async () => {
  for (const key of PROMOTION_ATTEMPT_REQUIRED_KEYS) {
    const pair = validPair({ terminal: { [key]: null } });
    const error = await refused(() => file(pair), `terminal with ${key} null`);
    // `failing_conjunct` is the one key the trigger lets carry null, and only under PROMOTED. Here
    // the outcome is REJECTED, so the writer refuses it for the state rather than for the key.
    assert.equal(
      error.detail.key,
      key,
      `${key} null was refused while naming ${error.detail.key}`,
    );
  }
});

test('every required key of the start, absent, is refused by name', async () => {
  for (const key of START_REQUIRED_KEYS) {
    const pair = validPair();
    delete pair.start[key];
    const error = await refused(() => file(pair), `start without ${key}`);
    assert.equal(error.detail.key, key);
  }
});

test('a value outside each of the four closed alphabets is refused, naming field and alphabet', async () => {
  const cases = [
    { field: 'outcome', mutate: (pair) => (pair.terminal.outcome = 'MAYBE') },
    { field: 'interpretation', mutate: (pair) => (pair.terminal.interpretation = 'GOOD') },
    { field: 'failing_conjunct', mutate: (pair) => (pair.terminal.failing_conjunct = 'banana') },
    {
      field: 'verdict',
      mutate: (pair) => (pair.terminal.conjuncts.delta_positive.verdict = 'AMBER'),
    },
  ];

  for (const { field, mutate } of cases) {
    const pair = validPair();
    mutate(pair);
    const error = await refused(() => file(pair), `${field} out of alphabet`);
    assert.ok(
      String(error.detail.key).includes(field),
      `${field}: the refusal named '${error.detail.key}'`,
    );
    assert.ok(Array.isArray(error.detail.alphabet), `${field}: the refusal named no alphabet`);
  }
});

test('conjuncts is an object of exactly the four published names, in the published order', async () => {
  const shapes = {
    'a string': 'paired_significant_at_alpha=UNEVALUABLE',
    'three of the four': (() => {
      const pair = validPair();
      delete pair.terminal.conjuncts.query_index_within_cmax;
      return pair.terminal.conjuncts;
    })(),
    'a fifth name': { ...validPair().terminal.conjuncts, mcnemar_significant: { verdict: 'PASS', reason: '' } },
    'the four out of order': (() => {
      const original = validPair().terminal.conjuncts;
      const reversed = {};
      for (const name of [...CONJUNCT_NAMES].reverse()) reversed[name] = original[name];
      return reversed;
    })(),
  };

  for (const [label, conjuncts] of Object.entries(shapes)) {
    const pair = validPair({ terminal: { conjuncts } });
    const error = await refused(() => file(pair), `conjuncts as ${label}`);
    assert.ok(String(error.detail.key).startsWith('conjuncts'), `${label}: named ${error.detail.key}`);
  }
});

test('a verdict other than PASS carries a reason, non-empty and under the declared cap', async () => {
  const reasons = {
    absent: undefined,
    null: null,
    blank: '   ',
    'above the cap': 'x'.repeat(CONJUNCT_REASON_MAX_BYTES + 1),
    // Multi-byte, so the cap is measured in BYTES and not in characters: 121 of these is 242 bytes.
    'above the cap in bytes': 'é'.repeat(Math.floor(CONJUNCT_REASON_MAX_BYTES / 2) + 1),
  };

  for (const [label, reason] of Object.entries(reasons)) {
    const pair = validPair();
    if (reason === undefined) delete pair.terminal.conjuncts.battery_in_force_green.reason;
    else pair.terminal.conjuncts.battery_in_force_green.reason = reason;
    const error = await refused(() => file(pair), `reason ${label}`);
    assert.equal(error.detail.key, 'conjuncts.battery_in_force_green.reason');
  }
});

test('a reason is refused at the cap and never trimmed to it', async () => {
  const pair = validPair();
  pair.terminal.conjuncts.battery_in_force_green.reason = 'y'.repeat(CONJUNCT_REASON_MAX_BYTES + 1);
  const error = await refused(() => file(pair), 'reason above the cap');
  assert.equal(error.detail.cap, CONJUNCT_REASON_MAX_BYTES);
  assert.equal(error.detail.bytes, CONJUNCT_REASON_MAX_BYTES + 1);
  // The original object is untouched: nothing was shortened on the way to the refusal.
  assert.equal(pair.terminal.conjuncts.battery_in_force_green.reason.length, CONJUNCT_REASON_MAX_BYTES + 1);
});

test('code_sha is forty hexadecimal characters, and the empty string is not a sha', async () => {
  for (const code_sha of ['', '   ', 'unknown', 'abc', 'g'.repeat(40), '0'.repeat(41)]) {
    const pair = validPair({ start: { code_sha } });
    const error = await refused(() => file(pair), `code_sha '${code_sha}'`);
    assert.equal(error.detail.key, 'code_sha');
  }
});

test('an identity key that is blank after trim names nothing, so it is refused', async () => {
  for (const key of ['attempt_id', 'candidate_prompt_version_id', 'incumbent_prompt_version_id']) {
    const pair = validPair({ terminal: { [key]: '   ' } });
    const error = await refused(() => file(pair), `${key} blank`);
    assert.equal(error.detail.key, key);
  }
});

test('attempt_id is a uuid, because the evaluation matrix joins on one', async () => {
  // `quality_report.eval_outcome.attempt_id` is `uuid not null`, and it is the only way to tie an
  // attempt to its item-by-round matrix. A non-uuid breaks that join for good: the row is append-only.
  const pair = validPair({ terminal: { attempt_id: 'attempt-1' }, start: { attempt_id: 'attempt-1' } });
  const error = await refused(() => file(pair), 'attempt_id that is not a uuid');
  assert.equal(error.detail.key, 'attempt_id');
});

test('the start and the terminal must name one attempt', async () => {
  const pair = validPair({ terminal: { attempt_id: '00000000-0000-4000-8000-000000000001' } });
  const error = await refused(() => file(pair), 'two attempts in one pair');
  assert.equal(error.detail.key, 'attempt_id');
});

test('an invalid TERMINAL beside a valid START reaches the database not at all', async () => {
  // The decisive case. It is what makes the writer's header true: both payloads are checked in full
  // before the first append, so the only way a start can land and its terminal fail afterwards is
  // infrastructure or contention — and both of those are answered by running the mandate again.
  const pair = validPair({ terminal: { outcome: 'MAYBE' } });

  const store = refusingStore();
  const reader = refusingReader();
  await refused(() => appendPromotionPair(store, reader, pair), 'valid start, invalid terminal');
  assert.equal(store.calls, 0, 'the start row was written before the terminal had been checked');
  assert.equal(reader.calls, 0);
});

test('the writer takes no cost, no agent and no organisation of its own', () => {
  // Six of these are forced to zero by `ledger_nonmodel_costs_zero`, so a parameter would be a
  // parameter whose only legal value is the one already hardwired — and whose illegal value would
  // inflate the consumption figure the ceiling recomputes from the chain. `agent` is fixed because
  // `ledger_agent_identity` fixes it. The organisation arrives inside `claims`, because the writer
  // derives what it writes from the session it runs under.
  for (const forbidden of [
    'agent',
    'org_id',
    'restarts',
    'tokens_in',
    'tokens_out',
    'cost_aud',
    'latency_ms',
  ]) {
    assert.ok(
      !PROMOTION_PAIR_KEYS.includes(forbidden),
      `${forbidden} is a parameter of the writer's input`,
    );
  }

  const source = readFileSync(WRITER, 'utf8');
  assert.match(source, /agent: 'evolve'/, 'the agent is not hardwired');
  assert.doesNotMatch(
    source,
    /agent:\s*(pair|input|row)\./,
    'the agent is taken from the caller',
  );
  for (const sentinel of ["tokens_in: 0", "tokens_out: 0", "cost_aud: '0.000000'", 'latency_ms: 0', 'restarts: 0']) {
    assert.ok(source.includes(sentinel), `${sentinel} is not written as a fixed sentinel`);
  }
});
