import {array,closed,choice,digest,exactReference,identifier,integer,record,scalarText,text,type Rule} from './intake.ts';

type Row=Record<string,any>;
/** Lossless retention of JSON observations, not a claim of semantic interpretation. */
export type Retained = {kind:'null'}|{kind:'boolean';value:boolean}|{kind:'string'|'number';value:string}|{kind:'array';items:Retained[]}|{kind:'object';entries:{key:string;value:Retained}[]};
export function retain(value:unknown,depth=0):Retained{
 if(depth>12)throw Error('MAPPING_DEPTH');
 if(value===null)return {kind:'null'};
 if(typeof value==='boolean')return {kind:'boolean',value};
 if(typeof value==='string'&&scalarText(value))return {kind:'string',value};
 if(typeof value==='number'&&Number.isFinite(value))return {kind:'number',value:Object.is(value,-0)?'-0':String(value)};
 if(Array.isArray(value)&&Object.keys(value).length===value.length)return {kind:'array',items:value.map(v=>retain(v,depth+1))};
 if(record(value)&&Object.keys(value).every(k=>scalarText(k)))return {kind:'object',entries:Object.entries(value).map(([key,v])=>({key,value:retain(v,depth+1)}))};
 throw Error('MAPPING_NOT_JSON');
}
export function restore(value:unknown,depth=0):any{
 if(depth>12||!record(value))throw Error('MAPPING_RETAINED');
 if(closed({kind:choice('null')})(value))return null;
 if(closed({kind:choice('boolean'),value:choice(true,false)})(value))return value.value;
 if(closed({kind:choice('string'),value:scalarText})(value))return value.value;
 if(closed({kind:choice('number'),value:text(64)})(value)){
  const n=Number(value.value);if(!Number.isFinite(n)||(Object.is(n,-0)?'-0':String(n))!==value.value)throw Error('MAPPING_NUMBER');return n;
 }
 if(closed({kind:choice('array'),items:array(()=>true,100000)})(value))return (value.items as unknown[]).map(v=>restore(v,depth+1));
 if(closed({kind:choice('object'),entries:array(closed({key:scalarText,value:()=>true}),100000)})(value)){
  const entries=value.entries as Row[];if(new Set(entries.map(e=>e.key)).size!==entries.length)throw Error('MAPPING_DUPLICATE');
  return Object.fromEntries(entries.map(e=>[e.key,restore(e.value,depth+1)]));
 }
 throw Error('MAPPING_RETAINED');
}
const pair:Rule=v=>array(integer,2)(v)&&(v as number[]).length===2&&(v as number[])[0]<=(v as number[])[1];
const original=closed({name:text(256),bytes:v=>integer(v)&&(v as number)<=1048576,sha256:digest});
const textLocator=closed({original:digest,byteRange:pair,codePointRange:pair});
const csvLocator=closed({original:digest,coordinate:text(512)});
const sheetLocator=closed({original:digest,part:text(512)});
const cellLocator=closed({original:digest,part:text(512),sheetId:text(128),cell:text(128)});
const csvRow=closed({index:integer,fields:array(text(65536),64),raw:text(262144),originalByteRange:pair});
const cached=closed({availability:choice('observed','not_available')},{lexical:text(65536),sourceType:text(32)});
const jsonValue:Rule=v=>{try{retain(v);return true;}catch{return false;}};
const attributes:Rule=v=>record(v)&&Object.entries(v).every(([k,x])=>k.startsWith('@_')&&scalarText(x));
const trialCell=closed({address:text(128),sourceType:text(32),availability:choice('present','no_stored_value'),locator:cellLocator},{storedLexical:text(65536),adapterType:text(32),value:jsonValue,numberFormat:text(512),formula:closed({storedExpression:text(65536),attributes,cached})});
const trialElement:Rule=v=>closed({id:identifier,type:choice('text'),text:text(1048576),locator:textLocator})(v)||
 closed({id:identifier,type:choice('table'),headers:array(text(65536),64),rows:array(csvRow,1000),locator:csvLocator})(v)||
 closed({id:identifier,type:choice('sheet'),name:text(128),sourceSheetId:text(128),visibility:choice('visible','hidden','veryHidden'),cells:array(trialCell,10000),merged:array(text(128),10000),hiddenRows:array(text(128),10000),columns:array(attributes,10000),autoFilter:jsonValue,declaredDimension:jsonValue,locator:sheetLocator})(v)||
 closed({id:identifier,type:choice('resource'),resource:scalarText})(v);
const nonempty=(max:number):Rule=>v=>text(max)(v)&&/\S/u.test(v as string);
const trialRelation=closed({from:identifier,to:identifier,scope:nonempty(512),basis:nonempty(512),preparationRevision:v=>integer(v)&&(v as number)>0});
const resourceId:Rule=v=>scalarText(v)&&(v as string).length>0&&!/[\u0000-\u0020\u007f]/u.test(v as string);
const trialResource=closed({id:resourceId,file:v=>typeof v==='string'&&v.length<=256&&/^[A-Za-z0-9_.-]+$/.test(v),bytes:integer,sha256:digest});
const extractionShape=closed({schema:choice('extraction-trial/1'),profile:choice('text','csv','xlsx'),original,
 outcome:choice('completed','partial'),coverage:closed({claim:choice('declared syntactic profile only'),unsupported:array(text(512),10000)}),
 inventory:jsonValue,elements:array(trialElement,10000),relations:array(trialRelation,10000),resources:array(trialResource,10000)});
const candidateShape=closed({schema:choice('candidate-trial/1'),candidate:closed({unit:identifier,version:v=>integer(v)&&(v as number)>0,preparationId:identifier,preparationRevision:v=>integer(v)&&(v as number)>0,selected:array(identifier,10000),canonicalSha256:digest,state:choice('synthetic_candidate_only')}),preparation:closed({id:identifier,revision:v=>integer(v)&&(v as number)>0}),canonical:closed({elements:array(trialElement,10000),relations:array(trialRelation,10000),resources:array(trialResource,10000)})});
const inventories:Record<string,Rule>={
 text:closed({bytes:integer,decodedCodePoints:integer,elements:integer,bomBytes:integer}),
 csv:closed({records:integer,bomBytes:integer,headerMode:choice('first record retained; labels do not replace column positions')}),
 xlsx:closed({members:integer,declaredExpandedBytes:integer,observedExpandedBytes:integer,parts:array(text(512),128),sheets:integer,cells:integer,dateSystem:choice('1900','1904'),semantics:choice('Package structure only; not a proof of all workbook meaning or dependencies.')}),
};
export const MAPPING_PROFILE='trial-to-prepared/1' as const;
const retainedValue:Rule=v=>{try{restore(v);return true;}catch{return false;}};
const artifact=closed({id:identifier,generation:v=>integer(v)&&(v as number)>0,bytes:integer,sha256:digest});
const mappedDifference=closed({id:identifier,before:exactReference,after:exactReference,method:choice('exact_selection','correction','synthesis'),reason:nonempty(2048),affected:array(identifier),actor:identifier,recorded_at:integer});
const trialProfile=closed({version:choice('intake-trial/1'),
 limits:closed({inputBytes:choice(1048576),expandedBytes:choice(8388608),members:choice(128),sheets:choice(8),cells:choice(10000),csvRecords:choice(1000),csvColumns:choice(64),csvRecordUnits:choice(65536),outputBytes:choice(8388608),wallMs:choice(10000),heapMiB:choice(128),concurrency:choice(1)}),
 text:closed({encoding:choice('utf-8'),fatal:choice(true),bom:scalarText,normalize:choice(false),markdown:choice('inert source text'),coordinates:scalarText}),
 csv:closed({encoding:choice('utf8'),bom:choice(false),columns:choice(false),cast:choice(false),cast_date:choice(false),delimiter:choice(','),quote:choice('"'),escape:choice('"'),record_delimiter:array(choice('\r\n','\n'),2),trim:choice(false),skip_empty_lines:choice(false),skip_records_with_error:choice(false),relax_column_count:choice(false),raw:choice(true),info:choice(true),max_record_size:choice(262144)}),
 xlsx:closed({type:choice('buffer'),cellFormula:choice(true),cellNF:choice(true),cellStyles:choice(true),cellText:choice(false),cellHTML:choice(false),cellDates:choice(false),sheetStubs:choice(true),xlfn:choice(true),WTF:choice(true),nodim:choice(true),sheetRows:choice(0)}),
 exclusions:array(scalarText),limitMeaning:scalarText});
const runtime=closed({node:text(32),sheetjs:choice('0.20.3'),rssBytes:integer});
const mappingContext=closed({preparation:exactReference,source:exactReference,original:exactReference,profile:exactReference,resources:array(closed({trial_id:scalarText,artifact}),10000),differences:array(mappedDifference,128),
 observations:closed({raw:jsonValue,profile_definition:trialProfile},{runtime})});
export const RETAINED_MAPPING_SHAPE:Rule=v=>{
 if(!closed({profile:choice(MAPPING_PROFILE),kind:choice('extraction','candidate'),source:retainedValue,context:retainedValue},{antecedent:retainedValue})(v)||!record(v))return false;
 try{return mappingContext(restore(v.context))&&(v.kind==='candidate'?extractionShape(restore(v.antecedent)):!Object.hasOwn(v,'antecedent'));}catch{return false;}
};
function same(a:any,b:any):boolean{
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));
 if(record(a)&&record(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
 return Object.is(a,b);
}
function demand(ok:unknown,code:string):asserts ok {if(!ok)throw Error(code);}
function inspectExtraction(x:Row){
 demand(extractionShape(x)&&inventories[x.profile](x.inventory),'MAPPING_EXTRACTION');
 demand((x.outcome==='partial')===(x.coverage.unsupported.length>0),'MAPPING_COVERAGE');
 demand(x.elements.every((e:Row)=>e.type===({text:'text',csv:'table',xlsx:'sheet'}[x.profile as 'text'|'csv'|'xlsx'])),'MAPPING_PROFILE_ELEMENT');
 demand(x.elements.every((e:Row)=>e.locator.original===x.original.sha256),'MAPPING_ORIGINAL');
 for(const e of x.elements){
  if(e.type==='sheet')demand(e.cells.every((c:Row)=>c.locator.original===x.original.sha256&&c.locator.part===e.locator.part&&c.locator.sheetId===e.sourceSheetId&&c.locator.cell===c.address),'MAPPING_CELL_LOCATION');
 }
}
function lex(c:Row):Row{
 if(c.availability==='no_stored_value')return {kind:c.formula?'missing':'empty',lexical:''};
 const value=c.storedLexical??c.value;
 if(c.sourceType==='s'||c.sourceType==='str'||c.sourceType==='inlineStr')return {kind:'text',lexical:String(c.value??c.storedLexical??'')};
 if(c.sourceType==='e')return {kind:'error',lexical:String(value)};
 if(c.sourceType==='b')return {kind:'boolean_lexical',lexical:String(value)};
 demand(c.sourceType==='n','MAPPING_CELL_TYPE');return {kind:'number_lexical',lexical:String(value)};
}
/** Builds a proposed representation. Caller context is not authenticated by this pure function. */
export function projectTrial(mapping:unknown):Row{
 demand(RETAINED_MAPPING_SHAPE(mapping),'MAPPING_ENVELOPE');const m=mapping as Row;
 const source=restore(m.source),ctx=restore(m.context),x=m.kind==='candidate'?restore(m.antecedent):source;
 inspectExtraction(x);demand(ctx.original.sha256===x.original.sha256,'MAPPING_ORIGINAL_REFERENCE');
 demand(ctx.differences.every((d:Row)=>same(d.before,ctx.source)&&same(d.after,ctx.preparation)),'MAPPING_DIFFERENCE_PAIR');
 let material=x;
 if(m.kind==='candidate'){
  demand(candidateShape(source),'MAPPING_CANDIDATE');material=source.canonical;
  demand(source.candidate.preparationId===source.preparation.id&&source.candidate.preparationRevision===source.preparation.revision,'MAPPING_PREPARATION_REFERENCE');
  demand(source.preparation.id===ctx.preparation.id&&source.preparation.revision===ctx.preparation.revision,'MAPPING_PREPARATION_REFERENCE');
  demand(new Set(source.candidate.selected).size===source.candidate.selected.length&&same([...source.candidate.selected].sort(),material.elements.map((e:Row)=>e.id).sort()),'MAPPING_SELECTION');
  for(const e of material.elements){
   const before=x.elements.find((b:Row)=>b.id===e.id);
   demand(before&&same(before,e)||ctx.differences.some((d:Row)=>same(d.before,ctx.source)&&same(d.after,ctx.preparation)&&d.affected?.includes(e.id)&&['correction','synthesis'].includes(d.method)),'MAPPING_UNEXPLAINED_CHANGE');
  }
  demand(material.relations.every((r:Row)=>r.preparationRevision===source.preparation.revision),'MAPPING_RELATION_REVISION');
 }
 demand(new Set(material.elements.map((e:Row)=>e.id)).size===material.elements.length,'MAPPING_DUPLICATE_ELEMENT');
 demand(new Set(material.resources.map((r:Row)=>r.id)).size===material.resources.length,'MAPPING_DUPLICATE_RESOURCE');
 demand(new Set(ctx.resources.map((r:Row)=>r.trial_id)).size===ctx.resources.length&&ctx.resources.length===material.resources.length,'MAPPING_RESOURCE_BINDING');
 const resources=material.resources.map((r:Row)=>{
  const b=ctx.resources.find((v:Row)=>v.trial_id===r.id);demand(b&&b.artifact.bytes===r.bytes&&b.artifact.sha256===r.sha256,'MAPPING_RESOURCE_BINDING');return b.artifact;
 });
 const elements=material.elements.map((e:Row)=>{
  const loc=e.locator;const antecedents=loc?[{antecedent:ctx.original,kind:e.type==='sheet'?'cells':'bytes',coordinates:loc.coordinate??loc.part??'zero-based half-open UTF-8 bytes; Unicode code points',...(loc.byteRange?{byte_range:loc.byteRange}:{})}]:[{antecedent:ctx.source,kind:'nonliteral',coordinates:'Explicit preparation transformation; no invented literal location'}];
  if(e.type==='text')return {id:e.id,kind:'text',text:e.text,antecedents};
  if(e.type==='resource'){
   const b=ctx.resources.find((r:Row)=>r.trial_id===e.resource);demand(b,'MAPPING_RESOURCE_BINDING');return {id:e.id,kind:'resource',resource:b.artifact,antecedents};
  }
  if(e.type==='table')return {id:e.id,kind:'table',cells:[],headers:e.headers,rows:e.rows.map((r:Row)=>({index:r.index,fields:r.fields,raw:r.raw,byte_range:r.originalByteRange})),antecedents};
  return {id:e.id,kind:'table',antecedents,cells:e.cells.map((c:Row)=>({address:c.address,value:lex(c),...(c.numberFormat!==undefined?{number_format:c.numberFormat}:{}),...(c.formula?{formula:c.formula.storedExpression,cached:c.formula.cached.availability==='not_available'?{kind:'missing',lexical:''}:lex({availability:'present',sourceType:c.formula.cached.sourceType,storedLexical:c.formula.cached.lexical})}:{})})),
   sheet:{source_id:e.sourceSheetId,name:e.name,visibility:e.visibility,merged:e.merged,hidden_rows:e.hiddenRows,columns:e.columns.map((c:Row)=>{
    demand(/^[1-9][0-9]*$/.test(c['@_min'])&&/^[1-9][0-9]*$/.test(c['@_max']),'MAPPING_COLUMN');
    return {minimum:Number(c['@_min']),maximum:Number(c['@_max']),...(c['@_hidden']!==undefined?{hidden:['1','true'].includes(c['@_hidden'])}:{}),...(c['@_width']!==undefined?{width_lexical:c['@_width']}: {})};})}};
 });
 const limitations=['syntactic-profile-only','raw-properties-retained-not-interpreted','semantic-fidelity-unverified'];
 const components:Row[]=[{id:'extraction',execution:'completed',coverage:x.outcome==='partial'?'partial':'complete',fidelity:'unchecked',limitations,incidents:[]}];
 const incidents:Row[]=[];
 x.coverage.unsupported.forEach((name:string,i:number)=>{
  const id='unprocessed-'+i,incident='incident-'+i;
  components.push({id,execution:'not_attempted',coverage:'none',fidelity:'unchecked',limitations:['component-not-offered'],incidents:[incident]});
  incidents.push({id:incident,component:id,cause:'route_unoffered',detail:name});
 });
 const inputs=[ctx.original,ctx.source,ctx.profile].filter((r:Row,i:number,a:Row[])=>a.findIndex(t=>same(t,r))===i);
 return {profile:'prepared-material/1',preparation:ctx.preparation,inputs,elements,
  relations:material.relations.map((r:Row,i:number)=>({id:'relation-'+i,from:r.from,to:r.to,role:'indispensable',scope:r.scope,origin:'prepared'})),
  resources,components,incidents,differences:ctx.differences,inventory:'unknown',current_use:'not_evaluated',trial_mapping:m};
}
export function trialMapping(source:unknown,context:unknown,antecedent?:unknown):Row{
 const candidate=record(source)&&source.schema==='candidate-trial/1';
 return {profile:MAPPING_PROFILE,kind:candidate?'candidate':'extraction',source:retain(source),context:retain(context),...(candidate?{antecedent:retain(antecedent)}:{})};
}
export function mappedProjectionMatches(preparation:unknown):boolean{
 if(!record(preparation)||!Object.hasOwn(preparation,'trial_mapping'))return false;
 try{return same(preparation,projectTrial(preparation.trial_mapping));}catch{return false;}
}
/** Compare against a separately retained input, not against a freshly returned manifest. */
export function mappingSourceMatches(preparation:unknown,source:unknown,context:unknown,antecedent?:unknown):boolean{
 if(!record(preparation))return false;
 try{return same(preparation,projectTrial(trialMapping(source,context,antecedent)));}catch{return false;}
}
/** A failed producer record cannot become a preparation; retain its actual cause. */
export function trialFailure(value:unknown){
 demand(closed({error:text(128),detail:text(200)})(value),'MAPPING_FAILURE');const v=value as Row;
 const unoffered=['unsupported_profile','unsupported_encoding','unsupported_container','unsupported_workbook_type','encrypted_input','external_relationship','xml_declaration_forbidden'];
 const unreadable=['invalid_utf8','invalid_xml','invalid_sheet','invalid_cell_address','missing_sheet_relation','missing_sheet'];
 const technical=['input_limit','member_limit','expanded_limit','sheet_limit','cell_limit','record_limit','column_limit','csv_record_limit','invalid_csv_locator','missing_adapter_sheet','adapter_omitted_cell','unsafe_zip_entry'];
 const cause=unoffered.includes(v.error)?'route_unoffered':unreadable.includes(v.error)||v.error.startsWith('CSV_')?'unreadable':technical.includes(v.error)?'technical_failure':'unclassified';
 return {execution:'failed',coverage:'unknown',cause,producer_code:v.error,detail:v.detail,preparation:null};
}
export function producerMapping(producer:unknown,context:unknown,profileDefinition:unknown):Row{
 demand(closed({raw:jsonValue,extraction:extractionShape,runtime})(producer)&&record(producer)&&record(context),'MAPPING_PRODUCER');
 return trialMapping(producer.extraction,{...context,observations:{raw:producer.raw,runtime:producer.runtime,profile_definition:profileDefinition}});
}
