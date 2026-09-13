import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from 'pg';
import {treatment} from './fixtures.mjs';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),5000);})]);}finally{clearTimeout(timer);}}
async function until(read,accept,label){const end=Date.now()+3000;let value;do{value=await read();if(accept(value))return value;await delay(10);}while(Date.now()<end);assert.fail(label+': '+JSON.stringify(value));}

/** The actual transport INSERT fails in PostgreSQL, after the real terminal end. */
export async function observationFailureCases(t,{env,client,request,requestEvents,clientCalls,diagnostics,admissions,failureReceiver,fallbackDiagnostics,flush,setBarrier}){
  const output='/work/output/transport-observation';mkdirSync(output,{recursive:true});const results=[];
  const bytes=Buffer.from('efbbbf496e666f726d616369c3b36e0d0a','hex');
  const declaration={profile:'intake/1',original:{name:'bom.txt',bytes:17,sha256:'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9',declared_media_type:'text/plain'},
    format_profile:'text-utf8/1',receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}};
  writeFileSync(output+'/reference.json',JSON.stringify({declaration,positive:{status:200,bytes:17,transportRows:1},
    failure:{status:200,bytes:17,transportRows:0,sqlState:'P0001',expectedSignalRecipient:'parent test process via existing failure hook'},
    receiverVariants:['configured','absent','throws'],fallbackRecipient:'parent process reading application stderr',
    irreversiblePoint:'terminal end, not final browser receipt',fixedAtMs:Date.now()},null,2),{flag:'wx'});
  const r=await request('/api/intake/receptions',{client,key:randomUUID(),body:declaration});assert.equal(r.status,202);
  const s=await request(`/api/intake/receptions/${r.body.reception_id}/attempts/1/original`,{client,bytes});assert.equal(s.status,200);
  const receipt=await request(`/api/intake/receptions/${r.body.reception_id}/finalize`,{client,key:randomUUID(),body:{profile:'intake/1',expected_revision:s.body.revision,original:s.body.original,format_profile:'text-utf8/1'}});assert.equal(receipt.status,200);
  const id=r.body.reception_id,path=`/api/intake/receptions/${id}/original`;
  const effects=async()=>({receipt:(await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows,
    work:(await env.admin.query('SELECT w.* FROM intake_trial.work w JOIN intake_trial.receipt r ON r.id=w.receipt_id WHERE r.reception_id=$1',[id])).rows});
  for(const [fail,mode] of [[false,'configured'],[true,'configured'],[true,'absent'],[true,'throws']])await t.test('post-handoff transport observation '+(fail?'failure reports and releases without a new effect, receiver '+mode:'positive persists before release'),async()=>{
    const reached=deferred(),release=deferred(),marker='T02_TRANSPORT_PROBE_'+randomUUID().replaceAll('-','');
    const starts={events:requestEvents.length,calls:clientCalls.length,diagnostics:diagnostics.length,admissions:admissions.length,fallback:fallbackDiagnostics.length};
    const beforeEffects=await effects();let writer,writerResult,paused,observation={fail,mode,marker,starts,beforeEffects};
    let pending;
    try{
      await failureReceiver(mode);
      setBarrier(async(label,event)=>{if(label==='before_handoff'&&event.route==='original'){paused=event;reached.resolve();await bounded(release.promise,'OBSERVATION_HANDOFF_RELEASE');}});
      pending=request(path,{client,label:'observation-failure'}).catch(error=>({status:null,errorCode:error.code??null,bytes:Buffer.alloc(0)}));
      await bounded(reached.promise,'OBSERVATION_HANDOFF_NOT_REACHED');
      const evidence=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[paused.evidenceId])).rows;
      const sql=(await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1',[paused.backendPid])).rows;
      const transportBefore=(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[paused.evidenceId])).rows;
      assert.equal(evidence.length,1);assert.equal(evidence[0].route,'original');assert.equal(evidence[0].status,200);
      assert.deepEqual(sql,[{state:'idle',xact_start:null}]);assert.deepEqual(transportBefore,[]);
      assert.match(paused.evidenceId,/^[a-f0-9-]{36}$/);
      await env.admin.query(`CREATE OR REPLACE FUNCTION pg_temp.transport_probe() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE LOG '${marker} evidence=% outcome=% bytes=% pid=%',NEW.evidence_id,NEW.outcome,NEW.bytes,pg_backend_pid();
        ${fail?"RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='synthetic-secret-not-for-diagnostics';":"RETURN NEW;"} END $$;
        CREATE TRIGGER transport_probe BEFORE INSERT ON intake_trial.transport FOR EACH ROW
        WHEN(NEW.evidence_id='${paused.evidenceId}') EXECUTE FUNCTION pg_temp.transport_probe();`);
      writer=new Client({...env.admin.connectionParameters,statement_timeout:4500,lock_timeout:4000});await writer.connect();
      const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      writerResult=writer.query('SELECT intake_control.set_treatment($1,$2,true)',[treatment.id,treatment.revision]);writerResult.catch(()=>{});
      const wait=await until(async()=>(await env.admin.query('SELECT wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0],v=>v?.wait_event==='advisory'&&v.blockers.includes(paused.backendPid),'OBSERVATION_WRITER_NOT_BLOCKED');
      const noNetwork=clientCalls.slice(starts.calls).filter(c=>c.path===path).reduce((n,c)=>n+c.receivedBytes,0);assert.equal(noNetwork,0);
      observation={...observation,paused,evidence,sql,transportBefore,writer:{pid,wait},noNetwork};
      release.resolve();const reply=await bounded(pending,'OBSERVATION_CLIENT_UNRESOLVED');await bounded(writerResult,'OBSERVATION_ADMISSION_NOT_RELEASED');
      await until(async()=>(await env.admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1',[paused.backendPid])).rows[0].n,n=>n===0,'OBSERVATION_BACKEND_NOT_CLOSED');await flush();
      const transport=(await env.admin.query('SELECT * FROM intake_trial.transport WHERE evidence_id=$1',[paused.evidenceId])).rows;
      const retainedEvidence=(await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1',[paused.evidenceId])).rows;
      const log=env.postgresLog().split('\n').filter(l=>l.includes(marker)&&l.includes('LOG:'));
      const events=requestEvents.slice(starts.events),signals=diagnostics.slice(starts.diagnostics),fallback=fallbackDiagnostics.slice(starts.fallback),afterEffects=await effects();
      const ended=events.filter(e=>e.kind==='terminal-end'),destroyed=events.filter(e=>e.kind==='terminal-destroy'&&e.fromIntakeTerminal);
      observation={...observation,reply:{status:reply.status,bytes:reply.bytes.length,hex:reply.bytes.toString('hex')},transport,retainedEvidence,log,signals,fallback,ended,destroyed,
        admissions:admissions.slice(starts.admissions),afterEffects,backendGone:true};
      assert.deepEqual({status:reply.status,bytes:reply.bytes,transportRows:transport.length},{status:200,bytes,transportRows:fail?0:1});
      assert.equal(log.length,1);assert.ok(log[0].includes(paused.evidenceId)&&log[0].includes('outcome=handed_off bytes=17'));
      assert.deepEqual(retainedEvidence,evidence);assert.deepEqual(afterEffects,beforeEffects);assert.equal(ended.length,1);assert.equal(ended[0].bytes,17);
      assert.equal(signals.length,fail&&mode==='configured'?1:0);
      assert.equal(fallback.length,fail&&mode!=='configured'?1:0,'A missing or failing receiver must not silently lose the observation failure');
      if(fail){
        const signal=signals[0]??fallback[0].event;
        assert.deepEqual({code:signal.code,phase:signal.phase,evidenceId:signal.evidenceId,outcome:signal.outcome,bytes:signal.bytes,responseStatus:signal.responseStatus},
          {code:'P0001',phase:'transport_observation',evidenceId:paused.evidenceId,outcome:'handed_off',bytes:17,responseStatus:200});
      }
      assert.equal(destroyed.length,0,'An observation failure must not re-enter the response-error path after handoff');
      assert.doesNotMatch(JSON.stringify({signals,fallback}),/synthetic-secret-not-for-diagnostics|synthetic-receiver-secret|password|cookie|csrf|authorization/i);
      await env.admin.query('DROP TRIGGER transport_probe ON intake_trial.transport');
      setBarrier(async()=>{});const following=await request(path,{client});assert.deepEqual({status:following.status,bytes:following.bytes},{status:200,bytes});
      assert.deepEqual(await effects(),beforeEffects);observation.following={status:following.status,bytes:following.bytes.length};
    }finally{
      release.resolve();setBarrier(async()=>{});await pending?.catch(()=>{});await writerResult?.catch(()=>{});await writer?.end();await failureReceiver('configured');
      await env.admin.query('DROP TRIGGER IF EXISTS transport_probe ON intake_trial.transport');
      results.push(observation);writeFileSync(output+'/observations.json',JSON.stringify(results,null,2));
    }
  });
}
