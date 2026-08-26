// test_PROMO_panel_states_only_what_it_can_name
//
// The vocabulary rule of the beat map is binding: no state is described in words outside the alphabet
// the instrument publishes, and *"almost green" does not exist*. So the view model refuses to render
// rather than degrading — a fifth verdict, a seventh failing conjunct, a missing reason, a set of
// conjuncts that is not the four published names in the published order: each is a throw, never a
// dash on a screen.
//
// Two properties are merged into this file because they are one property seen twice.
//
//   · **The alphabets are transcribed and compared.** The panel cannot import the agent layer — it
//     has to load with no bundler — so its four alphabets are copies, and a copy nobody compares is a
//     copy that drifts. The comparison is against the module that owns them.
//   · **The reasons are read from the row and never from the page.** With sentinel reasons in the
//     fixture, all four come out of the rendered view verbatim, and none of the four exists as a
//     literal anywhere under `src/app/`.
//
// And the floor: with no rows at all the panel renders the signed no-attempt wording in full, the
// count zero, and NOTHING green. The wording of the rung that presumes a row lives inside the filed
// branch and is structurally unreachable from the empty one — if the screen could paint it empty, the
// screen would be committing the offence the map forbids the presenter.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import * as writer from '../../agents/ledger/promotion_row.ts';
import {
  CONJUNCT_NAMES,
  CONJUNCT_VERDICTS,
  FAILING_CONJUNCTS,
  FAIL_CLOSED_STATEMENT,
  INTERPRETATIONS,
  NO_ATTEMPT_FILED,
  OUTCOMES,
  promotionPanelView,
} from '../../src/alg/promotion_panel.ts';
import { capsuleRows } from './promotion_fixture.mjs';

const PANEL = 'src/alg/promotion_panel.ts';

/** Every string the view holds, flattened, so a claim can be looked for in what would be rendered. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

function filesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

test('the four alphabets are the agent layer’s, transcribed and compared', () => {
  assert.deepEqual([...CONJUNCT_NAMES], [...writer.CONJUNCT_NAMES]);
  assert.deepEqual([...CONJUNCT_VERDICTS], [...writer.CONJUNCT_VERDICTS]);
  assert.deepEqual([...FAILING_CONJUNCTS], [...writer.FAILING_CONJUNCTS]);
  assert.deepEqual([...OUTCOMES], [...writer.OUTCOMES]);
  assert.deepEqual([...INTERPRETATIONS], [...writer.INTERPRETATIONS]);

  // The order is part of the contract, not presentation.
  assert.deepEqual(
    [...CONJUNCT_NAMES],
    [
      'paired_significant_at_alpha',
      'delta_positive',
      'battery_in_force_green',
      'query_index_within_cmax',
    ],
  );
  assert.equal(FAILING_CONJUNCTS.length, 6);
});

test('with no rows the panel renders the signed floor, the count zero, and nothing green', () => {
  const view = promotionPanelView([]);

  assert.equal(view.kind, 'not_filed');
  assert.equal(view.attempts, 0);
  assert.equal(view.statement, NO_ATTEMPT_FILED);

  // Byte for byte against the signed wording. It is one sentence of three clauses and it is what the
  // presenter would otherwise have to improvise.
  assert.equal(
    NO_ATTEMPT_FILED,
    'No promotion attempt has been filed yet. The gate exists as a signed contract in the schema: ' +
      'a rejection that does not name its failing conjunct cannot be written at all — the database ' +
      'refuses it. What I can show today is that contract, and the count of attempts, which is zero ' +
      'and honest.',
  );

  assert.notEqual(view.reconciliation.verdict, 'reconciled');
  const rendered = strings(view);
  for (const forbidden of ['PASS', 'UNEVALUABLE', 'REJECTED', 'precondition_underpowered']) {
    assert.ok(
      !rendered.some((text) => text.includes(forbidden)),
      `the empty panel printed '${forbidden}'`,
    );
  }
  assert.ok(
    !rendered.includes(FAIL_CLOSED_STATEMENT),
    'the wording that presumes a row was rendered without one',
  );
  assert.equal(view.fail_closed_statement, undefined, 'the empty branch carries the P1 wording');
});

test('the filed panel names the four conjuncts, their verdicts and their reasons, from the row', () => {
  const view = promotionPanelView(capsuleRows());

  assert.equal(view.kind, 'filed');
  assert.deepEqual(view.conjuncts.map((entry) => entry.name), [...CONJUNCT_NAMES]);
  for (const conjunct of view.conjuncts) {
    assert.ok(CONJUNCT_VERDICTS.includes(conjunct.verdict));
    assert.notEqual(conjunct.reason.trim(), '');
  }
  assert.equal(view.failing_conjunct, 'precondition_underpowered');
  assert.equal(view.outcome, 'REJECTED');
  assert.equal(view.interpretation, 'UNDERPOWERED');
  assert.equal(view.power.kind, 'not_derived');
  assert.equal(view.fail_closed_statement, FAIL_CLOSED_STATEMENT);
  assert.equal(view.reconciliation.verdict, 'reconciled');
  assert.equal(view.reconciliation.starts, 1);
  assert.equal(view.reconciliation.terminals, 1);
});

test('a fifth verdict, a seventh failing conjunct and a fourth outcome are refused, not painted', () => {
  const cases = [
    ['a fifth verdict', (rows) => (rows[1].output.conjuncts.delta_positive.verdict = 'AMBER')],
    ['a dash for a verdict', (rows) => (rows[1].output.conjuncts.delta_positive.verdict = '—')],
    ['N/A for a verdict', (rows) => (rows[1].output.conjuncts.delta_positive.verdict = 'N/A')],
    ['a seventh failing conjunct', (rows) => (rows[1].output.failing_conjunct = 'mcnemar_failed')],
    ['a fourth outcome', (rows) => (rows[1].output.outcome = 'MAYBE')],
    ['an interpretation outside the alphabet', (rows) => (rows[1].output.interpretation = 'GOOD')],
    ['a missing reason', (rows) => delete rows[1].output.conjuncts.battery_in_force_green.reason],
    ['a blank reason', (rows) => (rows[1].output.conjuncts.battery_in_force_green.reason = '  ')],
    ['three conjuncts', (rows) => delete rows[1].output.conjuncts.query_index_within_cmax],
    [
      'a fifth conjunct',
      (rows) => (rows[1].output.conjuncts.mcnemar_significant = { verdict: 'PASS', reason: '' }),
    ],
    [
      'a renamed conjunct',
      (rows) => {
        rows[1].output.conjuncts.delta_is_positive = rows[1].output.conjuncts.delta_positive;
        delete rows[1].output.conjuncts.delta_positive;
      },
    ],
    [
      'a half-derived interval',
      (rows) => (rows[1].output.power = { ...rows[1].output.power, ci_low: 0.01 }),
    ],
  ];

  for (const [label, mutate] of cases) {
    const rows = capsuleRows();
    mutate(rows);
    assert.throws(() => promotionPanelView(rows), /promotion panel/, `${label} was rendered`);
  }
});

test('the published order is re-established at render, because the storage does not keep it', () => {
  // Measured against PostgreSQL: `output` is a `jsonb` column and `jsonb` normalises key order by
  // length and then bytewise, so the four conjuncts come back as delta_positive,
  // battery_in_force_green, query_index_within_cmax, paired_significant_at_alpha — whatever order
  // they were written in. The canonical form the row's digest was taken over sorts keys as well. A
  // panel that demanded the published order of the row it read would throw on every real row, so
  // the order is checked by the WRITER on the payload it is handed and re-established here.
  const rows = capsuleRows();
  const stored = {};
  for (const name of [...CONJUNCT_NAMES].sort((a, b) => a.length - b.length)) {
    stored[name] = rows[1].output.conjuncts[name];
  }
  rows[1].output.conjuncts = stored;
  assert.notDeepEqual(Object.keys(stored), [...CONJUNCT_NAMES], 'the fixture did not reorder anything');

  const view = promotionPanelView(rows);
  assert.deepEqual(view.conjuncts.map((entry) => entry.name), [...CONJUNCT_NAMES]);
});

test('a row whose digest does not match its contents produces a named failure, never a checklist', () => {
  const rows = capsuleRows({ terminalRow: { verified: false } });
  const view = promotionPanelView(rows);

  assert.equal(view.kind, 'not_verifiable');
  assert.ok(view.failure.includes('does not hash to what it says it does'));
  assert.equal(view.conjuncts, undefined, 'a checklist was built over an unverified row');
  assert.equal(view.outcome, undefined);
  assert.equal(view.fail_closed_statement, undefined);
});

test('a dangling start is named rather than rendered as a gate that never ran', () => {
  const [start] = capsuleRows();
  const view = promotionPanelView([start]);

  assert.equal(view.kind, 'not_verifiable');
  assert.ok(view.failure.includes(start.attempt_id));
  assert.equal(view.reconciliation.verdict, 'not reconciled');
  assert.deepEqual(view.reconciliation.dangling, [start.attempt_id]);
});

test('the fail-closed sentence is rendered when, and only when, the precondition is what failed', () => {
  const promoted = capsuleRows();
  promoted[1].output.conjuncts = Object.fromEntries(
    CONJUNCT_NAMES.map((name) => [name, { verdict: 'PASS', reason: '' }]),
  );
  promoted[1].output.failing_conjunct = null;
  promoted[1].output.outcome = 'PROMOTED';
  promoted[1].output.interpretation = 'POWERED-CONCLUSIVE';
  promoted[1].output.candidate_prompt_version_id = promoted[1].output.incumbent_prompt_version_id;

  const view = promotionPanelView(promoted);
  assert.equal(view.kind, 'filed');
  assert.equal(view.failing_conjunct, null);
  assert.equal(view.fail_closed_statement, null, 'a promoted attempt was given the underpowered text');
});

test('the reasons come out of the row, and none of them is a literal under src/app/', () => {
  const sentinels = {
    paired_significant_at_alpha: 'sentinel reason one for the paired test',
    delta_positive: 'no candidate generation has been proposed; sentinel reason two',
    battery_in_force_green: 'sentinel reason three for the battery',
    query_index_within_cmax: 'sentinel reason four for the query index',
  };

  const rows = capsuleRows();
  for (const [name, reason] of Object.entries(sentinels)) {
    rows[1].output.conjuncts[name].reason = reason;
  }

  const view = promotionPanelView(rows);
  const rendered = strings(view);
  for (const reason of Object.values(sentinels)) {
    assert.ok(rendered.includes(reason), `the panel did not render '${reason}' verbatim`);
  }

  // And the real four are not typed into the page either: the screen reads them off the row.
  const app = filesUnder('src/app')
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const real = promotionPanelView(capsuleRows()).conjuncts.map((entry) => entry.reason);
  for (const reason of real) {
    assert.ok(!app.includes(reason), `'${reason.slice(0, 40)}…' is a literal under src/app/`);
  }
});

test('the panel module reaches for nothing outside its own directory', () => {
  // What makes it loadable with a bare runtime, which is what puts its tests in the fastest job.
  const source = readFileSync(PANEL, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('./'),
      `${PANEL} imports '${specifier}', which no bare runtime can resolve`,
    );
  }
});
