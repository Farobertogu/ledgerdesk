import {randomUUID} from 'node:crypto';
import {canonicalValue} from '../../../contracts/access_canonical.ts';
import {IntakeFailure, type ReceptionRequest} from '../protocol.ts';
import type {Admission} from '../authority.ts';
import type {PreparationService} from './service.ts';
import {preparationMetadata} from './persistence.ts';
import {byteDigest, referenceFor, same, type Row} from './records.ts';
import {comparisonCandidate, comparisonDisposition, targetIdentity, unresolvedDestination} from './comparison.ts';
import {readPriorAct, priorActMetadata, matchPriorAct} from './prior_act.ts';

/** Explicit item closure, not parser chunks or an implicit whole-document action. */
export function proposalItem(payload: Row, unitId: string) {
  const selected = payload.units.find((u: Row) => u.id === unitId);
  if (!selected) throw new IntakeFailure(404);
  const units = selected.inseparable_group ? payload.units.filter((u: Row) => u.inseparable_group === selected.inseparable_group) : [selected];
  const elementIds = [...new Set<string>(units.flatMap((u: Row) => u.elements))];
  const elements = payload.elements.filter((e: Row) => elementIds.includes(e.id));
  if (elements.length !== elementIds.length || payload.relations.some((r: Row) => elementIds.includes(r.from) !== elementIds.includes(r.to)))
    throw new IntakeFailure(409);
  const relations = payload.relations.filter((r: Row) => elementIds.includes(r.from));
  const conditions = payload.conditions.filter((c: Row) => units.some((u: Row) => u.conditions.includes(c.id)));
  const components = payload.components.filter((c: Row) => units.some((u: Row) => u.coverage.components.includes(c.id)));
  const key = selected.inseparable_group ? 'group:' + selected.inseparable_group : 'unit:' + selected.id;
  return {key, units, elements, relations, conditions, components,
    incidents: payload.incidents.filter((i: Row) => components.some((c: Row) => c.incidents.includes(i.id))),
    resources: payload.resources.filter((r: Row) => elements.some((e: Row) => e.kind === 'resource' && same(e.resource, r)))};
}
export function itemIdentity(item: Row, context: Row): string {
  const position = (id: string) => item.elements.findIndex((e: Row) => e.id === id);
  return byteDigest(Buffer.from(canonicalValue({
    elements: item.elements.map((e: Row) => {
      const {id, antecedents, ...content} = e;
      if (content.kind === 'resource') content.resource = {bytes: content.resource.bytes, sha256: content.resource.sha256};
      return content;
    }),
    relations: item.relations.map((r: Row) => ({from: position(r.from), to: position(r.to), role: r.role, scope: r.scope})),
    conditions: item.conditions.map((c: Row) => ({text: c.text, scope: c.scope})),
    scope: context.scope_id, purpose: context.purpose_id, treatment: context.treatment_revision,
    classifications: item.units.map((u: Row) => u.classification),
    coverage: item.components.map((c: Row) => ({execution: c.execution, coverage: c.coverage, fidelity: c.fidelity, limitations: c.limitations})),
    incidents: item.incidents.map((i: Row) => ({cause: i.cause, code: i.code ?? null, detail: i.detail ?? null})),
    complete_source_claims: item.units.map((u: Row) => u.coverage.complete_source_claim),
  })));
}

export async function proposePreparation(service: PreparationService, a: Admission, request: ReceptionRequest, body: Row) {
  await service.authority.resolve(a, 'propose');
  const meta = await preparationMetadata(a.db, request.parameters.id, Number(request.parameters.revision));
  if (!meta) throw new IntakeFailure(404);
  const reference = {id: meta.id, revision: meta.revision, sha256: meta.sha256};
  const retained = await service.readPrepared(a, reference), item = proposalItem(retained.record.payload, body.unit);
  const targetKey = canonicalValue(targetIdentity(body.target));
  const compared = body.target.kind === 'new' ? null : await comparisonCandidate(service, a, body.target);
  const identity = itemIdentity(item, meta.context);
  const disposition = comparisonDisposition(body.target, body.judgment, identity, compared?.candidate ?? null);
  let slot = (await a.db.query(`SELECT * FROM $INTAKE.constitution_slot WHERE preparation_id=$1 AND preparation_revision=$2 AND unit_key=$3`,
    [meta.id, meta.revision, item.key])).rows[0];
  if (slot && slot.target_key !== targetKey) throw new IntakeFailure(409);
  if (!slot) {
    slot = {id: randomUUID(), allocated_unit_id: randomUUID()};
    await a.db.query('INSERT INTO $INTAKE.constitution_slot VALUES($1,$2,$3,$4,$5,$6)',
      [slot.id, meta.id, meta.revision, item.key, targetKey, slot.allocated_unit_id]);
  }
  a.now = await a.db.now(); await service.authority.resolve(a, 'propose', meta.context);
  const id = randomUUID(), operationId = randomUUID();
  const proposal = {profile: 'preparation-proposal/1', preparation: reference, unit: body.unit, item: item.key,
    slot_id: slot.id, target: body.target, judgment: body.judgment, selected: item.elements.map((e: Row) => e.id),
    identity, disposition, context: meta.context};
  const proposalReference = referenceFor('preparation-proposal/1', id, 1, proposal);
  await a.db.query('INSERT INTO $INTAKE.preparation_proposal VALUES($1,1,$2,$3,$4,$5,$6,$7,$8)',
    [id, proposalReference.sha256, slot.id, a.session.account_id, meta.context,
      body.target.kind === 'new' ? null : body.target.unit_id, proposal, a.now]);
  const result = {state: 'proposed', proposal: proposalReference, preparation: reference, item: item.key};
  const effect = await service.recordEffect(a, request, body, operationId, result, meta.context);
  await service.shared.clock(a, 'E_propose', request.route);
  return service.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1',
    operation_id: operationId, effect, result, inspection: {proposal, preparation: retained.record}}, operationId);
}

export async function constitutePreparation(service: PreparationService, a: Admission, request: ReceptionRequest, body: Row) {
  // The historical item outcome is resolved under query authority before demanding a new exercise.
  await service.authority.resolve(a, 'lookup_operation');
  const metadata = (await a.db.query('SELECT id,sha256,principal,context,slot_id FROM $INTAKE.preparation_proposal WHERE id=$1', [body.proposal.id])).rows[0];
  if (!metadata || metadata.principal !== a.session.account_id) throw new IntakeFailure(404);
  if (body.proposal.revision !== 1 || body.proposal.sha256 !== metadata.sha256) throw new IntakeFailure(409);
  await service.authority.resolve(a, 'lookup_operation', metadata.context);
  const previous = (await a.db.query('SELECT id,principal FROM $INTAKE.constitution_outcome WHERE slot_id=$1', [metadata.slot_id])).rows[0];
  if (previous) {
    const existing = (await a.db.query("SELECT id FROM $INTAKE.editorial_effect WHERE operation='constitute' AND result->>'outcome_id'=$1 AND principal=$2",
      [previous.id, a.session.account_id])).rows[0];
    if (!existing) throw new IntakeFailure(503);
    // A second client key reconciles the same logical item, but its compared
    // payload must remain bound: it cannot later execute against another item.
    await service.recordIntention(a, request, body, existing.id);
    return service.knownEffect(a, request, existing.id);
  }
  const prior = body.mode === 'authorized_consequence' ?
    await readPriorAct(service, a, request, body.prior_act, metadata.context) : null;
  if (!prior) await service.authority.resolve(a, 'constitute', metadata.context, {mode: 'person'});
  const read = await service.shared.evidence(a, 'constitute', 'read_admission');
  await a.db.commit();
  await service.shared.clock(a, 'preparation-proposal-read', request.route);
  const row = (await a.db.query('SELECT body FROM $INTAKE.preparation_proposal WHERE id=$1', [metadata.id])).rows[0];
  if (!row || !same(referenceFor('preparation-proposal/1', metadata.id, 1, row.body), body.proposal)) throw new IntakeFailure(503);
  await a.db.begin([]);
  if (prior) matchPriorAct(prior, row.body, body.proposal);
  const proposal = row.body, retained = await service.readPrepared(a, proposal.preparation), item = proposalItem(retained.record.payload, proposal.unit);
  if (!same(proposal.selected, item.elements.map((e: Row) => e.id)) || proposal.identity !== itemIdentity(item, metadata.context) ||
    item.units.some((u: Row) => u.examination.outcome !== 'classifiable'))
    throw new IntakeFailure(409);
  const compared = proposal.target.kind === 'new' ? null : await comparisonCandidate(service, a, proposal.target);
  const disposition = comparisonDisposition(proposal.target, proposal.judgment, proposal.identity, compared?.candidate ?? null);
  if (disposition !== proposal.disposition) throw new IntakeFailure(409);
  a.now = await a.db.now();
  if (prior) await priorActMetadata(service, a, body.prior_act, metadata.context);
  else await service.authority.resolve(a, 'constitute', metadata.context);
  const slot = (await a.db.query('SELECT * FROM $INTAKE.constitution_slot WHERE id=$1', [metadata.slot_id])).rows[0];
  if (!slot || slot.preparation_id !== proposal.preparation.id || slot.preparation_revision !== proposal.preparation.revision ||
    slot.unit_key !== item.key || slot.target_key !== canonicalValue(targetIdentity(proposal.target)))
    throw new IntakeFailure(503);
  const outcomeId = randomUUID(), operationId = randomUUID();
  const blocked = ['identity_collision', 'possible_duplicate'].includes(disposition);
  const provenance = {inputs: retained.record.payload.inputs, differences: retained.record.descriptor.differences,
    preparation: proposal.preparation, judgment: proposal.judgment, target: proposal.target,
    execution: {mode: body.mode, executor: a.executor, principal: a.session.account_id,
      authorization: prior?.authorization ?? null, issuer: prior?.body.issuer ?? null,
      issuance_evidence: prior?.body.issuance_evidence ?? null}};
  const version = proposal.target.kind === 'successor' ? proposal.target.version.revision + 1 : 1;
  if (!Number.isSafeInteger(version)) throw new IntakeFailure(409);
  if (proposal.target.kind === 'successor') {
    const latest = Number((await a.db.query('SELECT max(version) AS version FROM $INTAKE.candidate WHERE unit_id=$1', [proposal.target.unit_id])).rows[0].version);
    if (latest !== proposal.target.version.revision) throw new IntakeFailure(409);
  }
  const candidate = disposition === 'constituted' ? referenceFor('preparation-effect/1',
    proposal.target.kind === 'successor' ? proposal.target.unit_id : slot.allocated_unit_id, version,
    {preparation: proposal.preparation, item: item.key, identity: proposal.identity}) : null;
  const relationship = disposition === 'relationship_recorded' ? {version: compared!.candidate.reference,
    preparation: proposal.preparation, relation: 'authenticated_repetition'} : null;
  const block = blocked ? {kind: disposition, preparation: proposal.preparation, proposal: body.proposal,
    comparison: compared?.candidate.reference ?? null, actor: a.session.account_id, recorded_at: a.now,
    reason: proposal.judgment.reason, continuation: 'awaiting_separate_adjudication',
    destination: unresolvedDestination(metadata.context, service.shared.config.catalog)} : null;
  const outcome = {outcome: blocked ? 'blocked' : disposition, block_kind: blocked ? disposition : null,
    outcome_id: outcomeId, candidates: candidate ? [candidate] : [], relationships: relationship ? [relationship] : [], blocks: block ? [block] : []};
  const outcomeReference = referenceFor('preparation-effect/1', outcomeId, 1, outcome);
  await service.shared.hooks.barrier?.('before_constitution_persist', {slotId: slot.id,
    proposalId: metadata.id, backendPid: a.db.backendPid});
  await a.db.query('INSERT INTO $INTAKE.constitution_outcome VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [outcomeId, slot.id, metadata.id, outcome.outcome, outcome.block_kind, outcomeReference, outcome, a.session.account_id, metadata.context, a.now]);
  if (candidate) await a.db.query('INSERT INTO $INTAKE.candidate VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,\'candidate\')',
    [candidate.id, candidate.revision, outcomeId, proposal.preparation.id, proposal.preparation.revision, item.key, candidate,
      proposal.identity, JSON.stringify(item.conditions), provenance]);
  if (relationship) await a.db.query('INSERT INTO $INTAKE.candidate_relationship VALUES($1,$2,$3,$4)',
    [outcomeId, compared!.candidate.unit_id, compared!.candidate.version, provenance]);
  const effect = await service.recordEffect(a, request, body, operationId, outcome, metadata.context);
  await service.shared.clock(a, 'E_constitute', request.route);
  return service.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1', operation_id: operationId, effect, result: outcome}, operationId);
}
