// T01: bounded synthetic Node HTTP experiments, NOT Next/T04/T05 acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { latch, openTerminalProbe, PROBE_MARKER, staleHandoffs } from './terminal_probe.mjs';
import { validateDetailResponse, validateProblem } from '../../src/contracts/material_reading.ts';

async function probeFor(t) {
  const probe = await openTerminalProbe();
  t.after(async () => {
    await probe.close();
    assert.deepEqual(probe.handlerErrors, [], 'server-side hook errors are not a successful denial');
  });
  return probe;
}

const sequence = (probe, type) => probe.events.find((event) => event.type === type)?.sequence;
const hasMaterial = (result) => result.json.projection?.original_text?.includes(PROBE_MARKER) === true;

test('T01 gate denies disabled experiment and absent server context before material lookup', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  for (const scenario of [{ enabled: false }, { context: false }]) {
    const result = await probe.read(scenario);
    assert.equal(result.status, 403);
    assert.equal(hasMaterial(result), false);
    assert.equal(validateProblem(result.json).ok, true);
  }
  assert.equal(probe.events.some((event) => event.type === 'prepared'), false);
  assert.equal(probe.events.some((event) => event.type === 'handoff_attempt'), false);
});

test('T01 positive: stable control delivers exact synthetic text to an independent HTTP client', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const result = await probe.read();
  assert.equal(result.status, 200);
  assert.equal(result.json.projection.original_text, PROBE_MARKER);
  assert.equal(validateDetailResponse(result.json).ok, true, 'the probe must emit the declared profile');
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.ok(sequence(probe, 'control_commit_simulated') < sequence(probe, 'handoff_attempt'));
  assert.ok(sequence(probe, 'handoff_attempt') < sequence(probe, 'client_bytes'));
  assert.deepEqual(staleHandoffs(probe.events), []);
  t.diagnostic('Scope: synthetic single-process coordination + real Node HTTP on 127.0.0.1. SQL commits are simulated. Next/PG/TLS/proxy/kernel fencing and strict expiry remain NOT DEMONSTRATED.');
});

test('T01 committed invalidation after preparation denies the stale DTO', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const result = await probe.read({ afterPrepare: () => probe.invalidate() });
  assert.equal(result.status, 404);
  assert.equal(hasMaterial(result), false);
  assert.equal(probe.events.some((event) => event.type === 'handoff_attempt'), false);
  assert.deepEqual(staleHandoffs(probe.events), []);
});

test('T01 common admission orders requested invalidation after the bounded handoff, then denies re-reading', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const committed = latch();
  const continueHandoff = latch();
  const reading = probe.read({ afterCommit: async () => { committed.release(); await continueHandoff.promise; } });
  await committed.promise;
  const invalidation = probe.invalidate();
  try {
    assert.ok(sequence(probe, 'invalidation_requested'));
    assert.equal(sequence(probe, 'invalidation_committed_simulated'), undefined);
  } finally { continueHandoff.release(); }
  const first = await reading;
  await invalidation;
  assert.equal(first.status, 200);
  assert.equal(hasMaterial(first), true);
  assert.ok(sequence(probe, 'handoff_attempt') < sequence(probe, 'invalidation_committed_simulated'));
  assert.deepEqual(staleHandoffs(probe.events), []);
  const second = await probe.read();
  assert.equal(second.status, 404);
  assert.equal(hasMaterial(second), false);
});

test('T01 simulated loss of control after commit stops a new handoff', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const result = await probe.read({ afterCommit: () => probe.loseControl() });
  assert.equal(result.status, 503);
  assert.equal(hasMaterial(result), false);
  assert.equal(probe.events.some((event) => event.type === 'handoff_attempt'), false);
});

test('T01 old generation cannot obtain fresh handoff; this is not socket fencing', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const result = await probe.read({ afterPrepare: () => probe.invalidate('generation') });
  assert.equal(result.status, 503);
  assert.equal(hasMaterial(result), false);
  assert.equal(probe.events.some((event) => event.type === 'handoff_attempt'), false);
});

test('T01 oracle detects unsafe mutation: trusting authorization from preparation', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const result = await probe.read({ unsafe: 'stale-authorization', afterPrepare: () => probe.invalidate() });
  assert.equal(result.status, 200, 'unsafe control must actually reach the client');
  assert.equal(hasMaterial(result), true);
  assert.equal(staleHandoffs(probe.events).length, 1, 'oracle must reject the leaked stale handoff');
});

test('T01 oracle detects unsafe mutation: releasing admission between commit and handoff', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const result = await probe.read({ unsafe: 'release-before-handoff', afterCommit: () => probe.invalidate() });
  assert.equal(result.status, 200, 'unsafe control must actually reach the client');
  assert.equal(hasMaterial(result), true);
  assert.equal(staleHandoffs(probe.events).length, 1, 'oracle must reject the commit/transport gap');
});

test('T01 expiry probe REPRODUCES a real-clock pause gap; strict expiry is NOT demonstrated', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const result = await probe.read({
    validForMs: 20,
    afterTemporalCheck: async ({ deadline }) => {
      while (performance.now() <= deadline) await delay(Math.max(1, deadline - performance.now() + 5));
    },
  });
  const handoff = probe.events.find((event) => event.type === 'handoff_attempt');
  assert.equal(result.status, 200);
  assert.equal(hasMaterial(result), true);
  assert.ok(handoff.at > handoff.deadline, 'the real-clock deadline must precede actual write attempt');
  t.diagnostic(`EXPIRY GAP OBSERVED: handoff ${Math.round((handoff.at - handoff.deadline) * 1000) / 1000} ms after deadline. Passing this experiment records a reproduced limitation, not a conforming terminal.`);
});

test('T01 bounded buffer observation distinguishes prior handoff from later client receipt', { timeout: 6000 }, async (t) => {
  const probe = await probeFor(t);
  const ready = latch();
  let resume;
  const reading = probe.read({ large: true, pauseClient: true, onClientReady: (resumeClient) => { resume = resumeClient; ready.release(); } });
  await ready.promise;
  try {
    await probe.invalidate();
    assert.equal(probe.events.some((event) => event.type === 'client_bytes'), false);
  } finally { resume(); }
  const result = await reading;
  assert.equal(result.status, 200);
  assert.equal(result.json.projection.original_text.length, 100000, 'stay inside the reading text profile');
  assert.equal(result.json.projection.original_text, PROBE_MARKER.padEnd(100000, 'x'));
  assert.equal(validateDetailResponse(result.json).ok, true);
  assert.ok(sequence(probe, 'handoff_attempt') < sequence(probe, 'invalidation_committed_simulated'));
  assert.ok(sequence(probe, 'invalidation_committed_simulated') < sequence(probe, 'client_bytes'));
  assert.deepEqual(staleHandoffs(probe.events), []);
  const write = probe.events.find((event) => event.type === 'node_write_returned');
  t.diagnostic(write.acceptedWithoutBackpressure
    ? 'NODE BACKPRESSURE NOT OBSERVED for the bounded profile. Later receipt of prior bytes observed; no buffer-fencing claim.'
    : `NODE BACKPRESSURE OBSERVED: write returned false, writableLength=${write.writableLength}. These are Node queue observations, not kernel/proxy fencing.`);
  t.diagnostic('The client consumed an earlier handoff after invalidation. Receipt time alone is not evidence of an unauthorized later handoff. Sensitive-route terminal guarantee remains NOT DEMONSTRATED.');
});
