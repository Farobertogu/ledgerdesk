import test from 'node:test';
import assert from 'node:assert/strict';
import {IntakeController} from '../../../src/components/intake/controller.ts';
import {IntakeJournal} from '../../../src/components/intake/journal.ts';
import {WORKSPACE_PROFILE, WORKSPACE_ACCEPT} from '../../../src/contracts/intake_workspace.ts';

const transport = {profile: 'session/1', uiOrigin: 'https://ui.inc02.test:8443', terminalOrigin: 'https://api.inc02.test:9443'};
const reference = {id: 'ref-1', revision: 1, sha256: 'a'.repeat(64)};
const context = {profile: WORKSPACE_PROFILE, kind: 'context', deployment: 'synthetic-deployment',
  context: {scope_id: 'scope-1', purpose_id: 'purpose-1', treatment_revision: reference}, offers: ['receive'],
  availability: {profile: 'intake/1', representation: 'intake-availability/2', profiles: [
    {format_profile: 'text-utf8/1', configuration: reference, original_bytes: 1048576, reception_available: true, processing_available: true}]}};
const session = () => new Response(JSON.stringify({authenticated: true, session_revision: 1, csrf_token: 'A'.repeat(43)}), {headers: {'content-type': 'application/json'}});
const json = value => new Response(JSON.stringify(value), {headers: {'content-type': WORKSPACE_ACCEPT}});
function store() {const values = new Map(); return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};}
function latch() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const effect = {profile: 'intake/1', representation: 'intake-preparation/1', state: 'known_effect', operation_id: 'effect-1', effect: reference,
  result: {state: 'prepared', preparation: reference, differences: []}};

test('LC01 context refresh keeps unsent local originals but requires new queries for protected object projections', async () => {
  const storage = store();
  const journal = new IntakeJournal(storage, {deployment: context.deployment, uiOrigin: transport.uiOrigin, terminalOrigin: transport.terminalOrigin});
  journal.retain({id: 'locator-1', itemKey: 'item-1', operation: 'finalize_preparation', profile: 'intake-preparation/1',
    key: 'same-intention', fingerprint: 'b'.repeat(64), references: {preparation: reference}});
  let effectRequests = 0;
  const controller = new IntakeController(transport, storage, async url => {
    if (String(url).endsWith('/session')) return session();
    if (String(url).endsWith('/profiles')) return json(context);
    effectRequests++; return json({profile: WORKSPACE_PROFILE, kind: 'preparation_effect', effect});
  });
  await controller.start(); await controller.action('item-1', 'reconcile');
  assert.equal(controller.snapshot().items[0].phase, 'prepared');
  controller.setTextDraft({name: 'Unsent text', text: '  Keep exact text\n'}); controller.captureText();
  const draftKey = controller.snapshot().items.find(item => item.phase === 'draft').key;
  await controller.start();
  assert.deepEqual(controller.snapshot().items.find(item => item.key === 'item-1').actions, ['reconcile']);
  assert.equal(controller.snapshot().items.find(item => item.key === 'item-1').preparation, null);
  assert.equal(controller.snapshot().items.find(item => item.key === draftKey).name, 'Unsent text');
  assert.deepEqual(controller.snapshot().textDraft, {name: 'Unsent text', text: '  Keep exact text\n'});
  assert.equal(effectRequests, 1, 'Refresh cannot silently reconcile or replay an effect.');
  await controller.action('item-1', 'reconcile');
  assert.equal(controller.snapshot().items.find(item => item.key === 'item-1').phase, 'prepared');
  assert.equal(journal.read()[0].key, 'same-intention');
});

test('LC02 an abandoned startup failure cannot clear a newer successful context', async () => {
  const held = latch(), reached = latch(); let calls = 0;
  const controller = new IntakeController(transport, store(), async url => {
    if (String(url).endsWith('/session')) return session();
    if (++calls === 1) {reached.resolve(); return held.promise;}
    return json(context);
  });
  const old = controller.start(); await reached.promise;
  await controller.start(); assert.equal(controller.snapshot().phase, 'ready');
  held.reject(Error('Old request failed after replacement')); await old;
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().notices.length, 0);
});

test('LC03 a failed current context clears protected state rather than resurrecting old items', async () => {
  let deny = false;
  const controller = new IntakeController(transport, store(), async url => {
    if (String(url).endsWith('/session')) return session();
    if (deny) throw Error('Current context is unavailable');
    return json(context);
  });
  await controller.start(); controller.setTextDraft({name: 'Draft', text: 'Local text'}); controller.captureText();
  assert.equal(controller.snapshot().items.length, 1); deny = true; await controller.start();
  assert.deepEqual({phase: controller.snapshot().phase, context: controller.snapshot().context, items: controller.snapshot().items},
    {phase: 'unavailable', context: null, items: []});
});
