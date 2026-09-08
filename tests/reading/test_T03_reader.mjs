import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../../src/components/reading/reader.ts';

const ref = id => ({ unit_id: id, version_id: 'v1' });
const list = { contract: 'reading/1', items: ['A', 'B'].map(id => ({ kind: 'REFERENCE', reference: ref(id), metadata: {} })), existence_signal: false };
const detail = id => ({ contract: 'reading/1', projection: { kind: 'CONTENT', reference: ref(id), metadata: {}, original_language: 'es', original_text: `${id}  e\u0301\r\n<em>inert</em>` } });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json', 'cache-control': 'private, no-store' } });
function harness() {
  const pending = [];
  const reader = new Reader((url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
  return { reader, pending };
}
async function ready(h) { const task = h.reader.reload(); h.pending.shift().resolve(response(list)); await task; }

test('requests omit credentials, redirects and cache; lists carry no original text', async () => {
  const h = harness(); const task = h.reader.reload();
  const request = h.pending.shift();
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.cache, 'no-store');
  request.resolve(response(list)); await task;
  assert.equal(h.reader.snapshot().list.items.length, 2); assert.equal(h.reader.snapshot().detail, null);
});
test('late A cannot replace B even when transport ignores cancellation', async () => {
  const h = harness(); await ready(h);
  const a = h.reader.select(ref('A')); const b = h.reader.select(ref('B'));
  h.pending[1].resolve(response(detail('B'))); await b;
  h.pending[0].resolve(response(detail('A'))); await a;
  assert.equal(h.reader.snapshot().detail.reference.unit_id, 'B');
});
test('late list cannot replace a newer list', async () => {
  const h = harness(); const first = h.reader.reload(); const second = h.reader.reload();
  h.pending[1].resolve(response({ ...list, items: [] })); await second;
  h.pending[0].resolve(response(list)); await first;
  assert.equal(h.reader.snapshot().list.items.length, 0);
});
test('different detail reference is rejected and all material cleared', async () => {
  const h = harness(); await ready(h); const task = h.reader.select(ref('A'));
  h.pending.shift().resolve(response(detail('B'))); await task;
  assert.equal(h.reader.snapshot().failure, 'invalid'); assert.equal(h.reader.snapshot().list, null);
});
test('pause invalidates an outstanding detail and clears both surfaces', async () => {
  const h = harness(); await ready(h); const task = h.reader.select(ref('A')); h.reader.pause();
  h.pending.shift().resolve(response(detail('A'))); await task;
  assert.equal(h.reader.snapshot().phase, 'paused'); assert.equal(h.reader.snapshot().detail, null);
});
test('back invalidates outstanding detail without discarding received references', async () => {
  const h = harness(); await ready(h); const task = h.reader.select(ref('A')); h.reader.back();
  h.pending.shift().resolve(response(detail('A'))); await task;
  assert.equal(h.reader.snapshot().selected, null); assert.equal(h.reader.snapshot().detail, null);
  assert.equal(h.reader.snapshot().list.items.length, 2);
});
test('a fresh selection removes the previous original immediately', async () => {
  const h = harness(); await ready(h); const a = h.reader.select(ref('A')); h.pending.shift().resolve(response(detail('A'))); await a;
  const b = h.reader.select(ref('B')); assert.equal(h.reader.snapshot().detail, null);
  h.pending.shift().resolve(response(detail('B'))); await b;
});
test('403 extensions are ignored and refusal clears list and original', async () => {
  const h = harness(); await ready(h); const task = h.reader.select(ref('A'));
  h.pending.shift().resolve(response({ type:'about:blank', title:'Unauthenticated', status:403, code:'UNAUTHENTICATED', secret:'do not display' }, 403)); await task;
  assert.equal(h.reader.snapshot().failure, 'unauthenticated'); assert.equal(h.reader.snapshot().list, null);
  assert.ok(!JSON.stringify(h.reader.snapshot()).includes('secret'));
});
test('duplicate references and successful responses without no-store fail closed', async () => {
  const h = harness(); let task = h.reader.reload();
  h.pending.shift().resolve(response({ ...list, items: [list.items[0], list.items[0]] })); await task;
  assert.equal(h.reader.snapshot().failure, 'invalid');
  task = h.reader.reload(); h.pending.shift().resolve(new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } })); await task;
  assert.equal(h.reader.snapshot().failure, 'invalid');
});
test('original code points and line endings are preserved', async () => {
  const h = harness(); await ready(h); const task = h.reader.select(ref('A'));
  h.pending.shift().resolve(response(detail('A'))); await task;
  assert.equal(h.reader.snapshot().detail.original_text, detail('A').projection.original_text);
});
test('A to B to A accepts only the final A request, not an older response for the same reference', async () => {
  const h = harness(); await ready(h);
  const oldA = h.reader.select(ref('A')); const b = h.reader.select(ref('B')); const finalA = h.reader.select(ref('A'));
  const fresh = detail('A'); fresh.projection.original_text = 'Latest A';
  h.pending[2].resolve(response(fresh)); await finalA;
  h.pending[0].resolve(response(detail('A'))); await oldA;
  h.pending[1].resolve(response(detail('B'))); await b;
  assert.equal(h.reader.snapshot().detail.original_text, 'Latest A');
});
test('a stale detail refusal cannot clear a newer successful selection', async () => {
  const h = harness(); await ready(h); const a = h.reader.select(ref('A')); const b = h.reader.select(ref('B'));
  h.pending[1].resolve(response(detail('B'))); await b;
  h.pending[0].resolve(response({ type: 'about:blank', title: 'Unauthenticated', status: 403, code: 'UNAUTHENTICATED' }, 403)); await a;
  assert.equal(h.reader.snapshot().detail.reference.unit_id, 'B'); assert.equal(h.reader.snapshot().failure, null);
});
test('refresh during detail clears the selection and ignores its later success', async () => {
  const h = harness(); await ready(h); const detailTask = h.reader.select(ref('A')); const refresh = h.reader.reload();
  assert.equal(h.reader.snapshot().selected, null); assert.equal(h.reader.snapshot().list, null);
  h.pending[1].resolve(response({ ...list, items: [] })); await refresh;
  h.pending[0].resolve(response(detail('A'))); await detailTask;
  assert.equal(h.reader.snapshot().list.items.length, 0); assert.equal(h.reader.snapshot().detail, null);
});
test('an older list failure cannot clear a newer successful list', async () => {
  const h = harness(); const old = h.reader.reload(); const fresh = h.reader.reload();
  h.pending[1].resolve(response(list)); await fresh;
  h.pending[0].resolve(response({ type: 'about:blank', title: 'Technical failure', status: 503, code: 'TECHNICAL_FAILURE' }, 503)); await old;
  assert.equal(h.reader.snapshot().list.items.length, 2); assert.equal(h.reader.snapshot().failure, null);
});
test('error bodies require the Problem media type; valid extensions remain tolerated', async () => {
  const body = { type: 'about:blank', title: 'Unavailable', status: 404, code: 'UNAVAILABLE', extra: 'not rendered' };
  for (const [media, expected] of [['application/json', 'invalid'], ['text/plain', 'invalid'], ['application/problem+json; charset=utf-8', 'unavailable']]) {
    const h = harness(); await ready(h); const task = h.reader.select(ref('A'));
    h.pending.shift().resolve(new Response(JSON.stringify(body), { status:404, headers:{ 'content-type':media } })); await task;
    assert.equal(h.reader.snapshot().failure, expected); assert.equal(h.reader.snapshot().detail, null);
    assert.ok(!JSON.stringify(h.reader.snapshot()).includes('not rendered'));
  }
});
test('a Problem with a mismatched HTTP status fails as an invalid response', async () => {
  const h = harness(); await ready(h); const task = h.reader.select(ref('A'));
  h.pending.shift().resolve(response({ type:'about:blank', title:'Unavailable', status:404, code:'UNAVAILABLE' }, 503)); await task;
  assert.equal(h.reader.snapshot().failure, 'invalid'); assert.equal(h.reader.snapshot().list, null);
});
