/**
 * One writer per run, as a property rather than a hope — and now shared by three cycles.
 *
 * ## What the queue is for
 *
 * The ledger's append loop is six immediate attempts with no backoff, and it reads the head of the
 * chain before the trigger takes its lock. A dozen cycles racing on one run can exhaust those six
 * with the model's answer already paid for: the money is gone and the row that would account for it
 * is the thing that failed. Serialising the cycles of a run costs latency and buys that away.
 *
 * ## Why it is a module and not a block of code inside a runner
 *
 * It was a block of code inside the triage runner, which was correct while there was one runner.
 * There are three cycles now — triage, draft, validate — writing into the same run, and the failure
 * a copied block produces is not a duplicated function: it is a **second queue**. Two maps on
 * `globalThis` under two names, each perfectly serialising its own cycles against a run the other
 * one is also writing to, and the property the whole arrangement exists for silently gone. A queue
 * that does not cover every writer of a run is not a weaker queue, it is no queue.
 *
 * So there is one map, under one key, in one module, and every cycle enqueues through it. The
 * comment is longer than the code because the code is the easy part.
 *
 * ## Held on `globalThis`, for the reason the pools are
 *
 * Next.js reloads modules in development. A map that came back empty after a reload would quietly
 * allow two writers again, in the one environment where nobody is watching for it and where a
 * developer editing a file is exactly the person who would then see `E_LEDGER_WRITE_FAILED` and
 * blame their own change.
 *
 * ## A failed cycle does not poison the queue
 *
 * The tail stored for the next caller is the **settled** promise, not the original one, so the next
 * cycle waits for this one to finish and not for it to succeed. Storing the raw promise would mean
 * one rejected cycle rejecting every cycle queued behind it, for the rest of the process's life.
 */

const globalForQueue = globalThis as unknown as {
  ledgerdeskRunQueue?: Map<string, Promise<unknown>>;
};

function queues(): Map<string, Promise<unknown>> {
  globalForQueue.ledgerdeskRunQueue ??= new Map();
  return globalForQueue.ledgerdeskRunQueue;
}

/**
 * Runs `work` after everything already queued for `runId` has settled.
 *
 * The returned promise is the caller's own: it resolves with the work's value and rejects with the
 * work's failure. What is stored as the tail is a promise that only ever resolves.
 */
export function onRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
  const queue = queues();
  const previous = queue.get(runId) ?? Promise.resolve();

  const mine = previous.then(work);
  queue.set(
    runId,
    mine.then(
      () => undefined,
      () => undefined,
    ),
  );
  return mine;
}

/** How many runs this process currently holds a tail for. For a test, and for nothing else. */
export function queuedRuns(): number {
  return queues().size;
}
