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
        ticket.status = event.status;
        if (event.length !== null && (typeof event.length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(event.length) || Number(event.length) > maximum)) throw Error('Invalid response length.');
        ticket.length = event.length === null ? null : Number(event.length);
      } else if (event.kind === 'chunk') {
        if (ticket.status === null || !Array.isArray(event.bytes) || event.bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw Error('Invalid consumed chunk.');
        ticket.size += event.bytes.length; if (ticket.size > maximum) throw Error('Consumed body exceeds its bound.');
        ticket.chunks.push(Buffer.from(event.bytes));
      } else if (event.kind === 'done') {
        if (ticket.status === null || event.size !== ticket.size || ticket.length !== null && ticket.length !== ticket.size) throw Error('Incomplete consumed body.');
        const bytes = Buffer.concat(ticket.chunks, ticket.size), value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        ticket.finish(null, {status: ticket.status, bytes, value});
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
          selected = url.origin === origin && url.pathname === '/api/intake/operations/lookup' && body?.kind === 'preparation_inspection' &&
            ['id', 'revision', 'sha256'].every(key => body.preparation?.[key] === armed.preparation[key]);
        } catch {}
      }
      const ticket = selected ? armed : null;
      if (ticket) {if (ticket.claimed) reject(ticket); else ticket.claimed = true;}
      let result;
      try {result = Reflect.apply(fetch, this, args);} catch (error) {if (ticket) reject(ticket); throw error;}
      if (ticket && !ticket.terminal) result.then(response => {
        if (ticket.terminal) return;
        try {
          emit(ticket, {kind: 'headers', status: response.status, length: response.headers.get('content-length')});
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
  return {
    async arm(page, preparation, {signal, timeoutMs = 15000} = {}) {
      if (!preparation || typeof preparation.id !== 'string' || !Number.isSafeInteger(preparation.revision) || typeof preparation.sha256 !== 'string') throw Error('An exact preparation reference is required.');
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
      try {await page.evaluate(({id, preparation}) => window.__ledgerdeskArmLookup({id, preparation}), {id, preparation});}
      catch (error) {finish(fail('ERR_RESPONSE_BODY_REJECTED', 'The lookup observation could not be armed.')); throw error;}
      return {result, async dispose() {
        finish(fail('ERR_RESPONSE_BODY_REJECTED', 'The lookup observation ended before completion.'));
        await page.evaluate(id => window.__ledgerdeskDropLookup(id), id).catch(() => {});
      }};
    },
  };
}
