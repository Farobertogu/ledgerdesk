import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {EXTRACTION_CONTENT} from '../../../src/contracts/intake_extraction_view.ts';
import {extractionControl,processingTreatment} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function extractionResourceCases(t,{env,intake,client,request}){
  await extractionControl(env);const directory=await mkdtemp('/work/output/resource-boundary-');
  const observations=[],bodies=[Buffer.from('Intact resource A-17 under Z.\n'),Buffer.from('Intact alternative A-18 under Z.\n')];
  const resources=bodies.map((b,i)=>({id:i?'A-18':'A-17',generation:i?9:7,bytes:b.length,sha256:hash(b)}));
  const referenceRelation={id:'required-exception',from:'line-1',to:'line-2',role:'indispensable',scope:'AZ-17 under condition Z',origin:'proposed'};
  for(let i=0;i<2;i++){
    await writeFile(path.join(directory,resources[i].id),bodies[i],{flag:'wx'});
    // Independently demonstrate both alternatives really exist and are readable.
    const actual=await readFile(path.join(directory,resources[i].id));
    assert.deepEqual({bytes:actual.length,sha256:hash(actual)},resources[i]&&{bytes:resources[i].bytes,sha256:resources[i].sha256});
  }
  const text='AZ-17 requires receipt Q.\nUnder condition Z, receipt R replaces Q.\n';
  async function prepare(label,choice='A',fault=null){
    const receipt=await receivedOriginal(request,client,Buffer.from(text),{name:'resource-'+label+'.txt'});
    const selected=resources[choice==='B'?1:0];
    // Fixed before the producer starts, from the operation choice and literal
    // independent fixture. Never derived from its returned manifest.
    const reference={original:receipt.original,selections:[{element_id:'selected-resource',resource:selected}],relations:[referenceRelation]};
    await writeFile(path.join(directory,label+'-reference.json'),JSON.stringify(reference),{flag:'wx'});
    const output=path.join(directory,label+'-producer.json');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./resource_producer.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
    const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    child.stdin.end(JSON.stringify({original:receipt.original,resources,choice:fault==='swap'?'B':choice,output}));
    try{assert.equal(await closed,0);}finally{clearTimeout(timer);}
    const produced=JSON.parse(await readFile(output,'utf8'));
    if(fault==='duplicate')produced.resources.push(structuredClone(produced.resources[0]));
    let reads=0,metadataReads=0;
    const port={reference,observation:async()=>{metadataReads++;return structuredClone(produced);},read:async r=>{
      reads++;const item=resources.find(x=>x.id===r.id&&x.generation===r.generation);assert.ok(item);
      const fd=await open(path.join(directory,item.id),'r');try{return await fd.readFile();}finally{await fd.close();}
    }};
    const service=new ExtractionService(intake,{instrumentedResources:port});await service.dispatch(receipt.work.id);
    return{receipt,reference,produced,service,reads:()=>reads,metadataReads:()=>metadataReads,label};
  }
  async function positive(row){
    const accepted=await row.service.accept(row.receipt.work.id);
    const q=await request('/api/intake/extractions/'+row.receipt.work.id,{client});
    assert.equal(q.status,200);assert.equal(EXTRACTION_CONTENT(q.body.result.content),true);
    const c=q.body.result.content,selected=row.reference.selections[0].resource;
    const stored=(await env.admin.query('SELECT count(*)::int AS results FROM intake_trial.extraction_result WHERE job_id=$1',[row.receipt.work.id])).rows[0];
    observations.push({case:row.label,reference:row.reference,produced:row.produced,accepted,body:q.body,reads:row.reads()});
    assert.deepEqual({reads:row.reads(),results:stored.results,resources:c.resources,
      selection:c.elements.filter(e=>e.kind==='resource').map(e=>({element_id:e.id,resource:e.resource})),relations:c.relations,
      text:c.elements.filter(e=>e.kind==='text').map(e=>e.text).join(''),payload:c.instrumented_resources.payloads[0]},
      {reads:1,results:1,resources:[selected],selection:row.reference.selections,relations:[referenceRelation],text,
        payload:{artifact:selected,data:bodies[selected.id==='A-18'?1:0].toString('base64')}});
  }
  try{
    await t.test('RES01 actual admitted storage and query preserve nonempty resource and indispensable relation',async()=>positive(await prepare('RES01')));
    for(const [name,fault,expected]of [['RES02','swap','EXTRACTION_RESOURCE_ASSOCIATION'],['RES03','duplicate','EXTRACTION_RESOURCE_DUPLICATE']]){
      await t.test(name+' invalid association reaches metadata checks without any resource body read',async()=>{
        const row=await prepare(name,'A',fault);
        let rejection=null;
        try{await row.service.accept(row.receipt.work.id);}catch(error){rejection=String(error.message);}
        const state=(await env.admin.query(`SELECT count(*)::int AS results FROM intake_trial.extraction_result WHERE job_id=$1`,[row.receipt.work.id])).rows[0];
        const negative={rejection,reads:row.reads(),results:state.results};
        observations.push({case:name,reads:row.reads(),expected,reference:row.reference,produced:row.produced});
        // Correct the intermediate producer metadata, not the preserved reference.
        row.produced.selections=structuredClone(row.reference.selections);row.produced.resources=[row.reference.selections[0].resource];
        // Finish a rejected attempt before asserting its observations, so an
        // intentionally broken guard cannot mask the next case with capacity.
        // An already accepted mutant needs no second effect or invented reset.
        if(state.results===0){
          const accepted=await row.service.accept(row.receipt.work.id);
          const q=await request('/api/intake/extractions/'+row.receipt.work.id,{client});
          assert.deepEqual({status:q.status,id:q.body.result?.id},{status:200,id:accepted.resultId});
          const c=q.body.result.content,selected=row.reference.selections[0].resource;
          assert.equal(EXTRACTION_CONTENT(c),true);
          assert.deepEqual({resources:c.resources,relations:c.relations,
            selection:c.elements.filter(e=>e.kind==='resource').map(e=>({element_id:e.id,resource:e.resource})),
            text:c.elements.filter(e=>e.kind==='text').map(e=>e.text).join(''),payload:c.instrumented_resources.payloads[0]},
          {resources:[selected],relations:[referenceRelation],selection:row.reference.selections,text,
            payload:{artifact:selected,data:bodies[selected.id==='A-18'?1:0].toString('base64')}});
        }
        assert.deepEqual(negative,{rejection:expected,reads:0,results:0});
      });
    }
    await t.test('RES04 a distinct operation legitimately selects the intact alternative resource',async()=>positive(await prepare('RES04','B')));
    await t.test('RES05 withdrawn current treatment refuses even boundary metadata and resources after lawful extraction',async()=>{
      const row=await prepare('RES05');
      await env.admin.query('SELECT intake_control.set_treatment($1,1,false)',[processingTreatment.id]);
      try{
        await assert.rejects(row.service.accept(row.receipt.work.id),/INTAKE_404/);
        assert.deepEqual({metadata:row.metadataReads(),bodies:row.reads()},{metadata:0,bodies:0});
      }finally{await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[processingTreatment.id]);}
      await positive(row);
    });
  }finally{
    await writeFile('/work/output/extraction-resources.json',JSON.stringify({observations,resources,
      scope:'Instrumented metadata producer and real resource files; real admission, original extraction, immutable seal, SQL acceptance and HTTPS query. Not native image extraction, preparation or candidate constitution.'},null,2),{flag:'wx'});
  }
}
