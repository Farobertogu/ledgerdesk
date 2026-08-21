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
  /** The edge exists, and the component that evaluates its guard has not been built yet. */
  'E_TRANSITION_GUARD_UNAVAILABLE',
  /** The ticket moved between the read and the write; nothing was applied. */
  'E_TRANSITION_STALE',
  /** The organisation has no account row, so a ticket cannot carry the NOT NULL account it needs. */
  'E_NO_ACCOUNT_FOR_ORG',
  /** The organisation has more than one account and nothing says which one a ticket belongs to. */
  'E_ACCOUNT_AMBIGUOUS',
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
