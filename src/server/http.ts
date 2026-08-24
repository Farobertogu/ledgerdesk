import { AppError, isAppError, type AppErrorCode } from '@/server/errors';

/**
 * One shape for every failure the API reports: `{ error: { code, message, ...detail } }`.
 * A client never has to read prose to find out what happened.
 */
export function errorResponse(error: unknown): Response {
  if (isAppError(error)) {
    return Response.json(
      { error: { code: error.code, message: error.message, ...error.detail } },
      { status: error.status },
    );
  }

  // Anything unrecognised is a defect of ours, and the client is told nothing about its internals.
  // The code is still one of the register's: a 500 that reports no code is a failure the caller
  // cannot branch on, and this surface has none of those.
  console.error('[api] unhandled failure:', error);
  const code: AppErrorCode = 'E_INTERNAL';
  return Response.json(
    { error: { code, message: 'the request could not be completed' } },
    { status: 500 },
  );
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new AppError('E_FIELD_INVALID', 400, 'the request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('E_FIELD_INVALID', 400, 'the request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The largest request body this API accepts, in bytes.
 *
 * **This is not the gap channel's cap and the two must not be confused.** The channel carries a
 * record of at most 1 024 bytes because eight of its nine fields are identifiers, digests and dates
 * and the ninth is a bounded note — that number is a statement about how much a producer may *say*.
 * This is a statement about how much an HTTP request may *weigh*, and it is larger for one reason:
 * the admission route is the only route in this system that carries a document. An article is bigger
 * than a note by construction — up to an excerpt's worth of prose, which is thousands of bytes in
 * UTF-8 — so a route sized to the channel would refuse every legitimate admission.
 *
 * Sixteen kibibytes leaves room for an article at the excerpt bound in a script that costs three
 * bytes a character, plus its title, its key and its provenance, and leaves nothing like room for a
 * payload nobody intended to send.
 *
 * The two other routes that take a payload — the intake and the transition — are unaffected: this is
 * opt-in, and a route that carries no document goes on using the reader above.
 */
export const REQUEST_BODY_MAX_BYTES = 16 * 1024;

/**
 * The same reader with a declared ceiling, measured in bytes off the wire.
 *
 * Bytes and not characters: the number is about what arrives, and a cap counted in characters admits
 * three times its own figure in any script outside the Latin range. Over the cap is refused whole and
 * never trimmed — a trimmed document is one whose ending nobody wrote.
 */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes: number = REQUEST_BODY_MAX_BYTES,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    throw new AppError('E_CONTRATO', 413, 'the request body is above the declared ceiling', {
      bytes,
      max_bytes: maxBytes,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('E_FIELD_INVALID', 400, 'the request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('E_FIELD_INVALID', 400, 'the request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
