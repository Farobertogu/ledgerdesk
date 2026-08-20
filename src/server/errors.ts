/**
 * Typed failures of the console HTTP surface.
 *
 * These codes are the contract between the consoles and their own API: a client can branch on
 * `code` instead of parsing prose. They are deliberately NOT entries in the specification's
 * consolidated register of typed error codes — that list is closed and only a dated ADR lengthens
 * it. If any of these has to become a code of record, that is a decision with a record, not a
 * side effect of this file.
 */
export const APP_ERROR_CODES = [
  /** No development session is selected, so the request carries no claims. */
  'E_NO_SESSION',
  /** The session's role is not the one this operation belongs to. */
  'E_ROLE_NOT_PERMITTED',
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
