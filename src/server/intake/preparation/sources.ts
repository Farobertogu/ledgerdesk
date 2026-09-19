import {PrivateExtractionPort, extractionSubject} from '../extraction_ports.ts';
import {extractionPhase} from '../extraction_phase.ts';
import {decodeExtractionContent} from '../../../contracts/intake_extraction.ts';
import {EXTRACTION_CONTENT} from '../../../contracts/intake_extraction_view.ts';
import {IntakeFailure} from '../protocol.ts';
import {exact} from '../reception.ts';
import type {ReceptionService} from '../service.ts';
import type {Admission} from '../authority.ts';
import {byteDigest, same, type Row} from './records.ts';
import type {RetainedSource} from './producer.ts';

/** Reads only a currently admitted, durably accepted result, through the existing fenced output participant. */
export async function acceptedExtractionSource(service: ReceptionService, a: Admission, selector: Row): Promise<RetainedSource> {
  const context = await service.authority.beforeExtractionSelection(a);
  if (a.extractionView !== 'content') throw new IntakeFailure(404);
  const j = (await a.db.query(`SELECT j.*,r.context,r.principal,rcp.id AS receipt_id,rcp.effect_id AS receipt_effect,
    rcp.reception_id,rcp.artifact_id,rcp.generation,rcp.bytes,rcp.sha256
    FROM $INTAKE.extraction_job j JOIN $INTAKE.work w ON w.id=j.id JOIN $INTAKE.receipt rcp ON rcp.id=w.receipt_id
    JOIN $INTAKE.reception r ON r.id=rcp.reception_id WHERE j.id=$1 AND r.context->>'scope_id'=$2 AND r.context->>'purpose_id'=$3`,
    [selector.job_id, context.scope_id, context.purpose_id])).rows[0];
  if (!j || j.state !== 'accepted') throw new IntakeFailure(404);
  const reception = {id: j.reception_id, principal: j.principal, context: j.context};
  await service.authority.resolve(a, 'extraction', undefined, reception);
  if (a.extractionView !== 'content') throw new IntakeFailure(404);
  const r = (await a.db.query(`SELECT r.*,o.location_binding,o.normalized_sha256,o.normalized_bytes,o.raw_sha256,
    a.binding,to_jsonb(o) AS output_record FROM $INTAKE.extraction_result r JOIN $INTAKE.extraction_output o ON o.id=r.output_id
    JOIN $INTAKE.extraction_attempt a ON a.job_id=r.job_id AND a.attempt_generation=r.attempt_generation
    WHERE r.id=$1 AND r.job_id=$2`, [j.accepted_result, j.id])).rows[0];
  if (!r) throw new IntakeFailure(503);
  const accepted = exact(r.effect_id, 1, {effectId: r.effect_id});
  if (!same(selector.reference, accepted)) throw new IntakeFailure(409);
  const original = {id: j.artifact_id, generation: j.generation, bytes: j.bytes, sha256: j.sha256};
  const event = await service.evidence(a, 'extraction', 'read_admission', {receptionId: j.reception_id, artifactId: original.id, generation: original.generation});
  const outputs = new PrivateExtractionPort('outputs'), bundle = JSON.parse(r.location_binding);
  let restoreAnchor: {id: string; sha256: string} | undefined;
  if (bundle.namespace !== service.config.namespace) {
    if (service.config.namespace !== 'intake_restore' || bundle.namespace !== 'intake_trial') throw new IntakeFailure(503);
    const cut = (await a.db.query(`SELECT n.backup_anchor,c.output_manifest_sha256 FROM intake_control.namespace_admission n
      JOIN intake_control.extraction_restore_cut c ON c.anchor_id=n.backup_anchor
      JOIN intake_control.extraction_restore_output o ON o.anchor_id=c.anchor_id
      WHERE n.namespace=$1 AND c.target_namespace=n.namespace AND n.enabled AND o.output_id=$2 AND o.original_row=$3::jsonb`,
      [service.config.namespace, r.output_id, JSON.stringify(r.output_record)])).rows[0];
    if (!cut) throw new IntakeFailure(503);
    restoreAnchor = {id: cut.backup_anchor, sha256: cut.output_manifest_sha256};
  }
  const observed = await extractionPhase({db: a.db, config: service.config, deadline: a.deadline, binding: r.binding,
    jobId: j.id, evidenceId: event.id, plan: {outputs: ['read']}, releaseAdmission: false, ports: {outputs},
    clock: label => service.clock(a, label, 'extraction'), barrier: service.hooks.barrier}, async phaseId => {
      await service.hooks.barrier?.('before_preparation_extraction_read', {jobId: j.id, evidenceId: event.id, backendPid: event.pid});
      await service.clock(a, 'preparation-source-read', 'extraction');
      return outputs.call({profile: 'intake-extraction-private/1', action: 'read', phaseId, incarnation: service.config.incarnation,
        namespace: service.config.namespace, original, evidenceId: event.id, subject: extractionSubject(r.binding), bundle,
        ...(restoreAnchor ? {restore_anchor: restoreAnchor} : {})});
    });
  const bytes = observed.value.ok && typeof observed.value.data === 'string' ? Buffer.from(observed.value.data, 'base64') : null;
  if (!bytes || bytes.length !== r.normalized_bytes || byteDigest(bytes) !== r.normalized_sha256) throw new IntakeFailure(503);
  const content = decodeExtractionContent(bytes) as Row;
  if (!EXTRACTION_CONTENT(content) || !same(content.original, original) || content.source.id !== r.binding.channel_id ||
    content.source.revision !== r.attempt_generation || content.source.sha256 !== r.raw_sha256) throw new IntakeFailure(503);
  a.now = await a.db.now(); await service.authority.resolve(a, 'extraction', undefined, reception);
  if (a.extractionView !== 'content') throw new IntakeFailure(404);
  return {bytes, input: {id: selector.id, kind: 'extraction', job_id: j.id, reference: accepted,
    receipt: exact(j.receipt_id, 1, {id: j.receipt_id, effectId: j.receipt_effect}), original, source: content.source,
    source_artifact: {id: r.output_id, generation: r.attempt_generation, bytes: r.normalized_bytes, sha256: r.normalized_sha256}}};
}
