import assert from 'node:assert/strict';

export const L03_REFERENCE = 'l03-exclusive-cgroup/1';
export const L03_BYTES = 536870912;
const fail = (condition, code) => assert.ok(condition, code);
const equal = (actual, expected, code) => assert.deepEqual(actual, expected, code);
const eventKeys = ['max', 'oom', 'oom_kill', 'oom_group_kill'];

export function counters(text) {
  fail(typeof text === 'string' && text.length <= 4096, 'COUNTERS_UNAVAILABLE');
  const entries = text.trim().split('\n').map(line => {
    const match = /^([a-z_]+) (0|[1-9][0-9]*)$/.exec(line);
    fail(match, 'COUNTERS_MALFORMED');
    fail(Number.isSafeInteger(Number(match[2])), 'COUNTERS_RANGE');
    return [match[1], Number(match[2])];
  });
  fail(new Set(entries.map(([key]) => key)).size === entries.length, 'COUNTERS_DUPLICATE');
  const value = Object.fromEntries(entries);
  for (const key of eventKeys) fail(Object.hasOwn(value, key), 'COUNTERS_MISSING');
  return value;
}

function zero(value, code) {
  for (const key of eventKeys) equal(value?.[key], 0, code);
}

export function validateArmed(record) {
  const { before, armed, container, reference } = record;
  equal(record.profile, L03_REFERENCE, 'REFERENCE_PROFILE');
  fail(/^system-ldl03[a-f0-9]{32}\.slice$/.test(reference), 'REFERENCE_NAME');
  fail(/^[a-f0-9]{64}$/.test(container.id), 'CONTAINER_ID');
  equal(container.parent, reference, 'CONTAINER_PARENT');
  equal(container.restartCount, 0, 'CONTAINER_RESTARTED');
  equal(container.restartPolicy, 'no', 'CONTAINER_RESTART_POLICY');
  equal(container.image, record.image, 'CONTAINER_IMAGE');
  const leaf = 'docker-' + container.id + '.scope';
  equal(before.path, '/system.slice/' + reference, 'REFERENCE_PATH');
  equal(before.processes, [], 'INITIAL_REFERENCE_OCCUPIED');
  equal(before.children, [], 'INITIAL_REFERENCE_HAS_CHILDREN');
  fail(before.identity && before.invocation, 'REFERENCE_IDENTITY_MISSING');
  equal(armed.identity, before.identity, 'REFERENCE_REPLACED');
  equal(armed.invocation, before.invocation, 'REFERENCE_RESTARTED');
  equal(armed.path, before.path, 'REFERENCE_MOVED');
  equal(armed.processes, [], 'REFERENCE_DIRECT_PROCESS');
  equal(armed.children.map(child => child.name), [leaf], 'FOREIGN_REFERENCE_CHILD');
  fail(Number.isSafeInteger(container.pid) && container.pid > 1, 'CONTAINER_PID');
  const child = armed.children[0];
  equal(child.processes, [container.pid], 'FOREIGN_REFERENCE_PROCESS');
  equal(child.children, [], 'NESTED_REFERENCE_CHILD');
  equal(container.membership, before.path + '/' + leaf, 'PROCESS_MEMBERSHIP');
  fail(/^[0-9]+$/.test(container.startTicks ?? ''), 'PROCESS_IDENTITY');
  equal(child.memoryMax, String(L03_BYTES), 'EFFECTIVE_MEMORY_LIMIT');
  equal(child.swapMax, '0', 'EFFECTIVE_SWAP_LIMIT');
  equal(child.cpuMax, '100000 100000', 'EFFECTIVE_CPU_LIMIT');
  equal(child.pidsMax, '64', 'EFFECTIVE_PID_LIMIT');
  equal(container.memory, L03_BYTES, 'DOCKER_MEMORY_LIMIT');
  equal(container.memorySwap, L03_BYTES, 'DOCKER_SWAP_LIMIT');
  fail(record.probeMatchesSource === true, 'NATIVE_PROBE_IDENTITY');
  for (const snapshot of [before, armed]) {
    equal(snapshot.active, 'active', 'REFERENCE_INACTIVE');
    equal(snapshot.memoryMax, 'max', 'ANCESTOR_LIMIT_CHANGED');
    zero(snapshot.events, 'PREEXISTING_MEMORY_EVENTS');
    zero(snapshot.localEvents, 'PREEXISTING_LOCAL_EVENTS');
  }
  zero(child.events, 'PREEXISTING_CHILD_EVENTS');
  return true;
}

// These counters prove limit pressure and an OOM-killed process in this owned
// case. They do not identify a historical failure or encode the OOM constraint.
// In particular, oom_kill alone also includes system-wide OOM victims.
export function validateTermination(record, mode) {
  validateArmed(record);
  fail(['memory', 'external', 'watchdog'].includes(mode), 'CONTROL_MODE');
  const { before, armed, after, outcome, container } = record;
  fail(after && outcome, 'TERMINAL_EVIDENCE_MISSING');
  equal(after.identity, before.identity, 'REFERENCE_REPLACED');
  equal(after.invocation, before.invocation, 'REFERENCE_RESTARTED');
  equal(after.path, before.path, 'REFERENCE_MOVED');
  equal(after.active, 'active', 'REFERENCE_NOT_RETAINED');
  equal(after.memoryMax, 'max', 'ANCESTOR_LIMIT_CHANGED');
  equal(after.processes, [], 'TERMINAL_REFERENCE_OCCUPIED');
  fail(after.children.length <= 1, 'FOREIGN_TERMINAL_CHILD');
  for (const child of after.children) {
    equal(child.name, armed.children[0].name, 'FOREIGN_TERMINAL_CHILD');
    equal(child.identity, armed.children[0].identity, 'TERMINAL_CHILD_REPLACED');
    equal(child.processes, [], 'TERMINAL_CHILD_OCCUPIED');
    equal(child.children, [], 'NESTED_TERMINAL_CHILD');
  }
  zero(after.localEvents, 'EVENT_FROM_REFERENCE_NOT_CASE');
  for (const key of eventKeys) fail(Number.isSafeInteger(after.events?.[key]) && after.events[key] >= armed.events[key], 'COUNTER_REGRESSION_OR_MISSING');
  equal(outcome.id, container.id, 'TERMINAL_CONTAINER_CHANGED');
  equal(outcome.running, false, 'CONTAINER_STILL_RUNNING');
  equal(outcome.restartCount, 0, 'CONTAINER_RESTARTED');
  equal(outcome.exit, 137, 'TERMINAL_EXIT');
  equal(outcome.clientCode, 137, 'ATTACHED_CLIENT_EXIT');
  equal(outcome.clientClosed, true, 'ATTACHED_CLIENT_UNCONFIRMED');
  equal(outcome.encodingError, false, 'CLIENT_ENCODING');
  if (mode === 'memory') {
    equal(outcome.reason, null, 'SUPERVISOR_INTERVENTION');
    equal(outcome.intervention, null, 'EXTERNAL_INTERVENTION');
    fail(after.events.max > 0 && after.events.oom > 0, 'CASE_LIMIT_NOT_REACHED');
    equal(after.events.oom_kill, 1, 'CASE_OOM_VICTIM_NOT_UNIQUE');
    equal(after.events.oom_group_kill, 0, 'UNEXPECTED_GROUP_OOM');
  } else {
    zero(after.events, 'CONTROL_HAS_MEMORY_EVENT');
    equal(outcome.reason, mode === 'watchdog' ? 'worker_timeout' : null, 'CONTROL_PRIMARY_CAUSE');
    equal(outcome.intervention, mode, 'CONTROL_INTERVENTION');
  }
  return { mode, limitBytes: L03_BYTES, memoryEvents: after.events,
    dockerOOMKilled: outcome.dockerOOMKilled, acceptedAsOOM: mode === 'memory' };
}

// Concrete IO is supplied by the Linux adapter. The same sequence is exercised
// with directed ports, including failures before release and during cleanup.
const terminalFailures = new WeakMap();
export const referenceFailure = error => error && typeof error === 'object' ? terminalFailures.get(error) : undefined;

export async function referenceCase(ports, mode) {
  let record = { profile: L03_REFERENCE, mode }, primary, cleanup;
  const errors = [], secondaryErrors = [];
  const observe = facts => Object.assign(record, facts);
  const failed = (phase, error) => {
    errors.push({ phase, message: error.message, code: error.code, actual: error.actual, expected: error.expected });
    if (!primary) primary = error; else secondaryErrors.push(error);
  };
  const retain = () => {
    if (primary) {
      record.failure = { message: primary.message, actual: primary.actual, expected: primary.expected };
      record.errors = errors;
      // Preserve the original object, even when the terminal file cannot be
      // written. The caller can include these facts in its terminal result.
      terminalFailures.set(primary, { record, secondaryErrors });
    }
  };
  try {
    const initial = await ports.prepare();
    record = { ...record, ...initial };
    await ports.persist('before', record);
    Object.assign(record, await ports.arm(record, mode));
    validateArmed(record);
    await ports.persist('armed', record);
    record.outcome = await ports.execute(mode, observe);
    // Keep the reference alive through this read and its durable export.
    record.after = await ports.readAfter(record);
    await ports.persist('after', record);
    record.verdict = validateTermination(record, mode);
    if (mode !== 'memory') {
      assert.throws(() => validateTermination(record, 'memory'), undefined,
        'Negative control must fail the actual OOM acceptance function');
    }
  } catch (error) { failed('execution', error); }
  finally {
    if (primary && ports.recoverTerminal) {
      try {
        // This bounded read happens before disposal, not after the reference
        // has disappeared. Partial observations remain useful on failure.
        const failures = await ports.recoverTerminal(observe);
        for (const { phase, error } of failures) failed(phase, error);
        await ports.persist('postmortem', record);
      } catch (error) { failed('postmortem-export-or-read', error); }
    }
    try { cleanup = await ports.cleanup(); }
    catch (error) { cleanup = { confirmed: false, code: error.code ?? 'CLEANUP_FAILED' }; failed('cleanup', error); }
    record.cleanup = cleanup;
    if (!cleanup?.confirmed) failed('cleanup-confirmation', Error('CLEANUP_UNCONFIRMED'));
    retain();
    try { await ports.persist('result', record); }
    catch (error) { failed('result-export', error); retain(); }
  }
  if (primary) throw primary;
  return record;
}
