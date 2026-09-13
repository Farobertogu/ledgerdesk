import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import { observeRequests, observedContext, clientEndpoint } from './request_observer.mjs';

test('request observer retains real persistent ordinals, async ownership and exact reads', async t => {
  const records=[], contexts=[], replies=[], ordinals=new WeakMap();
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    await new Promise(resolve=>setImmediate(resolve));
    contexts.push(observedContext({kind:'test-authority'}));
    res.end(Buffer.concat(chunks));
  });
  observeRequests(server,event=>records.push(event));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const agent=new http.Agent({keepAlive:true,maxSockets:1});
  t.after(async()=>{agent.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  async function call(route,body){return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:'POST',agent,
      headers:{cookie:'secret-cookie','x-ledgerdesk-csrf':'secret-csrf','x-ledgerdesk-intent':'controlled-test-intention','content-length':Buffer.byteLength(body)}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
    });
    req.on('socket',socket=>{const ready=()=>replies.push(clientEndpoint(socket,ordinals));if(socket.connecting)socket.once('connect',ready);else ready();});
    req.on('error',reject);req.end(body);
  });}
  await call('/api/access/v1/unobserved','not-retained');
  assert.deepEqual(await call('/api/intake/receptions?secret=not-retained','é\r\n'),Buffer.from('é\r\n'));
  assert.deepEqual(await call('/api/intake/receptions','second'),Buffer.from('second'));
  const boundaries=records.filter(e=>e.kind==='server-request');
  assert.deepEqual(boundaries.map(e=>e.clientKey),['controlled-test-intention','controlled-test-intention']);
  assert.deepEqual(boundaries.map(e=>e.socket.requestOrdinal),[2,3]);
  assert.deepEqual(replies.map(e=>e.requestOrdinal),[1,2,3]);
  assert.notEqual(boundaries[0].callId,boundaries[1].callId);
  assert.deepEqual(contexts.slice(1).map(e=>e.callId),boundaries.map(e=>e.callId));
  for(let i=0;i<boundaries.length;i++){
    const b=boundaries[i],c=replies[i+1];
    assert.deepEqual([b.socket.address,b.socket.port,b.socket.peerAddress,b.socket.peerPort],
      [c.peerAddress,c.peerPort,c.address,c.port]);
    const reads=records.filter(e=>e.kind==='application-read'&&e.callId===b.callId);
    assert.deepEqual(Buffer.concat(reads.map(e=>e.data)),Buffer.from(i?'second':'é\r\n'));
    const end=records.find(e=>e.kind==='terminal-end'&&e.callId===b.callId);
    assert.equal(end.bytes,Buffer.byteLength(i?'second':'é\r\n'));assert.equal(end.writableEnded,true);
  }
  assert.doesNotMatch(JSON.stringify(records),/secret-cookie|secret-csrf|not-retained|\?secret/);
});

test('qualified native discard never hides an explicit read or an application-issued dump',async t=>{
  const records=[],consumed=[];
  const server=http.createServer(async(req,res)=>{
    req.pause();
    if(req.url.endsWith('/explicit')){
      if(!req.readableLength)await once(req,'readable');
      consumed.push(req.read(1));
    }else if(req.url.endsWith('/application-dump')){
      if(!req.readableLength)await once(req,'readable');
      req._dump();await new Promise(resolve=>setImmediate(resolve));
    }
    res.statusCode=413;res.end('refused');
  });
  observeRequests(server,event=>records.push(event),{diagnoseReadOrigin:true});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  for(const name of ['native','explicit','application-dump']){
    await new Promise((resolve,reject)=>{
      const call=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/intake/'+name,method:'POST',agent:false,
        headers:{'content-length':'6'}},reply=>{reply.resume();reply.once('end',resolve);reply.once('error',reject);});
      call.once('error',reject);call.end('frame\n');
    });
    await delay(10);
    const id=records.find(e=>e.kind==='server-request'&&e.route==='/api/intake/'+name).callId;
    const reads=records.filter(e=>e.kind==='application-read'&&e.callId===id);
    assert.ok(reads.length,'The actual body-read control must be reached: '+name);
    const unqualified=reads.filter(e=>e.diagnosticReadOrigin!=='node-http-discard').reduce((sum,e)=>sum+e.bytes,0);
    if(name==='native'){
      assert.equal(unqualified,0);assert.equal(reads.reduce((sum,e)=>sum+e.bytes,0),6);
      assert.ok(records.some(e=>e.kind==='request-discard-start'&&e.callId===id&&e.nativeDiscard));
    }else assert.ok(unqualified>0,'Explicit consumption must remain detectable: '+name);
  }
  assert.deepEqual(consumed,[Buffer.from('f')]);
});
