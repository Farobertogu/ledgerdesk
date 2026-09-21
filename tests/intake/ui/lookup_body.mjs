import {randomUUID} from 'node:crypto';

/** Observe only bytes returned by the application's native reader. */
export async function lookupBodyObserver(context, {origin, maximum}) {
  const pending = new Map();
  const fail = (code, message) => Object.assign(new Error(message), {code});
  await context.exposeBinding('__ledgerdeskLookupBody', ({page}, event) => {
    const ticket = pending.get(event?.id); if (!ticket || ticket.page !== page) return;
    try {
      if (event.sequence !== ++ticket.sequence) throw Error('Consumed body observation lost an event.');
      if (event.kind === 'headers') {
        if (ticket.status !== null || !Number.isInteger(event.status) || event.status < 100 || event.status > 599) throw Error('Invalid response headers.');
        ticket.status = event.status; ticket.request = event.request;
        if (event.length !== null && (typeof event.length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(event.length) || Number(event.length) > maximum)) throw Error('Invalid response length.');
        ticket.length = event.length === null ? null : Number(event.length);
      } else if (event.kind === 'chunk') {
        if (ticket.status === null || !Array.isArray(event.bytes) || event.bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw Error('Invalid consumed chunk.');
        ticket.size += event.bytes.length; if (ticket.size > maximum) throw Error('Consumed body exceeds its bound.');
        ticket.chunks.push(Buffer.from(event.bytes));
      } else if (event.kind === 'done') {
        if (ticket.status === null || event.size !== ticket.size || ticket.length !== null && ticket.length !== ticket.size) throw Error('Incomplete consumed body.');
        const bytes = Buffer.concat(ticket.chunks, ticket.size), value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        ticket.finish(null, {status: ticket.status, bytes, value, request: ticket.request});
      } else throw Error('The native response was cancelled, rejected or could not be observed.');
    } catch (error) {ticket.finish(fail('ERR_RESPONSE_BODY_REJECTED', error.message));}
  });
  await context.addInitScript(({origin, maximum}) => {
    let armed = null;
    const streams = new WeakMap(), readers = new WeakMap();
    const emit = (ticket, event) => {
      // Sequence and final byte count make missing delivery fail closed without delaying native reads.
      void window.__ledgerdeskLookupBody({id: ticket.id, sequence: ++ticket.sequence, ...event}).catch(() => {});
    };
    const reject = ticket => {if (!ticket.terminal) {ticket.terminal = true; emit(ticket, {kind: 'failed'});}};
    window.__ledgerdeskArmLookup = selector => {
      if (armed && !armed.terminal) throw Error('A lookup observation is already active.');
      armed = {...selector, claimed: false, terminal: false, size: 0, sequence: 0};
    };
    window.__ledgerdeskDropLookup = id => {if (armed?.id === id) armed = null;};
    const fetch = window.fetch;
    window.fetch = function (...args) {
      const [input, init] = args; let selected = false;
      if (armed && !armed.terminal && typeof input === 'string' && init?.method === 'POST' && typeof init.body === 'string') {
        try {
          const url = new URL(input, location.href), body = JSON.parse(init.body);
          const same = (left, right, keys) => left && right && typeof left === 'object' && typeof right === 'object' && keys.every(key => left[key] === right[key]);
          if (url.origin === origin && armed.operation === 'lookup') selected = url.pathname === '/api/intake/operations/lookup' && body?.kind === 'preparation_inspection' &&
            same(body.preparation, armed.preparation, ['id', 'revision', 'sha256']);
          else if (url.origin === origin) {
            const intent = new Headers(init.headers).get('x-ledgerdesk-intent');
            const raw = sessionStorage.getItem(armed.journal.key);
            if (!raw || new TextEncoder().encode(raw).length > armed.journal.bytes) throw Error('The bounded journal is unavailable.');
            const journal = JSON.parse(raw);
            if (!Array.isArray(journal.entries) || journal.entries.length > armed.journal.entries) throw Error('Invalid journal entries.');
            const entries = journal.entries.filter(entry => entry.itemKey === armed.itemKey && entry.operation === armed.operation &&
              entry.profile === 'intake-preparation/1' && typeof intent === 'string' && entry.key === intent);
            if (entries.length === 1 && body?.profile === 'intake/1' && body.representation === 'intake-preparation/1') {
              if (armed.operation === 'constitute') selected = url.pathname === '/api/intake/constitutions' &&
                same(body.proposal, armed.proposal, ['id', 'revision', 'sha256']) && body.mode === 'person';
              else if (armed.operation === 'propose') selected = url.pathname === '/api/intake/preparations/' + armed.preparation.id + '/revisions/' + armed.preparation.revision + '/proposals' && body.unit === 'selected-material' &&
                journal.entries.some(entry => entry.itemKey === armed.itemKey && same(entry.references?.preparation, armed.preparation, ['id', 'revision', 'sha256']));
              else if (armed.operation === 'finalize_preparation') {
                const match = /^\/api\/intake\/preparation-attempts\/([^/]+)\/finalize$/.exec(url.pathname);
                if (match) {
                  const uploads = journal.entries.filter(entry => entry.itemKey === armed.itemKey && entry.operation === 'upload_preparation' &&
                    entry.references?.attemptId === match[1] && same(entry.references.document, body.document, ['id', 'generation', 'bytes', 'sha256']));
                  selected = uploads.length === 1 && (!armed.attempt || match[1] === armed.attempt.id && body.expected_revision === armed.attempt.revision &&
                    same(body.document, armed.attempt.document, ['id', 'generation', 'bytes', 'sha256']));
                }
              }
            }
          }
        } catch {}
      }
      const ticket = selected ? armed : null;
      if (ticket) {if (ticket.claimed) reject(ticket); else {ticket.claimed = true;
        ticket.request = {url: new URL(input, location.href).href, method: init.method, body: init.body, intent: new Headers(init.headers).get('x-ledgerdesk-intent')};}}
      let result;
      try {result = Reflect.apply(fetch, this, args);} catch (error) {if (ticket) reject(ticket); throw error;}
      if (ticket && !ticket.terminal) result.then(response => {
        if (ticket.terminal) return;
        try {
          emit(ticket, {kind: 'headers', status: response.status, length: response.headers.get('content-length'), request: ticket.request});
          if (!response.body) {reject(ticket); return;}
          streams.set(response.body, ticket);
        } catch {reject(ticket);}
      }, () => reject(ticket));
      return result;
    };
    const getReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function (...args) {
      const result = Reflect.apply(getReader, this, args), ticket = streams.get(this);
      if (ticket) readers.set(result, ticket); return result;
    };
    const read = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function (...args) {
      const result = Reflect.apply(read, this, args), ticket = readers.get(this);
      if (ticket) result.then(value => {
        if (ticket.terminal) return;
        try {
          if (value.done) {emit(ticket, {kind: 'done', size: ticket.size}); ticket.terminal = true;}
          else {
            if (!(value.value instanceof Uint8Array)) {reject(ticket); return;}
            ticket.size += value.value.byteLength; if (ticket.size > maximum) {reject(ticket); return;}
            emit(ticket, {kind: 'chunk', bytes: Array.from(value.value)});
          }
        } catch {reject(ticket);}
      }, () => reject(ticket));
      return result;
    };
    for (const [prototype, map] of [[ReadableStream.prototype, streams], [ReadableStreamDefaultReader.prototype, readers]]) {
      const cancel = prototype.cancel;
      prototype.cancel = function (...args) {const ticket = map.get(this); if (ticket) reject(ticket); return Reflect.apply(cancel, this, args);};
    }
  }, {origin, maximum});
  const arm = async (page, selector, {signal, timeoutMs = 15000} = {}) => {
      const id = randomUUID(); let timer, resolve, reject;
      const result = new Promise((yes, no) => {resolve = yes; reject = no;}); result.catch(() => {});
      const closed = () => finish(fail('ERR_RESPONSE_BODY_REJECTED', 'The page closed before the consumed body completed.'));
      const aborted = () => finish(signal.reason ?? fail('ERR_RESPONSE_BODY_REJECTED', 'The test was cancelled.'));
      const finish = (error, value) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer); page.off('close', closed); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value);
      };
      pending.set(id, {page, status: null, length: null, chunks: [], size: 0, sequence: 0, finish});
      page.once('close', closed); signal?.addEventListener('abort', aborted, {once: true});
      timer = setTimeout(() => finish(fail('ERR_RESPONSE_BODY_DEADLINE', 'The consumed lookup body exceeded its deadline.')), timeoutMs);
      if (signal?.aborted) {aborted(); throw signal.reason;}
      try {await page.evaluate(({id, selector}) => window.__ledgerdeskArmLookup({id, ...selector}), {id, selector});}
      catch (error) {finish(fail('ERR_RESPONSE_BODY_REJECTED', 'The lookup observation could not be armed.')); throw error;}
      return {result, async dispose() {
        finish(fail('ERR_RESPONSE_BODY_REJECTED', 'The lookup observation ended before completion.'));
        await page.evaluate(id => window.__ledgerdeskDropLookup(id), id).catch(() => {});
      }};
    };
  const exact = reference => reference && typeof reference.id === 'string' && Number.isSafeInteger(reference.revision) && typeof reference.sha256 === 'string';
  return {
    arm(page, preparation, options) {
      if (!exact(preparation)) throw Error('An exact preparation reference is required.');
      return arm(page, {operation: 'lookup', preparation}, options);
    },
    armEffect(page, selector, options) {
      if (!['finalize_preparation', 'propose', 'constitute'].includes(selector?.operation) || typeof selector.itemKey !== 'string' ||
        typeof selector.journal?.key !== 'string' || !Number.isSafeInteger(selector.journal.bytes) || !Number.isSafeInteger(selector.journal.entries) ||
        selector.operation === 'propose' && !exact(selector.preparation) || selector.operation === 'constitute' && !exact(selector.proposal)) throw Error('An exact editorial request selector is required.');
      return arm(page, selector, options);
    },
  };
}
