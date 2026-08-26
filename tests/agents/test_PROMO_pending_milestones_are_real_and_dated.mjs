// test_PROMO_pending_milestones_are_real_and_dated
//
// *"When will this be green?"* is the second safe question an examiner asks. Answered once, aloud,
// for four rows at a time, it is a promise; answered per row on the screen with a dated deliverable
// it is a fact the reader can check in the document beside it. So the dates drop to row level — and
// the moment they do, they have to be the REAL dates, taken from the table that publishes them.
//
// This file opens `docs/PROPOSAL.md`, pulls the D-9 and D-11 rows out of Table 19, and compares them
// against the constant byte for byte.
//
// **Two fields, and the second is why the build does not turn red for telling the truth.** D-9 falls
// due on 14 September and `main` is protected by the `check` and `db` jobs. A test that failed on the
// mere passing of a date would put `main` in red on 15 September with no change of code, while the
// work of D-10 and D-11 runs to 4 October — the build going red for saying something true. The rule
// is: red when the date has passed AND the deliverable has not landed. A warning would not do,
// because warnings are not read.
//
// **The clash with the specification is declared, not silenced.** `02_SPEC.md:1251` says *"pending
// M6, with a date"*; M6 is 4 October, which is D-11. The two are one commitment in two vocabularies,
// and the panel prints the Table 19 identifiers because those are the ones a reader can look up.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  CONJUNCT_MILESTONE,
  CONJUNCT_NAMES,
  milestoneState,
  PENDING_MILESTONES,
  promotionPanelView,
} from '../../src/alg/promotion_panel.ts';
import { capsuleRows } from './promotion_fixture.mjs';

const PANEL = 'src/alg/promotion_panel.ts';

/** Table 19 of the proposal, as rows: `| D-9 | title | owner | support | date | evidence |`. */
function tableNineteen() {
  const text = readFileSync('docs/PROPOSAL.md', 'utf8');
  const rows = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\|\s*(D-\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (!match) continue;
    rows.set(match[1], { title: match[2].trim(), date: match[5].trim() });
  }
  return rows;
}

test('the two milestones are rows of Table 19, with their published titles and dates', () => {
  const published = tableNineteen();
  assert.ok(published.size >= 16, `Table 19 was not found in docs/PROPOSAL.md (${published.size} rows)`);

  for (const entry of PENDING_MILESTONES) {
    const row = published.get(entry.id);
    assert.ok(row, `${entry.id} is not a row of Table 19`);
    assert.equal(entry.title, row.title, `${entry.id}: title`);
    assert.equal(entry.published_date, row.date, `${entry.id}: date`);
    assert.notEqual(entry.date.trim(), '', `${entry.id}: the ISO date is empty`);

    // The two spellings of one date have to be the same day. The ISO one is what the expiry rule
    // reads; the published one is what the screen prints and what the comparison above pins.
    const iso = new Date(`${entry.date}T00:00:00Z`);
    const printed = new Date(`${row.date} UTC`);
    assert.equal(
      iso.toISOString().slice(0, 10),
      printed.toISOString().slice(0, 10),
      `${entry.id}: '${entry.date}' and '${row.date}' are different days`,
    );
  }

  assert.deepEqual(PENDING_MILESTONES.map((entry) => entry.id), ['D-9', 'D-11']);
});

// The staleness of a published date is RENDERED by the panel, never enforced by this build: `main`
// is protected by `check`, so a test that failed on the mere passing of a date would block every
// merge in this repository on a morning when no code changed and no committer could act. What is
// asserted here is the function that reports it — both branches pinned against a supplied instant,
// so the assertion is about the rule and never about the day this file happens to run.
test('milestoneState reports the published date as ahead or as due, from a supplied instant', () => {
  const [first] = PENDING_MILESTONES;
  const dayBefore = new Date(`${first.date}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const dayAfter = new Date(`${first.date}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

  assert.equal(milestoneState(first, dayBefore), 'ahead');
  assert.equal(milestoneState(first, new Date(`${first.date}T00:00:00Z`)), 'ahead', 'the day itself is not yet past');
  assert.equal(milestoneState(first, dayAfter), 'due');
});

test('every unevaluable conjunct carries the deliverable that will make it evaluable', () => {
  assert.deepEqual(Object.keys(CONJUNCT_MILESTONE), [...CONJUNCT_NAMES]);
  assert.deepEqual(CONJUNCT_MILESTONE, {
    paired_significant_at_alpha: 'D-9',
    delta_positive: 'D-11',
    battery_in_force_green: 'D-11',
    query_index_within_cmax: 'D-9',
  });

  const view = promotionPanelView(capsuleRows());
  for (const conjunct of view.conjuncts) {
    if (conjunct.verdict !== 'UNEVALUABLE') {
      assert.equal(conjunct.milestone, null, `${conjunct.name} is ${conjunct.verdict} and is dated`);
      continue;
    }
    assert.ok(conjunct.milestone, `${conjunct.name} is UNEVALUABLE with no dated deliverable`);
    assert.equal(conjunct.milestone.id, CONJUNCT_MILESTONE[conjunct.name]);
    assert.notEqual(conjunct.milestone.published_date.trim(), '');
  }
});

test('the panel names the deliverables and never the milestone vocabulary', () => {
  const source = readFileSync(PANEL, 'utf8');
  // Two vocabularies for one commitment is how a screen and a document come to disagree. The panel
  // prints the identifiers of the table it cites. The reconciliation between them is a comment, and
  // the comment is where `M6` may appear — never a rendered string.
  const rendered = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(rendered, /\bM6\b/, 'the panel prints the milestone vocabulary');
});

test('neither date is a loose literal anywhere else under src/', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  };
  walk('src');

  for (const entry of PENDING_MILESTONES) {
    for (const file of files) {
      if (path.resolve(file) === path.resolve(PANEL)) continue;
      const text = readFileSync(file, 'utf8');
      assert.ok(
        !text.includes(entry.date) && !text.includes(entry.published_date),
        `${file} carries the date of ${entry.id} as a literal; it belongs in ${PANEL} alone`,
      );
    }
  }
});
