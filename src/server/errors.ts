/**
 * The console HTTP error contract.
 *
 * This array is the register of every typed failure the consoles' own API can report, and it is
 * the executable half of that register: a code that is not here cannot be constructed, because
 * `AppError` will not accept it.
 *
 * **The register is closed.** It is lengthened only by a recorded decision, never by a convenient
 * addition at a call site.
 *
 * **Partition, stated so that nothing lands in both places.** The specification keeps a
 * consolidated index of typed error codes for the INSTRUMENT — the ledger, the generators, the
 * seam and the agent contract. The codes below belong to a different layer: the HTTP surface of
 * the three consoles. The two sets are disjoint by construction and neither substitutes for the
 * other; a failure of the instrument is never renamed here, and a failure of this surface is
 * never promoted into that index except by a decision that says so.
 */
export const APP_ERROR_CODES = [
  /** No session is selected, so the request carries no claims. */
  'E_NO_SESSION',
  /** The session's role is not the one this operation belongs to. */
  'E_ROLE_NOT_PERMITTED',
  /** The build does not carry the development identity selector. */
  'E_DEV_IDENTITY_DISABLED',
  /** A required field is absent, empty, or of the wrong type. */
  'E_FIELD_INVALID',
  /** The row is not visible under the claims of this session — which includes "it does not exist". */
  'E_TICKET_NOT_VISIBLE',
  /** The edge is not one the state machine publishes. */
  'E_TRANSITION_ILLEGAL',
  /** The edge exists; its guard is evaluated by a named component, not by a console. */
  'E_TRANSITION_GUARD_UNAVAILABLE',
  /** The ticket moved between the read and the write; nothing was applied. */
  'E_TRANSITION_STALE',
  /** The organisation has no account row, so a ticket cannot carry the NOT NULL account it needs. */
  'E_NO_ACCOUNT_FOR_ORG',
  /** The organisation has more than one account and nothing says which one a ticket belongs to. */
  'E_ACCOUNT_AMBIGUOUS',
  /**
   * A payload arrived out of contract on a declared channel, and is refused whole.
   *
   * **Added by a recorded decision, and the decision had to answer a partition first.** The three
   * registers of this repository declare themselves closed and disjoint: the chokepoint's, the agent
   * layer's, and this one. This code belongs to none of them by inheritance — it is the boundary's,
   * fixed by the seam's own contract, which says out of contract is refused *rather than truncated
   * in silence*. It lands here because the receiver of the fourth channel is a console route: the
   * emission of a gap record is reached through the drafting cycle a person triggers, and the
   * admission through a route that carries a body. A code raised on an HTTP surface and reported to
   * whoever wrote the client is this register's kind of failure, whatever its origin.
   *
   * Nothing is trimmed and nothing is filled in on the way to it. A receiver that shortened an
   * over-long field would store a sentence its author did not write.
   */
  'E_CONTRACT_VIOLATION',
  /**
   * The organisation has declared no knowledge-gap commitment, so no record for it could name an
   * owner or a date.
   *
   * **It exists so that an unfinished deployment stops reading as a defect.** The emission runs
   * inside a savepoint and files the code it was refused with beside the escalation; without a name
   * of its own this arrives as `E_INTERNAL`, which tells whoever reads the chain that something
   * broke rather than that something was never configured. Those want different people and different
   * actions. The fix is one artefact and it is named in the message.
   */
  'E_GAP_COMMITMENT_MISSING',
  /**
   * The corpus moved under a runtime that is still holding the label it started with.
   *
   * The pointer is read twice with two lifetimes — frozen when a runtime is built, fresh on every
   * cycle — and after an admission that skipped the eviction the retrieval would read the new corpus
   * while every row written beside it named the old one. That is the evidence of this whole cycle
   * falsified in the act of producing it, and it is invisible: the answer improves, the rows look
   * ordinary. Comparing the two and refusing turns forgetting the eviction into a noisy refusal
   * instead of a quiet lie.
   */
  'E_RUNTIME_SNAPSHOT_STALE',
  /** A failure this surface did not anticipate. Typed so that a 500 is still a code and not silence. */
  'E_INTERNAL',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly detail: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    status: number,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
