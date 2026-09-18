import { closed, array, choice, text, integer, revision, identifier, exactReference, artifactReference, record, decodePreparedJson, INTAKE_RESPONSE, type IntakeRoute, type Rule } from './intake.ts';
import {RETAINED_MAPPING_SHAPE,mappedProjectionMatches} from './intake_mapping.ts';

export const PREPARED_PROFILE='prepared-material/1' as const;
const pair:Rule=v=>Array.isArray(v)&&v.length===2&&v.every(integer)&&(v[0] as number)<=(v[1] as number);
const localizer=closed({antecedent:exactReference,kind:choice('bytes','cells','nonliteral'),coordinates:text(512)},{byte_range:pair});
const value:Rule=v=>closed({kind:choice('text','number_lexical','boolean_lexical','error','empty','missing'),lexical:text(65536)})(v);
const cell=closed({address:text(128),value},{formula:text(65536),cached:value,number_format:text(512)});
const element:Rule=v=>closed({id:identifier,kind:choice('text'),text:text(1048576),antecedents:array(localizer)})(v)||
  closed({id:identifier,kind:choice('table'),cells:array(cell,10000),antecedents:array(localizer)},{
    headers:array(text(65536),64),rows:array(closed({index:integer,fields:array(text(65536),64),raw:text(262144),byte_range:pair}),1000),
    sheet:closed({source_id:text(128),name:text(128),visibility:choice('visible','hidden','veryHidden'),merged:array(text(128),10000),hidden_rows:array(text(128),10000),columns:array(closed({minimum:integer,maximum:integer},{hidden:choice(true,false),width_lexical:text(128)}),10000)})
  })(v)||
  closed({id:identifier,kind:choice('resource'),resource:artifactReference,antecedents:array(localizer)})(v);
const relation=closed({id:identifier,from:identifier,to:identifier,role:choice('indispensable','context'),scope:text(512),origin:choice('observed','prepared','proposed')});
const incident=closed({id:identifier,component:identifier,cause:choice('unreadable','route_unoffered','technical_failure'),detail:text(512)});
const component=closed({id:identifier,execution:choice('completed','failed','not_attempted'),coverage:choice('complete','partial','unknown','none'),fidelity:choice('checked','unchecked','disputed'),limitations:array(identifier),incidents:array(identifier)});
export {element as INTAKE_ELEMENT,relation as INTAKE_RELATION,component as INTAKE_COMPONENT};
const difference=closed({id:identifier,before:exactReference,after:exactReference,method:choice('exact_selection','correction','synthesis'),reason:text(2048),affected:array(identifier)},{actor:identifier,recorded_at:integer});
export const PREPARATION_SHAPE=closed({
  profile:choice(PREPARED_PROFILE),preparation:exactReference,inputs:array(exactReference),
  elements:array(element,10000),relations:array(relation,10000),resources:array(artifactReference,10000),
  components:array(component,10000),incidents:array(incident,10000),differences:array(difference,128),
  inventory:choice('known','unknown'),current_use:choice('not_evaluated','unavailable'),
},{trial_mapping:RETAINED_MAPPING_SHAPE});
function unique(rows:Record<string,unknown>[]):boolean{return new Set(rows.map(r=>r.id)).size===rows.length;}
function same(a:unknown,b:unknown):boolean {
  return record(a)&&record(b)&&a.id===b.id&&a.revision===b.revision&&a.sha256===b.sha256;
}
export function validatePreparation(input:unknown):boolean {
  if(!PREPARATION_SHAPE(input)||!record(input))return false;
  if(Object.hasOwn(input,'trial_mapping')&&!mappedProjectionMatches(input))return false;
  const p=input as Record<string,Record<string,unknown>[]>;
  for(const key of ['elements','relations','resources','components','incidents','differences'])
    if(!unique(p[key]))return false;
  if(new Set(p.inputs.map(i=>i.id+'@'+i.revision)).size!==p.inputs.length)return false;
  const ids=new Set(p.elements.map(e=>e.id)), resources=new Map(p.resources.map(e=>[e.id,e])),components=new Set(p.components.map(e=>e.id)),incidents=new Set(p.incidents.map(e=>e.id));
  for(const e of p.elements){
    for(const loc of e.antecedents as Record<string,unknown>[])if(!p.inputs.some(i=>same(i,loc.antecedent)))return false;
    if(e.kind==='resource'){const r=e.resource as Record<string,unknown>,actual=resources.get(r.id);if(!actual||['generation','bytes','sha256'].some(k=>actual[k]!==r[k]))return false;}
  }
  for(const r of p.relations)if(!ids.has(r.from)||!ids.has(r.to))return false;
  for(const c of p.components)if(!(c.incidents as string[]).every(id=>incidents.has(id)))return false;
  for(const incident of p.incidents)if(!components.has(incident.component))return false;
  for(const c of p.components)if(!(c.incidents as string[]).every(id=>p.incidents.some(i=>i.id===id&&i.component===c.id)))return false;
  for(const d of p.differences)if(!same(d.after,input.preparation)||!p.inputs.some(i=>same(i,d.before))||!(d.affected as string[]).every(id=>ids.has(id)))return false;
  return true;
}
/** Structural contract evidence only; meaningful omissions need independent examination. */
export function serializePreparation(input:unknown):string{
  if(!validatePreparation(input))throw Error('PREPARATION_INVALID');
  const encoded=JSON.stringify(input);
  if(new TextEncoder().encode(encoded).byteLength>8388608)throw Error('PREPARATION_LIMIT');
  return encoded;
}
export function readPreparation(bytes:Uint8Array):unknown{
  if(bytes.byteLength>8388608)throw Error('PREPARATION_LIMIT');
  const value:unknown=decodePreparedJson(bytes);
  if(!validatePreparation(value))throw Error('PREPARATION_INVALID');
  return value;
}
/** Association check relative to a separately preserved operation, not a payload hash. */
export function resourceSelectionMatches(expected:unknown,observed:unknown):boolean{
  const selection=closed({antecedent:exactReference,element_id:identifier,resource:artifactReference});
  if(!array(selection)(expected)||!array(selection)(observed))return false;
  const a=expected as Record<string,unknown>[],b=observed as Record<string,unknown>[];
  return a.length===b.length&&a.every((x,i)=>same(x.antecedent,b[i].antecedent)&&x.element_id===b[i].element_id&&
    ['id','generation','bytes','sha256'].every(k=>(x.resource as Record<string,unknown>)[k]===(b[i].resource as Record<string,unknown>)[k]));
}
const response=(fields:Record<string,Rule>):Rule=>closed({profile:choice('intake/1'),...fields});
const offeredProfile=closed({
  format_profile:choice('text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1'),
  revision, operational:choice(false), input_bytes:integer,
  implemented:choice(true,false),enabled:choice(false),authorized:choice('yes','no','unverified'),executable:choice('no'),
});
const reservation=response({operation_id:identifier,state:choice('reserved'),attempt:closed({id:identifier,revision,generation:revision})});
const staged=response({operation_id:identifier,state:choice('staged'),attempt:closed({id:identifier,revision,generation:revision})});
const receipt=response({operation_id:identifier,original:artifactReference,state:choice('received'),available:choice(true,false)});
const extraction=response({extraction:exactReference,original:artifactReference,inventory:choice('known','unknown'),components:array(component,10000),incidents:array(incident,10000)});
const proposal=response({proposal:exactReference,preparation:exactReference,selected:array(identifier,10000),disposition:choice('new','successor','relationship')});
const constitution=response({operation_id:identifier,effect:exactReference,outcome:choice('constituted','relationship_recorded','blocked'),candidates:array(exactReference)});
const problem=closed({profile:choice('intake/1'),type:choice('about:blank'),title:choice('Unavailable'),status:choice(404),code:choice('unavailable')});
/** Public projections only; proof of current disclosure admission stays in the service. */
export const INTAKE_RESPONSES:Record<IntakeRoute,Rule>={
 profiles:response({profiles:array(offeredProfile,4)}),
 reserve_reception:reservation,upload_original:staged,finalize_reception:INTAKE_RESPONSE,
 lookup_operation:INTAKE_RESPONSE,resume_reception:reservation,cancel_reception:INTAKE_RESPONSE,
 reception:receipt,original:v=>v instanceof Uint8Array&&v.byteLength<=1048576,extraction,
 reserve_preparation:reservation,upload_preparation:staged,finalize_preparation:INTAKE_RESPONSE,
 preparation:response({preparation:validatePreparation}),
 resource:v=>v instanceof Uint8Array&&v.byteLength<=8388608,
 difference:response({difference}),propose:proposal,constitute:constitution,
};
export function validateIntakeProjection(route:IntakeRoute,value:unknown):boolean{
 if(problem(value))return true;
 const rule=INTAKE_RESPONSES[route];if(!rule||!rule(value))return false;
 if(record(value)&&value.profile==='intake/1'&&value.state!==undefined&&INTAKE_RESPONSE(value)){
   return value.state==='known_effect'?exactReference(value.effect):value.effect===null;
 }
 if(route==='constitute'&&record(value)&&value.outcome!=='constituted')return (value.candidates as unknown[]).length===0;
 return true;
}
