import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {EXTRACTION_CONTENT} from '../../../src/contracts/intake_extraction_view.ts';
import {extractionControl} from './runtime_control.mjs';
import {receivedOriginal} from './received_fixture.mjs';
import {original,BOUNDARIES} from './references/cases.mjs';

export async function extractionFormatNegativeCases(t,{env,intake,client,request}){
  await extractionControl(env,{allFormats:true});const observations=[];
  const cases=[];
  for(const side of ['at','over']){
    const delta=Number(side==='over');
    cases.push({name:'records-'+side+'.csv',bytes:Buffer.from('a\n'.repeat(1000+delta)),code:delta?'record_limit':null,
      check:c=>assert.equal(c.elements[0].rows.length,1000)});
    cases.push({name:'columns-'+side+'.csv',bytes:Buffer.from(Array(64+delta).fill('001').join(',')+'\n'),code:delta?'column_limit':null,
      check:c=>assert.deepEqual(c.elements[0].rows[0].fields,Array(64).fill('001'))});
    for(const multi of [false,true]){
      const value=(multi?'😀'.repeat(32768):'a'.repeat(65536))+(delta?'x':'');
      cases.push({name:(multi?'multibyte-units-':'units-')+side+'.csv',bytes:Buffer.from(value+'\n'),code:delta?'csv_record_limit':null,
        check:c=>assert.deepEqual(c.elements[0].rows[0],{index:0,fields:[value],raw:value+'\n',byte_range:[0,Buffer.byteLength(value+'\n')]})});
    }
  }
  for(const b of BOUNDARIES.filter(r=>r.expected!=='completed')){
    const input=await original(b.file);cases.push({name:b.file,bytes:input.bytes,code:b.expected});
  }
  // Literal workbook expectations were fixed against the retained physical
  // original in T01. They do not come from this run's adapter or normalized body.
  const x=await original('cache-discrepant.xlsx');cases.push({name:'cache-discrepant.xlsx',bytes:x.bytes,code:null,check:c=>{
    assert.deepEqual(c.elements.map(e=>({name:e.sheet.name,id:e.sheet.source_id,visibility:e.sheet.visibility,loc:e.antecedents[0].coordinates})),
      [{name:'Items',id:'1',visibility:'visible',loc:'xl/worksheets/sheet1.xml'},
        {name:'Conditions',id:'2',visibility:'hidden',loc:'xl/worksheets/sheet2.xml'}]);
    const table=c.elements[0],cell=a=>table.cells.find(r=>r.address===a);
    assert.deepEqual({formula:cell('D2').formula,cache:cell('D2').cached,blank:cell('B3').value,zero:cell('B4').value,
      error:cell('B5').value,note:cell('A7').value,condition:cell('B8').cached,merged:table.sheet.merged,hiddenRows:table.sheet.hidden_rows},
      {formula:'B2*C2',cache:{kind:'number_lexical',lexical:'24.00'},blank:{kind:'empty',lexical:''},zero:{kind:'number_lexical',lexical:'0'},
        error:{kind:'error',lexical:'#N/A'},note:{kind:'text',lexical:'Amounts are in USD and exclude tax.'},
        condition:{kind:'text',lexical:'Under condition Z, receipt R replaces receipt Q.'},merged:['A7:D7','B8:D8'],hiddenRows:['6']});
  }});
  writeFileSync('/work/output/format-negative-reference.json',JSON.stringify(cases.map(({name,bytes,code})=>({name,bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),code})),null,2),{flag:'wx'});
  try{for(const item of cases)await t.test('FN '+item.name+' reaches actual conservation and protected query',async()=>{
    const xlsx=item.name.endsWith('.xlsx'),format=xlsx?'xlsx-cells/1':'csv-utf8/1';
    const receipt=await receivedOriginal(request,client,item.bytes,{name:item.name,format,
      media:xlsx?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv'});
    const service=new ExtractionService(intake),d=await service.dispatch(receipt.work.id);assert.equal(d.metadata.reason,null);
    const effect=await service.accept(receipt.work.id),q=await request('/api/intake/extractions/'+receipt.work.id,{client});
    assert.equal(q.status,200);assert.equal(q.body.result.id,effect.resultId);assert.equal(EXTRACTION_CONTENT(q.body.result.content),true);
    const c=q.body.result.content;assert.equal(c.original.sha256,receipt.original.sha256);
    observations.push({name:item.name,original:receipt.original,effect,content:c,termination:d.metadata});
    if(item.code)assert.deepEqual({outcome:c.outcome,elements:c.elements,cause:c.incidents[0]?.cause,code:c.incidents[0]?.code},
      {outcome:'failed',elements:[],cause:'technical_failure',code:item.code});
    else{assert.equal(c.outcome,'completed');item.check(c);}
  });}finally{writeFileSync('/work/output/extraction-format-negatives.json',JSON.stringify({observations,
    scope:'Literal boundary originals, real extraction, storage and query. These observations do not measure unrestricted memory or semantic completeness.'},null,2),{flag:'wx'});}
}
