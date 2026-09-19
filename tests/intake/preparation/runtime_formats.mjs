import assert from 'node:assert/strict';
import {ExtractionService} from '../../../src/server/intake/extraction.ts';
import {receivedOriginal} from '../extraction/received_fixture.mjs';
import {original,MARKDOWN} from '../extraction/references/cases.mjs';
import {CSV_REFERENCES} from '../extraction/references/csv.mjs';
import {REFERENCES} from './references/cases.mjs';
import {assertScopedCoverage} from './references/assertions.mjs';
import {preparationTreatment} from './runtime_control.mjs';
import {persistDocument,constituteDocument,preparationAxis as axis} from './runtime_helpers.mjs';

const xlsxMedia='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// These are reference facts fixed before each dispatch, not producer output.
const caches={'baseline.xlsx':{kind:'number_lexical',lexical:'25.00'},
  'cache-discrepant.xlsx':{kind:'number_lexical',lexical:'24.00'},
  'cache-missing.xlsx':{kind:'missing',lexical:''},'cache-zero.xlsx':{kind:'number_lexical',lexical:'0'},
  'unsupported-part.xlsx':{kind:'number_lexical',lexical:'25.00'}};
const condition='Under condition Z, receipt R replaces receipt Q.';

function expectedTable(elements,name){
  if(CSV_REFERENCES[name]){
    const reference=CSV_REFERENCES[name];let offset=0;
    const rows=reference.records.map((raw,index)=>{const start=offset;offset+=Buffer.byteLength(raw);
      return {index,fields:reference.fields[index],raw,byte_range:[start,offset]};});
    assert.deepEqual({count:elements.length,headers:elements[0].headers,rows:elements[0].rows},
      {count:1,headers:reference.fields[0],rows});
    return;
  }
  assert.deepEqual(elements.map(e=>[e.sheet.name,e.sheet.source_id,e.sheet.visibility,e.cells.length]),
    [['Items','1','visible',32],['Conditions','2','hidden',4]]);
  const cell=address=>elements[0].cells.find(c=>c.address===address);
  assert.deepEqual({formula:cell('D2').formula,cached:cell('D2').cached},
    {formula:'B2*C2',cached:caches[name]});
  assert.deepEqual(['A2','B3','B4','B5'].map(a=>cell(a).value),[
    {kind:'text',lexical:'001'},{kind:'empty',lexical:''},{kind:'number_lexical',lexical:'0'},{kind:'error',lexical:'#N/A'}]);
  assert.deepEqual({value:cell('C2').value,format:cell('C2').number_format},
    {value:{kind:'number_lexical',lexical:'12.5'},format:'0.00'});
  assert.equal(cell('A7').value.lexical,'Amounts are in USD and exclude tax.');
  assert.deepEqual({formula:cell('B8').formula,cached:cell('B8').cached},
    {formula:"'Conditions'!B2",cached:{kind:'text',lexical:condition}});
  assert.equal(elements[1].cells.find(c=>c.address==='B2').value.lexical,condition);
  assert.deepEqual(elements[0].sheet.merged,['A7:D7','B8:D8']);
  assert.deepEqual(elements[0].sheet.hidden_rows,['6']);
}

function stagedDocument(content,unit){
  const elements=content.elements.map(e=>{
    const {original_range,...value}=e;
    return {...value,antecedents:original_range?[{input_id:'source',kind:'bytes',coordinates:'original:'+original_range.bytes.join('..'),
      byte_range:original_range.bytes,code_point_range:original_range.code_points}]:e.antecedents.map(a=>({input_id:'source',kind:a.kind,
        coordinates:a.coordinates,...(a.byte_range?{byte_range:a.byte_range}:{})}))};
  });
  const workbook=elements.some(e=>e.sheet);
  // Declared preparation interpretation of the independently known cell dependency,
  // not a relationship invented by the native XLSX extractor.
  const relations=workbook?[{id:'sheet-condition',from:elements[0].id,to:elements[1].id,role:'indispensable',
    scope:'Items B8 references Conditions B2',origin:'prepared'}]:[];
  const conditions=workbook?[{id:'Z',text:condition,scope:'AZ-17'},
    {id:'currency',text:'Amounts are in USD and exclude tax.',scope:'Items amounts'}]:[];
  return {profile:'preparation-document/1',transformation:workbook?'correction':'exact_selection',elements,relations,conditions,
    units:[{id:unit,elements:elements.map(e=>e.id),conditions:conditions.map(c=>c.id),inseparable_group:null,
      classification:{function:axis('factual'),basis:axis('verifiable_attestation'),scope:axis('reusable_with_conditions')},
      examination:{outcome:'classifiable',reason:'Explicit bounded synthetic preparation judgment, not semantic extraction or approval.'},
      coverage:{components:['source:extraction'],complete_source_claim:false,reason:'Retain the original profile limitations and unknown semantic inventory.'}}],
    differences:workbook?[{before:['source'],method:'correction',transformation:'cleanup',
      reason:'Record the declared cross-sheet dependency and applicable conditions without changing any cell.',
      affected:[{kind:'relation',id:'sheet-condition'},{kind:'condition',id:'Z'},{kind:'condition',id:'currency'}]}]:[]};
}

export async function preparationFormatCases(t,{env,intake,client,request,call,check,counts,controlled,record}){
  // P05 removed this actual grant; the following operations explicitly restore it.
  await env.admin.query("UPDATE access_trial.grant_record SET withdrawn=false WHERE account_id=$1 AND permission_id='intake_constitute'",[controlled.account.id]);
  const extraction=new ExtractionService(intake);
  const receive=async(name,format,media)=>{
    const input=await original(name);
    if(CSV_REFERENCES[name])assert.equal(input.bytes.toString(),CSV_REFERENCES[name].records.join(''));
    const receipt=await receivedOriginal(request,client,input.bytes,{name,format,media,treatmentRevision:preparationTreatment});
    await extraction.dispatch(receipt.work.id);await extraction.accept(receipt.work.id);
    const query=await request('/api/intake/extractions/'+receipt.work.id,{client});check(query,200);
    return {input,receipt,result:query.body.result};
  };
  const prepare=async(source,unit)=>{
    const document=stagedDocument(source.result.content,unit);
    return persistDocument({call,check,document,inputs:[{id:'source',kind:'extraction',job_id:source.receipt.work.id,reference:source.result.effect}],
      selection:source.result.content.elements.map(e=>({input_id:'source',element_id:e.id,local_id:e.id}))});
  };
  await t.test('F01 both repeated CSV headers and multiline Unicode survive actual preparation with independent positions',async()=>{
    for(const name of ['table.csv','unicode-records.csv']){
      const source=await receive(name,'csv-utf8/1','text/csv');expectedTable(source.result.content.elements,name);
      const before=await counts(),prepared=await prepare(source,'CSV');expectedTable(prepared.record.payload.elements,name);
      assert.deepEqual(await counts(),before);
      assert.deepEqual(prepared.record.payload.inputs[0].original,source.receipt.original);
      record('prepared-csv',{name,reference:prepared.reference,bytes:prepared.record.descriptor.payload.bytes});
    }
  });
  await t.test('F02 actual XLSX preparations preserve cache distinctions, hidden condition sheet and recorded dependency',async()=>{
    for(const name of ['baseline.xlsx','cache-discrepant.xlsx','cache-missing.xlsx','cache-zero.xlsx']){
      const source=await receive(name,'xlsx-cells/1',xlsxMedia);expectedTable(source.result.content.elements,name);
      const prepared=await prepare(source,'Workbook');expectedTable(prepared.record.payload.elements,name);
      assert.deepEqual(prepared.record.payload.relations,[{id:'sheet-condition',from:'sheet-1',to:'sheet-2',role:'indispensable',
        scope:'Items B8 references Conditions B2',origin:'prepared'}]);
      assert.equal(prepared.record.differences[0].body.transformation,'cleanup');
      assert.equal(prepared.record.payload.current_use,'not_evaluated');
      record('prepared-workbook',{name,reference:prepared.reference,bytes:prepared.record.descriptor.payload.bytes});
    }
  });
  await t.test('F03 X07 retains the unprocessed component and its limitation through actual preparation and candidate constitution',async()=>{
    const source=await receive('unsupported-part.xlsx','xlsx-cells/1',xlsxMedia),ref=REFERENCES['F-X'].x07;
    assert.deepEqual({bytes:source.input.bytes.length,sha256:source.input.reference.sha256},{bytes:ref.bytes,sha256:ref.sha256});
    expectedTable(source.result.content.elements,'unsupported-part.xlsx');
    const prepared=await prepare(source,'X07'),before=await counts();
    const effect=await constituteDocument({call,check,prepared,unit:'X07'}),candidate=effect.constitution.result.candidates[0];
    const saved=(await env.admin.query(`SELECT c.editorial_state,c.preparation_id,c.preparation_revision,c.conditions,p.payload
      FROM intake_trial.candidate c JOIN intake_trial.preparation p ON p.id=c.preparation_id AND p.revision=c.preparation_revision
      WHERE c.unit_id=$1`,[candidate.id])).rows[0];
    assert.ok(saved);const payload=JSON.parse(saved.payload.toString());
    const incident=source.result.content.incidents.find(i=>i.detail===ref.unsupported);assert.ok(incident);
    const binding={preparation:prepared.reference,component_ids:{parent:'source:extraction',unsupported:'source:'+incident.component},
      incident_ids:{unsupported:'source:'+incident.id}};
    for(const observed of [prepared.record.payload,payload]){
      const coverage=observed.units[0].coverage;
      assertScopedCoverage({preparation:prepared.reference,...observed,selected_coverage:{components:coverage.components,
        complete_source_claim:coverage.complete_source_claim}},binding,'x07');
      expectedTable(observed.elements,'unsupported-part.xlsx');
    }
    assert.deepEqual({state:saved.editorial_state,reference:{id:saved.preparation_id,revision:saved.preparation_revision},counts:await counts()},
      {state:'candidate',reference:{id:prepared.reference.id,revision:prepared.reference.revision},
        counts:{candidates:before.candidates+1,outcomes:before.outcomes+1,effects:before.effects+1}});
    assert.deepEqual(saved.conditions,[{id:'Z',text:condition,scope:'AZ-17'},{id:'currency',text:'Amounts are in USD and exclude tax.',scope:'Items amounts'}]);
    record('prepared-X07-constitution',{reference:prepared.reference,candidate,incident:binding.incident_ids.unsupported,
      original:source.receipt.original,bytes:prepared.record.descriptor.payload.bytes,temporal:'Full temporal conformity remains unestablished.'});
  });
  await t.test('F04 short content, Unicode coordinates and inert Markdown survive the new prepared consumer',async()=>{
    for(const [name,format,media]of [['short.txt','text-utf8/1','text/plain'],['text.txt','text-utf8/1','text/plain'],['inert.md','markdown-inert/1','text/markdown'],['at-byte-limit.txt','text-utf8/1','text/plain']]){
      const expected=name==='short.txt'?'No.':name==='text.txt'?REFERENCES['F-T'].text:name==='at-byte-limit.txt'?'x'.repeat(1048576):MARKDOWN;
      const source=await receive(name,format,media);assert.equal(source.input.bytes.toString(),expected);
      const prepared=await prepare(source,'Text');assert.equal(prepared.record.payload.elements.map(e=>e.text).join(''),expected);
      if(name==='text.txt'){
        const last=prepared.record.payload.elements.at(-1),line=REFERENCES['F-T'].lines.at(-1);
        assert.deepEqual({text:last.text,bytes:last.antecedents[0].byte_range,points:last.antecedents[0].code_point_range},
          {text:line.text,bytes:line.bytes,points:line.code_points});
      }
      record('prepared-text-profile',{name,reference:prepared.reference,bytes:prepared.record.descriptor.payload.bytes});
    }
  });
}
