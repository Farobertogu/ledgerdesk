import assert from 'node:assert/strict';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {uiOrigin,apiOrigin,recipientEmail,password} from '../../access/journey_environment.mjs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';

/** Actual Chromium closes after actual HTTPS receipt. Closing is not logout. */
export async function extractionBrowserDisconnectCases(t,{env,intake,client,request}){
  await extractionControl(env);const observations=[];let browser;
  const server=https.createServer(env.tls,(req,res)=>{
    res.writeHead(200,{'content-type':'text/html','cache-control':'no-store',
      'content-security-policy':"default-src 'none'; connect-src "+apiOrigin});
    res.end('<!doctype html><html lang="en"><title>Extraction test driver</title><h1>Synthetic extraction test driver</h1></html>');
  });
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8443,'127.0.0.1',resolve);});
    await env.admin.query(`INSERT INTO intake_control.processing_declaration SELECT 'text-origin-session-1',1,$1,format,configuration,limits,
      request,plan,assignment,worker,executor_account,executor_reference,scope_ref,purpose_ref,'origin_session',image,expires_at
      FROM intake_control.processing_declaration WHERE id='text-extraction-1'`,['c'.repeat(64)]);
    for(const mode of ['origin_session','independent_of_origin_session']){
      t.signal.throwIfAborted();
      await t.test('DISCONNECT '+mode+' preserves the received work but not withdrawn independent faculty',async()=>{
        try{
        await env.admin.query("SELECT intake_control.set_processing('text-utf8/1',$1,1,$2,true)",
          mode==='origin_session'?['text-origin-session-1','c'.repeat(64)]:['text-extraction-1','b'.repeat(64)]);
        browser=await chromium.launch({args:['--host-resolver-rules=MAP *.inc02.test 127.0.0.1','--no-proxy-server']});
        const context=await browser.newContext(),page=await context.newPage();
        assert.equal((await page.goto(uiOrigin)).status(),200);
        const call=(path,{body,bytes,key}={})=>page.evaluate(async({api,path,body,bytes,key})=>{
          const payload=bytes?new Uint8Array(bytes):body===undefined?undefined:JSON.stringify(body);
          const r=await fetch(api+path,{method:payload===undefined?'GET':'POST',credentials:'include',cache:'no-store',redirect:'error',
            headers:payload===undefined?{}:{'content-type':bytes?'application/octet-stream':'application/json',
              'x-ledgerdesk-csrf':window.testCsrf,...(key?{'x-ledgerdesk-intent':key}:{})},body:payload});
          const value=await r.json();if(value.csrf_token)window.testCsrf=value.csrf_token;return{status:r.status,body:value};
        },{api:apiOrigin,path,body,bytes:bytes?Array.from(bytes):undefined,key});
        assert.equal((await call('/api/access/v1/reception')).status,200);
        const login=await call('/api/access/v1/sessions',{body:{email:recipientEmail,password},key:randomUUID()});
        assert.deepEqual(login.status,200,JSON.stringify(login.body));
        const text='Browser loss is not loss of processing authority.\n';
        const received=await receivedOriginal(call,null,Buffer.from(text));
        const session=(await env.admin.query('SELECT s.* FROM access_trial.session s JOIN intake_trial.reception r ON r.origin_session=s.digest WHERE r.id=$1',[received.reception_id])).rows[0];
        assert.ok(session&&!session.revoked);
        let disconnected=false;browser.once('disconnected',()=>{disconnected=true;});await browser.close();browser=null;
        assert.equal(disconnected,true);
        assert.deepEqual((await env.admin.query('SELECT * FROM access_trial.session WHERE digest=$1',[session.digest])).rows[0],session);
        const rows=(await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE permission_id='intake_processing' AND faculty='exercise' RETURNING id")).rows;
        assert.equal(rows.length,1);const service=new ExtractionService(intake);
        const reads=async()=>(await administration('observe-extraction',{participant:'objects'})).events.filter(e=>e.kind==='read'&&e.artifactId===received.original.id).length;
        const before=await reads();let after;
        try{
          await assert.rejects(service.dispatch(received.work.id),/INTAKE_404/);after=await reads();
          assert.deepEqual({reads:after,attempts:(await env.admin.query('SELECT count(*)::int n FROM intake_trial.extraction_attempt WHERE job_id=$1',[received.work.id])).rows[0].n},{reads:before,attempts:0});
        }finally{await env.admin.query('UPDATE access_trial.grant_record SET withdrawn=false WHERE id=$1',[rows[0].id]);}
        await service.dispatch(received.work.id);const effect=await service.accept(received.work.id);
        const q=await request('/api/intake/extractions/'+received.work.id,{client});
        assert.deepEqual({status:q.status,result:q.body.result?.id,text:q.body.result?.content.elements.map(e=>e.text).join('')},
          {status:200,result:effect.resultId,text});
        observations.push({mode,disconnected,originSessionRevoked:false,original:received.original,job:received.work.id,deniedReadCount:after-before,effect});
        }finally{await browser?.close();browser=null;}
      });
    }
  }finally{
    await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    writeFileSync('/work/output/extraction-browser-disconnect.json',JSON.stringify({observations,
      scope:'Actual browser-owned session, receipt and physical browser shutdown; both declared modes and independent faculty withdrawal. Session revocation remains a separate previously specified case; no tab synchronization or T05 UI claim.'},null,2),{flag:'wx'});
  }
}
