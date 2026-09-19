import {IntakeFailure} from '../protocol.ts';
import type {Admission} from '../authority.ts';
import type {PreparationService} from './service.ts';
import {same, type Row} from './records.ts';
import {itemIdentity, proposalItem} from './proposals.ts';

/** Typed identity is separate from the person's explanatory declaration. */
export function targetIdentity(target: Row) {
  return target.kind === 'new' ? {kind: 'new'} :
    {kind: target.kind, unit_id: target.unit_id, version: target.version};
}

/** A selector and a matching digest are not permission to materialize a target. */
export async function comparisonCandidate(service: PreparationService, a: Admission, target: Row) {
  const current = await service.authority.resolve(a, 'preparation');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(target.unit_id) ||
    target.version.id !== target.unit_id) throw new IntakeFailure(404);
  const meta = (await a.db.query(`SELECT c.unit_id,c.version,c.preparation_id,c.preparation_revision,p.context,p.sha256
    FROM $INTAKE.candidate c JOIN $INTAKE.preparation p ON p.id=c.preparation_id AND p.revision=c.preparation_revision
    WHERE c.unit_id=$1 AND c.version=$2`, [target.unit_id, target.version.revision])).rows[0];
  if (!meta || !same(current, meta.context)) throw new IntakeFailure(404);
  const retained = await service.readPrepared(a, {id: meta.preparation_id, revision: meta.preparation_revision, sha256: meta.sha256});
  // The protected candidate body is read only after its retained preparation's
  // current partition/treatment admission and durable read receipt.
  const candidate = (await a.db.query('SELECT * FROM $INTAKE.candidate WHERE unit_id=$1 AND version=$2',
    [meta.unit_id, meta.version])).rows[0];
  if (!candidate || !same(candidate.reference, target.version)) throw new IntakeFailure(409);
  const unit = retained.record.payload.units.find((u: Row) =>
    (u.inseparable_group ? 'group:' + u.inseparable_group : 'unit:' + u.id) === candidate.unit_key);
  if (!unit) throw new IntakeFailure(503);
  const item = proposalItem(retained.record.payload, unit.id);
  if (itemIdentity(item, meta.context) !== candidate.content_identity) throw new IntakeFailure(503);
  service.shared.hooks.storage?.({origin: 'preparation-comparison-boundary', kind: 'read',
    unitId: candidate.unit_id, version: candidate.version, preparationId: meta.preparation_id});
  return {candidate, retained, item, context: meta.context};
}

/** Explicit claims only: no similarity search, hash identity or implicit successor. */
export function comparisonDisposition(target: Row, judgment: Row, identity: string, existing: Row | null) {
  if (target.kind === 'new') {
    if (judgment.evidence || judgment.kind === 'same_version') throw new IntakeFailure(409);
    return judgment.kind === 'possible_duplicate' ? 'possible_duplicate' : 'constituted';
  }
  if (!existing || !judgment.evidence || !same(judgment.evidence, existing.reference)) throw new IntakeFailure(409);
  if (judgment.kind === 'possible_duplicate') return 'possible_duplicate';
  if (target.kind === 'relationship') {
    if (judgment.kind !== 'same_version') throw new IntakeFailure(409);
    return identity === existing.content_identity ? 'relationship_recorded' : 'identity_collision';
  }
  if (judgment.kind !== 'distinct') throw new IntakeFailure(409);
  return 'constituted';
}

/** This realization has no admitted identity-adjudication route. A preparation
 * or constitution grant must not be promoted into adjudication competence. */
export function unresolvedDestination(context: Row, catalog: Row) {
  return {state: 'vacant', scope_id: context.scope_id, purpose_id: context.purpose_id,
    reason: 'no_admitted_adjudication_route', basis: {catalog, responsibility: 'FN-AMBITO'}};
}
