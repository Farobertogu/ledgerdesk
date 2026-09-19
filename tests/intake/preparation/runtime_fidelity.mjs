import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync,unlinkSync,mkdtempSync} from 'node:fs';
import {PREPARATION_DOCUMENT} from '../../../src/contracts/intake_preparation.ts';
import {REFERENCES} from './references/cases.mjs';
import {preparationContext} from './runtime_control.mjs';

const profile={profile:'intake/1',representation:'intake-preparation/1'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const axis=value=>({value,reason:null});
// Construct expected changes from fixed source literals and ranges, not readback.
function baseDocument(){
  const lines=REFERENCES['F-T'].lines.filter(l=>['rule','exception'].includes(l.role));
  return {profile:'preparation-document/1',transformation:'exact_selection',
    elements:lines.map(l=>({id:l.role,kind:'text',text:REFERENCES['F-P'][l.role],
      antecedents:[{input_id:'base:source',kind:'bytes',coordinates:'original:'+l.bytes.join('..'),byte_range:l.bytes,code_point_range:l.code_points}]})),
    relations:[{id:'base:rule-condition',...REFERENCES['F-P'].relation,origin:'prepared'}],
    conditions:[{id:'base:condition-Z',text:'Under condition Z, receipt R replaces receipt Q.',scope:'AZ-17'}],
    units:[{id:'AZ17',elements:['rule','exception'],conditions:['base:condition-Z'],inseparable_group:null,
      classification:{function:axis('normative'),basis:axis('domain_adoption'),scope:axis('reusable_with_conditions')},
      examination:{outcome:'classifiable',reason:'An explicitly preserved independent synthetic item.'},
      coverage:{components:['base:source:extraction'],complete_source_claim:false,reason:'The selected item does not claim the entire source.'}}],differences:[]};
}

export async function preparationFidelityCases(t,{env,call,check,prepared,counts,storage,record}){
  const first=prepared.result.preparation,initialCounts=await counts();
  const original=(await env.admin.query('SELECT payload FROM intake_trial.preparation WHERE id=$1 AND revision=$2',[first.id,first.revision])).rows[0].payload;
  const bodyReads=()=>storage.filter(e=>e.origin==='prepared-record-boundary').length;
  let reordered,synthesized;
  async function create(document,expectedStatus=200){
    assert.equal(PREPARATION_DOCUMENT(document),true,'The directed input must reach construction beyond public document validation.');
    const bytes=Buffer.from(JSON.stringify(document));
    const reservation={...profile,inputs:[{id:'base',kind:'preparation',reference:first}],base:first,
      selection:['rule','exception'].map(id=>({input_id:'base',element_id:id,local_id:id})),
      document:{bytes:bytes.length,sha256:hash(bytes)},context:preparationContext};
    const saved=await call('/preparation-attempts',{body:reservation,key:randomUUID()});check(saved,202);
    const attempt=saved.body.result,staged=await call(`/preparation-attempts/${attempt.attempt_id}/content`,{bytes});check(staged,200);
    const before=(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.preparation')).rows[0].n;
    const finalized=await call(`/preparation-attempts/${attempt.attempt_id}/finalize`,{key:randomUUID(),body:{...profile,
      expected_revision:attempt.preparation.revision,document:staged.body.result.document,differences:[]}});
    const after=(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.preparation')).rows[0].n;
    assert.deepEqual({status:finalized.status,preparations:after-before,counts:await counts()},
      {status:expectedStatus,preparations:expectedStatus===200?1:0,counts:initialCounts},JSON.stringify(finalized.body));
    if(expectedStatus!==200)return null;
    const target=finalized.body.result.preparation;
    const query=await call(`/preparations/${target.id}/revisions/${target.revision}`);check(query,200);
    return {reference:target,record:query.body.preparation};
  }
  await t.test('H01 independently declared reorder persists a fresh revision and exactly paired attributable difference',async()=>{
    const doc=baseDocument();doc.transformation='correction';doc.elements.reverse();
    doc.differences=[{before:['base'],method:'correction',transformation:'cleanup',reason:'Place the explicit exception before its rule without detaching their context.',
      affected:[{kind:'element',id:'rule'},{kind:'element',id:'exception'}]}];
    reordered=await create(doc);
    assert.deepEqual({elements:reordered.record.payload.elements.map(e=>[e.id,e.text]),relations:reordered.record.payload.relations,
      conditions:reordered.record.payload.conditions,counts:await counts()},
      {elements:[['exception',REFERENCES['F-P'].exception],['rule',REFERENCES['F-P'].rule]],relations:doc.relations,
        conditions:doc.conditions,counts:initialCounts},'The persisted preparation must retain the independently selected condition and dependency.');
    const difference=reordered.record.differences[0],queried=await call('/differences/'+difference.reference.id);check(queried,200);
    assert.deepEqual(queried.body,{...profile,preparation:reordered.reference,difference});
    assert.deepEqual(difference.body.before.map(x=>x.input),[first]);
    assert.deepEqual(difference.body.after,{id:reordered.reference.id,revision:reordered.reference.revision,payload:reordered.record.descriptor.payload});
    assert.equal(difference.body.transformation,'cleanup');assert.ok(difference.body.actor);assert.ok(difference.body.recorded_at>0);
    assert.deepEqual((await env.admin.query('SELECT payload FROM intake_trial.preparation WHERE id=$1 AND revision=$2',[first.id,first.revision])).rows[0].payload,original);
    record('reordered-preparation',{reference:reordered.reference,difference:difference.reference,bytes:reordered.record.descriptor.payload.bytes});
  });
  if(!reordered)throw Error('FIDELITY_REORDER_PREREQUISITE');
  await t.test('H02 coherent rehash cannot pass an undeclared text substitution; dependency omission is independently rejected',async()=>{
    const altered=baseDocument();altered.elements[1].text='Under condition Z, receipt S replaces receipt Q.';
    await create(altered,409);
    const removed=baseDocument();removed.elements.pop();removed.relations=[];removed.units[0].elements=['rule'];
    await create(removed,409);
    const reorder=baseDocument();reorder.elements.reverse();await create(reorder,409);
  });
  await t.test('H03 legitimate nonliteral redaction preserves both antecedents, the condition and the original revision',async()=>{
    const doc=baseDocument(),antecedents=doc.elements.flatMap(e=>e.antecedents.map(a=>({...a,kind:'nonliteral'})));
    doc.transformation='synthesis';doc.transformations=[{from:'rule',to:'authored'},{from:'exception',to:'authored'}];
    doc.elements=[{id:'authored',kind:'text',text:REFERENCES['F-P'].redaction,antecedents}];
    doc.relations[0]={...doc.relations[0],from:'authored',to:'authored'};doc.units[0].elements=['authored'];
    doc.differences=[{before:['base'],method:'synthesis',transformation:'redaction',reason:'Restate both selected statements without claiming a literal original location.',
      affected:[{kind:'element',id:'rule'},{kind:'element',id:'exception'},{kind:'element',id:'authored'},{kind:'relation',id:'base:rule-condition'}]}];
    synthesized=await create(doc);
    assert.deepEqual({text:synthesized.record.payload.elements[0].text,antecedents:synthesized.record.payload.elements[0].antecedents,
      conditions:synthesized.record.payload.conditions,relations:synthesized.record.payload.relations},
      {text:REFERENCES['F-P'].redaction,antecedents,conditions:doc.conditions,relations:doc.relations});
    assert.equal(synthesized.record.differences[0].body.transformation,'redaction');
    assert.deepEqual(await counts(),initialCounts);
    const old=await call(`/preparations/${first.id}/revisions/${first.revision}`);check(old,200);
    assert.deepEqual(old.body.preparation.payload.elements.map(e=>e.text),[REFERENCES['F-P'].rule,REFERENCES['F-P'].exception]);
    record('authored-preparation',{reference:synthesized.reference,difference:synthesized.record.differences[0].reference});
  });
  await t.test('H04 difference admission applies before materializing its body, including embedded preparation differences',async()=>{
    const before=bodyReads(),difference=reordered.record.differences[0].reference;
    await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE permission_id='intake_difference_read' AND faculty='exercise'");
    try{
      // Withdraw the real invited difference faculty, leaving preparation consultation.
      const explicit=await call('/differences/'+difference.id),embedded=await call(`/preparations/${reordered.reference.id}/revisions/${reordered.reference.revision}`);
      assert.deepEqual({explicit:explicit.status,embedded:embedded.status,reads:bodyReads()},
        {explicit:404,embedded:404,reads:before});
    }finally{await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE permission_id='intake_difference_read' AND faculty='exercise'");}
    const positive=await call('/differences/'+difference.id);check(positive,200);assert.ok(bodyReads()>before);
  });
  await t.test('H05 intact unrelated and stale difference pairs are refused at persistence and consumption after valid admission',async()=>{
    const other=synthesized.record.differences[0],expectedBefore=reordered.record.differences[0].body.before;
    const wrongRecords=[],directory=mkdtempSync('/work/output/difference-input-'),control='/work/output/t04-difference-input.json';
    function configure(kind,phase){
      const observation=directory+'/'+kind+'-'+phase+'.json';
      writeFileSync(control,JSON.stringify({kind,phase,other,target:reordered.reference,observation,
        before:{input:synthesized.reference,payload:synthesized.record.descriptor.payload}}),{flag:'wx'});
      return ()=>{const actual=JSON.parse(readFileSync(observation,'utf8'));
        assert.equal(actual.representationValid,true);assert.notEqual(actual.pid,process.pid,'Injection must execute in the actual application process.');
        wrongRecords.push(actual);};
    }
    for(const kind of ['other-pair','stale-before']){
      const persisted=configure(kind,'persist');
      try{
        const doc=baseDocument();doc.transformation='correction';doc.elements.reverse();
        doc.differences=[{before:['base'],method:'correction',transformation:'cleanup',reason:'An independently repeated legitimate reorder.',
          affected:[{kind:'element',id:'rule'},{kind:'element',id:'exception'}]}];
        await create(doc,503);
      }finally{unlinkSync(control);}
      persisted();
      const consumed=configure(kind,'consume');
      try{
        const result=await call(`/preparations/${reordered.reference.id}/revisions/${reordered.reference.revision}`);
        assert.deepEqual({status:result.status,counts:await counts()},{status:503,counts:initialCounts});
      }finally{unlinkSync(control);}
      consumed();
      for(const valid of [reordered,synthesized]){
        const result=await call('/differences/'+valid.record.differences[0].reference.id);check(result,200);
        assert.deepEqual(result.body.difference,valid.record.differences[0]);
      }
    }
    assert.deepEqual(reordered.record.differences[0].body.before,expectedBefore);
    record('difference-association-negatives',{observations:wrongRecords,
      scope:'Structurally valid internal values at actual persistence and admitted consumption; no universal construction-correctness claim.'});
  });
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE permission_id='intake_constitute'");
  const propose=async prepared=>{
    const r=prepared.reference,result=await call(`/preparations/${r.id}/revisions/${r.revision}/proposals`,{key:randomUUID(),body:{...profile,unit:'AZ17',
      target:{kind:'new',declaration:'Explicit exact retained revision, not the latest preparation.'},
      judgment:{kind:'distinct',reason:'Synthetic per-revision confirmation.'}}});check(result,200);return result.body;
  };
  const oldProposal=await propose(reordered),newProposal=await propose(synthesized);
  const confirm=p=>call('/constitutions',{key:randomUUID(),body:{...profile,proposal:p.result.proposal,mode:'person'}});
  await t.test('H06 coherently altered resolver values reach the actual builder but cannot replace the inspected item',async()=>{
    const control='/work/output/t04-resolver-input.json',directory=mkdtempSync('/work/output/resolver-input-'),before=await counts(),reads=bodyReads();
    for(const kind of ['replace-text','drop-context']){
      const observation=directory+'/'+kind+'.json';
      writeFileSync(control,JSON.stringify({phase:'resolved',kind,target:reordered.reference,observation}),{flag:'wx'});
      let result;try{result=await confirm(oldProposal);}finally{unlinkSync(control);}
      const injected=JSON.parse(readFileSync(observation,'utf8'));
      assert.deepEqual({status:result.status,counts:await counts(),integrity:injected.integrityValid,internal:injected.pid!==process.pid},
        {status:409,counts:before,integrity:true,internal:true});
      assert.notDeepEqual(injected.substituted,injected.original);assert.ok(bodyReads()>reads);
      const unchanged=await call(`/preparations/${reordered.reference.id}/revisions/${reordered.reference.revision}`);check(unchanged,200);
      assert.deepEqual(unchanged.body.preparation.payload.elements.map(e=>[e.id,e.text]),
        [['exception',REFERENCES['F-P'].exception],['rule',REFERENCES['F-P'].rule]]);
      assert.deepEqual(unchanged.body.preparation.payload.relations,reordered.record.payload.relations);
      record('internal-resolver-rejection',{injected,status:result.status,counts:before,
        limit:'Known exact inspection mismatch, not universal semantic omission detection.'});
    }
  });
  await t.test('H07 corrupted retained bytes fail after read admission without becoming an altered candidate',async()=>{
    const control='/work/output/t04-resolver-input.json',observation=mkdtempSync('/work/output/corruption-')+'/observed.json',before=await counts();
    writeFileSync(control,JSON.stringify({phase:'storage',target:reordered.reference,observation}),{flag:'wx'});
    let reply;try{reply=await confirm(oldProposal);}finally{unlinkSync(control);}
    const observed=JSON.parse(readFileSync(observation,'utf8'));
    assert.deepEqual({status:reply.status,counts:await counts(),internal:observed.pid!==process.pid},{status:503,counts:before,internal:true});
    record('retained-byte-corruption',{observed,status:reply.status,counts:before});
  });
  await t.test('H08 an older still-admissible revision and the newer revision each constitute exactly what was inspected',async()=>{
    const before=await counts(),oldResult=await confirm(oldProposal),newResult=await confirm(newProposal);check(oldResult,200);check(newResult,200);
    const after=await counts(),saved=(await env.admin.query(`SELECT c.preparation_revision,c.editorial_state,p.payload,c.conditions
      FROM intake_trial.candidate c JOIN intake_trial.preparation p ON p.id=c.preparation_id AND p.revision=c.preparation_revision
      WHERE c.unit_id=ANY($1::uuid[]) ORDER BY c.preparation_revision`,[[oldResult.body.result.candidates[0].id,newResult.body.result.candidates[0].id]])).rows;
    assert.deepEqual({effects:after.effects-before.effects,candidates:after.candidates-before.candidates,
      rows:saved.map(r=>({revision:r.preparation_revision,state:r.editorial_state,text:JSON.parse(r.payload.toString()).elements.map(e=>e.text),conditions:r.conditions}))},
      {effects:2,candidates:2,rows:[{revision:reordered.reference.revision,state:'candidate',text:[REFERENCES['F-P'].exception,REFERENCES['F-P'].rule],conditions:reordered.record.payload.conditions},
        {revision:synthesized.reference.revision,state:'candidate',text:[REFERENCES['F-P'].redaction],conditions:synthesized.record.payload.conditions}]});
    record('exact-older-newer-confirmation',{older:reordered.reference,newer:synthesized.reference,oldEffect:oldResult.body.effect,newEffect:newResult.body.effect,counts:after});
  });
}
