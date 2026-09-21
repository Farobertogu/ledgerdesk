import test from 'node:test';
import assert from 'node:assert/strict';
import {IntakeJournal, JOURNAL_KEY} from '../../../src/components/intake/journal.ts';
import {capturedTextBytes, IntakeClient} from '../../../src/components/intake/client.ts';

const environment = {deployment: 'synthetic-deployment', uiOrigin: 'https://ui.inc02.test:8443', terminalOrigin: 'https://api.inc02.test:9443'};
const entry = {id: 'locator-1', itemKey: 'item-1', operation: 'reserve_preparation', profile: 'intake-preparation/1',
  key: 'one-intention', fingerprint: 'a'.repeat(64), references: {}};
function storage() {const values = new Map(); return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};}
test('J01 retained locator round trips without names, bodies or credentials', () => {
  const store = storage(), journal = new IntakeJournal(store, environment);
  journal.retain(entry); assert.deepEqual(journal.read(), [entry]);
  for (const key of ['body', 'name', 'csrf', 'cookie', 'password', 'response', 'draft'])
    assert.throws(() => journal.retain({...entry, [key]: 'protected'}), /Invalid recovery locator/);
  assert.deepEqual(journal.read(), [entry]);
});
test('J02 key/payload identity cannot be changed while adding learned references', () => {
  const journal = new IntakeJournal(storage(), environment); journal.retain(entry);
  journal.retain({...entry, references: {attemptId: 'attempt-1'}});
  assert.equal(journal.read()[0].references.attemptId, 'attempt-1');
  assert.throws(() => journal.retain({...entry, fingerprint: 'b'.repeat(64)}), /cannot be replaced/);
  assert.throws(() => journal.retain({...entry, key: 'another-intention'}), /cannot be replaced/);
});
test('J03 deployment replacement cannot reinterpret old locators', () => {
  const store = storage(); new IntakeJournal(store, environment).retain(entry);
  assert.throws(() => new IntakeJournal(store, {...environment, deployment: 'other'}).read(), /another environment/);
});
test('J04 a denied or ineffective write fails rather than claiming refresh recovery', () => {
  assert.throws(() => new IntakeJournal({getItem: () => null, setItem: () => {throw Error('denied');}}, environment).retain(entry), /denied/);
  assert.throws(() => new IntakeJournal({getItem: () => null, setItem: () => {}}, environment).retain(entry), /could not be retained/);
});
test('J05 malformed/duplicate/full journal is not silently cleared or truncated', () => {
  const store = storage(), journal = new IntakeJournal(store, environment); journal.retain(entry);
  const value = JSON.parse(store.getItem(JOURNAL_KEY)); value.entries.push(entry); store.setItem(JOURNAL_KEY, JSON.stringify(value));
  assert.throws(() => journal.read(), /duplicate locators/);
  store.setItem(JOURNAL_KEY, 'x'.repeat(65537)); assert.throws(() => journal.read(), /exceeds/);
  assert.equal(store.getItem(JOURNAL_KEY).length, 65537);
});
test('J06 captured field preserves exact whitespace/Unicode and rejects unpaired surrogates', () => {
  assert.deepEqual([...capturedTextBytes(' \r\ne\u0301 😀 ')], [...Buffer.from(' \r\ne\u0301 😀 ')]);
  assert.equal(Buffer.from(capturedTextBytes('x')).toString('hex'), '78');
  assert.throws(() => capturedTextBytes('\ud800'), /Unicode/);
});

const session = csrf => new Response(JSON.stringify({authenticated: true, session_revision: 1, csrf_token: csrf}), {headers: {'content-type': 'application/json'}});
const transport = {profile: 'session/1', uiOrigin: environment.uiOrigin, terminalOrigin: environment.terminalOrigin};
test('J07 a replaced exact session prevents sensitive response adoption', async () => {
  let sessionReads = 0;
  const client = new IntakeClient(transport, async url => String(url).endsWith('/session') ? session(++sessionReads < 3 ? 'A'.repeat(43) : 'B'.repeat(43)) :
    new Response('{"accepted":true}', {headers: {'content-type': 'application/json'}}));
  assert.equal(await client.session(), true);
  await assert.rejects(() => client.request({path: '/api/intake/profiles', accept: 'application/json', maximum: 1024,
    assertContext() {}, validate: value => value.accepted === true}), /session changed/);
});
test('J08 local item changes during the session observation cancel an otherwise valid response', async () => {
  let local = 1, sessionReads = 0;
  const client = new IntakeClient(transport, async url => {
    if (String(url).endsWith('/session')) {if (++sessionReads === 3) local = 2; return session('A'.repeat(43));}
    return new Response('{"accepted":true}', {headers: {'content-type': 'application/json'}});
  });
  await client.session();
  await assert.rejects(() => client.request({path: '/api/intake/profiles', accept: 'application/json', maximum: 1024,
    assertContext() {if (local !== 1) throw new DOMException('Context changed', 'AbortError');}, validate: () => true}), {name: 'AbortError'});
});
test('J09 positive request retains credentials and the exact body, with session checks around it', async () => {
  const observed = [];
  const client = new IntakeClient(transport, async (url, options) => {
    observed.push({url, options}); return String(url).endsWith('/session') ? session('A'.repeat(43)) :
      new Response('{"accepted":true}', {headers: {'content-type': 'application/json'}});
  });
  await client.session();
  const result = await client.request({path: '/api/intake/operations/lookup', method: 'POST', accept: 'application/json',
    body: '{"exact":" a "}', maximum: 1024, assertContext() {}, validate: value => value.accepted === true});
  assert.equal(result.value.accepted, true);
  assert.equal(observed.length, 4);
  assert.equal(observed[2].options.body, '{"exact":" a "}');
  assert.equal(observed[2].options.credentials, 'include');
  assert.equal(observed[2].options.headers['x-ledgerdesk-csrf'], 'A'.repeat(43));
});

test('J10 native fetch receiver is preserved for startup and guarded requests', async () => {
  let calls = 0;
  const client = new IntakeClient(transport, async function (url) {
    assert.equal(this, globalThis); calls++;
    return String(url).endsWith('/session') ? session('A'.repeat(43)) :
      new Response('{"accepted":true}', {headers: {'content-type': 'application/json'}});
  });
  assert.equal(await client.session(), true);
  const result = await client.request({path: '/api/intake/profiles', accept: 'application/json', maximum: 1024,
    assertContext() {}, validate: value => value.accepted === true});
  assert.equal(result.value.accepted, true); assert.equal(calls, 4);
});
