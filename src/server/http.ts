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
