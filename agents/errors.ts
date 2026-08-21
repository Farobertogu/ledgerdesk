/**
 * The gateway's typed failure register.
 *
 * This array is the register of every failure the model chokepoint can report, and it is the
 * executable half of that register: a code that is not here cannot be constructed, because
 * `GatewayError` will not accept it.
 *
 * **The register is closed.** It is lengthened only by a recorded decision, never by a convenient
 * addition at a call site.
 *
 * **Partition, stated so that nothing lands in both places.** `src/server/errors.ts` owns the HTTP
 * surface of the three consoles; those codes describe what a request did wrong. The codes below
 * describe what the path to the model refused to do, which is a different layer with a different
 * reader: an operator auditing egress, cost and reproducibility. The two sets are disjoint by
 * construction and neither substitutes for the other. A gateway refusal that a console has to
 * report is translated at the boundary, never renamed here.
 *
 * **One code is not this register's to name.** `E_MODELO_INESPERADO` is fixed by the specification
 * of the agent contract — the row is written and the pin is what raises — so it is reused verbatim
 * rather than given an English synonym that would then have to be reconciled with the source. Every
 * other code below is new here and is named in the language the rest of this tree is written in.
 */
export const GATEWAY_ERROR_CODES = [
  /** The configuration cannot hold the guarantees this module exists to hold. */
  'E_CONFIG_INVALID',
  /** The call named no input path, so the row it would write could not be replayed. */
  'E_INPUT_PATH_MISSING',
  /** No price is declared for the requested model, so the call could not be charged honestly. */
  'E_MODEL_PRICE_UNKNOWN',
  /** Nothing survived redaction: there is no body left to send. */
  'E_EMPTY_AFTER_REDACTION',
  /** The canary planted in this very call was not removed by the redactor. Fail closed. */
  'E_CANARY_NOT_REDACTED',
  /** The canary was found in the payload about to leave. Nothing left. */
  'E_CANARY_EGRESS',
  /** A value the redactor had removed was found in the payload about to leave. Nothing left. */
  'E_PII_EGRESS',
  /** The canary came back in the response, so the response is not persisted. */
  'E_CANARY_IN_RESPONSE',
  /** A removed value came back in the response, so the response is not persisted. */
  'E_PII_IN_RESPONSE',
  /** The ceiling would be crossed by this call. It is refused before it is made. */
  'E_BUDGET_EXHAUSTED',
  /** The provider did not answer inside the declared window. */
  'E_PROVIDER_TIMEOUT',
  /** The provider answered with a failure, or with a response that is not of the declared shape. */
  'E_PROVIDER_FAILED',
  /** The response carried a model id other than the one requested, under a declared pin. */
  'E_MODELO_INESPERADO',
  /** The chain could not be extended, so the call is not recorded and is reported as failed. */
  'E_LEDGER_WRITE_FAILED',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/**
 * A refusal on the path to the model.
 *
 * `detail` is deliberately typed as a plain record and is deliberately never allowed to carry the
 * values that caused the refusal. A `E_PII_EGRESS` whose message quotes the address it caught would
 * put that address in every log line that touches the error — which is the failure the code exists
 * to prevent, moved one layer out. Counts and kinds travel; literals do not.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: GatewayErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.detail = detail;
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}
