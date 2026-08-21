/**
 * Reproducibility of the replayed month, guarded where it is actually fragile.
 *
 * The generated report is verified by regenerating it and comparing bytes, which is only as strong
 * as the claim that the same inputs produce the same stream on any engine. Almost everything here
 * is closed over exactly specified arithmetic — integer multiplies, shifts, divisions, comparisons
 * and declared roundings — and those cannot drift. **One operation is not.** `Math.log` draws the
 * inter-arrival gaps, and the standard specifies it as implementation-approximated: two versions of
 * an engine may return values differing in the last bit.
 *
 * Two guards, and the second is the one that matters. The gaps are snapped to a one-second grid, so
 * a last-bit difference has to land within one part in 10¹³ of a half-second boundary to change an
 * arrival at all. And the whole stream carries a pinned digest, so if it ever does change, the
 * build says *the arrival stream changed* by name instead of leaving a maintainer to discover a
 * one-line difference in a table of τ values and guess why.
 *
 * If this test fails and nothing in the generator was edited, the engine moved. That is a finding,
 * not a flake, and the pin is how it gets reported as one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRIORITY_DECIMALS, quantisePriority, queueKey, storedCollationKey } from '../../src/alg/priority.ts';
import {
  ARRIVAL_GRID_MS,
  DEFAULT_ARRIVALS,
  arrivalStreamDigest,
  exponentialGapMs,
  generateArrivals,
  makeRng,
} from '../../src/alg/simulation.ts';
import { NOW, T0, queueTicket } from './fixtures.mjs';

/**
 * The digest of the published stream: 10,000 arrivals from the published seed.
 *
 * Regenerating it after a deliberate change to the generator is correct and expected. Regenerating
 * it to make a red build go green, without knowing what moved, is the mistake this pin exists to
 * make visible.
 */
const PINNED_STREAM = 'f423b137b82f82adc8f571b574eab78efc1c3ba52f84e2fea165a4f8314ff397';

test('test_ALG_arrival_stream_is_pinned', () => {
  const arrivals = generateArrivals({ seed: DEFAULT_ARRIVALS.seed, count: 10_000 });
  assert.equal(arrivals.length, 10_000);
  assert.equal(
    arrivalStreamDigest(arrivals),
    PINNED_STREAM,
    'the arrival stream changed: either the generator was edited, or the engine moved under it',
  );

  // Generating it twice in one process gives the same stream, which is the weakest half; the pin
  // above is the half that survives a change of machine.
  assert.equal(arrivalStreamDigest(generateArrivals({ seed: DEFAULT_ARRIVALS.seed, count: 10_000 })), PINNED_STREAM);

  // Every arrival sits on the grid, so no engine difference below a second can move one.
  for (let index = 1; index < arrivals.length; index++) {
    const gap = arrivals[index].createdAt - arrivals[index - 1].createdAt;
    assert.equal(gap % ARRIVAL_GRID_MS, 0, `the gap before ${arrivals[index].id} is off the grid`);
    assert.ok(gap >= ARRIVAL_GRID_MS, 'two arrivals never share an instant');
  }

  // A different seed is a different month. A pin that held for every seed would be pinning nothing.
  assert.notEqual(arrivalStreamDigest(generateArrivals({ seed: 'other', count: 10_000 })), PINNED_STREAM);
});

test('test_ALG_arrival_gap_is_quantised', () => {
  const rng = makeRng('ledgerdesk/alg/gap-grid');
  for (let index = 0; index < 5_000; index++) {
    const gap = exponentialGapMs(rng(), 160_000);
    assert.equal(gap % ARRIVAL_GRID_MS, 0);
    assert.ok(gap >= ARRIVAL_GRID_MS, 'a gap is never zero, so arrivals are always ordered');
  }

  // The grid is what absorbs a last-bit difference: two draws a hair apart give the same gap.
  const u = 0.42;
  assert.equal(exponentialGapMs(u, 160_000), exponentialGapMs(u + Number.EPSILON, 160_000));
});

test('test_ALG_stored_precision_is_exact', () => {
  // The scale is written as a literal rather than raised as a power; this is the check that the
  // literal and the declared number of decimals still agree.
  assert.equal(quantisePriority(1), 1);
  assert.equal(quantisePriority(0.1234564), 0.123456);
  assert.equal(quantisePriority(0.1234566), 0.123457);
  assert.equal(String(quantisePriority(0.123456789)).split('.')[1].length, PRIORITY_DECIMALS);

  // Quantisation is monotone, which is what lets it stand between the raw score and the order:
  // rounding can collapse two scores into a tie, and it can never swap them.
  const rng = makeRng('ledgerdesk/alg/quantise-monotone');
  for (let index = 0; index < 20_000; index++) {
    const a = rng();
    const b = rng();
    const [low, high] = a <= b ? [a, b] : [b, a];
    assert.ok(quantisePriority(low) <= quantisePriority(high));
  }
});

test('test_ALG_collation_encoding_is_well_formed', () => {
  // Fixed-width fields, so that comparing the encodings as text is comparing the key as a key. A
  // width that overflowed would collate wrongly and silently, which is this encoding's one failure
  // mode — so the encoder refuses rather than truncates.
  const sample = storedCollationKey(queueKey(queueTicket(), NOW));
  const fields = sample.split('|');
  assert.equal(fields.length, 4);
  assert.equal(fields[0].length, 1);
  assert.equal(fields[1].length, 7);
  assert.equal(fields[2].length, 15);

  // Every key of every ticket encodes to the same widths, whatever the values.
  for (const ticket of generateArrivals({ seed: 'ledgerdesk/alg/collation', count: 500 })) {
    const encoded = storedCollationKey(queueKey(ticket, ticket.slaDueAt + 1));
    const parts = encoded.split('|');
    assert.equal(parts[0].length, 1);
    assert.equal(parts[1].length, 7);
    assert.equal(parts[2].length, 15);
  }

  assert.throws(
    () => storedCollationKey({ breached: false, priority: 12, createdAt: T0, id: 'T-1' }),
    RangeError,
    'a priority outside the encodable range must be refused, not silently wrapped',
  );
  assert.throws(
    () => storedCollationKey({ breached: false, priority: 0.5, createdAt: -1, id: 'T-1' }),
    RangeError,
  );
});
