import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';

const local = new AsyncLocalStorage();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ownedRoute = route => /^\/api\/intake(?:\/|$)/.test(route);
const safeRoute = route => route.split('?')[0];
export function observedContext(event) {
  const current = local.getStore();
  return current ? { ...event, callId: current.callId } : event;
}

/** Observe actual request callbacks and reads without exposing authentication fields. */
export function observeRequests(server, publish, {diagnoseReadOrigin=process.env.LEDGERDESK_INTAKE_BOUNDARIES==='1',preparationBodyCapture=false}={}) {
  const listeners = server.listeners('request');
  if (listeners.length !== 1) throw Error('OBSERVER_REQUEST_LISTENER_COUNT');
  const original = listeners[0], sockets = new WeakMap();
  function measured(req, res) {
    const ordinal = (sockets.get(req.socket) ?? 0) + 1;
    sockets.set(req.socket, ordinal);
    if (!ownedRoute(req.url ?? '')) return original.call(this, req, res);
    const callId = randomUUID(), route = safeRoute(req.url), context = { callId };
    publish({ kind: 'server-request', callId, method: req.method, route, atMs: Date.now(),
      clientKey: typeof req.headers['x-ledgerdesk-intent']==='string'?req.headers['x-ledgerdesk-intent']:null,
      socket: { address: req.socket.localAddress, port: req.socket.localPort,
        peerAddress: req.socket.remoteAddress, peerPort: req.socket.remotePort, requestOrdinal: ordinal } });
    const read = req.read;
    let nativeDiscard=false;
    if(diagnoseReadOrigin){
      const dump=req._dump;
      req._dump=function(...args){
        const frames=(new Error().stack??'').split('\n').slice(1,9).map(line=>line.trim());
        // Only Node's actual HTTP completion starts this qualified discard.
        // An application calling _dump itself does not obtain that provenance.
        const alreadyDumped=this._dumped===true;
        if(!alreadyDumped)nativeDiscard=frames.some(line=>/^at resOnFinish \(node:_http_server:\d+:\d+\)$/.test(line));
        publish({kind:'request-discard-start',callId,atMs:Date.now(),nativeDiscard,alreadyDumped,diagnosticDumpFrames:frames});
        return dump.apply(this,args);
      };
    }
    // T04 stages documents up to 8 MiB; the retained T02 observation boundary
    // remains 1 MiB everywhere else. This changes test capture, not admission.
    const captureLimit=preparationBodyCapture&&req.method==='POST'&&
      /^\/api\/intake\/preparation-attempts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/content$/.test(req.url??'')&&
      req.headers.accept==='application/vnd.ledgerdesk.intake-preparation+json'?8388608:1048576;
    let total = 0;
    req.read = function (...args) {
      const value = read.apply(this, args);
      if (Buffer.isBuffer(value) && value.length) {
        total += value.length;
        if (total > captureLimit) throw Error('OBSERVER_CONSUMPTION_CAPTURE_LIMIT');
        const frames=diagnoseReadOrigin?(new Error().stack??'').split('\n').slice(1,9).map(line=>line.trim()):null;
        const internalFlow=frames?.[1]?.match(/^at flow \(node:internal\/streams\/readable:\d+:\d+\)$/)&&
          frames?.[2]?.match(/^at resume_ \(node:internal\/streams\/readable:\d+:\d+\)$/);
        const provenance=diagnoseReadOrigin?{diagnosticReadFrames:frames,
          diagnosticReadOrigin:nativeDiscard&&this._dumped===true&&this.listenerCount('data')===0&&internalFlow?'node-http-discard':'not-qualified-as-discard'}:{};
        publish({ kind: 'application-read', callId, atMs: Date.now(), bytes: value.length,
          sha256: hash(value), data: Buffer.from(value),
          ...provenance,
        });
      }
      return value;
    };
    const destroy = res.destroy;
    res.destroy = function (...args) {
      const fromIntakeTerminal=(new Error().stack??'').includes('/src/server/intake/terminal.ts:');
      publish({kind:'terminal-destroy',callId,atMs:Date.now(),headersSent:this.headersSent,writableEnded:this.writableEnded,fromIntakeTerminal});
      return destroy.apply(this,args);
    };
    const end = res.end;
    res.end = function (...args) {
      const payload = typeof args[0] === 'string' ? Buffer.from(args[0], typeof args[1] === 'string' ? args[1] : 'utf8')
        : Buffer.isBuffer(args[0]) || ArrayBuffer.isView(args[0]) ? Buffer.from(args[0]) : Buffer.alloc(0);
      const atMs = Date.now(), result = end.apply(this, args);
      publish({ kind: 'terminal-end', callId, atMs, bytes: payload.length, sha256: hash(payload),
        status: this.statusCode, destroyed: this.destroyed, writableEnded: this.writableEnded });
      return result;
    };
    return local.run(context, () => original.call(this, req, res));
  }
  server.removeListener('request', original);
  server.on('request', measured);
  return () => { server.removeListener('request', measured); server.on('request', original); };
}

/** Called on the client's real socket, before any response can supply an identity. */
export function clientEndpoint(socket, ordinals) {
  const ordinal = (ordinals.get(socket) ?? 0) + 1; ordinals.set(socket, ordinal);
  return { address: socket.localAddress, port: socket.localPort,
    peerAddress: socket.remoteAddress, peerPort: socket.remotePort,
    requestOrdinal: ordinal, observedAtMs: Date.now() };
}
