import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';

export async function extractionContainmentCases(t,{env,intake,client,request}){
  await extractionControl(env);const observations=[];
  try{for(const [name,text]of [['positive','A useful bounded extraction.\n'],['denied-access','T03 containment probes\n'],['timeout','T03 bounded nontermination\n']]){
    t.signal.throwIfAborted();
    await t.test('CONTAIN '+name+' uses the actual fixed launcher and retained closed process',async()=>{
      const receipt=await receivedOriginal(request,client,Buffer.from(text)),service=new ExtractionService(intake);
      const call=service.extraction.call.bind(service.extraction);let probe;
      service.extraction.call=async command=>{
        const reply=await call(command);
        if(command.action==='read'&&reply.ok&&name==='denied-access')probe=JSON.parse(Buffer.from(reply.data,'base64')).outcome.observation.raw.containment;
        return reply;
      };
      const dispatched=await service.dispatch(receipt.work.id);
      assert.equal(dispatched.metadata.reason,name==='timeout'?'worker_timeout':null);
      assert.ok(dispatched.metadata.observations.some(e=>e.kind==='running'&&e.pid>0));
      const closed=dispatched.metadata.observations.find(e=>e.kind==='closed');assert.ok(closed);assert.equal(closed.state.Running,false);
      assert.ok(dispatched.metadata.observations.some(e=>e.kind==='cleaned'));
      const effect=await service.accept(receipt.work.id),q=await request('/api/intake/extractions/'+receipt.work.id,{client});
      assert.equal(q.status,200);assert.equal(q.body.result.id,effect.resultId);
      if(name==='timeout'){
        assert.equal(q.body.result.content.outcome,'failed');assert.equal(q.body.result.content.incidents[0].code,'worker_timeout');
        assert.equal(q.body.result.content.inventory,'unknown');
      }else assert.equal(q.body.result.content.elements.map(e=>e.text).join(''),text);
      if(name==='denied-access'){
        assert.deepEqual({file:probe?.file,write:probe?.write,subprocess:probe?.subprocess,positiveOriginalBytes:probe?.positiveOriginalBytes},
          {file:'ERR_ACCESS_DENIED',write:'ERR_ACCESS_DENIED',subprocess:'ERR_ACCESS_DENIED',positiveOriginalBytes:Buffer.byteLength(text)});
        assert.ok(['ENETUNREACH','EHOSTUNREACH'].includes(probe.network),JSON.stringify(probe));
      }
      observations.push({name,job:receipt.work.id,probe,metadata:dispatched.metadata,effect});
    });
  }}finally{writeFileSync('/work/output/extraction-containment.json',JSON.stringify({observations,
    scope:'Actual fixed launcher, strict original read, denied filesystem and child-process operations, unroutable benchmark network address, and supervised nontermination in an identified copy. Timeout termination is not memory exhaustion. No claim of hostile-code universal isolation.'},null,2),{flag:'wx'});}
}
