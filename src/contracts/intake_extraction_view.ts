import {array,artifactReference,choice,closed,exactReference,identifier,integer,record,revision,text,type Rule} from './intake.ts';
import {INTAKE_ELEMENT,INTAKE_RELATION,INTAKE_COMPONENT} from './intake_artifact.ts';
import {EXTRACTION_FORMATS,EXTRACTION_STATES,EXTRACTION_BOUNDS} from './intake_extraction.ts';

const incident=closed({id:identifier,component:identifier,cause:choice('unreadable','route_unoffered','technical_failure','unknown')},
  {detail:text(512),code:text(128)});
const range:Rule=v=>Array.isArray(v)&&v.length===2&&v.every(integer)&&v[0]<=v[1];
const compactText=closed({id:identifier,kind:choice('text'),text:text(1048576),
  original_range:closed({bytes:range,code_points:range})});
const extractionElement:Rule=v=>INTAKE_ELEMENT(v)||compactText(v);
const resourceSelection=closed({element_id:identifier,resource:artifactReference});
const resourceBoundary=closed({profile:choice('intake-resource-boundary/1'),
  reference:closed({original:artifactReference,selections:array(resourceSelection,8),relations:array(INTAKE_RELATION,8)}),
  payloads:array(closed({artifact:artifactReference,data:v=>typeof v==='string'&&v.length<=87384&&v.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(v)}),8)});
const contentShape=closed({profile:choice('intake-extraction-content/1'),original:artifactReference,source:exactReference,
  format_profile:choice(...EXTRACTION_FORMATS),outcome:choice('completed','partial','failed'),
  elements:array(extractionElement,EXTRACTION_BOUNDS.textElements),relations:array(INTAKE_RELATION,10000),resources:array(artifactReference,10000),
  components:array(INTAKE_COMPONENT,10000),incidents:array(incident,10000),inventory:choice('known','unknown'),current_use:choice('not_evaluated')},
  {instrumented_resources:resourceBoundary});
/** Structural consistency is not a semantic coverage oracle. */
export const EXTRACTION_CONTENT:Rule=value=>{
  if(!contentShape(value)||!record(value))return false;
  const p=value as Record<string,any>;
  if(p.instrumented_resources){
    const b=p.instrumented_resources;
    if(!['id','generation','bytes','sha256'].every(k=>b.reference.original[k]===p.original[k])||
      b.payloads.length!==p.resources.length||b.payloads.reduce((n:number,r:any)=>n+r.artifact.bytes,0)>65536||
      b.payloads.some((row:any,i:number)=>!['id','generation','bytes','sha256'].every(k=>row.artifact[k]===p.resources[i][k])))return false;
  }
  for(const key of ['elements','relations','resources','components','incidents'])
    if(new Set(p[key].map((r:any)=>r.id)).size!==p[key].length)return false;
  for(const element of p.elements){
    if(compactText(element)){
      if(!['text-utf8/1','markdown-inert/1'].includes(p.format_profile)||
        element.original_range.bytes[1]>p.original.bytes||element.original_range.code_points[1]>p.original.bytes)return false;
      continue;
    }
    for(const loc of element.antecedents){const r=loc.antecedent;
      if(![p.source,{id:p.original.id,revision:p.original.generation,sha256:p.original.sha256}].some(x=>x.id===r.id&&x.revision===r.revision&&x.sha256===r.sha256))return false;}
    if(element.kind==='resource'&&!p.resources.some((r:any)=>['id','generation','bytes','sha256'].every(k=>r[k]===element.resource[k])))return false;
  }
  if(p.relations.some((r:any)=>!p.elements.some((e:any)=>e.id===r.from)||!p.elements.some((e:any)=>e.id===r.to)))return false;
  if(p.incidents.some((i:any)=>!p.components.some((c:any)=>c.id===i.component&&c.incidents.includes(i.id))))return false;
  if(p.components.some((c:any)=>c.incidents.some((id:string)=>!p.incidents.some((i:any)=>i.id===id&&i.component===c.id))))return false;
  return true;
};
const job=closed({id:identifier,revision,state:choice(...EXTRACTION_STATES),attempt_generation:integer});
const result=closed({id:identifier,effect:exactReference,attempt_generation:revision,content:EXTRACTION_CONTENT});
const resultMetadata=closed({id:identifier,effect:exactReference,attempt_generation:revision});
export const EXTRACTION_RESPONSE:Rule=value=>{
  if(!closed({profile:choice('intake/1'),representation:choice('intake-extraction/1'),extraction:job,
    view:choice('metadata','content'),receipt:exactReference,original:artifactReference,result:v=>v===null||result(v)||resultMetadata(v)})(value)||!record(value))return false;
  const p=value as Record<string,any>;
  if((p.extraction.state==='accepted')!==(p.result!==null))return false;
  return p.result===null||p.result.attempt_generation===p.extraction.attempt_generation&&
    (p.view==='metadata'?resultMetadata(p.result):result(p.result)&&
    ['id','generation','bytes','sha256'].every(k=>p.original[k]===p.result.content.original[k]));
};
