import type {IncomingMessage} from 'node:http';
import type {SessionTransport} from '../../../contracts/access_transport.ts';
import {WORKSPACE_ACCEPT, WORKSPACE_COMMAND_BYTES} from '../../../contracts/intake_workspace.ts';
import {IntakeFailure, receptionEnvelope} from '../protocol.ts';

/** Existing query paths, new explicit representation, no alternate effect endpoint. */
export function workspacePath(method: string, url: string) {
  return method === 'GET' && url === '/api/intake/profiles' ||
    method === 'GET' && /^\/api\/intake\/(?:receptions|extractions)\/[A-Za-z0-9._:-]+$/.test(url) ||
    method === 'POST' && url === '/api/intake/operations/lookup';
}
export function workspaceEnvelope(request: Pick<IncomingMessage, 'url' | 'method' | 'headers' | 'rawHeaders'>, transport: SessionTransport) {
  if (!workspacePath(request.method ?? '', request.url ?? '') || request.headers.accept !== WORKSPACE_ACCEPT) throw new IntakeFailure(400);
  if (['forwarded', 'x-forwarded-for', 'x-real-ip'].some(name => request.headers[name] !== undefined)) throw new IntakeFailure(400);
  const admitted = receptionEnvelope({...request, headers: {...request.headers, accept: 'application/json'}}, transport, true);
  if (admitted.contentLength > WORKSPACE_COMMAND_BYTES) throw new IntakeFailure(413);
  return admitted;
}
