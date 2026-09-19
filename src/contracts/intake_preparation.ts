import {
  array, artifactReference, choice, closed, decodeStrict, digest, exactReference,
  identifier, integer, record, revision, text, intakePath, INTAKE_ROUTES, type Rule,
} from './intake.ts';
import {INTAKE_ELEMENT, INTAKE_RELATION} from './intake_artifact.ts';
import {extractionArtifact, EXTRACTION_BOUNDS} from './intake_extraction.ts';

/** Operational preparation is explicit; historical trial representations remain unchanged. */
export const PREPARATION_REPRESENTATION = 'intake-preparation/1' as const;
export const PREPARATION_CONTENT = 'preparation-content/1' as const;
export const PREPARATION_RECORD = 'prepared-material/2' as const;
export const PREPARATION_BOUNDS = Object.freeze({
  commandBytes: 65536, documentBytes: 8388608, payloadBytes: 8388608,
  responseBytes: 8454144, poolBytes: 67108864, attempts: 32,
  inputs: 128, units: 128, entries: 10000, sheets: 8, cells: 10000,
  csvRecords: 1000, csvColumns: 64, idleMs: 5000, transferMs: 10000, constructionConcurrency: 1,
});
export const PREPARATION_ROUTES = [
  'reserve_preparation', 'upload_preparation', 'finalize_preparation',
  'preparation', 'resource', 'difference', 'propose', 'constitute',
] as const;
export type PreparationRoute = typeof PREPARATION_ROUTES[number];
export type Exact = {id: string; revision: number; sha256: string};
export type Artifact = {id: string; generation: number; bytes: number; sha256: string};
export const isPreparationRoute = (route: string): route is PreparationRoute =>
  (PREPARATION_ROUTES as readonly string[]).includes(route);

const nullable = (rule: Rule): Rule => value => value === null || rule(value);
const range: Rule = value => Array.isArray(value) && value.length === 2 &&
  value.every(integer) && value[0] <= value[1];
const nonempty = (rule: Rule, maximum = 128): Rule => value =>
  array(rule, maximum)(value) && (value as unknown[]).length > 0;
const distinct = (values: readonly string[]) => new Set(values).size === values.length;
const context = closed({scope_id: identifier, purpose_id: identifier, treatment_revision: exactReference});
export const PREPARATION_INPUT_SELECTOR: Rule = value =>
  closed({id: identifier, kind: choice('extraction'), job_id: identifier, reference: exactReference})(value) ||
  closed({id: identifier, kind: choice('preparation'), reference: exactReference})(value);

/** Resolved by the service from durable accepted state, never authenticated by this shape. */
export const PREPARATION_INPUT: Rule = value => closed({
  id: identifier, kind: choice('extraction'), reference: exactReference,
  job_id: identifier, receipt: exactReference, original: artifactReference,
  source: exactReference, source_artifact: extractionArtifact(EXTRACTION_BOUNDS.normalizedBytes),
})(value) || closed({id: identifier, kind: choice('preparation'), reference: exactReference,
  source_artifact: artifactReference})(value);
export const PREPARATION_LOCALIZER = closed({
  input_id: identifier, kind: choice('bytes', 'cells', 'nonliteral'), coordinates: text(512),
}, {byte_range: range, code_point_range: range});

/** Keep the existing table/value model without repeated full source hashes in each locator. */
export const PREPARATION_ELEMENT: Rule = value => {
  if (!record(value) || !array(PREPARATION_LOCALIZER)(value.antecedents)) return false;
  const root = {id: 'shape-source', revision: 1, sha256: '0'.repeat(64)};
  return INTAKE_ELEMENT({...value, antecedents: (value.antecedents as Record<string, unknown>[]).map(loc => ({
    antecedent: root, kind: loc.kind, coordinates: loc.coordinates,
    ...(loc.byte_range === undefined ? {} : {byte_range: loc.byte_range}),
  }))});
};
export const PREPARATION_COMPONENT = closed({
  id: identifier, execution: choice('completed', 'failed', 'not_attempted', 'unknown'),
  coverage: choice('complete', 'partial', 'none', 'unknown'), fidelity: choice('checked', 'unchecked', 'disputed'),
  limitations: array(identifier), incidents: array(identifier),
});
export const PREPARATION_INCIDENT = closed({
  id: identifier, component: identifier, cause: choice('unreadable', 'route_unoffered', 'technical_failure', 'unknown'),
}, {code: text(128), detail: text(512)});
export const PREPARATION_CONDITION = closed({id: identifier, text: text(2048), scope: text(512)});
export const PREPARATION_RESOURCE_ASSOCIATION = closed({local_id: identifier, element_id: identifier, artifact: artifactReference});
/** A preparation statement about an interruption is not native extractor evidence. */
export const PREPARATION_INTERRUPTION = closed({
  component: identifier, incident_id: identifier, source: exactReference,
  origin: choice('preparation_annotation', 'instrumented_preparation'),
});
const axis = (...values: string[]): Rule => value => closed({value: nullable(choice(...values)), reason: nullable(text(2048))})(value) &&
  record(value) && (value.value === null ? typeof value.reason === 'string' && value.reason.length > 0 : value.reason === null);
export const PREPARATION_CLASSIFICATION = closed({
  function: axis('definitional', 'normative', 'operational', 'factual'),
  basis: axis('domain_adoption', 'applicable_external_authority', 'verifiable_attestation', 'non_authoritative_reference'),
  scope: axis('reusable_with_conditions', 'situated'),
});
export const PREPARATION_UNIT = closed({
  id: identifier, elements: nonempty(identifier, PREPARATION_BOUNDS.entries),
  conditions: array(identifier), inseparable_group: nullable(identifier), classification: PREPARATION_CLASSIFICATION,
  examination: closed({outcome: choice('classifiable', 'divide', 'transform', 'block', 'reject'), reason: text(2048)}),
  coverage: closed({components: array(identifier), complete_source_claim: choice(false, true), reason: text(2048)}),
});
export const PREPARATION_SELECTION = closed({
  input_id: identifier, element_id: identifier, local_id: identifier,
}, {resource: artifactReference, local_resource_id: identifier});
export const PREPARATION_AFFECTED = closed({
  kind: choice('element', 'relation', 'condition', 'coverage', 'provenance'), id: identifier,
});
export const PREPARATION_DIFFERENCE_DRAFT = closed({
  before: nonempty(identifier), method: choice('exact_selection', 'correction', 'synthesis'),
  transformation: choice('reproducible_normalization', 'cleanup', 'redaction'),
  reason: text(2048), affected: nonempty(PREPARATION_AFFECTED, PREPARATION_BOUNDS.entries),
});
export const PREPARATION_TRANSFORMATION = closed({from: identifier, to: identifier});
/** The staged document requests changes. Its source claims do not replace retained inputs. */
const documentShape = closed({
  profile: choice('preparation-document/1'), transformation: choice('exact_selection', 'correction', 'synthesis'),
  elements: array(PREPARATION_ELEMENT, PREPARATION_BOUNDS.entries),
  relations: array(INTAKE_RELATION, PREPARATION_BOUNDS.entries),
  conditions: array(PREPARATION_CONDITION, PREPARATION_BOUNDS.entries),
  units: array(PREPARATION_UNIT, PREPARATION_BOUNDS.units),
  differences: array(PREPARATION_DIFFERENCE_DRAFT),
}, {
  transformations: array(PREPARATION_TRANSFORMATION, PREPARATION_BOUNDS.entries),
  observation: closed({components: array(PREPARATION_COMPONENT, PREPARATION_BOUNDS.entries),
    incidents: array(PREPARATION_INCIDENT, PREPARATION_BOUNDS.entries), inventory: choice('known', 'unknown'),
    interruptions: array(closed({component: identifier, incident_id: identifier}), PREPARATION_BOUNDS.entries)}),
});
export const PREPARATION_DOCUMENT: Rule = value => documentShape(value) && record(value) &&
  ['elements', 'relations', 'conditions', 'units'].every(key => distinct((value[key] as {id: string}[]).map(x => x.id)));

const contentShape = closed({
  profile: choice(PREPARATION_CONTENT), inputs: nonempty(PREPARATION_INPUT, PREPARATION_BOUNDS.inputs),
  elements: array(PREPARATION_ELEMENT, PREPARATION_BOUNDS.entries), relations: array(INTAKE_RELATION, PREPARATION_BOUNDS.entries),
  resources: array(artifactReference, PREPARATION_BOUNDS.entries),
  resource_associations: array(PREPARATION_RESOURCE_ASSOCIATION, PREPARATION_BOUNDS.entries),
  conditions: array(PREPARATION_CONDITION, PREPARATION_BOUNDS.entries), units: array(PREPARATION_UNIT, PREPARATION_BOUNDS.units),
  components: array(PREPARATION_COMPONENT, PREPARATION_BOUNDS.entries), incidents: array(PREPARATION_INCIDENT, PREPARATION_BOUNDS.entries),
  inventory: choice('known', 'unknown'), current_use: choice('not_evaluated', 'unavailable'),
  interruptions: array(PREPARATION_INTERRUPTION, PREPARATION_BOUNDS.entries),
}, {
  transformations: array(PREPARATION_TRANSFORMATION, PREPARATION_BOUNDS.entries),
});
export const PREPARATION_PAYLOAD: Rule = value => {
  if (!contentShape(value) || !record(value)) return false;
  const p = value as Record<string, any>;
  if (!['inputs', 'elements', 'relations', 'resources', 'conditions', 'units', 'components', 'incidents']
    .every(key => distinct(p[key].map((x: any) => x.id)))) return false;
  const contains = (collection: string, id: string) => p[collection].some((row: any) => row.id === id);
  if (p.elements.some((e: any) => e.antecedents.some((loc: any) => !contains('inputs', loc.input_id)))) return false;
  if (p.elements.some((e: any) => e.kind === 'resource' && !p.resources.some((r: any) =>
    ['id', 'generation', 'bytes', 'sha256'].every(k => e.resource[k] === r[k])))) return false;
  if (p.resources.some((r: any) => !p.elements.some((e: any) => e.kind === 'resource' &&
    ['id', 'generation', 'bytes', 'sha256'].every(k => e.resource[k] === r[k])))) return false;
  if (!distinct(p.resource_associations.map((r: any) => r.local_id)) ||
    !distinct(p.resource_associations.map((r: any) => r.element_id)) ||
    p.resource_associations.length !== p.elements.filter((e: any) => e.kind === 'resource').length ||
    p.resource_associations.some((r: any) => !p.elements.some((e: any) => e.id === r.element_id && e.kind === 'resource' &&
      ['id', 'generation', 'bytes', 'sha256'].every(k => e.resource[k] === r.artifact[k])))) return false;
  if (p.relations.some((r: any) => !contains('elements', r.from) || !contains('elements', r.to))) return false;
  if (p.incidents.some((i: any) => !p.components.some((c: any) => c.id === i.component && c.incidents.includes(i.id)))) return false;
  if (p.components.some((c: any) => c.incidents.some((id: string) => !p.incidents.some((i: any) => i.id === id && i.component === c.id)))) return false;
  if (p.interruptions.some((edge: any) => !p.components.some((c: any) => c.id === edge.component && c.execution === 'not_attempted') ||
    !p.incidents.some((i: any) => i.id === edge.incident_id && i.component !== edge.component && i.cause === 'technical_failure'))) return false;
  if (p.units.some((u: any) => !distinct(u.elements) || !distinct(u.conditions) ||
    u.elements.some((id: string) => !contains('elements', id)) || u.conditions.some((id: string) => !contains('conditions', id)) ||
    u.coverage.components.some((id: string) => !contains('components', id)))) return false;
  if (p.transformations && (!distinct(p.transformations.map((t: any) => t.from)) ||
    p.transformations.some((t: any) => !contains('elements', t.to)))) return false;
  const tables = p.elements.filter((e: any) => e.kind === 'table');
  if (tables.filter((t: any) => t.sheet).length > PREPARATION_BOUNDS.sheets ||
    tables.reduce((n: number, t: any) => n + t.cells.length, 0) > PREPARATION_BOUNDS.cells ||
    tables.reduce((n: number, t: any) => n + (t.rows?.length ?? 0), 0) > PREPARATION_BOUNDS.csvRecords) return false;
  return true;
};
export const PREPARATION_DIFFERENCE = closed({
  profile: choice('preparation-difference/1'),
  before: nonempty(closed({input: exactReference, payload: extractionArtifact(EXTRACTION_BOUNDS.normalizedBytes)})),
  after: closed({id: identifier, revision, payload: artifactReference}),
  method: choice('exact_selection', 'correction', 'synthesis'),
  transformation: choice('reproducible_normalization', 'cleanup', 'redaction'),
  affected: nonempty(PREPARATION_AFFECTED, PREPARATION_BOUNDS.entries), reason: text(2048), actor: identifier, recorded_at: integer,
});
export const PREPARATION_DESCRIPTOR = closed({
  profile: choice('preparation-descriptor/1'), id: identifier, revision, payload: artifactReference,
  inputs: nonempty(PREPARATION_INPUT, PREPARATION_BOUNDS.inputs), differences: array(exactReference),
  operation: exactReference, actor: identifier, recorded_at: integer,
});
const command = (required: Record<string, Rule>, optional: Record<string, Rule> = {}) => closed({
  profile: choice('intake/1'), representation: choice(PREPARATION_REPRESENTATION), ...required,
}, optional);
const newTarget = closed({kind: choice('new'), declaration: text(2048)});
const existingTarget = closed({kind: choice('successor', 'relationship'), unit_id: identifier,
  version: exactReference, declaration: text(2048)});
export const PREPARATION_TARGET: Rule = value => newTarget(value) || existingTarget(value);
const judgment = closed({kind: choice('distinct', 'same_version', 'possible_duplicate'), reason: text(2048)}, {evidence: exactReference});
export const PREPARATION_COMMANDS: Record<PreparationRoute | 'lookup_operation', Rule> = {
  reserve_preparation: command({inputs: nonempty(PREPARATION_INPUT_SELECTOR, PREPARATION_BOUNDS.inputs), base: nullable(exactReference),
    selection: array(PREPARATION_SELECTION, PREPARATION_BOUNDS.entries),
    document: closed({bytes: v => integer(v) && Number(v) <= PREPARATION_BOUNDS.documentBytes, sha256: digest}), context}),
  upload_preparation: value => value instanceof Uint8Array && value.byteLength <= PREPARATION_BOUNDS.documentBytes,
  // This realization generates attributable differences from the exact staged
  // document. It does not accept detached caller-supplied difference records.
  finalize_preparation: command({expected_revision: revision, document: artifactReference, differences: array(exactReference, 0)}),
  preparation: command({}), resource: command({}), difference: command({}),
  propose: command({unit: identifier, target: PREPARATION_TARGET, judgment}),
  constitute: command({proposal: exactReference, mode: choice('person', 'authorized_consequence')}, {prior_act: exactReference}),
  lookup_operation: command({operation_id: identifier}),
};
export function validatePreparationCommand(operation: PreparationRoute | 'lookup_operation', value: unknown): boolean {
  if (!Object.hasOwn(PREPARATION_COMMANDS, operation) || !PREPARATION_COMMANDS[operation](value)) return false;
  if (!record(value)) return operation === 'upload_preparation';
  if (operation === 'constitute') return value.mode === 'authorized_consequence' ?
    exactReference(value.prior_act) : !Object.hasOwn(value, 'prior_act');
  if (operation === 'reserve_preparation') {
    const inputs = value.inputs as {id: string}[], selection = value.selection as {input_id: string; local_id: string; resource?: Artifact; local_resource_id?: string}[];
    return distinct(inputs.map(x => x.id)) && distinct(selection.map(x => x.local_id)) &&
      selection.every(row => inputs.some(input => input.id === row.input_id) &&
        (row.resource === undefined ? row.local_resource_id === undefined : row.local_resource_id !== undefined)) &&
      distinct(selection.filter(row => row.local_resource_id !== undefined).map(row => row.local_resource_id!));
  }
  return true;
}
export function readPreparationDocument(bytes: Uint8Array): Record<string, any> {
  const value = decodeStrict(bytes, PREPARATION_BOUNDS.documentBytes);
  if (!PREPARATION_DOCUMENT(value)) throw Error('PREPARATION_DOCUMENT');
  return value as Record<string, any>;
}
export function readPreparationPayload(bytes: Uint8Array): Record<string, any> {
  const value = decodeStrict(bytes, PREPARATION_BOUNDS.payloadBytes);
  if (!PREPARATION_PAYLOAD(value)) throw Error('PREPARATION_PAYLOAD');
  return value as Record<string, any>;
}
/** Contract version is compared payload; the object's identity never changes the key namespace. */
export function preparationCanonical(operation: PreparationRoute | 'lookup_operation', parameters: Record<string, string>,
  value: unknown, serialize: (v: unknown) => string): string {
  intakePath(operation, parameters);
  if (!validatePreparationCommand(operation, value) || value instanceof Uint8Array) throw Error('PREPARATION_COMMAND');
  return serialize({profile: 'canon_m09_1', contract: 'intake/1', variant: operation,
    path: {template: INTAKE_ROUTES[operation].path, parameters}, query: {}, body: value});
}
