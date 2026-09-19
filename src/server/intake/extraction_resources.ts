import {createHash} from 'node:crypto';
import {array,artifactReference,closed,identifier,record} from '../../contracts/intake.ts';
import {INTAKE_RELATION} from '../../contracts/intake_artifact.ts';
import {EXTRACTION_CONTENT} from '../../contracts/intake_extraction_view.ts';
import {EXTRACTION_BOUNDS,type Artifact,type WorkerBinding} from '../../contracts/intake_extraction.ts';
import type {ExtractionMaterial} from './extraction_output.ts';

type Selection={element_id:string;resource:Artifact};
export type ResourceBoundaryReference={original:Artifact;selections:Selection[];relations:Record<string,unknown>[]};
/** Trusted, explicitly instrumented boundary. Native adapters do not implement
 * this port and no public request can select it or supply its reference. */
export type ResourceBoundaryPort={reference:ResourceBoundaryReference;
  observation:()=>Promise<unknown>;read:(resource:Artifact)=>Promise<Buffer>};
const selection=closed({element_id:identifier,resource:artifactReference});
const reference=closed({original:artifactReference,selections:array(selection,8),relations:array(INTAKE_RELATION,8)});
const observation=closed({original:artifactReference,selections:array(selection,8),relations:array(INTAKE_RELATION,8),resources:array(artifactReference,8)});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function same(a:any,b:any):boolean{
  if(Object.is(a,b))return true;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>same(x,b[i]));
  return record(a)&&record(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
}
/** Validate all associations before the first protected resource body read.
 * Metadata comes from a producer; the expectation comes from the admitted
 * operation, fixed independently before that producer ran. Neither is authority. */
export async function integrateResourceBoundary(material:ExtractionMaterial,binding:WorkerBinding,port:ResourceBoundaryPort,
  beforeRead:()=>Promise<void>):Promise<ExtractionMaterial>{
  const expected=structuredClone(port.reference);
  if(!reference(expected)||!same(expected.original,binding.original))throw Error('EXTRACTION_RESOURCE_REFERENCE');
  const value=await port.observation();
  if(!observation(value)||!record(value))throw Error('EXTRACTION_RESOURCE_OBSERVATION');
  const found=structuredClone(value) as any;
  if(new Set(found.resources.map((r:Artifact)=>r.id)).size!==found.resources.length||
    new Set(found.selections.map((s:Selection)=>s.element_id)).size!==found.selections.length)throw Error('EXTRACTION_RESOURCE_DUPLICATE');
  if(!same(found.original,expected.original)||!same(found.selections,expected.selections)||!same(found.relations,expected.relations)||
    !same(found.resources,found.selections.map((s:Selection)=>s.resource)))throw Error('EXTRACTION_RESOURCE_ASSOCIATION');
  const content=JSON.parse(material.normalized.toString('utf8'));
  if(!EXTRACTION_CONTENT(content)||content.resources.length||content.relations.length||material.outcome==='failed')throw Error('EXTRACTION_RESOURCE_BASE');
  const payloads=[];let total=0;
  for(const r of found.resources as Artifact[]){
    total+=r.bytes;if(total>65536)throw Error('EXTRACTION_RESOURCE_LIMIT');
  }
  for(const r of found.resources as Artifact[]){
    await beforeRead();const bytes=await port.read(structuredClone(r));
    if(bytes.length!==r.bytes||hash(bytes)!==r.sha256)throw Error('EXTRACTION_RESOURCE_INTEGRITY');
    payloads.push({artifact:r,data:bytes.toString('base64')});
  }
  content.resources=found.resources;
  content.elements.push(...found.selections.map((s:Selection)=>({id:s.element_id,kind:'resource',resource:s.resource,
    antecedents:[{antecedent:{id:binding.original.id,revision:binding.original.generation,sha256:binding.original.sha256},
      kind:'nonliteral',coordinates:'Instrumented resource-boundary association; not native extraction or editorial preparation'}]})));
  content.relations=found.relations;
  content.instrumented_resources={profile:'intake-resource-boundary/1',reference:expected,payloads};
  if(!EXTRACTION_CONTENT(content))throw Error('EXTRACTION_RESOURCE_CONTENT');
  const normalized=Buffer.from(JSON.stringify(content));
  if(normalized.length>EXTRACTION_BOUNDS.normalizedBytes||material.raw.length+normalized.length>EXTRACTION_BOUNDS.conservedBytes)
    throw Error('EXTRACTION_RESOURCE_CONSERVED_LIMIT');
  return {...material,normalized,normalizedSha256:hash(normalized),aggregateBytes:material.raw.length+normalized.length};
}
