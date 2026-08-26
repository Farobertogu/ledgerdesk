// test_PROMO_panel_makes_no_prohibited_claim
//
// Five things this surface is forbidden to say, checked against its source and against what it would
// actually render.
//
// The prohibition is not a matter of style: it is the reason the UNDERPOWERED state exists. A panel
// that prints `not derived` where Δ belongs is honest; one that prints "no improvement" turns *"we
// could not see it"* into *"there is none"* in front of an examiner, in the beat whose only asset is
// honesty. And a typed error code on a screen ASSERTS that a mechanism raised it — showing one this
// build cannot raise is the same class of lie as an undated slot, and it is the easiest one to
// commit, because the code is written in the specification and copies without thinking.
//
// Verified before this file was written: none of the five appears in the tree today, so the lint is
// born green and its whole value is the day somebody adds one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { GATEWAY_ERROR_CODES } from '../../agents/errors.ts';
import {
  NOT_DERIVED,
  PENDING_MILESTONES,
  SURFACE_SCOPE,
  promotionPanelView,
} from '../../src/alg/promotion_panel.ts';
import { APP_ERROR_CODES } from '../../src/server/errors.ts';
import { capsuleRows } from './promotion_fixture.mjs';

/** The three modules that make up the promotion surface. Nothing else renders this beat. */
const SURFACE = [
  'src/alg/promotion_panel.ts',
  'src/server/promotion.ts',
  'src/app/promotion/page.tsx',
];

const SOURCE = Object.fromEntries(SURFACE.map((file) => [file, readFileSync(file, 'utf8')]));

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

const RENDERED = strings(promotionPanelView(capsuleRows())).concat(strings(promotionPanelView([])));

test('1 · the two forbidden claims, and one defensible superset of them', () => {
  // The first two are published verbatim in the specification as what an UNDERPOWERED result may not
  // say. The third is NOT a transcription — it is a wider net cast over the same claim, declared here
  // as such so that nobody later cites it as though the specification had written it.
  const forbidden = ['does not improve', 'gets worse', 'no improvement'];

  for (const phrase of forbidden) {
    for (const [file, text] of Object.entries(SOURCE)) {
      assert.ok(!text.toLowerCase().includes(phrase), `${file} says '${phrase}'`);
    }
    for (const rendered of RENDERED) {
      assert.ok(!rendered.toLowerCase().includes(phrase), `the panel would render '${phrase}'`);
    }
  }
});

test('2 · no digit stands in a cell that is not derived', () => {
  const view = promotionPanelView(capsuleRows());
  assert.equal(view.power.kind, 'not_derived');

  // The six cells the specification names: Δ, both endpoints of the interval, MDE_n, MDI, and the two
  // gate parameters that OPEN-7 still holds open.
  assert.deepEqual(
    view.power.cells.map((cell) => cell.label),
    ['delta', 'ci_low', 'ci_high', 'MDE_n', 'MDI', 'alpha', 'C_max'],
  );

  for (const cell of view.power.cells) {
    assert.equal(cell.value, NOT_DERIVED, `${cell.label} carries something other than '${NOT_DERIVED}'`);
    assert.doesNotMatch(cell.value, /\d/, `${cell.label} carries a digit`);
    // A zero is the tempting value and the worst one: a zero in the Δ cell is a MEASURED zero to
    // anybody who reads it.
    assert.notEqual(cell.value, '0');
    assert.notEqual(cell.value, '—');
  }

  // The unit is named without the endpoints, and the interval itself is not printed at all: an
  // interval with a unit and no endpoints is exactly what the lint of the specification breaks a
  // build over.
  assert.equal(typeof view.power.ci_unit, 'string');
  assert.equal(view.power.delta, undefined, 'the not_derived branch can carry a figure');
  assert.equal(view.power.ci_low, undefined);
  assert.equal(view.power.ci_high, undefined);
});

test('3 · no typed error code the panel cannot raise', () => {
  const known = new Set([...GATEWAY_ERROR_CODES, ...APP_ERROR_CODES]);

  for (const [file, text] of Object.entries(SOURCE)) {
    for (const match of text.matchAll(/\bE_[A-Z][A-Z_]+\b/g)) {
      assert.ok(known.has(match[0]), `${file} names ${match[0]}, which is in neither closed register`);
    }
  }
  for (const rendered of RENDERED) {
    for (const match of rendered.matchAll(/\bE_[A-Z][A-Z_]+\b/g)) {
      assert.ok(known.has(match[0]), `the panel would render ${match[0]}`);
    }
  }

  // The three the specification writes beside the unevaluable conjuncts. They exist nowhere in this
  // tree — a grep over every file returns nothing — and the register is closed, so a panel printing
  // one would be asserting that a mechanism no build here carries had refused something. The reasons
  // are said in prose instead.
  for (const invented of ['E_MDE_AUSENTE', 'E_BATERIA_VENCIDA', 'E_QUERY_INDEX_NO_VERIFICABLE']) {
    assert.ok(!known.has(invented), `${invented} has been added to a closed register`);
    for (const [file, text] of Object.entries(SOURCE)) {
      assert.ok(!text.includes(invented), `${file} prints ${invented}`);
    }
    for (const rendered of RENDERED) {
      assert.ok(!rendered.includes(invented), `the panel would render ${invented}`);
    }
  }
});

test('4 · the quality surface is named only where it is disclaimed', () => {
  // One exemption, declared: the title of D-9 is a transcription of a row of Table 19 of the proposal
  // and is compared against it byte for byte elsewhere. Naming the deliverable that PAYS for a
  // surface is the opposite of claiming that surface.
  const allowed = new Set([SURFACE_SCOPE, ...PENDING_MILESTONES.map((entry) => entry.title)]);

  for (const claim of ['Model Quality', 'accuracy']) {
    for (const rendered of RENDERED) {
      if (!rendered.includes(claim)) continue;
      assert.ok(
        allowed.has(rendered),
        `the panel would render '${claim}' outside the disclaimer: ${rendered.slice(0, 80)}…`,
      );
    }
    // And the page and the reader name neither, at all.
    for (const file of ['src/server/promotion.ts', 'src/app/promotion/page.tsx']) {
      assert.ok(!SOURCE[file].includes(claim), `${file} names '${claim}'`);
    }
  }

  assert.ok(SURFACE_SCOPE.includes('does not stand in for the Model Quality surface'));
  assert.ok(SURFACE_SCOPE.includes('Decision Audit Log'));
});

test('5 · no budget figure the chain has not been asked to recompute', () => {
  // The only consumption counter in this tree sums `cost_aud` from the chain, and the schema forces
  // `cost_aud` to zero on a `start`. So any budget figure on this screen would be a number no ceiling
  // honours. The panel prints none.
  for (const rendered of RENDERED) {
    assert.doesNotMatch(rendered, /\bAUD\b/, `the panel would render a currency: ${rendered.slice(0, 60)}`);
    assert.doesNotMatch(rendered, /\$\s*\d/, `the panel would render an amount: ${rendered.slice(0, 60)}`);
    assert.doesNotMatch(
      rendered,
      /budget[^.]*\d/i,
      `the panel would render a budget figure: ${rendered.slice(0, 60)}`,
    );
  }
});

test('the presenter’s signed wording is nowhere in the surface', () => {
  // The demonstration script marks it [SAY] and its [SCREEN] list does not contain it. A panel that
  // painted it would put one signed sentence into two artefacts that can then disagree.
  const spoken = 'The promotion gate is shown in its honest state';
  for (const [file, text] of Object.entries(SOURCE)) {
    assert.ok(!text.includes(spoken), `${file} paints the line the presenter speaks`);
  }
  for (const rendered of RENDERED) {
    assert.ok(!rendered.includes(spoken), 'the panel would paint the line the presenter speaks');
  }
});
