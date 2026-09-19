import type {IncomingMessage} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readable} from '../stream.ts';
import {IntakeFailure, type ReceptionRequest} from '../protocol.ts';
import type {PreparationService} from './service.ts';
import {PREPARATION_BOUNDS, readPreparationDocument} from '../../../contracts/intake_preparation.ts';
import {byteDigest, referenceFor} from './records.ts';

/** First-application-body boundary. Stream readiness does not itself consume a protected chunk. */
export async function collectPreparation(service: PreparationService, request: ReceptionRequest, stream: IncomingMessage,
  token: string | null, onLoss: () => void) {
  const staged = request.route === 'upload_preparation', chunks: Buffer[] = [];
  const maximum = staged ? PREPARATION_BOUNDS.documentBytes : PREPARATION_BOUNDS.commandBytes;
  if (request.contentLength > maximum) throw new IntakeFailure(413);
  let consumed = 0; const deadline = Date.now() + PREPARATION_BOUNDS.transferMs;
  while (consumed < request.contentLength) {
    if (Date.now() >= deadline || !await readable(stream, deadline)) throw new IntakeFailure(400);
    const a = await service.open(request, token, onLoss);
    try {
      await service.shared.authority.beforeMetadata(a, request.route);
      if (staged) {
        const attempt = await service.attempt(a, request.parameters.id, 'upload_preparation');
        if (attempt.state !== 'reserved' || attempt.declared_bytes !== request.contentLength) throw new IntakeFailure(409);
      }
      const event = await service.shared.evidence(a, request.route, 'capture_admission');
      await a.db.commit();
      await service.shared.hooks.barrier?.('before_preparation_capture', {route: request.route, consumed, evidenceId: event.id, backendPid: event.pid});
      await service.shared.clock(a, 'preparation-command-capture', request.route);
      const count = Math.min(stream.readableLength, 65536, request.contentLength - consumed);
      const chunk = stream.read(count) as Buffer | null;
      if (!chunk || count === 0 || chunk.length !== count) throw new IntakeFailure(400);
      consumed += chunk.length; chunks.push(chunk);
      service.shared.hooks.storage?.({origin: 'preparation-receiver-boundary', kind: 'capture', bytes: chunk.length, consumed, evidenceId: event.id});
    } finally {await a.db.close();}
  }
  return Buffer.concat(chunks);
}
export async function uploadPreparation(service: PreparationService, request: ReceptionRequest, bytes: Buffer,
  token: string | null, onLoss: () => void) {
  const a = await service.open(request, token, onLoss, ['intake:preparation-attempt:' + request.parameters.id]);
  try {
    await service.shared.authority.beforeMetadata(a, request.route);
    const attempt = await service.attempt(a, request.parameters.id, 'upload_preparation');
    if (attempt.state !== 'reserved' || bytes.length !== attempt.declared_bytes || byteDigest(bytes) !== attempt.declared_sha256) throw new IntakeFailure(409);
    try {readPreparationDocument(bytes);} catch {throw new IntakeFailure(400);}
    const document = {id: attempt.staged_id, generation: 1, bytes: bytes.length, sha256: attempt.declared_sha256};
    await a.db.query('INSERT INTO $INTAKE.preparation_stage VALUES($1,$2,1,$3,$4,$5,$6)',
      [document.id, attempt.id, bytes.length, document.sha256, bytes, a.now]);
    await a.db.query("SELECT $INTAKE.advance_preparation_attempt($1,'reserved','staged')", [attempt.id]);
    const operationId = randomUUID(), result = {state: 'staged', attempt_id: attempt.id, preparation: {id: attempt.preparation_id, revision: attempt.revision}, document};
    const effect = referenceFor('preparation-operation/1', operationId, 1, {operation: 'upload_preparation', predecessor: attempt.predecessor, document});
    await a.db.query('INSERT INTO $INTAKE.editorial_effect VALUES($1,$2,$3,$4,$5,$6,$7)',
      [operationId, a.session.account_id, attempt.context, 'upload_preparation', effect, result, a.now]);
    await service.shared.evidence(a, request.route, 'effect', {operationId});
    await service.shared.clock(a, 'E_stage_preparation', request.route);
    return await service.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1', operation_id: operationId, effect, result}, operationId);
  } catch (error) {await a.db.close(); throw error;}
}
