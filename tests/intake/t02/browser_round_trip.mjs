import assert from 'node:assert/strict';
import https from 'node:https';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {uiOrigin,apiOrigin,recipientEmail,password} from '../../access/journey_environment.mjs';
import {treatment} from './fixtures.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const html='<!doctype html><html lang="en"><meta charset="utf-8"><title>Reception test driver</title><h1>Synthetic reception test driver</h1><p>This is test infrastructure, not the upload interface.</p><output id="state">Ready</output></html>';

/** No request interception, mocked API, proxy or certificate bypass is installed. */
export async function browserRoundTrip(t,{env,terminal,setBarrier}){
  let browser,server,context,page;let leakedCookies=0;
  const events=[],steps=[],requestPaths=new Map(),observations=[];
  const scenario=async(name,run)=>{
    let completed=false;await t.test(name,async()=>{await run();completed=true;});
    if(!completed)throw Error('BROWSER_DRIVER_PREREQUISITE_FAILED: '+name);
  };
  try{
    server=https.createServer(env.tls,(req,res)=>{
      if((req.headers.cookie??'').includes('__Host-ledgerdesk'))leakedCookies++;
      if(req.url!=='/'||req.method!=='GET'){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
        'content-security-policy':"default-src 'none'; connect-src "+apiOrigin+"; frame-ancestors 'none'"});res.end(html);
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8443,'127.0.0.1',resolve);});
    browser=await chromium.launch({args:['--host-resolver-rules=MAP *.inc02.test 127.0.0.1','--no-proxy-server']});
    context=await browser.newContext();page=await context.newPage();
    const network=await context.newCDPSession(page);await network.send('Network.enable');
    network.on('Network.requestWillBeSent',e=>{
      const u=new URL(e.request.url);
      if(u.origin!==apiOrigin||!u.pathname.startsWith('/api/intake/'))return;
      requestPaths.set(e.requestId,{path:u.pathname,method:e.request.method});events.push({kind:'request',path:u.pathname,method:e.request.method,requestId:e.requestId,at:e.timestamp});
    });
    network.on('Network.responseReceived',e=>{if(requestPaths.has(e.requestId))events.push({kind:'response',...requestPaths.get(e.requestId),requestId:e.requestId,status:e.response.status,at:e.timestamp});});
    network.on('Network.dataReceived',e=>{if(requestPaths.has(e.requestId))events.push({kind:'data',...requestPaths.get(e.requestId),requestId:e.requestId,bytes:e.dataLength,at:e.timestamp});});
    const response=await page.goto(uiOrigin+'/');assert.equal(response.status(),200);
    assert.equal(await page.locator('h1').textContent(),'Synthetic reception test driver');
    assert.doesNotMatch(await page.content(),/csrf_token|__Host-ledgerdesk|synthetic-recipient|Información/);
    await page.evaluate(()=>{window.receptionDriver={csrf:null,pending:false};});

    async function call(path,{body,bytes,key}={}){
      const result=await page.evaluate(async({path,body,bytes,key,api})=>{
        const driver=window.receptionDriver;driver.pending=true;
        try{
          const payload=bytes?new Uint8Array(bytes):body===undefined?undefined:JSON.stringify(body);
          const response=await fetch(api+path,{method:payload===undefined?'GET':'POST',credentials:'include',cache:'no-store',redirect:'error',
            headers:payload===undefined?{}:{'content-type':bytes?'application/octet-stream':'application/json',
              'x-ledgerdesk-csrf':driver.csrf,...(key?{'x-ledgerdesk-intent':key}:{})},body:payload});
          const raw=Array.from(new Uint8Array(await response.arrayBuffer()));
          const json=String(response.headers.get('content-type')).includes('json');
          const value=json?JSON.parse(new TextDecoder().decode(new Uint8Array(raw))):null;
          if(value?.csrf_token)driver.csrf=value.csrf_token;
          document.getElementById('state').textContent='Last response: '+response.status;
          return{status:response.status,body:value,bytes:raw,headers:Object.fromEntries(['content-type','content-length','cache-control'].map(k=>[k,response.headers.get(k)]))};
        }finally{driver.pending=false;}
      },{path,body,bytes,key,api:apiOrigin});
      await terminal.flushObservations();
      return result;
    }
    await scenario('browser establishes its own accepted session under the real HTTPS origins',async()=>{
      assert.equal((await call('/api/access/v1/reception')).status,200);
      const signed=await call('/api/access/v1/sessions',{body:{email:recipientEmail,password},key:'browser-login-1'});
      assert.equal(signed.status,200);
      const cookies=await context.cookies(apiOrigin);
      const session=cookies.find(c=>c.name==='__Host-ledgerdesk-session');
      assert.ok(session);assert.deepEqual([session.secure,session.httpOnly,session.sameSite,session.domain],[true,true,'Strict','api.inc02.test']);
      assert.equal((await context.cookies(uiOrigin)).some(c=>c.name==='__Host-ledgerdesk-session'),false);
      steps.push({step:'browser-session',status:signed.status,hostOnly:true});
    });
    const original=readFileSync(new URL('../t01/fixtures/bom.txt',import.meta.url));
    assert.deepEqual([original.length,hash(original)],[17,'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9']);
    const declaration={profile:'intake/1',original:{name:'bom.txt',bytes:17,sha256:hash(original),declared_media_type:'text/plain'},
      format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
    let reserved,staged,received;
    await scenario('browser sees offered reception without claiming processing is implemented',async()=>{
      const result=await call('/api/intake/profiles');assert.equal(result.status,200);
      assert.equal(result.body.profiles.length,4);assert.ok(result.body.profiles.every(p=>p.reception_available&&!p.processing_available));
      steps.push({step:'profiles',status:200,processingAvailable:false});
    });
    await scenario('browser reserves and sends the exact original without creating a receipt early',async()=>{
      const reserve=await call('/api/intake/receptions',{body:declaration,key:'browser-reservation-1'});assert.equal(reserve.status,202);reserved=reserve.body;
      const stage=await call(`/api/intake/receptions/${reserved.reception_id}/attempts/1/original`,{bytes:Array.from(original)});
      assert.equal(stage.status,200);staged=stage.body;
      assert.deepEqual([staged.state,staged.effect,staged.work],['staged',null,null]);
      const counts=(await env.admin.query('SELECT (SELECT count(*)::int FROM intake_trial.receipt) AS receipts,(SELECT count(*)::int FROM intake_trial.work) AS jobs')).rows[0];
      assert.deepEqual(counts,{receipts:0,jobs:0});steps.push({step:'staged',status:200,bytes:17,counts});
    });
    const finalPath=`/api/intake/receptions/${reserved.reception_id}/finalize`;
    const finalBody={profile:'intake/1',expected_revision:staged.revision,original:staged.original,format_profile:'text-utf8/1'};
    await scenario('finalization is durable while the actual browser still has no response or content',async()=>{
      let reached=0;
      setBarrier(async(label,event)=>{
        if(label!=='before_handoff'||event.route!=='finalize_reception')return;
        reached++;
        const evidence=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[event.evidenceId])).rows[0];
        const sql=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[event.backendPid])).rows[0];
        const receipt=(await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1',[reserved.reception_id])).rows[0];
        const pending=await page.evaluate(()=>window.receptionDriver.pending);
        const networkBefore=events.filter(e=>e.path===finalPath&&e.method==='POST'&&['response','data'].includes(e.kind));
        observations.push({label,observedAtMs:Date.now(),evidenceId:evidence?.id??null,evidenceStatus:evidence?.status??null,
          receiptId:receipt?.id??null,backendPid:event.backendPid,sql,pending,networkBefore});
        assert.deepEqual({evidence:evidence?.status,receipt:!!receipt,sql,pending,networkBefore},
          {evidence:200,receipt:true,sql:{state:'idle',xact_start:null},pending:true,networkBefore:[]});
      });
      try{const result=await call(finalPath,{body:finalBody,key:'browser-finalization-1'});assert.equal(result.status,200);received=result.body;}
      finally{setBarrier(async()=>{});}
      assert.equal(reached,1);assert.ok(received.effect);assert.equal(received.work.dispatchable,false);
      steps.push({step:'receipt',status:200,receptionId:received.reception_id,effectId:received.effect.id,jobId:received.work.id});
    });
    await scenario('browser receives exact protected bytes and separately queries the record',async()=>{
      const response=await call(`/api/intake/receptions/${reserved.reception_id}/original`);
      assert.deepEqual({status:response.status,bytes:Buffer.from(response.bytes),type:response.headers['content-type'],cache:response.headers['cache-control']},
        {status:200,bytes:original,type:'application/octet-stream',cache:'private, no-store'});
      const record=await call('/api/intake/operations/lookup',{body:{profile:'intake/1',by:'operation',operation_id:received.operation_id}});
      assert.equal(record.status,200);assert.equal(record.body.effect.id,received.effect.id);
      steps.push({step:'whole-original-and-query',status:200,bytes:response.bytes.length,sha256:hash(Buffer.from(response.bytes))});
    });
    await scenario('withdrawn loading blocks a new act but not recovery of the known effect',async()=>{
      const changed=(await env.admin.query("UPDATE access_trial.grant_record g SET withdrawn=true,revision=g.revision+1 FROM access_trial.account a WHERE g.account_id=a.id AND a.email=$1 AND permission_id='intake_load' AND faculty='exercise' RETURNING g.id",[recipientEmail])).rows;
      assert.equal(changed.length,1);
      const fresh=await call('/api/intake/receptions',{body:declaration,key:'browser-forbidden-reservation'});
      const known=await call(finalPath,{body:finalBody,key:'browser-finalization-1'});
      const counts=(await env.admin.query('SELECT (SELECT count(*)::int FROM intake_trial.receipt) AS receipts,(SELECT count(*)::int FROM intake_trial.work) AS jobs,(SELECT count(*)::int FROM intake_trial.reception) AS receptions')).rows[0];
      assert.deepEqual({fresh:fresh.status,known:known.status,effect:known.body.effect?.id,counts},
        {fresh:404,known:200,effect:received.effect.id,counts:{receipts:1,jobs:1,receptions:1}});
      steps.push({step:'query-without-load',fresh:404,known:200,counts});
    });
    await scenario('withdrawn query authority refuses disclosure without deleting the receipt',async()=>{
      const changed=(await env.admin.query("UPDATE access_trial.grant_record g SET withdrawn=true,revision=g.revision+1 FROM access_trial.account a WHERE g.account_id=a.id AND a.email=$1 AND permission_id='intake_records' AND faculty='exercise' RETURNING g.id",[recipientEmail])).rows;
      assert.equal(changed.length,1);
      const response=await call('/api/intake/operations/lookup',{body:{profile:'intake/1',by:'operation',operation_id:received.operation_id}});
      const rows=(await env.admin.query('SELECT id,effect_id FROM intake_trial.receipt')).rows;
      assert.deepEqual({status:response.status,receipts:rows.length,effect:rows[0].effect_id},{status:404,receipts:1,effect:received.effect.id});
      assert.doesNotMatch(JSON.stringify(response.body),new RegExp(received.effect.id));
      await page.reload();assert.equal(leakedCookies,0);assert.equal(await page.locator('#state').textContent(),'Ready');
      steps.push({step:'query-withdrawn',status:404,historyPreserved:true,uiCookieLeaks:leakedCookies});
    });
  }finally{
    setBarrier(async()=>{});
    writeFileSync('/work/output/browser-reception.json',JSON.stringify({profile:'intake-browser-observation/1',steps,events,observations,
      scope:'Actual Chromium and HTTPS/SQL/private-storage producers; test-only HTML driver, no T05 interface or full temporal conformity'},null,2));
    await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
  }
}
