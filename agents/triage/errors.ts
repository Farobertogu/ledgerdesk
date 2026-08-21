/**
 * The agent layer's typed failure register — the third one, and the reason there is a third.
 *
 * `agents/errors.ts` is the register of the path to the model: what the chokepoint refused to do,
 * read by an operator auditing egress, cost and reproducibility. `src/server/errors.ts` is the
 * register of the HTTP surface of the three consoles: what a request did wrong, read by whoever
 * wrote the client. Both are closed and the two are disjoint by construction.
 *
 * Neither of them describes what happens here. An envelope that came back from a model and does
 * not satisfy the agent contract is not a failure of the path — the call was made, the response
 * arrived, the row is written and the money is spent — and it is not a failure of a request, since
 * no request was involved. It is a failure of the **answer**, which is a layer of its own with a
 * reader of its own: whoever has to decide whether the ticket is retried, failed or escalated.
 *
 * **The register is closed**, on the same terms as the other two: it is lengthened by a recorded
 * decision, never by a convenient addition at a call site. ADR-023 records the two below.
 *
 * **Reserved and not taken: `E_NO_GROUNDING`.** The validator of a drafted answer will need a code
 * for "the draft cites nothing that was retrieved", and it belongs in this register when the
 * increment that owns retrieval and drafting arrives. It is named here so the first person to need
 * it finds a reservation rather than inventing a synonym, and it is not in the array below because
 * a code that nothing can raise is a code nobody can trust.
 */

/**
 * `E_PROMPT_NO_REGISTRADO` keeps the spelling the agent contract fixes, for the same reason
 * `E_MODELO_INESPERADO` does in the chokepoint's register: the code is the specification's, not
 * this file's, and an English synonym would have to be reconciled with the source it came from
 * every time either one moved.
 */
export const AGENT_ERROR_CODES = [
  /** The response text is not an envelope this agent's contract admits. */
  'E_SCHEMA',
  /** No prompt version is registered for this agent, so no call it made could be recorded. */
  'E_PROMPT_NO_REGISTRADO',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/**
 * A refusal at the agent layer.
 *
 * `detail` carries what is wrong with the envelope — which key, which value's type, which foreign
 * block — and never the envelope itself. A model that echoed a customer's address into its answer
 * would otherwise have that address copied into every log line the error touches, by way of the
 * validator that refused it.
 */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: AgentErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.detail = detail;
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}
