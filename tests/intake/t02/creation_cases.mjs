import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {administration} from './recovery_cases.mjs';
import {treatment} from './fixtures.mjs';

export async function creationCases(t,{env,client,request,storage,incomplete}){
  const rows=[],text=readFileSync(new URL('../t01/fixtures/table.csv',import.meta.url));
  const reserve=async bytes=>{
    const r=await request('/api/intake/receptions',{client,key:randomUUID(),body:{profile:'intake/1',
      original:{name:bytes.length?'table.csv':'empty.txt',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
        declared_media_type:bytes.length?'text/csv':'text/plain'},format_profile:bytes.length?'csv-utf8/1':'text-utf8/1',
      receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatment}}});
    assert.equal(r.status,202);return r.body;
  };
  const upload=(r,bytes,generation=1)=>request(`/api/intake/receptions/${r.reception_id}/attempts/${generation}/original`,{client,bytes});
  const snapshot=async id=>({reception:(await env.admin.query('SELECT * FROM intake_trial.reception WHERE id=$1',[id])).rows[0],
    attempts:(await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation',[id])).rows,
    receipts:(await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1',[id])).rows,
    jobs:(await env.admin.query('SELECT w.* FROM intake_trial.work w JOIN intake_trial.receipt r ON r.id=w.receipt_id WHERE r.reception_id=$1',[id])).rows});
  const resume=(r,state)=>request(`/api/intake/receptions/${r.reception_id}/resume`,{client,key:randomUUID(),body:{profile:'intake/1',
    expected_revision:state.reception.revision,expected_generation:1,cause:'interrupted',original:r.original}});
  const finish=async(r,bytes,staged)=>{
    const done=await request(`/api/intake/receptions/${r.reception_id}/finalize`,{client,key:randomUUID(),body:{profile:'intake/1',
      expected_revision:staged.body.revision,original:staged.body.original,format_profile:bytes.length?'csv-utf8/1':'text-utf8/1'}});
    const served=await request(`/api/intake/receptions/${r.reception_id}/original`,{client}),state=await snapshot(r.reception_id);
    assert.deepEqual({status:done.status,read:served.status,bytes:served.bytes,receipts:state.receipts.length,jobs:state.jobs.length},
      {status:200,read:200,bytes,receipts:1,jobs:1});return state;
  };
  try{
    for(const bytes of [text,Buffer.alloc(0)]){
      await t.test(`CREATE positive exact original ${bytes.length?'nonempty':'empty'}`,async()=>{
        const r=await reserve(bytes),staged=await upload(r,bytes);assert.equal(staged.status,200);
        rows.push({case:'positive',bytes:bytes.length,state:await finish(r,bytes,staged)});
      });
      for(const mode of ['failed','denied'])await t.test(`CREATE ${mode} ${bytes.length?'nonempty':'empty'} retains state and recovers by a new identity`,async()=>{
        const r=await reserve(bytes);await administration('arm-create-fault',{artifactId:r.original.id,generation:1,mode});
        const response=await upload(r,bytes),before=await snapshot(r.reception_id),physical=await administration('inspect',{});
        const observed=storage.filter(e=>e.artifactId===r.original.id),closure=observed.find(e=>e.kind==='create-closure');
        assert.deepEqual({status:response.status,state:before.reception.state,receipts:before.receipts.length,jobs:before.jobs.length,
          outcome:closure?.outcome,closure:closure?.closure,unresolved:incomplete.find(e=>e.receptionId===r.reception_id)?.unresolved},
          {status:mode==='failed'?503:409,state:'interrupted',receipts:0,jobs:0,outcome:mode,closure:'acknowledged-retired-current',unresolved:false});
        assert.ok(physical.source.includes(r.original.id+'-1.'+(mode==='failed'?'json':'fenced')));
        assert.ok(!physical.source.includes(r.original.id+'-1.stage'));
        const phase=(await env.admin.query('SELECT c.kind FROM intake_control.phase_completion c WHERE phase_id=$1',[closure.phaseId])).rows[0];
        assert.equal(phase.kind,'participants_closed');
        const resumed=await resume(r,before);assert.equal(resumed.status,202);
        assert.notEqual(resumed.body.original.id,r.original.id);assert.equal(resumed.body.original.generation,2);
        assert.equal((await upload(r,bytes,1)).status,409);
        const staged=await upload(r,bytes,2);assert.equal(staged.status,200);
        const after=await finish(r,bytes,staged),retained=await administration('inspect',{});
        assert.deepEqual(after.attempts.map(a=>[a.generation,a.state]),[[1,'fenced'],[2,'sealed']]);
        assert.ok(retained.source.includes(r.original.id+'-1.fenced'));
        if(mode==='failed')assert.ok(retained.source.includes(r.original.id+'-1.json'));
        rows.push({case:mode,bytes:bytes.length,before,after,physical,retained,observed});
      });
    }
    await t.test('CREATE unconfirmed participant closure remains unresolved and cannot resume',async()=>{
      const r=await reserve(text);await administration('arm-create-fault',{artifactId:r.original.id,generation:1,mode:'unclosed'});
      const response=await upload(r,text),before=await snapshot(r.reception_id),retry=await resume(r,before),after=await snapshot(r.reception_id);
      const closure=storage.find(e=>e.artifactId===r.original.id&&e.kind==='create-closure');
      assert.deepEqual({status:response.status,state:before.reception.state,receipts:after.receipts.length,jobs:after.jobs.length,
        attempts:after.attempts.length,closure:closure?.closure,unresolved:incomplete.find(e=>e.receptionId===r.reception_id)?.unresolved},
        {status:503,state:'uncertain',receipts:0,jobs:0,attempts:1,closure:'not-confirmed',unresolved:true});
      assert.ok([409,503].includes(retry.status));
      const phase=(await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0];assert.ok(phase.active_phase);
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_control.phase_completion WHERE phase_id=$1',[phase.active_phase])).rows[0].n,0);
      rows.push({case:'unclosed',before,after,retryStatus:retry.status,closure,phase});
    });
  }finally{writeFileSync('/work/output/create-observations.json',JSON.stringify(rows,null,2));}
}
