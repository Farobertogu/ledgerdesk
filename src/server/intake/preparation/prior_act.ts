import {exactReference} from '../../../contracts/intake.ts';
import {BINDINGS} from '../../../contracts/intake_bindings.ts';
import {IntakeFailure, type ReceptionRequest} from '../protocol.ts';
import type {Admission} from '../authority.ts';
import type {PreparationService} from './service.ts';
import {referenceFor, same, type Row} from './records.ts';

/** This adapter consumes a separately governed human authorization input. It
 * neither authors that act nor turns a proposal or matching hash into authority.
 * The bounded profile depends on the issuer's recorded exercise support, but
 * never on the continued life of the issuer's original browser session. */
export async function priorActMetadata(service: PreparationService, a: Admission, ref: Row, context: Row) {
  await service.authority.resolve(a, 'lookup_operation', context);
  if (!exactReference(ref) || !/^[a-f0-9-]{36}$/i.test(ref.id)) throw new IntakeFailure(404);
  const row = (await a.db.query(`SELECT p.id,p.revision,p.sha256,p.source_id,p.namespace,p.principal,p.context,
    p.executor,p.issuer,p.authorization_binding,p.issued_at,p.expires_at,c.enabled
    FROM intake_control.constitution_prior_act p JOIN intake_control.constitution_prior_current c USING(id,revision)
    WHERE p.id=$1 AND p.revision=$2`, [ref.id, ref.revision])).rows[0];
  if (!row?.enabled || row.sha256 !== ref.sha256 || row.source_id !== a.control.source_id ||
    row.namespace !== service.shared.config.namespace || row.principal !== a.session.account_id ||
    !same(row.context, context) || !same(row.executor, a.executor) ||
    Number(row.issued_at) > a.now || Number(row.expires_at) <= a.now) throw new IntakeFailure(404);
  const issuer = a.authority.accounts.find(x => x.id === row.issuer.account);
  const grant = a.authority.grants.find(x => x.id === row.issuer.grant?.id);
  const support = a.authority.supports.find(x => x.id === row.issuer.support?.id);
  const entry = (await a.db.query("SELECT * FROM intake_control.catalog_entry WHERE operation='constitute'")).rows[0];
  if (!entry || !issuer || issuer.person_ref !== row.issuer.person || !grant || !support ||
    grant.account_id !== issuer.id || grant.revision !== row.issuer.grant.revision ||
    support.revision !== row.issuer.support.revision || grant.support_ref !== support.id ||
    grant.permission_id !== entry.permission_id || grant.faculty !== 'exercise' ||
    !a.authority.contains(grant.scope_ref, context.scope_id) || !a.authority.grantAlive(grant) ||
    !a.authority.allows(issuer, entry.permission_id, 'exercise', context.scope_id) ||
    !exactReference(row.authorization_binding?.act) || !same(row.authorization_binding.act, ref) ||
    !exactReference(row.authorization_binding.express_authorization) || !exactReference(row.authorization_binding.target)) throw new IntakeFailure(404);
  // Admission of the real executor and current treatment precedes body materialization.
  // References here came from controlled metadata, never from a caller-built binding.
  await service.authority.resolve(a, 'constitute', context, {mode: 'authorized_consequence', authorization: row.authorization_binding});
  if (!a.treatment.fields.includes('constitution-authorization')) throw new IntakeFailure(404);
  a.deadline = Math.min(a.deadline, Number(row.expires_at), a.authority.deadline);
  return {row, entry, authorization: row.authorization_binding};
}

export async function readPriorAct(service: PreparationService, a: Admission, request: ReceptionRequest, ref: Row, context: Row) {
  const admitted = await priorActMetadata(service, a, ref, context);
  const event = await service.shared.evidence(a, 'constitute', 'read_admission');
  await a.db.commit();
  await service.shared.clock(a, 'constitution-prior-act-read', request.route);
  const stored = (await a.db.query('SELECT body FROM intake_control.constitution_prior_act WHERE id=$1 AND revision=$2', [ref.id, ref.revision])).rows[0];
  service.shared.hooks.storage?.({origin: 'constitution-prior-act-boundary', kind: 'read', id: ref.id,
    revision: ref.revision, evidenceId: event.id});
  await a.db.begin([]);
  const body = stored?.body, {row, entry, authorization} = admitted;
  if (!body || body.profile !== 'constitution-prior-act/1' || body.operation !== 'constitute' ||
    body.mode !== 'authorized_consequence' || body.continuity !== 'issuer-exercise-support' ||
    !same(referenceFor('constitution-prior-act/1', ref.id, ref.revision, body), ref) ||
    !same(body.issuer, row.issuer) || !same(body.executor, row.executor) || body.principal !== row.principal ||
    body.deployment !== service.shared.config.deployment || body.source_id !== row.source_id ||
    body.namespace !== row.namespace || !same(body.context, context) ||
    body.issued_at !== Number(row.issued_at) || body.expires_at !== Number(row.expires_at) ||
    !same(body.catalog, service.shared.config.catalog) || !same(body.limits, service.shared.config.limits) ||
    body.source?.basis !== BINDINGS.constitute.basis || body.source.holder !== BINDINGS.constitute.holder ||
    body.source.entry_revision !== entry.entry_revision || !same(body.source.comparison, entry.source_comparison) ||
    !exactReference(body.issuance_evidence) || body.express?.operation !== 'constitute' ||
    body.express.mode !== 'authorized_consequence' || body.express.effect !== BINDINGS.constitute.effect ||
    !same(body.express.target, authorization.target) ||
    !same(referenceFor('constitution-express-authorization/1', authorization.express_authorization.id,
      authorization.express_authorization.revision, body.express), authorization.express_authorization) ||
    !same(referenceFor('constitution-exact-target/1', authorization.target.id, authorization.target.revision, body.target), authorization.target))
    throw new IntakeFailure(404);
  return {...admitted, body};
}

export function matchPriorAct(prior: Awaited<ReturnType<typeof readPriorAct>>, proposal: Row, reference: Row) {
  const expected = {proposal: reference, preparation: proposal.preparation, item: proposal.item,
    slot_id: proposal.slot_id, selected: proposal.selected, identity: proposal.identity,
    target: proposal.target, judgment: proposal.judgment, disposition: proposal.disposition};
  if (!same(prior.body.target, expected)) throw new IntakeFailure(404);
}
