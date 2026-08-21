// test_TRIAGE_run_registry_claims_without_awaiting
//
// The deterministic half of a deadlock's regression guard.
//
// What went wrong: the composition root asserted "no two organisations share a run" by walking its
// registry of runtimes and **awaiting** each other organisation's entry to read the run out of it.
// Those entries are promises and they are frequently in flight, so two organisations starting
// together each awaited the other, for ever, with no timeout and no error — a request that never
// answers, in the one path every request goes through.
//
// The symptom has a guard of its own — `test_APP_composition_root_serves_two_orgs` puts two
// organisations through the real server with a deadline — and that guard is a guard on **luck**:
// the window is narrow, it needs both runtimes registered before either passes its first await, and
// a run that misses it passes. Measured, and worth saying plainly: with the faulty assert restored,
// that test went green.
//
// So the mechanism gets its own test, here, where it is deterministic. The claim is a synchronous
// operation over a plain map, and every case below is about that being true — including the one
// that says so directly, because "this function does not return a promise" is precisely the
// property whose loss reintroduces the bug.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  claimRun,
  createRunClaims,
  holderOf,
  releaseRun,
} from '../../src/server/run_registry.ts';

const RUN_A = 'a1111111-1111-4111-8111-111111111111';
const RUN_B = 'b2222222-2222-4222-8222-222222222222';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('test_TRIAGE_run_registry_claims_without_awaiting', () => {
  it('claims a free run', () => {
    const claims = createRunClaims();
    claimRun(claims, RUN_A, ORG_A);
    assert.equal(holderOf(claims, RUN_A), ORG_A);
  });

  it('refuses a run another organisation holds, and names both', () => {
    const claims = createRunClaims();
    claimRun(claims, RUN_A, ORG_A);

    assert.throws(
      () => claimRun(claims, RUN_A, ORG_B),
      (error) => error.message.includes(ORG_A) && error.message.includes(ORG_B),
      'a second organisation took a run that was already held',
    );

    // The refusal leaves the holder where it was: a rejected claim must not half-apply.
    assert.equal(holderOf(claims, RUN_A), ORG_A);
  });

  it('is idempotent for the holder, because a failed build gets retried', () => {
    const claims = createRunClaims();
    claimRun(claims, RUN_A, ORG_A);
    claimRun(claims, RUN_A, ORG_A);
    claimRun(claims, RUN_A, ORG_A);
    assert.equal(holderOf(claims, RUN_A), ORG_A);
  });

  it('keeps organisations out of each other s runs and lets them hold their own', () => {
    const claims = createRunClaims();
    claimRun(claims, RUN_A, ORG_A);
    claimRun(claims, RUN_B, ORG_B);
    assert.equal(holderOf(claims, RUN_A), ORG_A);
    assert.equal(holderOf(claims, RUN_B), ORG_B);
  });

  it('releases only the holder s own claim', () => {
    const claims = createRunClaims();
    claimRun(claims, RUN_A, ORG_A);

    // A build failing in one organisation must not release another organisation's run.
    releaseRun(claims, RUN_A, ORG_B);
    assert.equal(holderOf(claims, RUN_A), ORG_A, 'a stranger released a claim');

    releaseRun(claims, RUN_A, ORG_A);
    assert.equal(holderOf(claims, RUN_A), undefined);

    // And once released it is free, which is what makes a retried build work.
    claimRun(claims, RUN_A, ORG_B);
    assert.equal(holderOf(claims, RUN_A), ORG_B);
  });

  it('releases a run nobody holds without complaining', () => {
    const claims = createRunClaims();
    releaseRun(claims, RUN_A, ORG_A);
    assert.equal(holderOf(claims, RUN_A), undefined);
  });

  // THE ONE THAT MATTERS. The deadlock was not a wrong answer, it was an await in a place that
  // cannot have one. A future edit that reached for a promise in here — to look something up, to
  // read a runtime, to ask a database — would reintroduce it, and this is the only place it could
  // be caught before it hung a server.
  it('answers without a promise, which is the property the deadlock cost', () => {
    const claims = createRunClaims();

    const claimed = claimRun(claims, RUN_A, ORG_A);
    assert.equal(claimed, undefined, 'claimRun returned a value; if it is ever a promise, it can deadlock');
    assert.ok(!isThenable(claimed));

    // The effect is already visible on the very next line, with nothing awaited in between: that
    // is what "synchronous" has to mean here, and a promise-returning version would fail this.
    assert.equal(holderOf(claims, RUN_A), ORG_A, 'the claim had not taken effect by the next statement');

    assert.ok(!isThenable(releaseRun(claims, RUN_A, ORG_A)));
    assert.equal(holderOf(claims, RUN_A), undefined);

    for (const fn of [claimRun, releaseRun, holderOf, createRunClaims]) {
      assert.notEqual(
        fn.constructor.name,
        'AsyncFunction',
        `${fn.name} is async; the run claim must not be awaitable`,
      );
    }
  });
});

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}
