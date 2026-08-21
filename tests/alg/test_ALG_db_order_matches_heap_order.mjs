/**
 * Case 14 of the published edge cases: the queue served from storage and the queue served from the
 * heap are the same queue.
 *
 * There are two ways to order the queue and the system uses both. Storage sorts rows by the four
 * key columns; the simulation harness pops a heap. They are two readings of one rule, and the
 * moment they disagree the demonstration and the measurements stop describing the same system.
 *
 * **What this file proves and what it does not.** It holds the heap against an independent
 * implementation of the sort a storage engine performs over the key columns — written separately,
 * in `compareStoredRows`, precisely so that the comparison is between two expressions of the rule
 * rather than between one expression and itself. It does **not** execute that sort in a database:
 * the query and the index it runs over belong to the increment that introduces the queue view, and
 * the check against a live engine belongs to the job that has one. Until then, what is verified
 * here is that the two orderings agree; that a database performs the third is not claimed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareStoredRows, compareQueueKeys, queueKey } from '../../src/alg/priority.ts';
import { generateArrivals, heapOrder, storedOrder } from '../../src/alg/simulation.ts';

const ARRIVALS = 10_000;

/** Weight configurations the agreement is checked under, not just the published one. */
const CONFIGURATIONS = [
  { id: 'C-base', weights: { severity: 0.35, negativity: 0.25, urgency: 0.3, tier: 0.1 } },
  { id: 'C-sla', weights: { severity: 0.25, negativity: 0.2, urgency: 0.45, tier: 0.1 } },
  { id: 'C-sev', weights: { severity: 0.5, negativity: 0.2, urgency: 0.2, tier: 0.1 } },
];

test('test_ALG_db_order_matches_heap_order', (t) => {
  const arrivals = generateArrivals({ seed: 'ledgerdesk/alg/arrivals/v1', count: ARRIVALS });
  const firstArrival = arrivals[0].createdAt;
  const lastArrival = arrivals[arrivals.length - 1].createdAt;

  // Four instants along the replayed month. The instant matters: it decides which tickets are
  // breached and how much of each SLA window has been spent, so an agreement that held only at one
  // moment would be an agreement about nothing.
  const instants = [
    firstArrival,
    firstArrival + Math.floor((lastArrival - firstArrival) / 3),
    firstArrival + Math.floor((2 * (lastArrival - firstArrival)) / 3),
    lastArrival,
  ];

  for (const configuration of CONFIGURATIONS) {
    for (const now of instants) {
      const fromHeap = heapOrder(arrivals, now, configuration.weights);
      const fromStorage = storedOrder(arrivals, now, configuration.weights);

      assert.equal(fromHeap.length, ARRIVALS);
      assert.deepEqual(
        fromHeap,
        fromStorage,
        `${configuration.id}: the heap order and the stored order diverged at ${now}`,
      );
    }
  }

  // The agreement is not vacuous: at the middle instant the queue really is a mixture of breached
  // and unbreached tickets, which is the only situation in which the first key column decides
  // anything at all.
  const now = instants[2];
  const keys = arrivals.map((ticket) => queueKey(ticket, now, CONFIGURATIONS[0].weights));
  const breached = keys.filter((key) => key.breached).length;
  assert.ok(breached > 0 && breached < ARRIVALS, 'the sampled instant must mix breached and unbreached tickets');

  // And distinct priorities really do occur, so the second column decides something too.
  assert.ok(new Set(keys.map((key) => key.priority)).size > 1_000, 'the priorities must actually differ');

  t.diagnostic(
    `${ARRIVALS} tickets ordered at ${instants.length} instants under ${CONFIGURATIONS.length} weight ` +
      `configurations; at the sampled instant ${breached} were breached`,
  );

  // The two comparators agree pair by pair, not merely on the sorted result. A sort can hide a
  // disagreement between two comparators whenever the pair never gets compared.
  for (let index = 0; index + 1 < 2_000; index++) {
    const a = queueKey(arrivals[index], now, CONFIGURATIONS[0].weights);
    const b = queueKey(arrivals[ARRIVALS - 1 - index], now, CONFIGURATIONS[0].weights);
    assert.equal(
      Math.sign(compareQueueKeys(a, b)),
      Math.sign(compareStoredRows(a, b)),
      `the two readings of the key disagreed on ${a.id} against ${b.id}`,
    );
  }
});
