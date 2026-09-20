import {PREPARATION_DOCUMENT} from '../../contracts/intake_preparation.ts';
import type {ComponentObservation, ElementChoice, InspectionBlock, PreparationDraft} from './view_model.ts';

type Wire = Record<string, any>;
export function emptyPreparationDraft(): PreparationDraft {
  return {selected: [], corrections: {}, classification: {function: {value: null, reason: ''},
    basis: {value: null, reason: ''}, scope: {value: null, reason: ''}}, conditions: [], dependencies: [],
    examination: {outcome: null, reason: ''}, coverage: {completeSourceClaim: false, reason: ''}, changeReason: ''};
}
export function componentObservations(content: Wire): readonly ComponentObservation[] {
  return content.components.map((c: Wire) => ({...c, incidents: c.incidents.map((id: string) => {
    const incident = content.incidents.find((i: Wire) => i.id === id);
    return {id, cause: incident.cause, detail: incident.detail ?? null};
  })}));
}
export function elementChoices(extraction: Wire): readonly ElementChoice[] {
  return extraction.result.content.elements.map((element: Wire) => {
    const coordinates = element.original_range ? 'Original bytes ' + element.original_range.bytes.join('..') :
      element.antecedents.map((a: Wire) => a.coordinates).join('\n');
    const base = {id: element.id, title: element.sheet?.name ?? element.id, reference: extraction.result.effect};
    let inspection: InspectionBlock;
    if (element.kind === 'text') inspection = {...base, kind: 'text', text: element.text, coordinates};
    else if (element.kind === 'resource') inspection = {...base, kind: 'resource', resource: element.resource,
      mediaType: 'application/octet-stream', downloadOffered: false};
    else inspection = {...base, kind: 'table',
      columns: element.rows ? ['Record', ...Array.from({length: Math.max(0, ...element.rows.map((row: Wire) => row.fields.length))},
        (_, index) => `Column ${index + 1}${element.headers?.[index] === undefined ? '' : ': ' + element.headers[index]}`)] :
        ['Coordinate', 'Value kind', 'Literal value', 'Formula', 'Stored result kind', 'Stored result', 'Number format'],
      rows: element.rows ? element.rows.map((row: Wire) => [String(row.index), ...row.fields]) :
        element.cells.map((cell: Wire) => [cell.address, cell.value.kind, cell.value.lexical,
          cell.formula ?? '[absent]', cell.cached?.kind ?? '[absent]', cell.cached?.lexical ?? '[absent]', cell.number_format ?? '[absent]']),
      notes: element.headers ?? [], fields: [
        {name: 'Source coordinates', value: coordinates},
        ...(element.sheet ? [{name: 'Sheet visibility', value: element.sheet.visibility},
          {name: 'Merged cells', value: element.sheet.merged.join('\n')},
          {name: 'Hidden rows', value: element.sheet.hidden_rows.join('\n')},
          {name: 'Column metadata', value: JSON.stringify(element.sheet.columns)}] : []),
        ...(element.rows ? element.rows.map((row: Wire) => ({name: 'CSV record ' + row.index,
          value: JSON.stringify({fields: row.fields, bytes: row.byte_range, raw: row.raw})})) : []),
      ]};
    return {id: element.id, label: base.title, kind: element.kind, source: extraction.result.effect,
      coordinates, inspection, correctionOffered: element.kind === 'text'};
  });
}

/** Display only the retained representation, never re-run an extractor or formula. */
export function preparedInspection(record: Wire, resourceOffers: readonly string[] = [], selected?: readonly string[], unitIds?: readonly string[]) {
  const payload = record.payload;
  const elements = selected ? payload.elements.filter((element: Wire) => selected.includes(element.id)) : payload.elements;
  const blocks: InspectionBlock[] = elementChoices({result: {effect: record.reference, content: {elements}}}).map(choice => {
    const block = choice.inspection;
    if (block.kind !== 'resource') return block;
    const association = payload.resource_associations.find((row: Wire) => row.element_id === choice.id);
    return {...block, downloadOffered: !!association && resourceOffers.includes(association.local_id)};
  });
  const units = payload.units.filter((unit: Wire) => !unitIds || unitIds.includes(unit.id));
  const conditions = payload.conditions.filter((condition: Wire) => units.some((unit: Wire) => unit.conditions.includes(condition.id)));
  for (const condition of conditions) blocks.push({id: 'condition:' + condition.id, title: 'Condition', reference: record.reference,
    kind: 'text', text: condition.text, coordinates: condition.scope});
  for (const relation of payload.relations.filter((row: Wire) => !selected || selected.includes(row.from) && selected.includes(row.to)))
    blocks.push({id: 'relation:' + relation.id, title: 'Dependency', reference: record.reference, kind: 'facts', fields: [
      {name: 'From', value: relation.from}, {name: 'To', value: relation.to}, {name: 'Role', value: relation.role},
      {name: 'Scope', value: relation.scope}, {name: 'Recorded origin', value: relation.origin}]});
  for (const unit of units) blocks.push({id: 'unit:' + unit.id, title: 'Human declarations', reference: record.reference, kind: 'facts', fields: [
    {name: 'Unit', value: unit.id}, ...Object.entries(unit.classification).map(([axis, choice]) => ({name: axis,
      value: (choice as Wire).value ?? 'Unresolved: ' + (choice as Wire).reason})),
    {name: 'Examination', value: unit.examination.outcome}, {name: 'Reason', value: unit.examination.reason},
    {name: 'Complete source claim', value: String(unit.coverage.complete_source_claim)}, {name: 'Coverage reason', value: unit.coverage.reason}]});
  const differences: InspectionBlock[] = record.differences.map((difference: Wire) => ({id: difference.reference.id,
    title: 'Recorded difference', reference: difference.reference, kind: 'facts', fields: [
      {name: 'Before', value: JSON.stringify(difference.body.before)}, {name: 'After', value: JSON.stringify(difference.body.after)},
      {name: 'Method', value: difference.body.method}, {name: 'Transformation', value: difference.body.transformation},
      {name: 'Affected', value: JSON.stringify(difference.body.affected)}, {name: 'Reason', value: difference.body.reason},
      {name: 'Actor', value: difference.body.actor}, {name: 'Recorded at', value: String(difference.body.recorded_at)}]}));
  return {blocks, differences, observations: componentObservations(payload)};
}

export function proposalInspection(record: Wire, proposal: Wire) {
  const selected = record.payload.units.find((unit: Wire) => unit.id === proposal.unit);
  if (!selected) throw Error('The reviewed proposal unit is unavailable.');
  const units = selected.inseparable_group ? record.payload.units.filter((unit: Wire) => unit.inseparable_group === selected.inseparable_group) : [selected];
  const inspected = preparedInspection(record, [], proposal.selected, units.map((unit: Wire) => unit.id));
  return {...inspected, blocks: [{id: 'proposal-terms', title: 'Exact proposal terms', reference: record.reference, kind: 'facts' as const,
    fields: [{name: 'Prepared unit', value: proposal.unit}, {name: 'Target', value: JSON.stringify(proposal.target)},
      {name: 'Identity judgment', value: proposal.judgment.kind}, {name: 'Reason', value: proposal.judgment.reason},
      {name: 'Proposed disposition', value: proposal.disposition}]}, ...inspected.blocks]};
}

/** A human request, not a replacement for the retained-source producer. */
export function preparationDocument(extraction: Wire, draft: PreparationDraft) {
  const content = extraction.result?.content;
  if (!content || extraction.view !== 'content' || !draft.selected.length || draft.examination.outcome === null)
    throw Error('Select content and record an examination before saving.');
  const selected = new Set(draft.selected), affected: Wire[] = [];
  const selection: Wire[] = [], elements: Wire[] = [];
  for (const source of content.elements) {
    if (!selected.has(source.id)) continue;
    const element = structuredClone(source);
    const row: Wire = {input_id: 'source', element_id: source.id, local_id: source.id};
    if (source.kind === 'resource') Object.assign(row, {resource: source.resource, local_resource_id: source.id});
    selection.push(row);
    element.antecedents = source.original_range ? [{input_id: 'source', kind: 'bytes',
      coordinates: 'original:' + source.original_range.bytes.join('..'), byte_range: [...source.original_range.bytes],
      code_point_range: [...source.original_range.code_points]}] : source.antecedents.map((loc: Wire) => ({
        input_id: 'source', kind: loc.kind, coordinates: loc.coordinates, ...(loc.byte_range ? {byte_range: [...loc.byte_range]} : {}),
      }));
    delete element.original_range;
    if (Object.hasOwn(draft.corrections, source.id)) {
      if (source.kind !== 'text') throw Error('Only text corrections are offered.');
      element.text = draft.corrections[source.id];
      if (element.text !== source.text) affected.push({kind: 'element', id: source.id});
    }
    elements.push(element);
  }
  if (elements.length !== selected.size) throw Error('The selection no longer matches the exact extraction.');
  const relations: Wire[] = [];
  for (const relation of content.relations) {
    if (selected.has(relation.from) !== selected.has(relation.to)) throw Error('Retain both ends of the source dependency.');
    if (selected.has(relation.from)) relations.push({...structuredClone(relation), id: 'source:' + relation.id});
  }
  for (const relation of draft.dependencies) {
    if (!selected.has(relation.from) || !selected.has(relation.to)) throw Error('A declared dependency needs two selected endpoints.');
    relations.push({id: relation.id, from: relation.from, to: relation.to, role: relation.required ? 'indispensable' : 'context',
      scope: 'Selected preparation unit', origin: 'prepared'});
    affected.push({kind: 'relation', id: relation.id});
  }
  for (const condition of draft.conditions) affected.push({kind: 'condition', id: condition.id});
  const classification = Object.fromEntries(Object.entries(draft.classification).map(([name, axis]) =>
    [name, {value: axis.value, reason: axis.value === null ? axis.reason : null}]));
  if (affected.length && !draft.changeReason) throw Error('Explain the declared changes before saving.');
  const document = {profile: 'preparation-document/1', transformation: affected.length ? 'correction' : 'exact_selection',
    elements, relations, conditions: structuredClone(draft.conditions), units: [{id: 'selected-material',
      elements: elements.map(e => e.id), conditions: draft.conditions.map(c => c.id), inseparable_group: null, classification,
      examination: draft.examination, coverage: {components: content.components.map((c: Wire) => 'source:' + c.id),
        complete_source_claim: draft.coverage.completeSourceClaim, reason: draft.coverage.reason}}],
    differences: affected.length ? [{before: ['source'], method: 'correction', transformation: 'cleanup', reason: draft.changeReason, affected}] : []};
  if (!PREPARATION_DOCUMENT(document)) throw Error('Complete the human declarations with values or explicit unresolved reasons.');
  return {document, selection, inputs: [{id: 'source', kind: 'extraction', job_id: extraction.extraction.id, reference: extraction.result.effect}]};
}
