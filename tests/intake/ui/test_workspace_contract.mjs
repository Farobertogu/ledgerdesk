import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKSPACE_ACCEPT, WORKSPACE_PROFILE, validateWorkspaceQuery, validateWorkspaceResponse} from '../../../src/contracts/intake_workspace.ts';
import {validatePreparationCommand} from '../../../src/contracts/intake_preparation.ts';
import {validatePreparationResponse} from '../../../src/contracts/intake_preparation_response.ts';
import {workspaceEnvelope} from '../../../src/server/intake/workspace/protocol.ts';
import {sealPreparation} from '../../../src/server/intake/preparation/records.ts';
import {createHash} from 'node:crypto';
import {WorkspaceService} from '../../../src/server/intake/workspace/service.ts';
import {IntakeFailure} from '../../../src/server/intake/protocol.ts';
import {IntakeController} from '../../../src/components/intake/controller.ts';
import {IntakeJournal} from '../../../src/components/intake/journal.ts';

const reference = {id: 'reference-1', revision: 1, sha256: 'a'.repeat(64)};
const artifact = {id: 'document-1', generation: 1, bytes: 7, sha256: 'b'.repeat(64)};
const transport = {profile: 'session/1', uiOrigin: 'https://ui.inc02.test:8443', terminalOrigin: 'https://api.inc02.test:9443'};
const command = {profile: WORKSPACE_PROFILE, kind: 'preparation_effect', variant: 'reserve_preparation', client_key: 'unique-request'};
const request = () => ({method: 'POST', url: '/api/intake/operations/lookup',
  headers: {host: 'api.inc02.test:9443', origin: transport.uiOrigin, accept: WORKSPACE_ACCEPT,
    'content-type': 'application/json', 'content-length': '145', 'x-ledgerdesk-csrf': 'A'.repeat(43)}, rawHeaders: []});

test('Q01 scoped effect locator is explicit and cannot supply another principal or payload', () => {
  assert.equal(validateWorkspaceQuery(command), true);
  for (const field of ['principal', 'deployment', 'act', 'fingerprint', 'body', 'operation_id'])
    assert.equal(validateWorkspaceQuery({...command, [field]: 'other'}), false, field);
  assert.equal(validateWorkspaceQuery({...command, variant: 'upload_preparation'}), false);
  assert.equal(validateWorkspaceQuery({...command, variant: 'constructor'}), false);
  assert.equal(validateWorkspaceQuery({...command, client_key: ''}), false);
});
test('Q02 attempt query requires its exact staged artifact, not an inferred successful reserve', () => {
  const query = {profile: WORKSPACE_PROFILE, kind: 'preparation_attempt', attempt_id: 'attempt-1', document: artifact};
  assert.equal(validateWorkspaceQuery(query), true);
  assert.equal(validateWorkspaceQuery({...query, document: reference}), false);
  assert.equal(validateWorkspaceQuery({...query, state: 'staged'}), false);
});
test('Q03 proposal inspection uses an exact reference, never latest', () => {
  const query = {profile: WORKSPACE_PROFILE, kind: 'proposal_inspection', proposal: reference};
  assert.equal(validateWorkspaceQuery(query), true);
  assert.equal(validateWorkspaceQuery({...query, proposal: {id: reference.id}}), false);
  assert.equal(validateWorkspaceQuery({...query, proposal: {...reference, revision: 'latest'}}), false);
});
test('Q04 new query profile does not widen the old preparation command', () => {
  assert.equal(validatePreparationCommand('lookup_operation', command), false);
  assert.equal(validatePreparationCommand('lookup_operation', {profile: 'intake/1', representation: 'intake-preparation/1', operation_id: 'operation-1'}), true);
  assert.equal(validateWorkspaceQuery({profile: 'intake/1', representation: 'intake-preparation/1', operation_id: 'operation-1'}), false);
});
test('Q05 effect response preserves the closed historical result and is not an old response', () => {
  const effect = {profile: 'intake/1', representation: 'intake-preparation/1', state: 'known_effect',
    operation_id: 'effect-1', effect: reference,
    result: {state: 'staged', attempt_id: 'attempt-1', preparation: {id: 'preparation-1', revision: 1}, document: artifact}};
  const response = {profile: WORKSPACE_PROFILE, kind: 'preparation_effect', effect};
  assert.equal(validateWorkspaceResponse('preparation_effect', response), true);
  assert.equal(validatePreparationResponse('lookup_operation', 200, response), false);
  assert.equal(validateWorkspaceResponse('preparation_effect', {...response, inspection: {}}), false);
});
test('Q06 context keeps configuration separate from the current general reception offer', () => {
  const value = {profile: WORKSPACE_PROFILE, kind: 'context', deployment: 'synthetic-deployment',
    context: {scope_id: 'scope-1', purpose_id: 'purpose-1', treatment_revision: reference}, offers: [],
    availability: {profile: 'intake/1', representation: 'intake-availability/2', profiles: [
      {format_profile: 'text-utf8/1', configuration: reference, original_bytes: 1048576, reception_available: true, processing_available: true}]}};
  assert.equal(validateWorkspaceResponse('context', value), true);
  assert.equal(validateWorkspaceResponse('context', {...value, offers: ['receive']}), true);
  assert.equal(validateWorkspaceResponse('context', {...value, offers: ['constitute']}), false);
  assert.equal(validateWorkspaceResponse('context', {...value, hidden_offers: 1}), false);
});
test('Q07 neutral owned-attempt projection excludes protected document bytes and declarations', () => {
  const value = {profile: WORKSPACE_PROFILE, kind: 'preparation_attempt', attempt_id: 'attempt-1',
    state: 'staged', preparation: {id: 'preparation-1', revision: 2}, document: artifact, offers: []};
  assert.equal(validateWorkspaceResponse('preparation_attempt', value), true);
  for (const field of ['body', 'principal', 'origin_session', 'reservation'])
    assert.equal(validateWorkspaceResponse('preparation_attempt', {...value, [field]: 'protected'}), false);
  assert.equal(validateWorkspaceResponse('preparation_attempt', {...value, state: 'received'}), false);
  assert.equal(validateWorkspaceResponse('preparation_attempt', {...value, offers: ['finalize_preparation']}), true);
  assert.equal(validateWorkspaceResponse('preparation_attempt', {...value, state: 'reserved', offers: ['finalize_preparation']}), false);
});
test('Q08 query envelope retains exact origin, CSRF and no intention header', () => {
  assert.equal(workspaceEnvelope(request(), transport).route, 'lookup_operation');
  for (const [name, value, status] of [['origin', 'https://foreign.test', 403],
    ['x-ledgerdesk-csrf', 'invalid', 403], ['x-ledgerdesk-intent', 'key-1', 400],
    ['x-forwarded-for', '127.0.0.2', 400], ['accept', 'application/json', 400]]) {
    const changed = request(); changed.headers[name] = value;
    assert.throws(() => workspaceEnvelope(changed, transport), error => error.status === status, name);
  }
});
test('Q09 query envelope does not admit an effect path, duplicate header or encoded path', () => {
  const changed = request(); changed.rawHeaders = ['Accept', WORKSPACE_ACCEPT, 'accept', WORKSPACE_ACCEPT];
  assert.throws(() => workspaceEnvelope(changed, transport), error => error.status === 400);
  for (const url of ['/api/intake/receptions', '/api/intake/operations/lookup?secret=x', '/api/intake/operations/%6cookup'])
    assert.throws(() => workspaceEnvelope({...request(), url}, transport), error => error.status === 400);
});
test('Q10 context query has no body and query commands retain a finite byte bound', () => {
  const get = request(); get.method = 'GET'; get.url = '/api/intake/profiles';
  delete get.headers['content-type']; delete get.headers['content-length']; delete get.headers['x-ledgerdesk-csrf'];
  assert.equal(workspaceEnvelope(get, transport).route, 'profiles');
  get.headers['content-length'] = '1';
  assert.throws(() => workspaceEnvelope(get, transport), error => error.status === 400);
  const post = request(); post.headers['content-length'] = '65537';
  assert.throws(() => workspaceEnvelope(post, transport), error => error.status === 413);
});

test('Q11 object projections admit only the named GET queries, including extraction', () => {
  for (const [segment, route] of [['receptions', 'reception'], ['extractions', 'extraction']]) {
    const get = request(); get.method = 'GET'; get.url = `/api/intake/${segment}/object-1`;
    delete get.headers['content-type']; delete get.headers['content-length']; delete get.headers['x-ledgerdesk-csrf'];
    assert.deepEqual(workspaceEnvelope(get, transport), {route, parameters: {id: 'object-1'}, method: 'GET', contentLength: 0, clientKey: null, csrf: null});
    assert.throws(() => workspaceEnvelope({...get, method: 'POST'}, transport), error => error.status === 400);
    assert.throws(() => workspaceEnvelope({...get, url: get.url + '/original'}, transport), error => error.status === 400);
    assert.throws(() => workspaceEnvelope({...get, url: get.url + '?other=1'}, transport), error => error.status === 400);
  }
});

function preparedRecord() {
  const axis = {value: null, reason: 'Unresolved by this contract vector.'};
  const payload = {profile: 'preparation-content/1', inputs: [{id: 'source', kind: 'preparation', reference, source_artifact: artifact}],
    elements: [{id: 'figure', kind: 'resource', resource: artifact, antecedents: [{input_id: 'source', kind: 'bytes', coordinates: 'region-A'}]}],
    relations: [], conditions: [], resources: [artifact], resource_associations: [{element_id: 'figure', local_id: 'resource-A', artifact}],
    units: [{id: 'unit', elements: ['figure'], conditions: [], inseparable_group: null,
      classification: {function: axis, basis: axis, scope: axis}, examination: {outcome: 'classifiable', reason: 'Synthetic contract vector.'},
      coverage: {components: ['source'], complete_source_claim: false, reason: 'No completeness claim.'}}],
    components: [{id: 'source', execution: 'completed', coverage: 'partial', fidelity: 'unchecked', limitations: ['unexamined-context'], incidents: []}],
    incidents: [], inventory: 'unknown', current_use: 'not_evaluated', interruptions: []};
  return sealPreparation({id: 'retained', revision: 1, artifactId: 'payload', payload, differences: [],
    operation: reference, actor: 'principal', recordedAt: 1}).record;
}
test('Q12 prepared inspection keeps resource offers within the authorized record and old profiles closed', () => {
  const preparation = preparedRecord();
  const value = {profile: WORKSPACE_PROFILE, kind: 'preparation_inspection', preparation, offers: ['propose'], resource_offers: ['resource-A']};
  assert.equal(validateWorkspaceQuery({profile: WORKSPACE_PROFILE, kind: 'preparation_inspection', preparation: preparation.reference}), true);
  assert.equal(validateWorkspaceResponse('preparation_inspection', value), true);
  assert.equal(validatePreparationResponse('preparation', 200, value), false);
  for (const resource_offers of [['foreign'], ['resource-A', 'resource-A']])
    assert.equal(validateWorkspaceResponse('preparation_inspection', {...value, resource_offers}), false);
  assert.equal(validateWorkspaceResponse('preparation_inspection', {...value, offers: ['constitute']}), false);
  assert.equal(validateWorkspaceResponse('preparation_inspection', {...value, hidden_offers: 1}), false);
});
test('Q13 exact proposal inspection cannot substitute the retained preparation or widen its effect offer', () => {
  const preparation = preparedRecord(), proposal = {profile: 'preparation-proposal/1', preparation: preparation.reference,
    unit: 'unit', item: 'unit:unit', slot_id: 'slot', target: {kind: 'new', declaration: 'Explicit target.'},
    judgment: {kind: 'distinct', reason: 'Explicit judgment.'}, selected: ['figure'], identity: 'a'.repeat(64), disposition: 'constituted',
    context: {scope_id: 'scope', purpose_id: 'purpose', treatment_revision: reference}};
  const value = {profile: WORKSPACE_PROFILE, kind: 'proposal_inspection', proposal: reference,
    inspection: {proposal, preparation}, offers: ['constitute']};
  assert.equal(validateWorkspaceResponse('proposal_inspection', value), true);
  const changed = structuredClone(value);
  changed.inspection.preparation.reference = {...changed.inspection.preparation.reference, revision: 2};
  assert.equal(validateWorkspaceResponse('proposal_inspection', changed), false);
  assert.equal(validateWorkspaceResponse('proposal_inspection', {...value, offers: ['publish']}), false);
});

// Actual projection and controller; rows, current authority and HTTP are explicit
// doubles. Mounted W18 separately exercises PostgreSQL, admission and delivery.
async function originalOfferCase({state, allowed, receipt, sealed}) {
  const id = '10000000-0000-4000-8000-000000000001', original = Buffer.from('Exact retained original.\n');
  const row = {id, principal: 'principal-1', state, stopped: state === 'stopped', revision: 2, generation: 1,
    declaration: {bytes: original.length, sha256: createHash('sha256').update(original).digest('hex')},
    format: 'text-utf8/1', configuration: reference, load_reference: {intention: reference}};
  const attempt = {artifact_id: 'artifact-1', generation: 1, state: sealed ? 'sealed' : 'reserved', expires_at: Date.now() + 60000};
  const authorityCalls = [], requests = [];
  const db = {query: async sql => {
    let rows;
    if (sql.startsWith('SELECT * FROM $INTAKE.reception ')) rows = [row];
    else if (sql.startsWith('SELECT * FROM $INTAKE.attempt ')) rows = [attempt];
    else if (sql.startsWith('SELECT id FROM $INTAKE.intention ')) rows = [{id: 'reserve-1'}];
    else if (sql.startsWith('SELECT * FROM $INTAKE.receipt ')) rows = receipt ? [{id: 'receipt-1', effect_id: 'effect-1', artifact_id: 'artifact-1'}] : [];
    else if (sql.startsWith('SELECT id,state,dispatchable FROM $INTAKE.work ')) rows = [{id: 'job-1', state: state === 'stopped' ? 'stopped' : 'not_started', dispatchable: false}];
    else if (sql.startsWith('SELECT outcome FROM $INTAKE.availability ')) rows = [{outcome: 'available'}];
    else if (sql.startsWith("SELECT to_regclass('$INTAKE.extraction_job')")) rows = [{installed: false}];
    else throw Error('Unexpected original-offer fixture query: ' + sql);
    return {rows, rowCount: rows.length};
  }};
  const authority = {resolve: async (_admission, route) => {
    authorityCalls.push(route); if (route === 'original' && !allowed) throw new IntakeFailure(404);
  }};
  const shared = {authority, config: {}, evidence: async () => {}, prepared: (_a, _r, status, body) => ({status, body})};
  const result = await new WorkspaceService(shared).reception({db, session: {account_id: row.principal}}, {route: 'reception', parameters: {id}});
  assert.equal(validateWorkspaceResponse('reception', result.body), true);
  const values = new Map(), storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const context = {profile: WORKSPACE_PROFILE, kind: 'context', deployment: 'offer-test',
    context: {scope_id: 'scope-1', purpose_id: 'purpose-1', treatment_revision: reference}, offers: [],
    availability: {profile: 'intake/1', representation: 'intake-availability/2', profiles: []}};
  new IntakeJournal(storage, {deployment: context.deployment, uiOrigin: transport.uiOrigin, terminalOrigin: transport.terminalOrigin}).retain({
    id: 'locator-1', itemKey: 'item-1', operation: 'reserve_reception', profile: 'intake-reception/2',
    key: 'intention-1', fingerprint: 'b'.repeat(64), references: {receptionId: id}});
  const controller = new IntakeController(transport, storage, async (url, options) => {
    const pathname = new URL(url).pathname; requests.push(pathname);
    if (pathname === '/api/access/v1/session') return new Response(JSON.stringify({authenticated: true, session_revision: 1, csrf_token: 'A'.repeat(43)}), {headers: {'content-type': 'application/json'}});
    if (pathname === '/api/intake/profiles') return new Response(JSON.stringify(context), {headers: {'content-type': WORKSPACE_ACCEPT}});
    if (pathname === '/api/intake/receptions/' + id) return new Response(JSON.stringify(options.headers.accept === WORKSPACE_ACCEPT ? result.body : result.body.reception), {headers: {'content-type': options.headers.accept}});
    if (pathname === '/api/intake/receptions/' + id + '/original') return new Response(original, {headers: {'content-type': 'application/octet-stream'}});
    throw Error('Unexpected original-offer fixture request: ' + pathname);
  });
  try {
    await controller.start(); await controller.action('item-1', 'reconcile');
    const item = controller.snapshot().items[0];
    await controller.action('item-1', 'inspect_original');
    return {offered: result.body.offers.includes('inspect_original'), authorityEvaluated: authorityCalls.includes('original'),
      action: item.actions.includes('inspect_original'), requests: requests.filter(p => p.endsWith('/original')).length,
      inspector: controller.snapshot().inspector?.subject ?? null};
  } finally {controller.suspend();}
}

for (const [id, label, state, allowed, receipt, sealed, expected] of [
  ['Q14', 'received original remains offered', 'received', true, true, true, true],
  ['Q15', 'received metadata alone grants no original', 'received', false, true, true, false],
  ['Q16', 'F01 stopped sealed original remains offered and inspectable', 'stopped', true, true, true, true],
  ['Q17', 'stopped original still needs current permission', 'stopped', false, true, true, false],
  ['Q18', 'unreceived stop never offers or requests an original', 'stopped', true, false, false, false],
  ['Q19', 'receipt without a sealed attempt is not an original offer', 'stopped', true, true, false, false],
  ['Q20', 'sealed staging without a durable receipt is not a received original', 'stopped', true, false, true, false],
]) test(id + ' ' + label, async () => {
  assert.deepEqual(await originalOfferCase({state, allowed, receipt, sealed}),
    {offered: expected, authorityEvaluated: receipt && sealed, action: expected, requests: expected ? 1 : 0, inspector: expected ? 'original' : null});
});
