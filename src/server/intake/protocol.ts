import type { IncomingMessage } from 'node:http';
import { INTAKE_ROUTES, canonicalIntake, decodeIntake, identifier, validateIntake } from '../../contracts/intake.ts';
import { resolveReceptionPath, type ReceptionRoute, type ReceptionErrorStatus } from '../../contracts/intake_reception.ts';
import type { SessionTransport } from '../../contracts/access_transport.ts';
import { canonicalValue } from '../../contracts/access_canonical.ts';

export class IntakeFailure extends Error {
  readonly status: ReceptionErrorStatus;
  constructor(status: ReceptionErrorStatus) { super('INTAKE_' + status); this.status = status; }
}
export type ReceptionRequest = {
  route: ReceptionRoute; parameters: Record<string, string>; method: 'GET' | 'POST';
  contentLength: number; clientKey: string | null; csrf: string | null;
};
const singleton = new Set(['host', 'origin', 'cookie', 'content-type', 'content-length', 'x-ledgerdesk-csrf', 'x-ledgerdesk-intent']);
export function receptionEnvelope(request: Pick<IncomingMessage, 'url' | 'method' | 'headers' | 'rawHeaders'>, transport: SessionTransport): ReceptionRequest {
  const route = resolveReceptionPath(request.method ?? '', request.url ?? '');
  if (!route) throw new IntakeFailure(400);
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    if (singleton.has(name) && seen.has(name)) throw new IntakeFailure(400);
    seen.add(name);
  }
  if (request.headers['transfer-encoding'] !== undefined || request.headers['content-encoding'] !== undefined ||
      request.headers.range !== undefined || request.headers['if-none-match'] !== undefined ||
      request.headers['if-modified-since'] !== undefined || request.headers.expect !== undefined) throw new IntakeFailure(400);
  if (request.headers.host !== new URL(transport.terminalOrigin).host || request.headers.origin !== transport.uiOrigin) throw new IntakeFailure(403);
  const definition = INTAKE_ROUTES[route.route];
  const length = request.headers['content-length'];
  const key = request.headers['x-ledgerdesk-intent'];
  const csrf = request.headers['x-ledgerdesk-csrf'];
  if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new IntakeFailure(400);
  const contentLength = Number(length ?? 0);
  if (definition.method === 'GET') {
    if (contentLength !== 0 || request.headers['content-type'] !== undefined || key !== undefined) throw new IntakeFailure(400);
  } else {
    if (length === undefined) throw new IntakeFailure(400);
    if (request.headers['content-type'] !== definition.media) throw new IntakeFailure(415);
    if (contentLength > definition.maxBytes) throw new IntakeFailure(413);
    if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) throw new IntakeFailure(403);
    if (definition.effect === 'intention' ? !identifier(key) : key !== undefined) throw new IntakeFailure(400);
  }
  return { ...route, method: definition.method, contentLength, clientKey: typeof key === 'string' ? key : null, csrf: typeof csrf === 'string' ? csrf : null };
}
export function receptionCommand(request: ReceptionRequest, bytes: Uint8Array): Record<string, any> {
  if (request.method === 'GET') {
    if (bytes.length !== 0) throw new IntakeFailure(400);
    return { profile: 'intake/1' };
  }
  if (request.route === 'upload_original' || bytes.length !== request.contentLength) throw new IntakeFailure(400);
  try {
    const body = decodeIntake(bytes);
    if (!validateIntake(request.route, body)) throw Error('SHAPE');
    return body as Record<string, any>;
  } catch { throw new IntakeFailure(400); }
}
export function receptionCanonical(request: ReceptionRequest, body: unknown): string {
  return canonicalIntake(request.route, request.parameters, body, canonicalValue);
}
