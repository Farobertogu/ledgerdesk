import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {administration} from '../t02/recovery_cases.mjs';
import {REFERENCES} from './references/cases.mjs';
import {assertResourceAssociation} from './references/assertions.mjs';
import {preparationTreatment,preparationContext} from './runtime_control.mjs';
import {persistDocument,preparationHash as hash,preparationAxis as axis,preparationProfile as profile} from './runtime_helpers.mjs';

export async function preparationResourceCases(t,{env,intake,client,request,call,check,counts,controlled,storage,record,afterPrepared}){
  const directory=await mkdtemp('/work/output/prepared-resources-');
  const references=['az17','az18'].map(key=>REFERENCES['F-R'][key]);
  const resources=references.map(r=>({id:r.artifact,generation:r.generation,bytes:r.bytes,sha256:r.sha256}));
  const files=resources.map(r=>path.join(directory,r.id));
  for(let index=0;index<2;index++){
    await writeFile(files[index],references[index].utf8,{flag:'wx'});
    const actual=await readFile(files[index]);
    assert.deepEqual({bytes:actual.length,sha256:hash(actual)},{bytes:resources[index].bytes,sha256:resources[index].sha256});
  }
  const initialCounts=await counts(),sources={},prepared={};
  const preparedCount=async()=>(await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.preparation')).rows[0].n;
  const resourceReads=()=>storage.filter(e=>e.origin==='prepared-resource-boundary').length;
  async function source(index){
    const choice=index?'B':'A',caption=index?'AZ-18 under condition Z':references[0].caption;
    const receipt=await receivedOriginal(request,client,Buffer.from(caption),{name:'instrumented-'+choice+'.txt',treatmentRevision:preparationTreatment});
    const reference={original:receipt.original,selections:[{element_id:'figure-original',resource:resources[index]}],
      relations:[{id:'figure-caption',from:'figure-original',to:'line-1',role:'indispensable',scope:caption,origin:'proposed'}]};
    // The independent admitted operation exists before its metadata producer.
    await writeFile(path.join(directory,choice+'-operation.json'),JSON.stringify(reference),{flag:'wx'});
    const output=path.join(directory,choice+'-producer.json');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./resource_producer.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
    const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    child.stdin.end(JSON.stringify({original:receipt.original,resources,choice,output}));
    try{assert.equal(await closed,0);}finally{clearTimeout(timer);}
    const produced=JSON.parse(await readFile(output));let bodyReads=0;
    const service=new ExtractionService(intake,{instrumentedResources:{reference,observation:async()=>structuredClone(produced),
      read:async artifact=>{bodyReads++;const at=resources.findIndex(r=>r.id===artifact.id);assert.ok(at>=0);return readFile(files[at]);}}});
    await service.dispatch(receipt.work.id);await service.accept(receipt.work.id);
    const response=await request('/api/intake/extractions/'+receipt.work.id,{client});check(response,200);assert.equal(bodyReads,1);
    return {receipt,result:response.body.result,reference,index,caption};
  }
  function requestFor(source,alternative=null){
    const resource=resources[source.index],caption=source.result.content.elements.find(e=>e.id==='line-1'),figure=source.result.content.elements.find(e=>e.id==='figure-original');
    assert.equal(caption.text,source.caption);assert.deepEqual(figure.resource,resource);
    const document={profile:'preparation-document/1',transformation:'exact_selection',
      elements:[{...figure,id:'figure',antecedents:figure.antecedents.map(a=>({input_id:'source',kind:a.kind,coordinates:a.coordinates}))},
        {id:'caption',kind:'text',text:caption.text,antecedents:[{input_id:'source',kind:'bytes',coordinates:'original:0..'+Buffer.byteLength(source.caption),
          byte_range:[0,Buffer.byteLength(source.caption)],code_point_range:[0,[...source.caption].length]}]}],
      relations:[{id:'source:figure-caption',from:'figure',to:'caption',role:'indispensable',scope:source.caption,origin:'proposed'}],conditions:[],
      units:[{id:source.index?'Resource18':'Resource17',elements:['figure','caption'],conditions:[],inseparable_group:null,
        classification:{function:axis('factual'),basis:axis('non_authoritative_reference'),scope:axis('reusable_with_conditions')},
        examination:{outcome:'classifiable',reason:'Instrumented resource association, not native SVG extraction or visual fidelity.'},
        coverage:{components:['source:extraction'],complete_source_claim:false,reason:'The instrumented resource does not establish semantic source completeness.'}}],differences:[]};
    const inputs=[{id:'source',kind:'extraction',job_id:source.receipt.work.id,reference:source.result.effect}];
    if(alternative)inputs.push({id:'alternative',kind:'extraction',job_id:alternative.receipt.work.id,reference:alternative.result.effect});
    return {document,inputs,selection:[{input_id:'source',element_id:'figure-original',local_id:'figure',local_resource_id:'R-1',resource},
      {input_id:'source',element_id:'line-1',local_id:'caption'}]};
  }
  async function checkResource(result,variant){
    const r=result.reference;
    const query=await call(`/preparations/${r.id}/revisions/${r.revision}/resources/R-1`);check(query,200);
    const resource=query.body;
    assert.equal(resource.encoding,'base64');assert.deepEqual(resource.preparation,r);
    assertResourceAssociation({preparation:r,...result.record.payload,delivered_resources:[{element_id:resource.element_id,
      local_resource_id:resource.local_resource_id,artifact:resource.artifact,utf8:Buffer.from(resource.data,'base64').toString()}]},
      {preparation:r,elements:{figure:'figure',caption:'caption'},resource_id:variant==='az17'?'A-17':'A-18'},variant);
    const observed=storage.filter(e=>e.origin==='prepared-resource-boundary'&&e.preparationId===r.id&&e.revision===r.revision).at(-1);
    assert.ok(observed,'The actual protected body read must expose its prior evidence identifier');
    const receipt=(await env.admin.query(`SELECT e.phase,e.artifact_id,a.local_id,a.resource_id,a.resource_generation
      FROM intake_trial.preparation_resource_read r JOIN intake_trial.evidence e ON e.id=r.evidence_id
      JOIN intake_trial.preparation_resource_association a ON a.preparation_id=r.preparation_id
        AND a.preparation_revision=r.preparation_revision AND a.local_id=r.local_id
      WHERE r.evidence_id=$1`,[observed.evidenceId])).rows;
    assert.deepEqual(receipt,[{phase:'read_admission',artifact_id:null,local_id:'R-1',
      resource_id:variant==='az17'?'A-17':'A-18',resource_generation:variant==='az17'?7:9}]);
    return resource;
  }
  await t.test('R01 a distinct operation legitimately retains and delivers intact A-18/g9 as local R-1',async()=>{
    sources.B=await source(1);prepared.B=await persistDocument({call,check,...requestFor(sources.B)});
    await checkResource(prepared.B,'az18');
    record('prepared-resource-alternative',{reference:prepared.B.reference,resource:resources[1]});
  });
  if(!prepared.B)throw Error('RESOURCE_ALTERNATIVE_PREREQUISITE');
  await t.test('R02 OP-V-17 persists its independently selected A-17/g7 while valid A-18/g9 also exists',async()=>{
    sources.A=await source(0);prepared.A=await persistDocument({call,check,...requestFor(sources.A,sources.B)});
    const saved=(await env.admin.query(`SELECT local_id,element_id,resource_id,resource_generation,resource_bytes,resource_sha256
      FROM intake_trial.preparation_resource_association WHERE preparation_id=$1 AND preparation_revision=$2`,[prepared.A.reference.id,prepared.A.reference.revision])).rows;
    record('resource-birth-observation',{preparation:prepared.A.reference,selected:resources[0],saved});
    assert.deepEqual(saved,[{local_id:'R-1',element_id:'figure',resource_id:'A-17',resource_generation:7,resource_bytes:18,resource_sha256:resources[0].sha256}]);
    const resource=await checkResource(prepared.A,'az17');
    assert.deepEqual(await counts(),initialCounts);
    record('prepared-resource-selection',{reference:prepared.A.reference,resource:resource.artifact,source:sources.A.reference});
  });
  if(!prepared.A)throw Error('RESOURCE_SELECTION_PREREQUISITE');
  if(afterPrepared)await afterPrepared(prepared.A);
  await t.test('R03 an intact wrong staged resource is rejected after public validation before preparation persistence',async()=>{
    const input=requestFor(sources.A,sources.B);input.document.elements[0].resource=resources[1];
    const before=await preparedCount();
    const result=await persistDocument({call,check,...input,expectedStatus:409});
    assert.deepEqual({status:result.rejection.status,preparations:await preparedCount(),counts:await counts()},
      {status:409,preparations:before,counts:initialCounts});
    await checkResource(prepared.A,'az17');await checkResource(prepared.B,'az18');
  });
  await t.test('R04 current resource admission precedes protected source and retained-resource body reads',async()=>{
    const input=requestFor(sources.A),bytes=Buffer.from(JSON.stringify(input.document)),before=resourceReads();
    const normalizedReads=async()=>(await administration('observe-extraction',{participant:'outputs'})).events.filter(e=>e.kind==='protected-normalized-read').length;
    const beforeNormalized=await normalizedReads();
    await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=true WHERE account_id=$1 AND permission_id='intake_resource_read'",[controlled.account.id]);
    try{
      const r=prepared.A.reference,query=await call(`/preparations/${r.id}/revisions/${r.revision}/resources/R-1`);
      const denied=await call('/preparation-attempts',{key:randomUUID(),body:{...profile,inputs:input.inputs,base:null,
        selection:input.selection,document:{bytes:bytes.length,sha256:hash(bytes)},context:preparationContext}});
      assert.deepEqual({resource:query.status,reservation:denied.status,resourcesRead:resourceReads(),normalizedRead:await normalizedReads()},
        {resource:404,reservation:404,resourcesRead:before,normalizedRead:beforeNormalized});
    }finally{await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_resource_read'",[controlled.account.id]);}
    await checkResource(prepared.A,'az17');assert.ok(resourceReads()>before);
  });
  await t.test('R05 a new revision sourced from a retained preparation preserves exact resource bytes and scoped association',async()=>{
    const r=prepared.A.reference,p=prepared.A.record.payload;
    const document={profile:'preparation-document/1',transformation:'exact_selection',
      elements:p.elements.map(e=>({...e,antecedents:e.antecedents.map(a=>({...a,input_id:'base:'+a.input_id}))})),
      relations:p.relations.map(x=>({...x,id:'base:'+x.id})),conditions:[],
      units:p.units.map(u=>({...u,coverage:{...u.coverage,components:['base:source:extraction']}})),differences:[]};
    const next=await persistDocument({call,check,document,inputs:[{id:'base',kind:'preparation',reference:r}],base:r,
      selection:[{input_id:'base',element_id:'figure',local_id:'figure',resource:resources[0],local_resource_id:'R-1'},
        {input_id:'base',element_id:'caption',local_id:'caption'}]});
    await checkResource(next,'az17');await checkResource(prepared.A,'az17');
    assert.equal(next.reference.revision,2);assert.deepEqual(await counts(),initialCounts);
    record('prepared-resource-next-revision',{before:r,after:next.reference,resource:resources[0]});
  });
}
