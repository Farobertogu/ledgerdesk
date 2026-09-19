import {identifier} from '../../../contracts/intake.ts';
import {decodeExtractionContent} from '../../../contracts/intake_extraction.ts';
import {EXTRACTION_CONTENT} from '../../../contracts/intake_extraction_view.ts';
import {IntakeFailure} from '../protocol.ts';
import {PREPARATION_BOUNDS, PREPARATION_DOCUMENT, PREPARATION_INPUT, validatePreparationCommand,
  readPreparationDocument, type Artifact, type Exact} from '../../../contracts/intake_preparation.ts';
import {artifactFor, byteDigest, encodePayload, same, sealDifference, sealPreparation, PreparationLimit,
  verifyPreparation, type Row, type PreparedRecord} from './records.ts';

export type RetainedSource = {input: Row; bytes: Uint8Array; preparation?: PreparedRecord;
  resourceBodies?: Array<{artifact: Artifact; bytes: Buffer}>};
export type Production = ReturnType<typeof sealPreparation> & {resources: Array<{artifact: Artifact; bytes: Buffer}>};
const copy = <T>(value: T): T => structuredClone(value);
/** An admissible envelope can still request an invalid preparation change. */
class PreparationChangeFailure extends IntakeFailure {
  constructor(message: string) {super(409); this.message = message;}
}
const joined = (a: string, b: string): string => {
  const value = a + ':' + b;
  if (!identifier(value)) throw Error('PREPARATION_ALIAS_LIMIT');
  return value;
};
function exactSource(source: RetainedSource): Row {
  const input = source.input;
  if (!PREPARATION_INPUT(input) || source.bytes.byteLength !== input.source_artifact.bytes ||
      byteDigest(source.bytes) !== input.source_artifact.sha256) throw Error('PREPARATION_SOURCE_INTEGRITY');
  if (input.kind === 'extraction') {
    const content = decodeExtractionContent(source.bytes) as Row;
    if (!EXTRACTION_CONTENT(content) || !same(content.original, input.original) || !same(content.source, input.source))
      throw Error('PREPARATION_SOURCE_ASSOCIATION');
    return content;
  }
  if (!source.preparation || !same(source.preparation.reference, input.reference) ||
      !same(source.preparation.descriptor.payload, input.source_artifact) || !verifyPreparation(source.preparation, source.bytes))
    throw Error('PREPARATION_SOURCE_ASSOCIATION');
  return source.preparation.payload;
}

/** The caller admits and materializes retained sources first. No source authority is inferred here. */
export function constructPreparation(args: {
  reservation: Row; document: Row; staged: Artifact; stagedBytes: Uint8Array; sources: RetainedSource[];
  id: string; revision: number; artifactId: string; operation: Exact; actor: string; recordedAt: number;
  resourceBodies: Array<{artifact: Artifact; bytes: Uint8Array}>;
}): Production {
  const {reservation: r, document: d} = args;
  if (!validatePreparationCommand('reserve_preparation', r) || !PREPARATION_DOCUMENT(d) ||
      !same(r.document, {bytes: args.staged.bytes, sha256: args.staged.sha256}) ||
      !same(args.staged, artifactFor(args.staged.id, args.staged.generation, args.stagedBytes)) ||
      !same(d, readPreparationDocument(args.stagedBytes))) throw Error('PREPARATION_PRODUCTION_INPUT');
  if (args.sources.length !== r.inputs.length || new Set(args.sources.map(s => s.input.id)).size !== args.sources.length)
    throw Error('PREPARATION_SOURCE_SET');
  const sourceMap = new Map<string, {input: Row; content: Row}>();
  for (const source of args.sources) {
    const selector = r.inputs.find((x: Row) => x.id === source.input.id);
    if (!selector || selector.kind !== source.input.kind || !same(selector.reference, source.input.reference) ||
        (selector.kind === 'extraction' && selector.job_id !== source.input.job_id)) throw Error('PREPARATION_SOURCE_SELECTOR');
    sourceMap.set(selector.id, {input: source.input, content: exactSource(source)});
  }
  if (r.base && !args.sources.some(s => s.input.kind === 'preparation' && same(s.input.reference, r.base)))
    throw new PreparationChangeFailure('PREPARATION_BASE_SOURCE');
  const inputs: Row[] = [], elements: Row[] = [], relations: Row[] = [], components: Row[] = [], incidents: Row[] = [];
  const conditions: Row[] = [], resources: Artifact[] = [], associations: Row[] = [], interruptions: Row[] = [];
  const sourceUnits: Row[] = [];
  let inventory = 'known';
  for (const [alias, {input, content}] of sourceMap) {
    inputs.push(copy(input));
    if (input.kind === 'preparation') for (const parent of content.inputs) inputs.push({...copy(parent), id: joined(alias, parent.id)});
    if (content.inventory === 'unknown') inventory = 'unknown';
    const selections = r.selection.filter((s: Row) => s.input_id === alias);
    if (new Set(selections.map((s: Row) => s.element_id)).size !== selections.length) throw new PreparationChangeFailure('PREPARATION_SELECTION_DUPLICATE');
    const selected = new Map<string, Row>(selections.map((s: Row) => [s.element_id, s]));
    for (const row of content.components) components.push({...copy(row), id: joined(alias, row.id),
      incidents: row.incidents.map((id: string) => joined(alias, id))});
    for (const row of content.incidents) incidents.push({...copy(row), id: joined(alias, row.id), component: joined(alias, row.component)});
    for (const edge of content.interruptions ?? []) interruptions.push({...copy(edge), component: joined(alias, edge.component), incident_id: joined(alias, edge.incident_id)});
    for (const selection of selections) {
      const original = content.elements.find((e: Row) => e.id === selection.element_id);
      if (!original) throw new PreparationChangeFailure('PREPARATION_SELECTED_ELEMENT');
      if (original.kind === 'resource') {
        if (!same(selection.resource, original.resource)) throw new PreparationChangeFailure('PREPARATION_SELECTED_RESOURCE');
        if (!resources.some(a => same(a, original.resource))) resources.push(copy(original.resource));
        associations.push({local_id: selection.local_resource_id, element_id: selection.local_id, artifact: copy(original.resource)});
      } else if (selection.resource || selection.local_resource_id) throw new PreparationChangeFailure('PREPARATION_NONRESOURCE_SELECTION');
      const next = {...copy(original), id: selection.local_id};
      if (original.original_range) {
        next.antecedents = [{input_id: alias, kind: 'bytes', coordinates: 'original:' + original.original_range.bytes.join('..'),
          byte_range: copy(original.original_range.bytes), code_point_range: copy(original.original_range.code_points)}];
        delete next.original_range;
      } else next.antecedents = original.antecedents.map((loc: Row) => input.kind === 'preparation' ?
        {...copy(loc), input_id: joined(alias, loc.input_id)} : {
          input_id: alias, kind: loc.kind, coordinates: loc.coordinates,
          ...(loc.byte_range === undefined ? {} : {byte_range: copy(loc.byte_range)}),
        });
      elements.push(next);
    }
    for (const relation of content.relations) {
      const from = selected.get(relation.from), to = selected.get(relation.to);
      if (Boolean(from) !== Boolean(to)) throw new PreparationChangeFailure('PREPARATION_DEPENDENCY_CLOSURE');
      if (from && to) relations.push({...copy(relation), id: joined(alias, relation.id), from: from.local_id, to: to.local_id});
    }
    // Existing unit conditions and inseparable groups remain obligations of selected base content.
    for (const unit of content.units ?? []) {
      if (!unit.elements.some((id: string) => selected.has(id))) continue;
      if (unit.elements.some((id: string) => !selected.has(id))) throw new PreparationChangeFailure('PREPARATION_BASE_UNIT_CLOSURE');
      if (unit.inseparable_group && content.units.some((other: Row) => other.inseparable_group === unit.inseparable_group &&
          other.elements.some((id: string) => !selected.has(id)))) throw new PreparationChangeFailure('PREPARATION_INSEPARABLE_GROUP');
      sourceUnits.push({...copy(unit), elements: unit.elements.map((id: string) => selected.get(id)!.local_id),
        conditions: unit.conditions.map((id: string) => joined(alias, id))});
      for (const id of unit.conditions) {
        const condition = content.conditions.find((c: Row) => c.id === id);
        if (!condition) throw Error('PREPARATION_SOURCE_CONDITION');
        const mapped = {...copy(condition), id: joined(alias, id)};
        if (!conditions.some(c => c.id === mapped.id)) conditions.push(mapped);
      }
    }
  }
  if (inputs.length > PREPARATION_BOUNDS.inputs) throw Error('PREPARATION_INPUT_LIMIT');
  const affected = (kind: string, id: string) => d.differences.some((difference: Row) =>
    difference.affected.some((a: Row) => a.kind === kind && a.id === id));
  const changed = (kind: string, id: string) => {
    if (d.transformation === 'exact_selection' || !affected(kind, id)) throw new PreparationChangeFailure('PREPARATION_UNDECLARED_CHANGE:' + kind);
  };
  const transforms: Row[] = d.transformations ?? [];
  if (transforms.length && (d.transformation !== 'synthesis' || new Set(transforms.map(t => t.from)).size !== transforms.length ||
    transforms.some(t => !elements.some(e => e.id === t.from && e.kind === 'text') ||
      !d.elements.some((e: Row) => e.id === t.to && e.kind === 'text')))) throw new PreparationChangeFailure('PREPARATION_TRANSFORMATION_MAP');
  const transformed = (id: string): string => transforms.find(t => t.from === id)?.to ?? id;
  if (!transforms.length && elements.length === d.elements.length &&
      elements.every(e => d.elements.some((next: Row) => next.id === e.id)) &&
      !same(elements.map(e => e.id), d.elements.map((e: Row) => e.id)))
    for (const element of elements) changed('element', element.id);
  for (const before of elements) {
    const after = d.elements.find((e: Row) => e.id === before.id);
    if (!after) {
      if (transformed(before.id) === before.id) throw new PreparationChangeFailure('PREPARATION_SELECTION_LOSS');
      changed('element', before.id); changed('element', transformed(before.id));
      continue;
    }
    if (before.kind === 'resource' && !same(before, after)) throw new PreparationChangeFailure('PREPARATION_RESOURCE_CHANGE');
    if (!same(before, after)) changed('element', before.id);
  }
  for (const after of d.elements) if (!elements.some(e => e.id === after.id)) {
    changed('element', after.id);
    if (!after.antecedents.length || after.antecedents.some((a: Row) => a.kind !== 'nonliteral' ||
      !elements.some(before => transforms.some(t => t.from === before.id && t.to === after.id) &&
        before.antecedents.some((loc: Row) => loc.input_id === a.input_id && same(loc.byte_range ?? null, a.byte_range ?? null) &&
          same(loc.code_point_range ?? null, a.code_point_range ?? null)))))
      throw new PreparationChangeFailure('PREPARATION_AUTHORED_PROVENANCE');
    if (elements.filter(before => transforms.some(t => t.from === before.id && t.to === after.id)).some(before =>
      before.antecedents.some((loc: Row) => !after.antecedents.some((a: Row) => a.input_id === loc.input_id &&
        same(loc.byte_range ?? null, a.byte_range ?? null))))) throw new PreparationChangeFailure('PREPARATION_AUTHORED_SOURCE_LOSS');
  }
  for (const [kind, before, after] of [['relation', relations, d.relations], ['condition', conditions, d.conditions]] as const) {
    for (const row of before) {
      const next = after.find((x: Row) => x.id === row.id);
      // A retained indispensable context cannot disappear behind a valid new difference.
      if (!next) throw new PreparationChangeFailure('PREPARATION_CONTEXT_LOSS');
      if (!same(row, next)) {
        changed(kind, row.id);
        if (kind === 'relation' && (next.from !== transformed(row.from) || next.to !== transformed(row.to) ||
          next.role !== row.role || next.scope !== row.scope)) throw new PreparationChangeFailure('PREPARATION_TRANSFORMED_CONTEXT');
      }
    }
    for (const row of after) if (!before.some((x: Row) => x.id === row.id)) {
      if (kind === 'relation' && row.origin === 'observed') throw new PreparationChangeFailure('PREPARATION_INVENTED_OBSERVATION');
      if (!affected(kind, row.id)) throw new PreparationChangeFailure('PREPARATION_UNRECORDED_CONTEXT');
    }
  }
  if (d.observation) {
    if (!d.differences.some((x: Row) => x.affected.some((a: Row) => a.kind === 'coverage')))
      throw new PreparationChangeFailure('PREPARATION_OBSERVATION_DIFFERENCE');
    const source = {id: args.staged.id, revision: args.staged.generation, sha256: args.staged.sha256};
    for (const c of d.observation.components) components.push({...copy(c), id: joined('statement', c.id),
      incidents: c.incidents.map((id: string) => joined('statement', id))});
    for (const i of d.observation.incidents) incidents.push({...copy(i), id: joined('statement', i.id), component: joined('statement', i.component)});
    for (const e of d.observation.interruptions) {
      const incidentId = d.observation.incidents.some((i: Row) => i.id === e.incident_id) ?
        joined('statement', e.incident_id) : e.incident_id;
      if (!incidents.some(i => i.id === incidentId && i.cause === 'technical_failure'))
        throw new PreparationChangeFailure('PREPARATION_INTERRUPTION_SOURCE');
      interruptions.push({component: joined('statement', e.component), incident_id: incidentId,
        source, origin: 'preparation_annotation'});
    }
    if (d.observation.inventory === 'unknown') inventory = 'unknown';
  }
  if (new Set(d.units.flatMap((u: Row) => u.elements)).size !== d.elements.length ||
      d.elements.some((e: Row) => !d.units.some((u: Row) => u.elements.includes(e.id)))) throw new PreparationChangeFailure('PREPARATION_UNIT_COVERAGE');
  for (const unit of d.units) {
    if (!unit.coverage.components.length || unit.coverage.complete_source_claim &&
      (inventory !== 'known' || components.some(c => c.coverage !== 'complete' || c.execution !== 'completed' || c.limitations.length)))
      throw new PreparationChangeFailure('PREPARATION_COVERAGE_CLAIM');
    if (sourceUnits.some(source => source.elements.some((id: string) => unit.elements.includes(id)) &&
      source.conditions.some((id: string) => !unit.conditions.includes(id)))) throw new PreparationChangeFailure('PREPARATION_UNIT_CONDITION');
  }
  const payload = {profile: 'preparation-content/1', inputs, elements: copy(d.elements), relations: copy(d.relations),
    resources, resource_associations: associations, conditions: copy(d.conditions), units: copy(d.units),
    components, incidents, inventory, current_use: 'not_evaluated', interruptions,
    ...(transforms.length ? {transformations: copy(transforms)} : {})};
  const bytes = encodePayload(payload), target = {id: args.id, revision: args.revision, payload: artifactFor(args.artifactId, args.revision, bytes)};
  const differences = d.differences.map((draft: Row, index: number) => {
    const before = draft.before.map((id: string) => {
      const source = sourceMap.get(id); if (!source) throw Error('PREPARATION_DIFFERENCE_SOURCE');
      return {input: source.input.reference, payload: source.input.source_artifact};
    });
    return sealDifference(joined(args.id, 'r' + args.revision + ':difference-' + index), 1, {profile: 'preparation-difference/1', before, after: target,
      method: draft.method, transformation: draft.transformation, affected: copy(draft.affected), reason: draft.reason,
      actor: args.actor, recorded_at: args.recordedAt});
  });
  const result = sealPreparation({id: args.id, revision: args.revision, artifactId: args.artifactId, payload, differences,
    operation: args.operation, actor: args.actor, recordedAt: args.recordedAt});
  const bodies = resources.map(artifact => {
    const found = args.resourceBodies.find(r => same(r.artifact, artifact));
    if (!found || found.bytes.byteLength !== artifact.bytes || byteDigest(found.bytes) !== artifact.sha256)
      throw Error('PREPARATION_RESOURCE_INTEGRITY');
    return {artifact, bytes: Buffer.from(found.bytes)};
  });
  if (bodies.reduce((n, r) => n + r.bytes.length, bytes.length) > PREPARATION_BOUNDS.payloadBytes)
    throw new PreparationLimit();
  return {...result, resources: bodies};
}
