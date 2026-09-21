import {array, artifactReference, choice, closed, exactReference, identifier, integer, record, revision, text, type Rule} from './intake.ts';
import {receptionProblem, type ReceptionErrorStatus} from './intake_reception.ts';
import {PREPARATION_DESCRIPTOR, PREPARATION_DIFFERENCE, PREPARATION_PAYLOAD, PREPARATION_TARGET,
  PREPARATION_REPRESENTATION, PREPARATION_RECORD, type PreparationRoute} from './intake_preparation.ts';

const nullable = (rule: Rule): Rule => value => value === null || rule(value);
const anyOf = (...rules: Rule[]): Rule => value => rules.some(rule => rule(value));
const context = closed({scope_id: identifier, purpose_id: identifier, treatment_revision: exactReference});
const difference = closed({reference: exactReference, body: PREPARATION_DIFFERENCE});
export const PREPARATION_RECORD_RESPONSE = closed({profile: choice(PREPARATION_RECORD), reference: exactReference,
  descriptor: PREPARATION_DESCRIPTOR, payload: PREPARATION_PAYLOAD, differences: array(difference)});
const shortPreparation = closed({id: identifier, revision});
const reserved = closed({state: choice('reserved'), attempt_id: identifier, preparation: shortPreparation, document: artifactReference,
  continuation: closed({operation: choice('upload_preparation'), mode: choice('authorized_consequence'), target: identifier, origin_session_bound: choice(true)})});
const staged = closed({state: choice('staged'), attempt_id: identifier, preparation: shortPreparation, document: artifactReference});
const prepared = closed({state: choice('prepared'), preparation: exactReference, differences: array(exactReference)});
const proposed = closed({state: choice('proposed'), proposal: exactReference, preparation: exactReference, item: text(256)});
const judgment = closed({kind: choice('distinct', 'same_version', 'possible_duplicate'), reason: text(2048)}, {evidence: exactReference});
const disposition = choice('constituted', 'relationship_recorded', 'identity_collision', 'possible_duplicate');
const proposal = closed({profile: choice('preparation-proposal/1'), preparation: exactReference, unit: identifier, item: text(256),
  slot_id: identifier, target: PREPARATION_TARGET, judgment, selected: array(identifier, 10000),
  identity: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), disposition, context});
const relationship = closed({version: exactReference, preparation: exactReference, relation: choice('authenticated_repetition')});
const blocked = closed({kind: choice('identity_collision', 'possible_duplicate'), preparation: exactReference, proposal: exactReference,
  comparison: nullable(exactReference), actor: identifier, recorded_at: integer, reason: text(2048),
  continuation: choice('awaiting_separate_adjudication'), destination: closed({state: choice('vacant'), scope_id: identifier,
    purpose_id: identifier, reason: choice('no_admitted_adjudication_route'),
    basis: closed({catalog: exactReference, responsibility: choice('FN-AMBITO')})})});
const outcomeShape = closed({outcome: choice('constituted', 'relationship_recorded', 'blocked'),
  block_kind: nullable(choice('identity_collision', 'possible_duplicate')), outcome_id: identifier,
  candidates: array(exactReference, 1), relationships: array(relationship, 1), blocks: array(blocked, 1)});
const outcome: Rule = value => {
  if (!outcomeShape(value) || !record(value)) return false;
  const v = value as Record<string, any>;
  if (v.outcome === 'constituted') return v.block_kind === null && v.candidates.length === 1 && !v.relationships.length && !v.blocks.length;
  if (v.outcome === 'relationship_recorded') return v.block_kind === null && !v.candidates.length && v.relationships.length === 1 && !v.blocks.length;
  return !v.candidates.length && !v.relationships.length && v.blocks.length === 1 && v.block_kind === v.blocks[0].kind;
};
const envelope = (required: Record<string, Rule>) => closed({profile: choice('intake/1'),
  representation: choice(PREPARATION_REPRESENTATION), ...required});
const effect = (result: Rule) => envelope({operation_id: identifier, effect: exactReference, result});
const known = envelope({state: choice('known_effect'), operation_id: identifier, effect: exactReference,
  result: anyOf(reserved, staged, prepared, proposed, outcome)});
export const PREPARATION_INSPECTION = closed({proposal, preparation: PREPARATION_RECORD_RESPONSE});
const responses: Record<PreparationRoute | 'lookup_operation', Rule> = {
  reserve_preparation: effect(reserved), upload_preparation: effect(staged), finalize_preparation: effect(prepared),
  preparation: envelope({preparation: PREPARATION_RECORD_RESPONSE}),
  difference: envelope({preparation: exactReference, difference}),
  resource: envelope({preparation: exactReference, element_id: identifier, local_resource_id: identifier, artifact: artifactReference,
    encoding: choice('base64'), data: value => typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)}),
  propose: envelope({operation_id: identifier, effect: exactReference, result: proposed,
    inspection: PREPARATION_INSPECTION}),
  constitute: effect(outcome), lookup_operation: known,
};

/** Closed wire shape; retained-source validation and current authority remain separate obligations. */
export function validatePreparationResponse(operation: PreparationRoute | 'lookup_operation', status: number, value: unknown): boolean {
  if (!Object.hasOwn(responses, operation)) return false;
  if (status === 200 && known(value)) return !['preparation', 'resource', 'difference'].includes(operation);
  if (status !== (operation === 'reserve_preparation' ? 202 : 200)) return false;
  return responses[operation](value);
}
export function preparationProblem(status: ReceptionErrorStatus) {
  return {...receptionProblem(status), representation: PREPARATION_REPRESENTATION};
}
