import type {IncomingMessage, ServerResponse} from 'node:http';
import {INTAKE_ROUTES, identifier, decodeStrict, intakePath} from '../../../contracts/intake.ts';
import {PREPARATION_ROUTES, PREPARATION_BOUNDS, validatePreparationCommand} from '../../../contracts/intake_preparation.ts';
import {preparationProblem, validatePreparationResponse} from '../../../contracts/intake_preparation_response.ts';
import {sessionToken, corsHeaders} from '../../access/transport.ts';
import type {AccessConfig} from '../../access/config.ts';
import type {ReceptionService, PreparedIntake} from '../service.ts';
import {IntakeFailure, type ReceptionRequest} from '../protocol.ts';
import {PreparationService} from './service.ts';
import {collectPreparation, uploadPreparation} from './stream.ts';
import {PreparationLimit} from './records.ts';

export const PREPARATION_ACCEPT = 'application/vnd.ledgerdesk.intake-preparation+json';
export function preparationPath(method: string, url: string) {
  if (/[?%#\\]/.test(url)) return null;
  for (const name of [...PREPARATION_ROUTES, 'lookup_operation'] as const) {
    const route = INTAKE_ROUTES[name]; if (method !== route.method) continue;
    const names: string[] = [], pattern = route.path.replace(/:([a-z_]+)/g, (_, name) => {names.push(name); return '([A-Za-z0-9][A-Za-z0-9._:-]{0,127})';});
    const match = new RegExp('^' + pattern + '$').exec(url); if (!match) continue;
    const parameters = Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
    try {intakePath(name, parameters);} catch {return null;}
    return {route: name, parameters};
  }
  return null;
}
type TerminalSupport = {
  diagnostic(error: unknown): {status: 400|403|404|409|413|415|429|503; code: string|null; locations: string[]};
  observe(prepared: PreparedIntake, outcome: 'handed_off'|'interrupted', bytes: number): Promise<void>;
};
export function createPreparationTerminal(access: AccessConfig, shared: ReceptionService, support: TerminalSupport) {
  const service = new PreparationService(shared);
  const handles = (req: IncomingMessage) => shared.config.preparation === 'intake-preparation/1' &&
    req.headers.accept === PREPARATION_ACCEPT && preparationPath(req.method ?? '', req.url ?? '') !== null;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    req.pause(); let prepared: PreparedIntake | undefined;
    try {
      service.ensureEnabled();
      const path = preparationPath(req.method ?? '', req.url ?? '');
      if (!path || req.headers.accept !== PREPARATION_ACCEPT) throw new IntakeFailure(400);
      const definition = INTAKE_ROUTES[path.route], seen = new Set<string>();
      const controlled = new Set(['host', 'origin', 'cookie', 'accept', 'content-type', 'content-length', 'x-ledgerdesk-csrf', 'x-ledgerdesk-intent']);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i].toLowerCase(); if (controlled.has(key) && seen.has(key)) throw new IntakeFailure(400); seen.add(key);
      }
      if (req.headers.host !== new URL(access.transport.terminalOrigin).host || req.headers.origin !== access.transport.uiOrigin) throw new IntakeFailure(403);
      if (['transfer-encoding', 'content-encoding', 'range', 'if-none-match', 'if-modified-since', 'expect', 'forwarded', 'x-forwarded-for', 'x-real-ip'].some(k => req.headers[k] !== undefined)) throw new IntakeFailure(400);
      const length = req.headers['content-length'];
      if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new IntakeFailure(400);
      const contentLength = Number(length ?? 0), key = req.headers['x-ledgerdesk-intent'], csrf = req.headers['x-ledgerdesk-csrf'];
      if (definition.method === 'GET') {
        if (contentLength || req.headers['content-type'] !== undefined || key !== undefined) throw new IntakeFailure(400);
      } else {
        if (length === undefined) throw new IntakeFailure(400);
        if (req.headers['content-type'] !== (path.route === 'upload_preparation' ? 'application/octet-stream' : 'application/json')) throw new IntakeFailure(415);
        if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) throw new IntakeFailure(403);
        if (definition.effect === 'intention' ? !identifier(key) : key !== undefined) throw new IntakeFailure(400);
      }
      const request: ReceptionRequest = {...path, method: definition.method, contentLength, clientKey: typeof key === 'string' ? key : null, csrf: typeof csrf === 'string' ? csrf : null};
      const token = sessionToken(req.headers.cookie), onLoss = () => res.destroy();
      const bytes = request.method === 'POST' ? await collectPreparation(service, request, req, token, onLoss) : Buffer.alloc(0);
      if (request.route === 'upload_preparation') prepared = await uploadPreparation(service, request, bytes, token, onLoss);
      else {
        const body = request.method === 'GET' ? {profile: 'intake/1', representation: 'intake-preparation/1'} : decodeStrict(bytes, PREPARATION_BOUNDS.commandBytes);
        if (!validatePreparationCommand(path.route, body)) throw new IntakeFailure(400);
        prepared = await service.command(request, body as any, token, onLoss);
      }
      if (!validatePreparationResponse(path.route, prepared.status, prepared.body)) throw new IntakeFailure(503);
      const response = prepared.originalBytes ?? Buffer.from(JSON.stringify(prepared.body));
      if (response.length > PREPARATION_BOUNDS.responseBytes) throw new IntakeFailure(503);
      await shared.clock(prepared.admission, 'response-handoff', request.route);
      if (res.destroyed) {await support.observe(prepared, 'interrupted', 0); return;}
      res.sendDate = false;
      res.writeHead(prepared.status, {...corsHeaders(access.transport), 'content-type': PREPARATION_ACCEPT,
        'cache-control': 'private, no-store', 'content-length': String(response.length)});
      res.end(response);
      await support.observe(prepared, 'handed_off', response.length);
    } catch (error) {
      const event = support.diagnostic(error instanceof PreparationLimit ? new IntakeFailure(413) :
        (error as {code?: string})?.code === '53400' ? new IntakeFailure(429) : error);
      try {shared.hooks.failure?.(event);} finally {
        if (res.headersSent || res.destroyed) res.destroy();
        else {
          const bytes = Buffer.from(JSON.stringify(preparationProblem(event.status)));
          res.sendDate = false;
          res.writeHead(event.status, {...corsHeaders(access.transport), 'content-type': 'application/problem+json',
            'content-length': String(bytes.length), 'cache-control': 'private, no-store'});
          res.end(bytes);
        }
      }
    } finally {await prepared?.close();}
  }
  return {handles, handle, service};
}
