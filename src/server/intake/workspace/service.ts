import {WORKSPACE_PROFILE, type WorkspaceQuery} from '../../../contracts/intake_workspace.ts';
import {BINDINGS} from '../../../contracts/intake_bindings.ts';
import type {Admission} from '../authority.ts';
import type {PreparedIntake, ReceptionService} from '../service.ts';
import {IntakeFailure, type ReceptionRequest} from '../protocol.ts';
import {PreparationService} from '../preparation/service.ts';
import {itemIdentity, proposalItem} from '../preparation/proposals.ts';
import {referenceFor, same} from '../preparation/records.ts';
import {selected, projection, phase} from '../reception.ts';
import {readExtraction} from '../extraction_query.ts';

const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export class WorkspaceService {
  readonly shared: ReceptionService;
  readonly preparation: PreparationService;
  constructor(shared: ReceptionService) {this.shared = shared; this.preparation = new PreparationService(shared);}

  /** Check existing evaluators in the admitted snapshot, preserving the query binding.
   * An offer never executes a command and never authorizes a later effect. */
  async offered(a: Admission, evaluate: () => Promise<unknown>) {
    const previous = {binding: a.binding, entry: a.entry, treatment: a.treatment, extractionView: a.extractionView};
    try {await evaluate(); return true;}
    catch (error) {if (error instanceof IntakeFailure && error.status === 404) return false; throw error;}
    finally {Object.assign(a, previous);}
  }

  async reception(a: Admission, request: ReceptionRequest) {
    await this.shared.authority.resolve(a, 'reception');
    if (!uuid(request.parameters.id)) throw new IntakeFailure(404);
    const {reception, attempt} = await selected(a.db, request.parameters.id, a.session.account_id);
    await this.shared.authority.resolve(a, 'reception', undefined, reception);
    const operation = (await a.db.query("SELECT id FROM $INTAKE.intention WHERE reception_id=$1 AND variant='reserve_reception'", [reception.id])).rows[0];
    if (!operation) throw new IntakeFailure(503);
    const body = await projection(a.db, reception, attempt, operation.id, 2), offers: string[] = [];
    const retainedOriginal = body.effect !== null && attempt.state === 'sealed' && ['received', 'stopped'].includes(body.state);
    if (retainedOriginal && await this.offered(a, () => this.shared.authority.resolve(a, 'original', undefined, reception))) offers.push('inspect_original');
    if (body.work && await this.offered(a, () => this.shared.authority.resolve(a, 'extraction', undefined, reception))) offers.push('inspect_extraction');
    const processing = body.work && 'extraction' in body.work ? body.work.extraction : null;
    const stoppable = !reception.stopped && (body.state !== 'received' || processing && processing.attempt_generation > 0 && !['accepted', 'stopped'].includes(processing.state));
    if (stoppable && await this.offered(a, () => this.shared.authority.resolve(a, 'cancel_reception', undefined, reception, phase(a, reception, attempt)))) offers.push('stop');
    await this.shared.evidence(a, request.route, 'query', {operationId: operation.id, receptionId: reception.id});
    return this.shared.prepared(a, request, 200, {profile: WORKSPACE_PROFILE, kind: 'reception', reception: body, offers}, operation.id);
  }

  async extraction(a: Admission, request: ReceptionRequest) {
    if (!uuid(request.parameters.id)) throw new IntakeFailure(404);
    return readExtraction(this.shared, a, request, async (body, context) => {
      const offers: string[] = [];
      if (body.view === 'content' && body.result && await this.offered(a, async () => {
        for (const operation of ['reserve_preparation', 'upload_preparation', 'finalize_preparation'])
          await this.preparation.authority.resolve(a, operation, context,
            operation === 'upload_preparation' ? {mode: 'authorized_consequence'} : undefined, true);
      })) offers.push('prepare');
      return {profile: WORKSPACE_PROFILE, kind: 'extraction', extraction: body, offers};
    });
  }

  async context(a: Admission, request: ReceptionRequest) {
    await this.shared.authority.resolve(a, 'profiles');
    const context = {scope_id: a.binding.scope.id, purpose_id: a.binding.purpose, treatment_revision: a.binding.treatment};
    const receive = await this.shared.authority.receptionOffered(a, context);
    // Reuse the exact admitted profile projection; never reinterpret its configuration flag as authority.
    const result = await this.shared.profiles(a, {...request, representation: 2});
    return {...result, body: {profile: WORKSPACE_PROFILE, kind: 'context', deployment: this.shared.config.deployment, context,
      offers: receive ? ['receive'] : [], availability: result.body}};
  }

  async effect(a: Admission, request: ReceptionRequest, query: Extract<WorkspaceQuery, {kind: 'preparation_effect'}>) {
    await this.preparation.authority.resolve(a, 'lookup_operation');
    const row = (await a.db.query(`SELECT effect_id,canonical_profile,digest_key_version FROM $INTAKE.editorial_intention
      WHERE deployment=$1 AND principal=$2 AND act=$3 AND variant=$4 AND client_key=$5`,
      [this.shared.config.deployment, a.session.account_id, BINDINGS[query.variant].basis, query.variant, query.client_key])).rows[0];
    if (!row) throw new IntakeFailure(404);
    if (row.canonical_profile !== 'canon_m09_1' || row.digest_key_version !== 1) throw new IntakeFailure(503);
    const result = await this.preparation.knownEffect(a, request, row.effect_id);
    return {...result, body: {profile: WORKSPACE_PROFILE, kind: query.kind, effect: result.body}};
  }

  async attempt(a: Admission, request: ReceptionRequest, query: Extract<WorkspaceQuery, {kind: 'preparation_attempt'}>) {
    await this.preparation.authority.resolve(a, 'lookup_operation');
    if (!uuid(query.attempt_id)) throw new IntakeFailure(404);
    // No staged body or original declaration is selected by this metadata query.
    const row = (await a.db.query(`SELECT id,principal,context,state,preparation_id,revision,
      staged_id,declared_bytes,declared_sha256 FROM $INTAKE.preparation_attempt WHERE id=$1`, [query.attempt_id])).rows[0];
    if (!row || row.principal !== a.session.account_id) throw new IntakeFailure(404);
    await this.preparation.authority.resolve(a, 'lookup_operation', row.context);
    const document = {id: row.staged_id, generation: 1, bytes: row.declared_bytes, sha256: row.declared_sha256};
    if (!same(query.document, document)) throw new IntakeFailure(409);
    const finalize = row.state === 'staged' && await this.offered(a,
      () => this.preparation.authority.resolve(a, 'finalize_preparation', row.context, undefined, true));
    await this.shared.evidence(a, request.route, 'query');
    return this.shared.prepared(a, request, 200, {profile: WORKSPACE_PROFILE, kind: query.kind,
      attempt_id: row.id, state: row.state, document, preparation: {id: row.preparation_id, revision: row.revision},
      offers: finalize ? ['finalize_preparation'] : []}, null);
  }

  async inspection(a: Admission, request: ReceptionRequest, query: Extract<WorkspaceQuery, {kind: 'proposal_inspection'}>) {
    await this.preparation.authority.resolve(a, 'lookup_operation');
    await this.preparation.authority.resolve(a, 'preparation');
    if (!uuid(query.proposal.id)) throw new IntakeFailure(404);
    const meta = (await a.db.query('SELECT id,revision,sha256,principal,context FROM $INTAKE.preparation_proposal WHERE id=$1',
      [query.proposal.id])).rows[0];
    if (!meta || meta.principal !== a.session.account_id) throw new IntakeFailure(404);
    await this.preparation.authority.resolve(a, 'lookup_operation', meta.context);
    await this.preparation.authority.resolve(a, 'preparation', meta.context);
    if (!same(query.proposal, {id: meta.id, revision: meta.revision, sha256: meta.sha256})) throw new IntakeFailure(409);
    const event = await this.shared.evidence(a, request.route, 'read_admission');
    await a.db.commit();
    await this.shared.hooks.barrier?.('before_workspace_proposal_read', {proposalId: meta.id, evidenceId: event.id, backendPid: event.pid});
    await this.shared.clock(a, 'workspace-proposal-read', request.route);
    const value = (await a.db.query('SELECT body FROM $INTAKE.preparation_proposal WHERE id=$1', [meta.id])).rows[0];
    if (!value || !same(referenceFor('preparation-proposal/1', meta.id, meta.revision, value.body), query.proposal)) throw new IntakeFailure(503);
    await a.db.begin([]);
    const retained = await this.preparation.readPrepared(a, value.body.preparation);
    const item = proposalItem(retained.record.payload, value.body.unit);
    if (!same(value.body.selected, item.elements.map((element: {id: string}) => element.id)) ||
      value.body.identity !== itemIdentity(item, meta.context)) throw new IntakeFailure(503);
    // No resource bytes are fetched here; each download has its separate resource admission.
    const allowed = item.units.every((unit: {examination: {outcome: string}}) => unit.examination.outcome === 'classifiable') &&
      await this.offered(a, () => this.preparation.authority.resolve(a, 'constitute', meta.context, {mode: 'person'}, true));
    return this.shared.prepared(a, request, 200, {profile: WORKSPACE_PROFILE, kind: query.kind,
      proposal: query.proposal, inspection: {proposal: value.body, preparation: retained.record}, offers: allowed ? ['constitute'] : []}, null);
  }

  async preparedInspection(a: Admission, request: ReceptionRequest, query: Extract<WorkspaceQuery, {kind: 'preparation_inspection'}>) {
    await this.preparation.authority.resolve(a, 'lookup_operation');
    const retained = await this.preparation.readPrepared(a, query.preparation);
    const propose = await this.offered(a, () => this.preparation.authority.resolve(a, 'propose', retained.meta.context, undefined, true));
    const resources = retained.record.payload.resource_associations.length > 0 &&
      await this.offered(a, () => this.preparation.authority.resolve(a, 'resource', retained.meta.context, undefined, true));
    return this.shared.prepared(a, request, 200, {profile: WORKSPACE_PROFILE, kind: query.kind,
      preparation: retained.record, offers: propose ? ['propose'] : [],
      resource_offers: resources ? retained.record.payload.resource_associations.map((row: {local_id: string}) => row.local_id) : []}, null);
  }

  async query(request: ReceptionRequest, query: WorkspaceQuery | null, token: string | null, onLoss: () => void): Promise<PreparedIntake> {
    this.preparation.ensureEnabled();
    const a = await this.shared.authority.open(request, token, [], onLoss, 'inc03_intake_reader');
    try {
      await this.shared.authority.beforeMetadata(a, request.route);
      if (request.route === 'profiles') return await this.context(a, request);
      if (request.route === 'reception') return await this.reception(a, request);
      if (request.route === 'extraction') return await this.extraction(a, request);
      if (!query) throw new IntakeFailure(400);
      if (query.kind === 'preparation_effect') return await this.effect(a, request, query);
      if (query.kind === 'preparation_attempt') return await this.attempt(a, request, query);
      if (query.kind === 'preparation_inspection') return await this.preparedInspection(a, request, query);
      return await this.inspection(a, request, query);
    } catch (error) {await a.db.close(); throw error;}
  }
}
