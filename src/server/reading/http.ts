import { PROBLEMS, validateExactRequest } from '../../contracts/material_reading.ts';
import type { Problem } from '../../contracts/material_reading.ts';
import type { ReadingOperation } from '../kb/reading.ts';
import { readTrialConfig } from './config.ts';
import { contextFromTrial } from './context.ts';

export function problemResponse(status: 400 | 403 | 404 | 503): Response {
  const problem: Problem = PROBLEMS[status];
  return new Response(JSON.stringify(problem), {
    status,
    headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'private, no-store' },
  });
}

/** Syntax only. IDs stay opaque; encoded separators are data, never SQL or filesystem paths. */
export function parseReadingRequest(request: Request): ReadingOperation | null {
  if (request.method !== 'GET' || request.body !== null
      || request.headers.has('transfer-encoding')
      || (request.headers.has('content-length') && request.headers.get('content-length') !== '0')) return null;
  let url: URL;
  try { url = new URL(request.url); } catch { return null; }
  if (request.url.includes('?') || url.hash || url.username || url.password) return null;
  if (url.pathname === '/api/v1/material') return { kind: 'list' };
  const match = /^\/api\/v1\/material\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  try {
    const result = validateExactRequest({
      unit_id: decodeURIComponent(match[1]), version_id: decodeURIComponent(match[2]),
    });
    return result.ok ? { kind: 'exact', reference: result.value } : null;
  } catch { return null; }
}

/** T01/T02 fail-closed composition. T04 will supply the persistence/admission implementation.
 * Enabling the internal trial is NOT enough to serve material: until that exists a valid,
 * contextual request gets 503. Never an empty success, mock text, old DB or a prior body.
 */
export async function handleReadingRequest(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Response> {
  const operation = parseReadingRequest(request);
  if (!operation) return problemResponse(400);
  try {
    const context = contextFromTrial(readTrialConfig(env));
    if (!context) return problemResponse(403);
  } catch {
    return problemResponse(503);
  }
  return problemResponse(503);
}
