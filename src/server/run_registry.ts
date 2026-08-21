/**
 * Which organisation holds which run — the one-to-one-to-one invariant, as a mechanism.
 *
 * ## Why this is its own module, and why every function in it is synchronous
 *
 * The invariant matters because of what violating it does: `ledger_link()` is `security definer`
 * and reads the true head of a run across tenants, while the writer reads a head clipped by the
 * tenant policy. A run whose rows belong to two organisations therefore has a writer proposing a
 * `prev_hash` the trigger rejects, for as long as anyone retries — `E_LEDGER_WRITE_FAILED`,
 * permanently, on a run that looks perfectly ordinary.
 *
 * The first version of the check asserted it by walking the registry of runtimes and **awaiting**
 * each other organisation's entry to read its run. Those entries are promises, and they are
 * frequently *in flight*: an organisation checking the invariant while another organisation was
 * checking it back produced two runtimes waiting on each other, with no timeout on either side and
 * no error to report. A request that never answers, in the one code path every request goes
 * through, on exactly the arrangement the demonstration uses — its beats are spread across both
 * seeded tenants.
 *
 * So the check lives here instead, as a claim over a plain map, and **the whole contract of this
 * module is that none of it is asynchronous**. A run identifier is a pure function of the
 * organisation and the run label, so the claim needs no runtime, no database and no promise; the
 * caller takes it before it builds anything, at a point where no await has run and nothing can
 * interleave. `test_TRIAGE_run_registry_claims_without_awaiting` is what keeps that true — a
 * future edit that reached for a promise in here would reintroduce the deadlock, and there is no
 * other place where it could be caught before it hung a server.
 *
 * The module imports nothing, deliberately: it is the piece that has to be checkable on its own.
 */

/** run_id → the organisation that holds it. */
export type RunClaims = Map<string, string>;

export function createRunClaims(): RunClaims {
  return new Map();
}

/**
 * Records that `orgId` holds `runId`, or refuses because somebody else does.
 *
 * Idempotent for the holder: an organisation re-entering its own claim is the ordinary case, since
 * a claim survives a runtime that failed to build and was retried.
 *
 * The refusal is an `Error` and not a typed application code on purpose. It cannot be reached by
 * anything a user does — run identifiers are derived from organisation identifiers — so reaching it
 * means the derivation has been replaced by something that collides, which is a defect of the
 * process and is found by the process failing.
 */
export function claimRun(claims: RunClaims, runId: string, orgId: string): void {
  const holder = claims.get(runId);
  if (holder !== undefined && holder !== orgId) {
    throw new Error(
      `run ${runId} is already held by organisation ${holder}, so ${orgId} may not write into it; ` +
        'a run whose rows belong to two organisations cannot be extended by any writer',
    );
  }
  claims.set(runId, orgId);
}

/**
 * Gives up a claim, and only the holder's own.
 *
 * Called when a runtime fails to build, so that the two maps of the registry never disagree about
 * what this process holds. The holder check is what stops a failed build in one organisation from
 * quietly releasing another organisation's run.
 */
export function releaseRun(claims: RunClaims, runId: string, orgId: string): void {
  if (claims.get(runId) === orgId) claims.delete(runId);
}

/** Who holds `runId`, or `undefined`. */
export function holderOf(claims: RunClaims, runId: string): string | undefined {
  return claims.get(runId);
}
