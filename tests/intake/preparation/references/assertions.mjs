import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REFERENCES } from './cases.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const same = (actual, expected, label) => assert.deepEqual(actual, expected, label);
function object(value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), label);
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Reflect.ownKeys(value)) assert.ok(allowed.includes(key), `${label}: unexpected ${String(key)}`);
}
function need(value, key) {
  object(value, `Missing object for ${key}`);
  assert.ok(own(value, key), `Missing ${key}`);
  return value[key];
}
function string(value, label) {
  assert.ok(typeof value === 'string' && value.trim().length > 0, label);
}
function integer(value, minimum, label) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum, label);
}
function digest(value, label) {
  assert.ok(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), label);
}
function exact(value) {
  keys(value, ['id', 'revision', 'sha256'], 'Exact reference');
  string(need(value, 'id'), 'Reference ID');
  integer(need(value, 'revision'), 1, 'Reference revision');
  digest(need(value, 'sha256'), 'Reference digest');
}
function artifact(value) {
  keys(value, ['id', 'generation', 'bytes', 'sha256'], 'Artifact reference');
  string(need(value, 'id'), 'Artifact ID');
  integer(need(value, 'generation'), 1, 'Artifact generation');
  integer(need(value, 'bytes'), 0, 'Artifact length');
  digest(need(value, 'sha256'), 'Artifact digest');
}
function target(value) {
  keys(value, ['id', 'revision', 'payload'], 'Target reference');
  string(need(value, 'id'), 'Target ID');
  integer(need(value, 'revision'), 1, 'Target revision');
  artifact(need(value, 'payload'));
}
function idMap(value, allowed, label) {
  keys(value, allowed, label);
  for (const id of Object.values(value)) string(id, label);
}
function bindings(value) {
  keys(value, ['preparation', 'before', 'before_payload', 'after', 'difference', 'interruption_source', 'inputs',
    'elements', 'resource_id', 'component_ids', 'incident_ids', 'actor'], 'Identity-only bindings');
  for (const key of ['preparation', 'before', 'difference', 'interruption_source']) if (own(value, key)) exact(value[key]);
  if (own(value, 'before_payload')) artifact(value.before_payload);
  if (own(value, 'after')) target(value.after);
  if (own(value, 'inputs')) idMap(value.inputs, ['original', 'extraction', 'base'], 'Input IDs');
  if (own(value, 'elements')) idMap(value.elements, ['rule', 'exception', 'authored', 'short', 'figure', 'caption'], 'Element IDs');
  if (own(value, 'component_ids')) idMap(value.component_ids, ['parent', 'unsupported', 'A', 'B', 'C', 'D', 'E'], 'Component IDs');
  if (own(value, 'incident_ids')) idMap(value.incident_ids, ['unsupported', 'B', 'C', 'D', 'E'], 'Incident IDs');
  for (const key of ['resource_id', 'actor']) if (own(value, key)) string(value[key], key);
}
function choose(value, allowed) {
  assert.ok(typeof value === 'string' && allowed.includes(value), `Unknown variant: ${String(value)}`);
}
function start(observed, bound) {
  object(observed, 'Observed record');
  bindings(bound);
}
function preparation(observed, bound) {
  exact(need(observed, 'preparation'));
  same(observed.preparation, need(bound, 'preparation'), 'Exact preparation binding');
}
function rows(value, label) {
  assert.ok(Array.isArray(value), label);
  for (const row of value) object(row, label);
  return value;
}
function identified(value, label) {
  rows(value, label);
  for (const row of value) string(need(row, 'id'), label);
  same(new Set(value.map(row => row.id)).size, value.length, `${label}: duplicate ID`);
  return value;
}
function strings(value, label) {
  assert.ok(Array.isArray(value), label);
  for (const item of value) string(item, label);
  same(new Set(value).size, value.length, `${label}: duplicate value`);
}
function find(rows, id, label) {
  string(id, label);
  const matches = rows.filter(row => row.id === id);
  same(matches.length, 1, label);
  return matches[0];
}
function edges(observed, elements) {
  const result = identified(need(observed, 'relations'), 'Relations');
  for (const relation of result) {
    assert.ok(elements.some(e => e.id === relation.from) && elements.some(e => e.id === relation.to), 'Relation endpoints');
    choose(relation.role, ['indispensable', 'context']);
    choose(relation.origin, ['observed', 'prepared', 'proposed']);
    string(relation.scope, 'Relation scope');
  }
  return result;
}
function antecedents(element, bound, kind, ranges) {
  const inputId = need(need(bound, 'inputs'), 'original');
  const locators = rows(need(element, 'antecedents'), 'Antecedents');
  same(locators.length, ranges.length, 'Exact source-span count');
  for (let index = 0; index < ranges.length; index++) {
    const locator = locators[index];
    same(locator.input_id, inputId, 'Original identity');
    same(locator.kind, kind, 'Literal versus nonliteral source correspondence');
    string(locator.coordinates, 'Source coordinates');
    same(locator.byte_range, ranges[index], 'Independent original byte range');
    if (own(locator, 'code_point_range')) same(locator.code_point_range, ranges[index], 'ASCII source code-point range');
  }
}

export function assertPreparedText(observed, bound, variant) {
  choose(variant, ['az17', 'reordered', 'redaction', 'short']);
  start(observed, bound);
  preparation(observed, bound);
  const elements = identified(need(observed, 'elements'), 'Prepared elements');
  const ids = need(bound, 'elements');
  const reference = REFERENCES['F-P'];
  const roles = variant === 'short' ? ['short'] : variant === 'redaction' ? ['authored']
    : variant === 'reordered' ? reference.reordered : reference.order;
  const selectedIds = roles.map(role => need(ids, role));
  same(new Set(selectedIds).size, roles.length, 'Distinct bound element roles');
  same(elements.filter(e => selectedIds.includes(e.id)).map(e => e.id), selectedIds, 'Canonical selected order');
  const extra = elements.filter(e => !selectedIds.includes(e.id));
  assert.ok(extra.length <= (variant === 'short' ? 0 : 1), 'Only an optional heading may accompany the selected text');
  for (const heading of extra) {
    same(heading.kind, 'text', 'Heading kind');
    same(heading.text, reference.heading, 'Heading text');
    antecedents(heading, bound, 'bytes', [[0, 7]]);
  }
  for (const role of roles) {
    const element = find(elements, ids[role], role);
    same(element.kind, 'text', `${role} kind`);
    const literal = role === 'short' ? REFERENCES['F-T'].short.text : role === 'authored' ? reference.redaction : reference[role];
    same(element.text, literal, `${role} literal`);
    const ranges = role === 'short' ? [[0, 3]] : role === 'rule' ? [[7, 52]]
      : role === 'exception' ? [[52, 102]] : [[7, 52], [52, 102]];
    antecedents(element, bound, role === 'authored' ? 'nonliteral' : 'bytes', ranges);
  }
  const relations = edges(observed, elements);
  if (variant === 'short') same(relations.length, 0, 'The short fixture has no declared dependency');
  if (variant === 'az17' || variant === 'reordered') {
    const indispensable = relations.filter(r => r.from === ids.rule && r.to === ids.exception);
    same(indispensable.length, 1, 'Exactly one rule-to-exception relation');
    same(indispensable[0].role, reference.relation.role, 'Indispensable condition');
    same(indispensable[0].scope, reference.relation.scope, 'AZ-17 scope');
  }
}

export function assertResourceAssociation(observed, bound, variant) {
  choose(variant, ['az17', 'az18']);
  start(observed, bound);
  preparation(observed, bound);
  const reference = REFERENCES['F-R'][variant];
  const expected = { id: need(bound, 'resource_id'), generation: reference.generation, bytes: reference.bytes, sha256: reference.sha256 };
  const elements = identified(need(observed, 'elements'), 'Resource elements');
  same(elements.length, 2, 'Only the selected figure and its caption');
  const ids = need(bound, 'elements');
  assert.notEqual(need(ids, 'figure'), need(ids, 'caption'), 'Distinct figure/caption IDs');
  const figure = find(elements, ids.figure, 'Bound figure');
  const caption = find(elements, ids.caption, 'Bound caption');
  same(figure.kind, 'resource', 'Figure kind');
  same(caption.kind, 'text', 'Caption kind');
  string(caption.text, 'Caption text');
  if (reference.caption !== null) same(caption.text, reference.caption, 'Independent caption');
  artifact(figure.resource);
  same(figure.resource, expected, 'Prepared figure association');
  const resources = identified(need(observed, 'resources'), 'Resource catalog');
  same(resources.length, 1, 'Exact selected resource catalog');
  artifact(resources[0]);
  same(resources[0], expected, 'Retained resource association');
  const associations = rows(need(observed, 'resource_associations'), 'Actual preparation-local associations');
  same(associations.length, 1, 'Exact preparation-local association count');
  artifact(need(associations[0], 'artifact'));
  same(associations[0], { local_id: REFERENCES['F-R'].local_id, element_id: ids.figure, artifact: expected },
    'Independent local label, element and artifact association');
  const relations = edges(observed, elements).filter(r => r.from === ids.figure && r.to === ids.caption);
  same(relations.length, 1, 'Figure-to-caption relation');
  if (reference.scope !== null) same(relations[0].scope, reference.scope, 'Resource scope');
  const delivered = rows(need(observed, 'delivered_resources'), 'Actual resource bytes');
  same(delivered.length, 1, 'Exact resource delivery');
  same(delivered[0].element_id, ids.figure, 'Delivered element association');
  same(need(delivered[0], 'local_resource_id'), REFERENCES['F-R'].local_id, 'Actual preparation-local delivery selector');
  artifact(delivered[0].artifact);
  same(delivered[0].artifact, expected, 'Delivered artifact association');
  same(delivered[0].utf8, reference.utf8, 'Independent exact resource body');
  same(Buffer.byteLength(delivered[0].utf8, 'utf8'), reference.bytes, 'Observed resource byte length');
  same(createHash('sha256').update(delivered[0].utf8, 'utf8').digest('hex'), reference.sha256, 'Observed resource digest');
}

export function assertDifferenceAssociation(observed, bound, variant) {
  choose(variant, ['correction', 'other']);
  start(observed, bound);
  preparation(observed, bound);
  const reference = REFERENCES['F-D'][variant];
  const differences = rows(need(observed, 'differences'), 'Differences');
  same(differences.length, 1, 'Exact difference count');
  const difference = differences[0];
  exact(need(difference, 'reference'));
  same(difference.reference, need(bound, 'difference'), 'Difference identity');
  const before = rows(need(difference, 'before'), 'Difference source pair');
  same(before.length, 1, 'One exact changed antecedent');
  exact(before[0].input);
  artifact(before[0].payload);
  same(before[0], { input: need(bound, 'before'), payload: need(bound, 'before_payload') }, 'Independent source/payload pair');
  target(need(difference, 'after'));
  same(difference.after, need(bound, 'after'), 'Independent target/payload pair');
  same({ id: difference.after.id, revision: difference.after.revision },
    { id: bound.preparation.id, revision: bound.preparation.revision }, 'Difference targets this preparation');
  same(need(observed, 'before_text'), reference.before_text, 'Exact before literal');
  same(need(observed, 'after_text'), reference.after_text, 'Exact after literal');
  same(difference.method, reference.method, 'Correction method');
  same(difference.transformation, reference.transformation, 'Correction classification');
  same(difference.affected, [{ kind: 'element', id: need(need(bound, 'elements'), reference.affected_role) }], 'Affected element');
  same(difference.actor, need(bound, 'actor'), 'Attributable actor');
  integer(need(difference, 'recorded_at'), 0, 'Recorded time');
  // No arbitrary reason string or timestamp was fixed by the independent source.
  string(need(difference, 'reason'), 'Retained correction reason');
}

function coverageRows(observed) {
  const components = identified(need(observed, 'components'), 'Components');
  const incidents = identified(need(observed, 'incidents'), 'Incidents');
  for (const component of components) {
    choose(component.execution, ['completed', 'failed', 'not_attempted', 'unknown']);
    choose(component.coverage, ['complete', 'partial', 'none', 'unknown']);
    choose(component.fidelity, ['checked', 'unchecked', 'disputed']);
    strings(need(component, 'limitations'), 'Component limitations');
    strings(need(component, 'incidents'), 'Component incident links');
    for (const id of component.incidents) find(incidents, id, 'Retained incident link');
  }
  for (const incident of incidents) {
    find(components, need(incident, 'component'), 'Incident component');
    choose(incident.cause, ['unreadable', 'route_unoffered', 'technical_failure', 'unknown']);
    for (const field of ['code', 'detail']) if (own(incident, field)) assert.equal(typeof incident[field], 'string', `Incident ${field}`);
  }
  choose(need(observed, 'inventory'), ['known', 'unknown']);
  const selection = need(observed, 'selected_coverage');
  keys(selection, ['components', 'complete_source_claim'], 'Selected coverage');
  strings(need(selection, 'components'), 'Selected components');
  same(need(selection, 'complete_source_claim'), false, 'No false complete-source claim');
  for (const id of selection.components) find(components, id, 'Selected component');
  return { components, incidents, selection };
}
function linkedIncident(component, incidents, id, cause) {
  const incident = find(incidents, id, 'Expected incident');
  same(incident.component, component.id, 'Incident attribution');
  same(incident.cause, cause, 'Independent incident cause');
  assert.ok(component.incidents.includes(id), 'Component retains its incident');
  return incident;
}

export function assertScopedCoverage(observed, bound, variant) {
  choose(variant, ['x07', 'mixed-known', 'mixed-unknown']);
  start(observed, bound);
  preparation(observed, bound);
  const { components, incidents, selection } = coverageRows(observed);
  const ids = need(bound, 'component_ids');
  const incidentIds = need(bound, 'incident_ids');
  if (variant === 'x07') {
    const reference = REFERENCES['F-X'].x07;
    const parent = find(components, need(ids, 'parent'), 'X07 parent');
    const unsupported = find(components, need(ids, 'unsupported'), 'X07 unsupported part');
    assert.notEqual(parent.id, unsupported.id, 'Distinct X07 component roles');
    same(components.length, 2, 'X07 retained component count');
    for (const key of ['execution', 'coverage', 'fidelity']) {
      same(parent[key], reference.parent[key], `X07 parent ${key}`);
      same(unsupported[key], reference.unprocessed[key], `X07 unsupported ${key}`);
    }
    same(observed.inventory, reference.inventory, 'Package inventory is not semantic completeness');
    same(selection.components, [parent.id], 'Selected X07 parent scope');
    same(incidents.length, 1, 'X07 unsupported incident retained');
    const incident = linkedIncident(unsupported, incidents, need(incidentIds, 'unsupported'), reference.incident.cause);
    same(need(incident, 'detail'), reference.incident.detail, 'Exact unsupported member remains in detail');
    assert.ok(!own(incident, 'code'), 'Do not invent a source code for the unsupported member');
    assert.ok(unsupported.limitations.includes('component-not-offered'), 'Unsupported route limitation');
    for (const limit of ['syntactic-profile-only', 'raw-properties-retained-not-interpreted', 'semantic-fidelity-unverified']) {
      assert.ok(parent.limitations.includes(limit), 'Retained extraction limitation');
    }
    return;
  }
  const reference = REFERENCES['F-X'].mixed;
  const known = variant === 'mixed-known';
  const roles = known ? reference.known : reference.unknown;
  const expectedIds = roles.map(role => need(ids, role));
  same(new Set(expectedIds).size, roles.length, 'Distinct component roles');
  same([...components.map(c => c.id)].sort(), [...expectedIds].sort(), 'Exact observed inventory; no fabricated remainder');
  same(observed.inventory, known ? 'known' : 'unknown', 'Retained inventory knowledge');
  same(selection.components, [ids.A], 'Only independently usable A selected');
  for (const role of roles) {
    const component = find(components, ids[role], role);
    same(component.execution, reference[role].execution, `${role} execution`);
    if (role === 'A') {
      assert.ok(['complete', 'partial'].includes(component.coverage), 'A retains processed coverage');
    } else {
      assert.ok(['none', 'unknown'].includes(component.coverage), `${role} is not examined complete`);
      assert.notEqual(component.fidelity, 'checked', `${role} has no fabricated fidelity check`);
    }
    if (reference[role].cause) linkedIncident(component, incidents, need(incidentIds, role), reference[role].cause);
  }
  if (known) {
    const interrupted = find(components, ids.E, 'Interrupted E');
    assert.ok(!incidents.some(incident => incident.component === interrupted.id && incident.cause === 'technical_failure'),
      'Unattempted E must not acquire an attempted technical-failure incident');
    const interruptions = rows(need(observed, 'interruptions'), 'Retained preparation interruption statements');
    same(interruptions.length, 1, 'Exact declared interruption count');
    const edge = interruptions[0];
    keys(edge, ['component', 'incident_id', 'source', 'origin'], 'Preparation interruption statement');
    same(need(edge, 'component'), interrupted.id, 'Interrupted component');
    same(need(edge, 'incident_id'), need(incidentIds, reference.E.interrupted_by), 'E refers to the independently bound D incident');
    exact(need(edge, 'source'));
    same(edge.source, need(bound, 'interruption_source'), 'Exact pre-bound preparation statement source');
    choose(need(edge, 'origin'), ['preparation_annotation', 'instrumented_preparation']);
    // This retains an attributable preparation statement, not a native T03
    // extraction observation or an inferred causal edge between adjacent rows.
  } else if (own(observed, 'interruptions')) {
    same(observed.interruptions, [], 'Unknown remainder cannot acquire a fabricated E interruption');
  }
}

export function assertConstitutionOutcome(observed, bound, variant) {
  choose(variant, ['distinct', 'repetition', 'collision', 'possible_duplicate']);
  start(observed, bound);
  preparation(observed, bound);
  const reference = REFERENCES['F-C9'];
  const expected = reference.outcomes[variant];
  const countKeys = ['candidates', 'relationships', 'blocks', 'approvals', 'published', 'searchable'];
  const before = need(observed, 'before_counts'), after = need(observed, 'after_counts');
  for (const counts of [before, after]) {
    keys(counts, countKeys, 'Independent effect counts');
    for (const key of countKeys) integer(need(counts, key), 0, key);
  }
  const deltas = Object.fromEntries(countKeys.map(key => [key, after[key] - before[key]]));
  same({ outcome: need(observed, 'outcome'), states: need(observed, 'candidate_states'), deltas,
    previous_bytes_unchanged: need(observed, 'previous_bytes_unchanged'),
    previous_provenance_unchanged: need(observed, 'previous_provenance_unchanged'),
    new_receipt_preserved: need(observed, 'new_receipt_preserved') }, {
    outcome: expected.outcome, states: expected.states,
    deltas: { candidates: expected.candidates, relationships: expected.relationships, blocks: expected.blocks,
      approvals: reference.approvals, published: reference.published, searchable: reference.searchable },
    previous_bytes_unchanged: true, previous_provenance_unchanged: true, new_receipt_preserved: true,
  }, 'C9 outcome, effects and immutable history');
  if (expected.block_kind !== null) {
    same(need(observed, 'block_kind'), expected.block_kind, 'Typed unresolved block');
    const destination = need(observed, 'destination');
    object(destination, 'Block destination');
    choose(need(destination, 'kind'), ['resolved', 'vacant']);
    keys(destination, destination.kind === 'resolved' ? ['kind', 'reference'] : ['kind'], 'Block destination');
    if (destination.kind === 'resolved') exact(need(destination, 'reference'));
  } else {
    if (own(observed, 'block_kind')) same(observed.block_kind, null, 'No block on a successful outcome');
    assert.ok(!own(observed, 'destination'), 'No unresolved destination on a successful outcome');
  }
}
