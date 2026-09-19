import {createHash} from 'node:crypto';
import {BINDINGS, bindingConsistent} from '../../../contracts/intake_bindings.ts';
import {exactReference} from '../../../contracts/intake.ts';
import {PREPARATION_PARTITIONS, preparationSignature, comparisonMatches} from '../../../contracts/intake_preparation_bindings.ts';
import {canonicalValue} from '../../../contracts/access_canonical.ts';
import {IntakeFailure} from '../protocol.ts';
import type {Admission, IntakeAuthority} from '../authority.ts';
import type {IntakeConfig} from '../config.ts';
import {referenceFor, same, type Row} from './records.ts';

/** Operation adapter over the existing session/support/scope evaluator. No personal-load fallback. */
export class PreparationAuthority {
  readonly base: IntakeAuthority;
  readonly config: IntakeConfig;
  constructor(base: IntakeAuthority, config: IntakeConfig) {this.base = base; this.config = config;}

  async resolve(a: Admission, operation: string, context?: Row, consequence?: {predecessor?: Row; authorization?: Row; mode?: string}) {
    if (operation === 'lookup_operation') {
      await this.base.resolve(a, 'lookup_operation', context as any);
      return {scope_id: a.binding.scope.id, purpose_id: a.binding.purpose, treatment_revision: a.binding.treatment};
    }
    const partition = PREPARATION_PARTITIONS[operation];
    if (!partition) throw new IntakeFailure(503);
    const entry = (await a.db.query('SELECT * FROM intake_control.catalog_entry WHERE operation=$1', [operation])).rows[0];
    if (!entry?.active || !same(entry.catalog, this.config.catalog) || !same(entry.definition, BINDINGS[operation]) ||
      entry.partition !== partition || !exactReference(entry.route_reference) || !exactReference(entry.source_comparison)) throw new IntakeFailure(503);
    const scopeId = context?.scope_id ?? entry.scope_ref, purpose = context?.purpose_id ?? entry.purpose_ref;
    const scope = a.authority.scopes.find(s => s.id === scopeId && s.active);
    const permission = a.authority.permissions.find(p => p.id === entry.permission_id && p.active);
    const account = a.authority.accounts.find(p => p.id === a.session.account_id);
    if (!scope || !permission || scope.purpose_ref !== purpose || purpose !== entry.purpose_ref ||
      !a.authority.contains(entry.scope_ref, scopeId) || !a.authority.allows(account, permission.id, 'exercise', scopeId)) throw new IntakeFailure(404);
    const grant = a.authority.grants.find(g => g.account_id === a.session.account_id && g.permission_id === permission.id &&
      g.faculty === 'exercise' && a.authority.contains(g.scope_ref, scopeId) && a.authority.grantAlive(g));
    const support = a.authority.supports.find(s => s.id === grant?.support_ref);
    if (!support) throw new IntakeFailure(404);
    const t = (await a.db.query(`SELECT t.*,c.enabled FROM intake_control.treatment_current c
      JOIN intake_control.treatment t USING(id,revision) WHERE c.singleton`)).rows[0];
    if (!t?.enabled || t.scope_ref !== scopeId || t.purpose_ref !== purpose || Number(t.expires_at) <= a.now ||
      !t.fields.includes('intake-metadata') || !t.disposition_ref || t.receiver?.coverage !== 'first-receiver' ||
      !['FN-APROBACION', 'FN-AMBITO'].includes(t.receiver.function) || !t.receiver.responsible_person ||
      !['receiver', 'storage', 'processor', 'response_destination'].every(k => exactReference(t[k]?.reference)) ||
      t.response_destination.kind !== 'current-session-origin' || BINDINGS[operation].treatment.some(action => !t.actions.includes(action)))
      throw new IntakeFailure(404);
    if (operation !== 'lookup_operation' && !t.fields.includes('preparation-body')) throw new IntakeFailure(404);
    const treatment = {id: t.id, revision: t.revision, sha256: t.sha256};
    if (context && !same(context.treatment_revision, treatment)) throw new IntakeFailure(409);
    const mode = consequence?.mode ?? 'person';
    const signature = preparationSignature(operation, purpose, this.config.limits, mode);
    const expectedCatalogSignature = operation === 'constitute' ? {
      person: preparationSignature(operation, purpose, this.config.limits, 'person'),
      authorized_consequence: preparationSignature(operation, purpose, this.config.limits, 'authorized_consequence'),
    } : signature;
    if (!signature || !same(expectedCatalogSignature, entry.signature)) throw new IntakeFailure(503);
    const current: Row = {deployment: this.config.deployment, catalog: this.config.catalog,
      entry: {id: operation, revision: entry.entry_revision}, permission: {id: permission.id, revision: permission.revision},
      support: {id: support.id, revision: support.revision}, scope: {id: scopeId, revision: scope.revision}, purpose,
      route: entry.route_reference, treatment,
      admission: {id: 'admission:' + this.config.controlSource, revision: a.control.revision,
        sha256: createHash('sha256').update(canonicalValue({control: a.control.revision, treatment, session: a.session.digest, scope: scopeId, permission: permission.id})).digest('hex')},
      signature, view_partitions: ['prepared_content', 'prepared_resource', 'preparation_difference', 'own_record'].includes(partition) ? [{id: scopeId, revision: scope.revision}] : []};
    if (BINDINGS[operation].resolution === 'M04-D02-effect-comparison') {
      const comparison = (await a.db.query('SELECT * FROM intake_control.preparation_comparison WHERE operation=$1', [operation])).rows[0];
      if (!comparison?.enabled || !same(comparison.catalog, this.config.catalog) || comparison.entry_revision !== entry.entry_revision ||
        comparison.scope_ref !== entry.scope_ref || comparison.purpose_ref !== purpose ||
        !comparisonMatches(operation, comparison.body, entry.scope_ref, purpose, this.config.limits) ||
        !exactReference(comparison.reference) || !same(comparison.reference, entry.source_comparison) ||
        !same(comparison.reference, referenceFor('preparation-comparison/1', comparison.reference.id, comparison.reference.revision, comparison.body)))
        throw new IntakeFailure(503);
      current.comparison = comparison.reference;
    }
    if (consequence?.predecessor) current.predecessor = consequence.predecessor;
    if (consequence?.authorization) current.authorization = consequence.authorization;
    const binding: Row = {profile: 'intake-binding/2', operation, ...current,
      basis: BINDINGS[operation].basis, effect: BINDINGS[operation].effect, holder: BINDINGS[operation].holder,
      faculty: 'exercise', kind: 'act', mode};
    delete binding.deployment;
    if (!bindingConsistent(binding, current)) throw new IntakeFailure(503);
    a.deadline = Math.min(a.deadline, a.authority.deadline, Number(t.expires_at));
    a.entry = entry; a.binding = binding; a.treatment = t;
    this.base.observation?.({origin: 'current-authority-boundary', kind: 'authorized', operation,
      principal: a.session.account_id, backendPid: a.db.backendPid, controlSourceId: a.control.source_id,
      controlRevision: a.control.revision, atMs: Date.now()});
    return {scope_id: scopeId, purpose_id: purpose, treatment_revision: treatment};
  }
}
