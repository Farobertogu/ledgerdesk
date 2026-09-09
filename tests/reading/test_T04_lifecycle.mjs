import test from 'node:test';
import assert from 'node:assert/strict';
import { createObserverGates, cleanupSteps, withDeadline } from './lifecycle.mjs';

test('an unreached event and an unreleased observer each reject within their bound', async () => {
  const gates = createObserverGates(25);
  const reached = gates.deferred('Event never reached');
  const resume = gates.deferred('Observer never resumed');
  await Promise.all([
    assert.rejects(reached.promise, /Event never reached was not released/),
    assert.rejects(resume.promise, /Observer never resumed was not released/),
  ]);
  assert.equal(gates.count(), 0);
});

test('a failed assertion releases every parked observer at the subtest boundary', async () => {
  const gates = createObserverGates(1000);
  const first = gates.deferred(), second = gates.deferred();
  try { assert.fail('Injected assertion failure'); }
  catch (error) { assert.match(error.message, /Injected assertion/); }
  finally { gates.releaseAll(); }
  await Promise.all([first.promise, second.promise]);
  assert.equal(gates.count(), 0);
  gates.releaseAll();
});

test('normal gate resolution retains its value and leaves no timer or parked gate', async () => {
  const gates = createObserverGates(25), gate = gates.deferred();
  gate.resolve('reached'); gate.resolve('ignored');
  assert.equal(await gate.promise, 'reached'); assert.equal(gates.count(), 0);
});

test('cleanup attempts writer and cluster after a terminal close timeout, without reporting success', async () => {
  const calls = [];
  await assert.rejects(cleanupSteps([
    { label: 'terminal', close: () => { calls.push('terminal'); return new Promise(() => {}); } },
    { label: 'writer', close: () => { calls.push('writer'); throw new Error('Injected writer close error'); } },
    { label: 'cluster', close: () => { calls.push('cluster'); } },
  ], 25), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].cause.message, /exceeded 25 ms/);
    assert.match(error.errors[1].cause.message, /Injected writer/); return true;
  });
  assert.deepEqual(calls, ['terminal', 'writer', 'cluster']);
});

test('a stalled writer cannot prevent the cluster cleanup step', async () => {
  let clusterClosed = false;
  await assert.rejects(cleanupSteps([
    { label: 'writer', close: () => new Promise(() => {}) },
    { label: 'cluster', close: () => { clusterClosed = true; } },
  ], 25), AggregateError);
  assert.equal(clusterClosed, true);
});

test('cluster cleanup failures stay visible after the other resources close', async () => {
  await assert.rejects(cleanupSteps([
    { label: 'terminal', close: () => undefined },
    { label: 'cluster', close: () => { throw new Error('Removal not confirmed'); } },
  ], 25), (error) => error.errors.length === 1 && error.errors[0].cause.message === 'Removal not confirmed');
});

test('deadline preserves both synchronous exceptions and successful results', async () => {
  assert.equal(await withDeadline(() => 7, 'success', 25), 7);
  await assert.rejects(withDeadline(() => { throw new Error('original cause'); }, 'error', 25), /original cause/);
  await cleanupSteps([{ label: 'normal cleanup', close: () => undefined }], 25);
});
