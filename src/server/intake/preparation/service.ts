import {randomUUID} from 'node:crypto';
import {PREPARATION_BOUNDS, preparationCanonical, validatePreparationCommand, readPreparationDocument, type Exact} from '../../../contracts/intake_preparation.ts';
import {BINDINGS} from '../../../contracts/intake_bindings.ts';
import {canonicalValue} from '../../../contracts/access_canonical.ts';
import {IntakeFailure, type ReceptionRequest} from '../protocol.ts';
import {currentIntakeControl, type Admission} from '../authority.ts';
import type {ReceptionService, PreparedIntake} from '../service.ts';
import {PreparationAuthority} from './authority.ts';
import {acceptedExtractionSource} from './sources.ts';
import {constructPreparation, type RetainedSource} from './producer.ts';
import {materializePreparation, persistPreparation, preparationMetadata} from './persistence.ts';
import {artifactFor, referenceFor, byteDigest, same, type Row} from './records.ts';
import {proposePreparation, constitutePreparation} from './proposals.ts';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

/** Synthetic preparation service. Terminal registration is separate and remains closed until realized. */
export class PreparationService {
  readonly authority: PreparationAuthority;
  readonly shared: ReceptionService;
  constructor(shared: ReceptionService) {
    this.shared = shared;
    this.authority = new PreparationAuthority(shared.authority, shared.config);
  }
  ensureEnabled() {
    if (this.shared.config.preparation !== 'intake-preparation/1') throw new IntakeFailure(404);
  }
  async open(request: ReceptionRequest, token: string | null, onLoss: () => void, keys: string[] = []) {
    this.ensureEnabled();
    return this.shared.authority.open(request, token, keys, onLoss);
  }
  async commandLocks(request: ReceptionRequest, body: Row, token: string | null, onLoss: () => void): Promise<string[]> {
    if (request.route === 'reserve_preparation') return ['intake:preparation-reservation-capacity',
      ...(body.base ? ['intake:prepared-revision:' + body.base.id] : [])];
    if (request.route === 'finalize_preparation') return ['intake:preparation-construction', 'intake:preparation-attempt:' + request.parameters.id];
    if (request.route === 'propose') return ['intake:prepared-items:' + request.parameters.id + ':' + request.parameters.revision,
      ...(body.target.kind === 'new' ? [] : ['intake:prepared-identity:' + body.target.unit_id])];
    if (request.route !== 'constitute') return [];
    // Discover only immutable routing metadata under current consultation
    // admission. Close that snapshot and its locks before acquiring the complete
    // item/identity/session/intention set in effective PostgreSQL order.
    const probe = await this.open(request, token, onLoss);
    let slot: string | null = null, keys: string[] = [];
    try {
      await this.shared.authority.beforeMetadata(probe, request.route);
      await this.authority.resolve(probe, 'lookup_operation');
      const known = request.clientKey && (await probe.db.query(`SELECT id FROM $INTAKE.editorial_intention
        WHERE deployment=$1 AND principal=$2 AND act=$3 AND variant=$4 AND client_key=$5`,
        [this.shared.config.deployment, probe.session.account_id, BINDINGS[request.route].basis, request.route, request.clientKey])).rowCount;
      if (known) return []; // Reconcile first; a changed selector cannot force a new protected read.
      if (!uuid(body.proposal.id)) throw new IntakeFailure(404);
      const meta = (await probe.db.query(`SELECT principal,context,slot_id,comparison_unit_id
        FROM $INTAKE.preparation_proposal WHERE id=$1`, [body.proposal.id])).rows[0];
      if (!meta || meta.principal !== probe.session.account_id) throw new IntakeFailure(404);
      await this.authority.resolve(probe, 'lookup_operation', meta.context);
      slot = meta.slot_id;
      keys = ['intake:constitution-slot:' + meta.slot_id,
        ...(meta.comparison_unit_id ? ['intake:prepared-identity:' + meta.comparison_unit_id] : [])];
    } finally {await probe.db.close();}
    await this.shared.hooks.barrier?.('before_constitution_competition', {proposalId: body.proposal.id, slotId: slot});
    return keys;
  }
  operationReference(id: string, request: ReceptionRequest, body: unknown) {
    return referenceFor('preparation-operation/1', id, 1, {operation: request.route,
      canonical: preparationCanonical(request.route as any, request.parameters, body, canonicalValue)});
  }
  async recordEffect(a: Admission, request: ReceptionRequest, body: Row, id: string, result: Row, context: Row) {
    const reference = this.operationReference(id, request, body);
    await a.db.query('INSERT INTO $INTAKE.editorial_effect VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, a.session.account_id, context, request.route, reference, result, a.now]);
    await this.recordIntention(a, request, body, id);
    await this.shared.evidence(a, request.route, 'effect', {operationId: id});
    return reference;
  }
  async recordIntention(a: Admission, request: ReceptionRequest, body: Row, id: string) {
    if (request.clientKey) await a.db.query('INSERT INTO $INTAKE.editorial_intention VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [randomUUID(), this.shared.config.deployment, a.session.account_id, BINDINGS[request.route].basis, request.route,
        request.clientKey, 'canon_m09_1', 1, this.shared.digest(preparationCanonical(request.route as any, request.parameters, body, canonicalValue)), id, a.now]);
  }
  async known(a: Admission, request: ReceptionRequest, body: Row): Promise<PreparedIntake | null> {
    if (!request.clientKey) return null;
    const prior = (await a.db.query(`SELECT id,effect_id,canonical_profile,digest_key_version,fingerprint FROM $INTAKE.editorial_intention
      WHERE deployment=$1 AND principal=$2 AND act=$3 AND variant=$4 AND client_key=$5`,
      [this.shared.config.deployment, a.session.account_id, BINDINGS[request.route].basis, request.route, request.clientKey])).rows[0];
    if (!prior) return null;
    await this.authority.resolve(a, 'lookup_operation');
    if (prior.canonical_profile !== 'canon_m09_1' || prior.digest_key_version !== 1) throw new IntakeFailure(503);
    const canonical = preparationCanonical(request.route as any, request.parameters, body, canonicalValue);
    if (prior.fingerprint !== this.shared.digest(canonical)) throw new IntakeFailure(409);
    return this.knownEffect(a, request, prior.effect_id);
  }
  async knownEffect(a: Admission, request: ReceptionRequest, id: string) {
    await this.authority.resolve(a, 'lookup_operation');
    const meta = (await a.db.query('SELECT id,principal,context,reference FROM $INTAKE.editorial_effect WHERE id=$1', [id])).rows[0];
    if (!meta || meta.principal !== a.session.account_id) throw new IntakeFailure(404);
    await this.authority.resolve(a, 'lookup_operation', meta.context);
    const evidence = await this.shared.evidence(a, request.route, 'read_admission', {operationId: id});
    await a.db.commit();
    await this.shared.hooks.barrier?.('before_preparation_effect_read', {operationId: id, evidenceId: evidence.id, backendPid: evidence.pid});
    await this.shared.clock(a, 'preparation-effect-query', request.route);
    const value = (await a.db.query('SELECT result FROM $INTAKE.editorial_effect WHERE id=$1', [id])).rows[0];
    if (!value) throw new IntakeFailure(503);
    await a.db.begin([]);
    return this.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1',
      state: 'known_effect', operation_id: id, effect: meta.reference, result: value.result}, id);
  }
  async readPrepared(a: Admission, reference: Exact) {
    const context = await this.authority.resolve(a, 'preparation');
    if (!uuid(reference.id)) throw new IntakeFailure(404);
    const meta = await preparationMetadata(a.db, reference.id, reference.revision);
    if (!meta || !same({scope_id: meta.context.scope_id, purpose_id: meta.context.purpose_id},
      {scope_id: context.scope_id, purpose_id: context.purpose_id})) throw new IntakeFailure(404);
    await this.authority.resolve(a, 'preparation', meta.context);
    if (meta.sha256 !== reference.sha256) throw new IntakeFailure(409);
    // This representation includes difference bodies. Preparation permission does
    // not substitute for the distinct difference view admission.
    if (meta.has_differences) await this.authority.resolve(a, 'difference', meta.context);
    const event = await this.shared.evidence(a, 'preparation', 'read_admission', {artifactId: meta.artifact_id, generation: meta.generation});
    await a.db.commit();
    await this.shared.hooks.barrier?.('before_preparation_body_read', {preparationId: meta.id, revision: meta.revision, evidenceId: event.id, backendPid: event.pid});
    await this.shared.clock(a, 'preparation-body-read', 'preparation');
    const retained = await materializePreparation(a.db, reference);
    this.shared.hooks.storage?.({origin: 'prepared-record-boundary', kind: 'read', preparationId: meta.id,
      revision: meta.revision, bytes: retained.bytes.length, differences: retained.record.differences.length, evidenceId: event.id});
    await a.db.begin([]);
    return {...retained, meta};
  }
  async difference(a: Admission, request: ReceptionRequest) {
    await this.authority.resolve(a, 'difference');
    const meta = (await a.db.query(`SELECT d.preparation_id,d.preparation_revision,p.sha256
      FROM $INTAKE.preparation_difference d JOIN $INTAKE.preparation p
      ON p.id=d.preparation_id AND p.revision=d.preparation_revision WHERE d.id=$1`, [request.parameters.id])).rows[0];
    if (!meta) throw new IntakeFailure(404);
    // Validate the retained transition, not a detached, self-authenticating act.
    const retained = await this.readPrepared(a, {id: meta.preparation_id, revision: meta.preparation_revision, sha256: meta.sha256});
    const difference = retained.record.differences.find(d => d.reference.id === request.parameters.id);
    if (!difference) throw new IntakeFailure(503);
    return this.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1',
      preparation: retained.record.reference, difference}, null);
  }
  async resourceBody(a: Admission, retained: Awaited<ReturnType<PreparationService['readPrepared']>>, localId: string) {
    await this.authority.resolve(a, 'resource', retained.meta.context);
    const association = retained.record.payload.resource_associations.find((row: Row) => row.local_id === localId);
    if (!association) throw new IntakeFailure(404);
    // materializePreparation has checked this association against the exact
    // conserved payload. An existing intact resource is not interchangeable.
    const artifact = association.artifact;
    const event = await this.shared.evidence(a, 'resource', 'read_admission');
    await a.db.query(`INSERT INTO $INTAKE.preparation_resource_read VALUES($1,$2,$3,$4)`,
      [event.id, retained.meta.id, retained.meta.revision, association.local_id]);
    await a.db.commit();
    await this.shared.hooks.barrier?.('before_prepared_resource_read', {preparationId: retained.meta.id,
      revision: retained.meta.revision, localId, artifactId: artifact.id, evidenceId: event.id, backendPid: event.pid});
    await this.shared.clock(a, 'prepared-resource-read', 'resource');
    const row = (await a.db.query('SELECT body FROM $INTAKE.preparation_resource WHERE id=$1 AND generation=$2 AND bytes=$3 AND sha256=$4',
      [artifact.id, artifact.generation, artifact.bytes, artifact.sha256])).rows[0];
    if (!row) throw new IntakeFailure(503);
    const bytes = Buffer.from(row.body);
    this.shared.hooks.storage?.({origin: 'prepared-resource-boundary', kind: 'read', preparationId: retained.meta.id,
      revision: retained.meta.revision, localId, artifactId: artifact.id, bytes: bytes.length, evidenceId: event.id});
    if (bytes.length !== artifact.bytes || byteDigest(bytes) !== artifact.sha256) throw new IntakeFailure(503);
    await a.db.begin([]);
    return {association, artifact, bytes};
  }
  async resource(a: Admission, request: ReceptionRequest) {
    await this.authority.resolve(a, 'resource');
    if (!uuid(request.parameters.id)) throw new IntakeFailure(404);
    const meta = await preparationMetadata(a.db, request.parameters.id, Number(request.parameters.revision));
    if (!meta) throw new IntakeFailure(404);
    const reference = {id: meta.id, revision: meta.revision, sha256: meta.sha256};
    const retained = await this.readPrepared(a, reference);
    const resource = await this.resourceBody(a, retained, request.parameters.resource_id);
    return this.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1',
      preparation: reference, element_id: resource.association.element_id, local_resource_id: resource.association.local_id,
      artifact: resource.artifact, encoding: 'base64', data: resource.bytes.toString('base64')}, null);
  }
  async sources(a: Admission, selectors: Row[], selections: Row[] = [], loadResources = false): Promise<RetainedSource[]> {
    const result: RetainedSource[] = [];
    for (const selector of selectors) {
      const selected = selections.filter(s => s.input_id === selector.id && s.resource);
      if (selected.length) await this.authority.resolve(a, 'resource');
      if (selector.kind === 'extraction') result.push(await acceptedExtractionSource(this.shared, a, selector));
      else {
        const retained = await this.readPrepared(a, selector.reference);
        const resourceBodies = [];
        if (loadResources) for (const selection of selected) {
          const association = retained.record.payload.resource_associations.find((row: Row) => row.element_id === selection.element_id);
          if (!association || !same(association.artifact, selection.resource)) throw new IntakeFailure(409);
          const resource = await this.resourceBody(a, retained, association.local_id);
          resourceBodies.push({artifact: resource.artifact, bytes: resource.bytes});
        }
        result.push({input: {id: selector.id, kind: 'preparation', reference: selector.reference,
          source_artifact: retained.record.descriptor.payload}, bytes: retained.bytes, preparation: retained.record, resourceBodies});
      }
    }
    return result;
  }
  async attempt(a: Admission, id: string, operation: string) {
    if (!uuid(id)) throw new IntakeFailure(404);
    const row = (await a.db.query(`SELECT a.id,a.principal,a.origin_session,a.context,a.state,a.operation_id,a.preparation_id,a.revision,
      a.staged_id,a.artifact_id,a.declared_bytes,a.declared_sha256,e.reference AS predecessor
      FROM $INTAKE.preparation_attempt a JOIN $INTAKE.editorial_effect e ON e.id=a.operation_id WHERE a.id=$1`, [id])).rows[0];
    if (!row || row.principal !== a.session.account_id) throw new IntakeFailure(404);
    const consequence = operation === 'upload_preparation' ? {mode: 'authorized_consequence', predecessor: row.predecessor,
      authorization: {act: row.predecessor, express_authorization: row.predecessor,
        target: {id: row.staged_id, revision: 1, sha256: row.declared_sha256}}} : {predecessor: row.predecessor};
    if (operation === 'upload_preparation' && row.origin_session !== a.session.digest) throw new IntakeFailure(404);
    await this.authority.resolve(a, operation, row.context, consequence);
    return row;
  }
  async reserve(a: Admission, request: ReceptionRequest, body: Row) {
    await this.authority.resolve(a, 'reserve_preparation', body.context);
    if (Number((await a.db.query('SELECT count(*) AS n FROM $INTAKE.preparation_attempt')).rows[0].n) >= PREPARATION_BOUNDS.attempts)
      throw new IntakeFailure(429);
    const sources = await this.sources(a, body.inputs, body.selection);
    for (const selection of body.selection) {
      const source = sources.find(s => s.input.id === selection.input_id);
      if (!source) throw new IntakeFailure(409);
      // Full construction follows staging; reservation fixes selectors, not caller-authenticated outputs.
      if (source.input.kind === 'preparation' && !source.preparation!.payload.elements.some((e: Row) => e.id === selection.element_id)) throw new IntakeFailure(409);
    }
    let preparationId = randomUUID(), revision = 1;
    if (body.base) {
      if (!sources.some(s => s.input.kind === 'preparation' && same(s.input.reference, body.base))) throw new IntakeFailure(409);
      preparationId = body.base.id;
      revision = Number((await a.db.query('SELECT coalesce(max(revision),0)+1 AS revision FROM $INTAKE.preparation_attempt WHERE preparation_id=$1', [preparationId])).rows[0].revision);
    }
    a.now = await a.db.now(); await this.authority.resolve(a, 'reserve_preparation', body.context);
    const id = randomUUID(), operationId = randomUUID(), stagedId = randomUUID(), artifactId = randomUUID();
    const result = {state: 'reserved', attempt_id: id, preparation: {id: preparationId, revision},
      document: {id: stagedId, generation: 1, bytes: body.document.bytes, sha256: body.document.sha256},
      continuation: {operation: 'upload_preparation', mode: 'authorized_consequence', target: stagedId, origin_session_bound: true}};
    await a.db.query(`INSERT INTO $INTAKE.preparation_attempt VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved',$13)`,
      [id, operationId, a.session.account_id, a.session.digest, body.context, body, preparationId, revision,
        stagedId, artifactId, body.document.bytes, body.document.sha256, a.now]);
    const effect = await this.recordEffect(a, request, body, operationId, result, body.context);
    await this.shared.clock(a, 'E_reserve_preparation', request.route);
    return this.shared.prepared(a, request, 202, {profile: 'intake/1', representation: 'intake-preparation/1', operation_id: operationId, effect, result}, operationId);
  }
  async finalize(a: Admission, request: ReceptionRequest, body: Row) {
    const attempt = await this.attempt(a, request.parameters.id, 'finalize_preparation');
    if (body.expected_revision !== attempt.revision || body.differences.length) throw new IntakeFailure(409);
    if (attempt.state !== 'staged') throw new IntakeFailure(409);
    const stage = {id: attempt.staged_id, generation: 1, bytes: attempt.declared_bytes, sha256: attempt.declared_sha256};
    if (!same(body.document, stage)) throw new IntakeFailure(409);
    const event = await this.shared.evidence(a, request.route, 'read_admission', {artifactId: stage.id, generation: 1});
    await a.db.commit(); await this.shared.clock(a, 'preparation-stage-read', request.route);
    const stored = (await a.db.query('SELECT body FROM $INTAKE.preparation_stage WHERE attempt_id=$1 AND id=$2', [attempt.id, stage.id])).rows[0];
    const declaration = (await a.db.query('SELECT reservation FROM $INTAKE.preparation_attempt WHERE id=$1', [attempt.id])).rows[0];
    if (!stored || !declaration) throw new IntakeFailure(503);
    const bytes = Buffer.from(stored.body);
    if (bytes.length !== stage.bytes || byteDigest(bytes) !== stage.sha256) throw new IntakeFailure(503);
    const document = readPreparationDocument(bytes);
    await a.db.begin([]);
    const sources = await this.sources(a, declaration.reservation.inputs, declaration.reservation.selection, true);
    a.now = await a.db.now(); await this.attempt(a, request.parameters.id, 'finalize_preparation');
    const operationId = randomUUID(), operation = this.operationReference(operationId, request, body);
    const resources: Array<{artifact: any; bytes: Buffer}> = [];
    for (const source of sources) {
      if (source.input.kind === 'extraction') {
        const content = JSON.parse(Buffer.from(source.bytes).toString('utf8'));
        for (const resource of content.instrumented_resources?.payloads ?? []) if (declaration.reservation.selection.some((s: Row) => s.resource && same(s.resource, resource.artifact)))
          resources.push({artifact: resource.artifact, bytes: Buffer.from(resource.data, 'base64')});
      } else resources.push(...source.resourceBodies ?? []);
    }
    const produced = constructPreparation({reservation: declaration.reservation, document, staged: stage, stagedBytes: bytes, sources,
      id: attempt.preparation_id, revision: attempt.revision, artifactId: attempt.artifact_id, operation,
      actor: a.session.account_id, recordedAt: a.now, resourceBodies: resources});
    await persistPreparation(a.db, attempt, produced);
    const result = {state: 'prepared', preparation: produced.record.reference, differences: produced.record.descriptor.differences};
    const effect = await this.recordEffect(a, request, body, operationId, result, attempt.context);
    await this.shared.clock(a, 'E_prepare', request.route);
    return this.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1', operation_id: operationId, effect, result}, operationId);
  }
  async command(request: ReceptionRequest, body: Row, token: string | null, onLoss: () => void): Promise<PreparedIntake> {
    if (!validatePreparationCommand(request.route as any, body)) throw new IntakeFailure(400);
    const keys = await this.commandLocks(request, body, token, onLoss);
    const a = await this.open(request, token, onLoss, keys);
    try {
      await this.shared.authority.beforeMetadata(a, request.route);
      const known = await this.known(a, request, body); if (known) return known;
      if (request.route === 'lookup_operation') {
        if (!uuid(body.operation_id)) throw new IntakeFailure(404);
        return await this.knownEffect(a, request, body.operation_id);
      }
      if (request.route === 'reserve_preparation') return await this.reserve(a, request, body);
      if (request.route === 'finalize_preparation') return await this.finalize(a, request, body);
      if (request.route === 'propose') return await proposePreparation(this, a, request, body);
      if (request.route === 'constitute') return await constitutePreparation(this, a, request, body);
      if (request.route === 'difference') return await this.difference(a, request);
      if (request.route === 'resource') return await this.resource(a, request);
      if (request.route === 'preparation') {
        await this.authority.resolve(a, 'preparation');
        if (!uuid(request.parameters.id)) throw new IntakeFailure(404);
        const meta = await preparationMetadata(a.db, request.parameters.id, Number(request.parameters.revision));
        if (!meta) throw new IntakeFailure(404);
        const retained = await this.readPrepared(a, {id: meta.id, revision: meta.revision, sha256: meta.sha256});
        return await this.shared.prepared(a, request, 200, {profile: 'intake/1', representation: 'intake-preparation/1', preparation: retained.record}, null);
      }
      // Entries with no completed handler remain closed, even with a present catalog row.
      throw new IntakeFailure(404);
    } catch (error) {await a.db.close(); throw error;}
  }
}
