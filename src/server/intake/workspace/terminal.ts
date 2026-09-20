import type {IncomingMessage, ServerResponse} from 'node:http';
import {decodeStrict} from '../../../contracts/intake.ts';
import {WORKSPACE_ACCEPT, WORKSPACE_COMMAND_BYTES, WORKSPACE_PROFILE, validateWorkspaceQuery, validateWorkspaceResponse, type WorkspaceQuery} from '../../../contracts/intake_workspace.ts';
import {PREPARATION_BOUNDS} from '../../../contracts/intake_preparation.ts';
import {receptionProblem} from '../../../contracts/intake_reception.ts';
import type {AccessConfig} from '../../access/config.ts';
import {corsHeaders, sessionToken} from '../../access/transport.ts';
import {IntakeFailure} from '../protocol.ts';
import type {PreparedIntake, ReceptionService} from '../service.ts';
import {collectCommand} from '../stream.ts';
import {workspaceEnvelope, workspacePath} from './protocol.ts';
import {WorkspaceService} from './service.ts';

type Support = {
  diagnostic(error: unknown): {status: 400|403|404|409|413|415|429|503; code: string|null; locations: string[]};
  observe(prepared: PreparedIntake, outcome: 'handed_off'|'interrupted', bytes: number): Promise<void>;
};
export function createWorkspaceTerminal(access: AccessConfig, shared: ReceptionService, support: Support) {
  const service = new WorkspaceService(shared);
  const handles = (req: IncomingMessage) => shared.config.preparation === 'intake-preparation/1' &&
    req.headers.accept === WORKSPACE_ACCEPT && workspacePath(req.method ?? '', req.url ?? '');
  async function handle(req: IncomingMessage, res: ServerResponse) {
    req.pause(); let prepared: PreparedIntake | undefined;
    try {
      const request = workspaceEnvelope(req, access.transport), token = sessionToken(req.headers.cookie);
      let query: WorkspaceQuery | null = null;
      if (request.method === 'POST') {
        const bytes = await collectCommand(shared, request, req, token, () => res.destroy());
        let decoded: unknown;
        try {decoded = decodeStrict(bytes, WORKSPACE_COMMAND_BYTES);} catch {throw new IntakeFailure(400);}
        if (!validateWorkspaceQuery(decoded)) throw new IntakeFailure(400);
        query = decoded;
      }
      prepared = await service.query(request, query, token, () => res.destroy());
      const kind = query?.kind ?? (request.route === 'profiles' ? 'context' : request.route);
      if (!['context', 'reception', 'extraction', 'preparation_effect', 'preparation_attempt', 'preparation_inspection', 'proposal_inspection'].includes(kind) ||
        !validateWorkspaceResponse(kind as Parameters<typeof validateWorkspaceResponse>[0], prepared.body)) throw new IntakeFailure(503);
      const bytes = Buffer.from(JSON.stringify(prepared.body));
      if (bytes.length > PREPARATION_BOUNDS.responseBytes) throw new IntakeFailure(503);
      await shared.clock(prepared.admission, 'workspace-response-handoff', request.route);
      if (res.destroyed) {await support.observe(prepared, 'interrupted', 0); return;}
      res.sendDate = false;
      res.writeHead(200, {...corsHeaders(access.transport), 'content-type': WORKSPACE_ACCEPT,
        'cache-control': 'private, no-store', 'content-length': String(bytes.length)});
      res.end(bytes);
      await support.observe(prepared, 'handed_off', bytes.length);
    } catch (error) {
      const event = support.diagnostic(error);
      try {shared.hooks.failure?.(event);} finally {
        if (res.headersSent || res.destroyed) res.destroy();
        else {
          const bytes = Buffer.from(JSON.stringify({...receptionProblem(event.status), representation: WORKSPACE_PROFILE}));
          res.sendDate = false;
          res.writeHead(event.status, {...corsHeaders(access.transport), 'content-type': 'application/problem+json',
            'cache-control': 'private, no-store', 'content-length': String(bytes.length)});
          res.end(bytes);
        }
      }
    } finally {await prepared?.close();}
  }
  return {handles, handle};
}
