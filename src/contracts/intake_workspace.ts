import {array, artifactReference, choice, closed, exactReference, identifier, record, revision, type Rule} from './intake.ts';
import {AVAILABILITY_RESPONSE_V2, RECEPTION_RESPONSE_V2} from './intake_reception_v2.ts';
import {EXTRACTION_RESPONSE} from './intake_extraction_view.ts';
import {PREPARATION_INSPECTION, PREPARATION_RECORD_RESPONSE, validatePreparationResponse} from './intake_preparation_response.ts';

/** An explicit read profile. Existing intake/1 and preparation/1 bodies stay closed. */
export const WORKSPACE_PROFILE = 'intake-workspace/1' as const;
export const WORKSPACE_ACCEPT = 'application/vnd.ledgerdesk.intake-workspace+json';
export const WORKSPACE_COMMAND_BYTES = 65536;
export const WORKSPACE_QUERY_KINDS = ['preparation_effect', 'preparation_attempt', 'preparation_inspection', 'proposal_inspection'] as const;
export type WorkspaceQueryKind = typeof WORKSPACE_QUERY_KINDS[number];
export type WorkspaceResponseKind = 'context' | 'reception' | 'extraction' | WorkspaceQueryKind;
export type WorkspaceExact = {id: string; revision: number; sha256: string};
export type WorkspaceArtifact = {id: string; generation: number; bytes: number; sha256: string};
export type WorkspaceEffectVariant = 'reserve_preparation' | 'finalize_preparation' | 'propose' | 'constitute';
export type WorkspaceQuery = {profile: typeof WORKSPACE_PROFILE} & (
  | {kind: 'preparation_effect'; variant: WorkspaceEffectVariant; client_key: string}
  | {kind: 'preparation_attempt'; attempt_id: string; document: WorkspaceArtifact}
  | {kind: 'preparation_inspection'; preparation: WorkspaceExact}
  | {kind: 'proposal_inspection'; proposal: WorkspaceExact}
);
const envelope = (required: Record<string, Rule>) => closed({profile: choice(WORKSPACE_PROFILE), ...required});
const queries: Record<WorkspaceQueryKind, Rule> = {
  preparation_effect: envelope({kind: choice('preparation_effect'),
    variant: choice('reserve_preparation', 'finalize_preparation', 'propose', 'constitute'), client_key: identifier}),
  preparation_attempt: envelope({kind: choice('preparation_attempt'), attempt_id: identifier, document: artifactReference}),
  preparation_inspection: envelope({kind: choice('preparation_inspection'), preparation: exactReference}),
  proposal_inspection: envelope({kind: choice('proposal_inspection'), proposal: exactReference}),
};
export function validateWorkspaceQuery(value: unknown): value is WorkspaceQuery {
  return record(value) && typeof value.kind === 'string' && Object.hasOwn(queries, value.kind) &&
    queries[value.kind as WorkspaceQueryKind](value);
}
const context = closed({scope_id: identifier, purpose_id: identifier, treatment_revision: exactReference});
const responses: Record<WorkspaceResponseKind, Rule> = {
  context: envelope({kind: choice('context'), deployment: identifier, context, offers: array(choice('receive'), 1), availability: AVAILABILITY_RESPONSE_V2}),
  reception: envelope({kind: choice('reception'), reception: RECEPTION_RESPONSE_V2,
    offers: array(choice('inspect_original', 'inspect_extraction', 'stop'), 3)}),
  extraction: envelope({kind: choice('extraction'), extraction: EXTRACTION_RESPONSE,
    offers: array(choice('prepare'), 1)}),
  preparation_effect: envelope({kind: choice('preparation_effect'),
    effect: value => validatePreparationResponse('lookup_operation', 200, value)}),
  preparation_attempt: envelope({kind: choice('preparation_attempt'), attempt_id: identifier,
    state: choice('reserved', 'staged', 'finalized'), document: artifactReference,
    preparation: closed({id: identifier, revision}), offers: array(choice('finalize_preparation'), 1)}),
  preparation_inspection: envelope({kind: choice('preparation_inspection'), preparation: PREPARATION_RECORD_RESPONSE,
    offers: array(choice('propose'), 1), resource_offers: array(identifier, 10000)}),
  proposal_inspection: envelope({kind: choice('proposal_inspection'), proposal: exactReference, inspection: PREPARATION_INSPECTION,
    offers: array(choice('constitute'), 1)}),
};
export function validateWorkspaceResponse(kind: WorkspaceResponseKind, value: unknown): boolean {
  if (!Object.hasOwn(responses, kind) || !responses[kind](value)) return false;
  if (kind === 'extraction') {
    const body = value as {extraction: {view: string; result: unknown}; offers: string[]};
    return body.offers.length === 0 || body.extraction.view === 'content' && body.extraction.result !== null;
  }
  if (kind === 'preparation_inspection') {
    const body = value as {preparation: {payload: {resource_associations: {local_id: string}[]}}; resource_offers: string[]};
    return new Set(body.resource_offers).size === body.resource_offers.length &&
      body.resource_offers.every(id => body.preparation.payload.resource_associations.some(row => row.local_id === id));
  }
  if (kind === 'preparation_attempt') {
    const body = value as {state: string; offers: string[]};
    return body.offers.length === 0 || body.state === 'staged';
  }
  if (kind !== 'proposal_inspection') return true;
  const response = value as {inspection: {proposal: {preparation: WorkspaceExact}; preparation: {reference: WorkspaceExact}}};
  const a = response.inspection.proposal.preparation, b = response.inspection.preparation.reference;
  return a.id === b.id && a.revision === b.revision && a.sha256 === b.sha256;
}
