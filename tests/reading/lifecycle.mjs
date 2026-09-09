// Test-only lifecycle helpers. A timeout is a failure, never a successful close.
export async function withDeadline(operation, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createObserverGates(timeoutMs = 15000) {
  const pending = new Set();
  function deferred(label = 'Observer gate') {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const finish = (settle, value) => {
      clearTimeout(timer); pending.delete(gate); settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${label} was not released within ${timeoutMs} ms`)), timeoutMs);
    const gate = { promise, resolve: (value) => finish(resolve, value) };
    // An observer may stop consuming after another assertion fails. Its actual await still
    // receives the rejection; this handler only prevents an unrelated unhandled-rejection crash.
    promise.catch(() => undefined);
    pending.add(gate);
    return gate;
  }
  return {
    deferred,
    releaseAll() { for (const gate of [...pending]) gate.resolve(); },
    count() { return pending.size; },
  };
}

export async function cleanupSteps(steps, defaultTimeoutMs = 10000) {
  const failures = [];
  for (const { label, close, timeoutMs = defaultTimeoutMs } of steps) {
    try { await withDeadline(close, label, timeoutMs); }
    catch (error) { failures.push(new Error(`${label} failed`, { cause: error })); }
  }
  if (failures.length) throw new AggregateError(failures, 'Test cleanup failed; all cleanup steps were attempted');
}
