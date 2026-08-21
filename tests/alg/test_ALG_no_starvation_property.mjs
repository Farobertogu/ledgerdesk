/**
 * Case 9 of the published edge cases: low-severity starvation.
 *
 * The claim is not "low-severity tickets are usually fine". It is that a ticket's wait is bounded
 * no matter how much higher-scoring work arrives after it, and the bound holds because of two
 * properties of the order key rather than because of luck in one replay:
 *
 *   1. urgency is non-decreasing in time and reaches its maximum at the due instant, so waiting
 *      can only ever raise a ticket's score — nothing a later arrival does can lower it;
 *   2. past the due instant the breach class takes over, and every breached ticket precedes every
 *      non-breached one whatever the two scores are.
 *
 * Both are checked generatively below, and then demonstrated over ten thousand replayed arrivals:
 * everything is served, every cohort is served, and the longest wait does not grow when four times
 * as much work arrives. That last one is the whole of it — a starving queue is exactly one whose
 * worst wait grows with the volume behind it.
 *
 * Every number comes from a seeded stream. There is no `Math.random` in this file and no clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRIORITY_WEIGHTS, compareQueueKeys, computePriority, queueKey } from '../../src/alg/priority.ts';
import {
  DEFAULT_ARRIVALS,
  DEFAULT_REPLAY,
  generateArrivals,
  makeRng,
  replay,
} from '../../src/alg/simulation.ts';

const ARRIVALS = 10_000;

/**
 * How much the worst wait may grow when four times the work arrives. Proportional growth would be
 * ×4 and would be starvation; the measured figure is about ×1.6, and what it measures is mostly
 * that a longer replay contains more days and therefore a more extreme worst day.
 */
const MAX_WAIT_GROWTH_ALLOWANCE = 2;

/**
 * How far the 95th percentile of the wait may move over the same fourfold increase.
 *
 * This is the tight half of the pair. The extreme wait is a maximum over more days and drifts for
 * that reason alone; the body of the distribution has no such excuse, and a queue that was quietly
 * accumulating work would show it here first.
 */
const P95_DRIFT_ALLOWANCE = 0.1;

function percentileOf(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

test('test_ALG_no_starvation_property', (t) => {
  // ---- 1. Waiting never costs a ticket anything -----------------------------------------------
  const rng = makeRng('ledgerdesk/alg/starvation/monotonicity');
  const sample = generateArrivals({ seed: 'ledgerdesk/alg/starvation/vectors', count: 2_000 });

  for (const ticket of sample) {
    const window = ticket.slaDueAt - ticket.createdAt;
    // Three instants spread across and beyond the window, always moving forward.
    let now = ticket.createdAt - Math.floor(rng() * window);
    let previous = computePriority(ticket, now).score;
    for (let step = 0; step < 4; step++) {
      now += Math.floor(rng() * window * 1.5) + 1;
      const score = computePriority(ticket, now).score;
      assert.ok(
        score >= previous - 1e-12,
        `the score of ${ticket.id} fell as time passed: ${previous} then ${score}`,
      );
      previous = score;
    }
    // At the due instant urgency is spent, and it stays spent afterwards.
    const atDue = computePriority(ticket, ticket.slaDueAt);
    assert.equal(atDue.components.urgency.normalised, 1);
    assert.equal(atDue.breached, false, 'a ticket is not breached at its due instant, only past it');
    const pastDue = computePriority(ticket, ticket.slaDueAt + 1);
    assert.equal(pastDue.components.urgency.normalised, 1);
    assert.equal(pastDue.breached, true);
    assert.ok(pastDue.score >= atDue.score - 1e-12);
  }

  // ---- 2. Breach outranks score, always --------------------------------------------------------
  // The pairing is deliberately hostile: the breached ticket is the mildest possible and the
  // non-breached one the most severe, so the only thing that can put the first in front is the
  // breach class itself.
  for (let index = 0; index < 500; index++) {
    const breachedTicket = {
      id: `T-B-${index}`,
      severity: 1,
      sentiment: 1,
      tier: 'standard',
      valueBand: 1,
      createdAt: 0,
      slaDueAt: 1_000,
    };
    const now = 1_000 + Math.floor(rng() * 1e6) + 1;
    const freshTicket = {
      id: `T-A-${index}`,
      severity: 4,
      sentiment: -1,
      tier: 'premium',
      valueBand: 5,
      createdAt: now - 1,
      slaDueAt: now + 1_000,
    };
    assert.ok(computePriority(freshTicket, now).score > computePriority(breachedTicket, now).score);
    assert.ok(
      compareQueueKeys(queueKey(breachedTicket, now), queueKey(freshTicket, now)) < 0,
      'a breached ticket must precede a non-breached one whatever the two scores are',
    );
  }

  // ---- 2b. The dominance inequality: who can still overtake a breached ticket -------------------
  //
  // This is the sharp form of the bound and it holds as an inequality, not as a tendency. Once a
  // ticket is breached, the only tickets that can be served before it are those with a **strictly
  // greater** priority. Everything else — every later arrival, however severe, however furious,
  // however valuable the account — is behind it, because a non-breached ticket loses on the first
  // column and an equally-scoring breached one loses on age. So the set that can overtake a waiting
  // ticket is not "the future": it is a fixed class fixed by its own score, and the wait is that
  // class's arrivals divided by the service rate. That is what makes the wait finite whenever the
  // service rate exceeds the arrival rate, and it is provable rather than measured.
  const overtakers = generateArrivals({ seed: 'ledgerdesk/alg/starvation/dominance', count: 1_500 });
  for (const waiting of overtakers.slice(0, 300)) {
    const now = waiting.slaDueAt + 1; // the instant it breaches
    const waitingKey = queueKey(waiting, now);
    assert.equal(waitingKey.breached, true);

    for (const later of overtakers.slice(300, 600)) {
      // Any ticket created after it, evaluated at the same instant.
      const rival = { ...later, id: `R-${later.id}`, createdAt: waiting.createdAt + 1 };
      const rivalKey = queueKey(rival, now);
      if (rivalKey.priority <= waitingKey.priority) {
        assert.ok(
          compareQueueKeys(waitingKey, rivalKey) < 0,
          `${rival.id} does not outscore the breached ${waiting.id} yet was placed in front of it`,
        );
      }
    }
  }

  // ---- 3. Ten thousand arrivals, replayed ------------------------------------------------------
  const seeds = ['ledgerdesk/alg/arrivals/v1', 'ledgerdesk/alg/starvation/seed-2'];
  for (const seed of seeds) {
    const arrivals = generateArrivals({ seed, count: ARRIVALS });
    const result = replay({ arrivals, weights: DEFAULT_PRIORITY_WEIGHTS, ...DEFAULT_REPLAY });

    assert.deepEqual(result.unserved, [], `${seed}: tickets were left in the queue`);
    assert.equal(result.served.length, ARRIVALS, `${seed}: not every arrival was served`);
    assert.ok(Number.isFinite(result.maxWaitMs));

    // Every cohort is served, and the one the case is about — the mildest tickets on the smallest
    // accounts — is served completely. A starved cohort would show up here as a service rate below
    // one, whatever the aggregate looked like.
    const cohorts = new Map();
    for (const ticket of arrivals) {
      const key = `${ticket.tier}/sev${ticket.severity}`;
      cohorts.set(key, (cohorts.get(key) ?? 0) + 1);
    }
    const servedByCohort = new Map();
    let worstLowSeverityWait = 0;
    for (const record of result.served) {
      const key = `${record.tier}/sev${record.severity}`;
      servedByCohort.set(key, (servedByCohort.get(key) ?? 0) + 1);
      if (record.severity === 1) worstLowSeverityWait = Math.max(worstLowSeverityWait, record.waitMs);
    }
    for (const [cohort, count] of cohorts) {
      assert.equal(servedByCohort.get(cohort), count, `${seed}: cohort ${cohort} was not served in full`);
    }
    assert.ok(worstLowSeverityWait > 0, `${seed}: the low-severity cohort must actually have queued`);

    t.diagnostic(
      `${seed}: peak queue ${result.peakQueueLength}, worst wait ${(result.maxWaitMs / 60000).toFixed(1)} min, ` +
        `worst low-severity wait ${(worstLowSeverityWait / 60000).toFixed(1)} min`,
    );
  }

  // ---- 4. The bound does not grow with the volume behind it ------------------------------------
  // The same stream, replayed at a quarter, a half and its full length. If later arrivals could
  // push an earlier ticket back indefinitely, the worst wait would grow with the volume; it does
  // not, because urgency and the breach class put a ceiling on how far back anything can be pushed.
  const stream = generateArrivals({ seed: DEFAULT_ARRIVALS.seed, count: ARRIVALS });
  const measured = [];
  for (const size of [ARRIVALS / 4, ARRIVALS / 2, ARRIVALS]) {
    const prefix = stream.slice(0, size);
    const result = replay({ arrivals: prefix, weights: DEFAULT_PRIORITY_WEIGHTS, ...DEFAULT_REPLAY });
    assert.deepEqual(result.unserved, [], `the prefix of ${size} arrivals did not drain`);
    const waits = result.served.map((record) => record.waitMs);
    measured.push({ size, maxWaitMs: result.maxWaitMs, p95WaitMs: percentileOf(waits, 0.95) });
  }

  const first = measured[0];
  const last = measured[measured.length - 1];
  const volumeRatio = last.size / first.size;
  const maxGrowth = last.maxWaitMs / first.maxWaitMs;
  const p95Drift = Math.abs(last.p95WaitMs / first.p95WaitMs - 1);

  t.diagnostic(
    `wait by volume: ${measured
      .map((m) => `${m.size}→p95 ${(m.p95WaitMs / 60000).toFixed(1)} / max ${(m.maxWaitMs / 60000).toFixed(1)} min`)
      .join(', ')} (×${volumeRatio} the arrivals: max ×${maxGrowth.toFixed(2)}, p95 ${(p95Drift * 100).toFixed(1)} %)`,
  );

  assert.ok(
    maxGrowth <= MAX_WAIT_GROWTH_ALLOWANCE && maxGrowth < volumeRatio,
    `the worst wait grew ×${maxGrowth.toFixed(2)} when ×${volumeRatio} the work arrived, which is starvation`,
  );
  assert.ok(
    p95Drift <= P95_DRIFT_ALLOWANCE,
    `the 95th percentile of the wait moved ${(p95Drift * 100).toFixed(1)} % with ×${volumeRatio} the volume, which is a queue accumulating work`,
  );
});
