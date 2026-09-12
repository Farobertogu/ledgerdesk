import {INTAKE_ROUTES, INTAKE_LIMITS, closed, array, choice, identifier, revision, artifactReference, exactReference, text, record, type Rule} from './intake.ts';

export const BINDING_PROFILE = 'intake-binding/2' as const;
type Definition = {basis:string; effect:string; holder:string; modes:readonly string[]; parent:string|null; reads:readonly string[]; treatment:readonly string[]; projection:string; point:string; resolution:string};
const definition = (basis:string,effect:string,holder:string,modes:string[],parent:string|null,reads:string[],treatment:string[],projection:string,point:string,resolution='catalog-entry'):Definition =>
  ({basis,effect,holder,modes,parent,reads,treatment,projection,point,resolution});
const person=['person'], continuation=['authorized_consequence'];
const view=(projection:string,reads:string[],treatment:string[]=[])=>definition('LEER_PARTICION_GOBERNADA','disclose-'+projection,'FN-ACCESO',person,null,reads,treatment,projection,'protected-read-and-handoff','partition-and-purpose');
/** Effect specifications, not permission IDs and not an admission decision. */
export const BINDINGS:Record<string,Definition>=Object.freeze({
 profiles:definition('existing-capability-projection','disclose-visible-intake-surfaces','FN-ACCESO',person,null,[],[], 'visible-profiles','projection-and-handoff','existing-surface'),
 reserve_reception:definition('CARGAR_MATERIAL','reserve-one-original','FN-APROBACION',person,null,[],['capture','conserve'],'reservation','reservation-commit'),
 upload_original:definition('CARGAR_MATERIAL','stage-exact-original-attempt','FN-APROBACION',person,'reserve_reception',[],['capture','conserve'],'staged','first-byte-and-staging'),
 finalize_reception:definition('CARGAR_MATERIAL','commit-one-receipt-and-job','FN-APROBACION',person,'reserve_reception',['staged-original'],['read','conserve','process'],'operation','receipt-commit'),
 lookup_operation:definition('VER_EL_REGISTRO','disclose-owned-intention-result','FN-ACCESO',person,null,['operation-record'],[],'operation','record-read-and-handoff','record-partition'),
 resume_reception:definition('CARGAR_MATERIAL','advance-attempt-after-authoritative-absence','FN-APROBACION',person,'reserve_reception',['operation-record'],['capture','conserve','process'],'reservation','generation-commit'),
 cancel_reception:definition('CARGAR_MATERIAL','stop-uncompleted-dependent-work','FN-APROBACION',person,'reserve_reception',['operation-record'],[],'operation','stop-commit','declared-subtractive-containment'),
 reception:definition('VER_EL_REGISTRO','disclose-receipt-without-body','FN-ACCESO',person,null,['receipt-record'],[],'receipt','record-read-and-handoff','record-partition'),
 original:view('whole-original',['whole-original'],['read','deliver']),
 extraction:view('extraction',['extraction','visible-component-incidents'],['read','deliver']),
 reserve_preparation:definition('existing-internal-prepare-candidate-material','reserve-exact-preparation','FN-APROBACION',person,null,['selected-antecedents'],['read','modify','conserve'],'reservation','antecedent-read-and-reservation','M04-D02-effect-comparison'),
 upload_preparation:definition('existing-internal-prepare-candidate-material','stage-exact-prepared-payload','FN-APROBACION',continuation,'reserve_preparation',[],['capture','conserve'],'staged','first-byte-and-staging','M04-D02-effect-comparison'),
 finalize_preparation:definition('existing-internal-prepare-candidate-material','persist-exact-new-preparation-revision','FN-APROBACION',person,'reserve_preparation',['selected-antecedents','selected-resources','exact-difference-pairs'],['read','modify','conserve'],'operation','preparation-commit','M04-D02-effect-comparison'),
 preparation:view('preparation',['exact-preparation','visible-differences'],['read','deliver']),
 resource:view('selected-resource',['authorized-preparation-association','selected-resource'],['read','deliver']),
 difference:view('difference',['exact-difference-pair','permitted-antecedents'],['read','deliver']),
 propose:definition('existing-internal-prepare-candidate-material','freeze-closed-constitution-proposal','FN-APROBACION',person,null,['exact-preparation','indispensable-context','selected-resources','exact-difference-pairs'],['read','conserve'],'proposal','proposal-commit','M04-D02-effect-comparison'),
 constitute:definition('CONSTITUIR_CANDIDATA','constitute-exact-proposal-or-C9-disposition','FN-APROBACION',['person','authorized_consequence'],null,['exact-proposal','exact-preparation','selected-resources','exact-difference-pairs'],['read','conserve'],'constitution','E_constitute'),
 dispatch_extraction:definition('intake-extraction-resolution/1','dispatch-bounded-extraction','FN-APROBACION',[],'finalize_reception',['whole-original'],['read','process','processor-destination'],'worker-request','before-original-read-and-dispatch','admitted-processing'),
 accept_extraction_result:definition('intake-extraction-resolution/1','accept-current-worker-result','FN-APROBACION',[],'dispatch_extraction',['worker-output','selected-resources','exact-antecedents'],['read','process','conserve'],'extraction','E_accept','admitted-processing'),
});

const selector=closed({id:identifier,revision});
const signature=closed({objects:array(identifier),transitions:array(identifier),purpose:identifier,affected:array(identifier),surfaces:array(identifier),autonomy:choice('person','authorized_consequence','fixed_processing_plan'),limits:exactReference,residues:array(identifier)});
/** Normative source identities, not seeded catalog/permission rows or runtime authority. */
export const PROCESSING_RESOLUTION = Object.freeze({
 profile:'intake-extraction-resolution/1', operation:'analizar', recordOperation:'conservar estados',
 sources:[
  {document:'B1',sha256:'74d403954d20927dabc4cc7868f88234cb2ef3da1a1a4f978003aedd1ab72341',sections:['3.4','4.1','4.2','4.3']},
  {document:'C2_C3_C4_C7_C8_C11_C12',sha256:'cdcbe3fc244e2e8dc50e93418a6c4bf3036ca535f5a2aec650fe18db44c7d213',sections:['2.1','2.3','2.5','5.3']},
  {document:'G11',sha256:'3e89fef33aff9987f0e6b316d375a48a5351b8369a1499c16899c84ea548767e',sections:['1','2','3.1','3.2']},
 ],
 scope:'exact-snapshot-extraction-only',adoption:'synthetic-contract-not-operational-admission',
});
const original:Rule=v=>artifactReference(v)&&record(v)&&(v.bytes as number)<=INTAKE_LIMITS.originalBytes;
const load=closed({code:choice('CARGAR_MATERIAL'),mode:choice('person'),person:exactReference,intention:exactReference,
 original,format:choice('text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1'),configuration:exactReference,
 destination:exactReference,limits:exactReference,session:exactReference,receipt_effect:exactReference});
const phase=closed({executor:exactReference,reservation:exactReference,attempt:revision,predecessor:exactReference});
const work=closed({id:exactReference,generation:revision,originating_act:exactReference,receipt:exactReference,request:exactReference,
 plan:exactReference,worker:exactReference,acceptance_effect:exactReference,expires_at:revision,
 session_dependency:choice('origin_session','independent_of_origin_session')});
const authorization=closed({act:exactReference,express_authorization:exactReference,target:exactReference});
const common={
 profile:choice(BINDING_PROFILE),operation:choice(...Object.keys(BINDINGS)),catalog:exactReference,
 entry:selector,basis:text(128),effect:text(128),holder:text(128),
 permission:selector,faculty:choice('exercise'),support:selector,scope:selector,purpose:identifier,route:exactReference,treatment:exactReference,
 admission:exactReference,signature,view_partitions:array(selector),
};
const loadOperations=['reserve_reception','upload_original','finalize_reception','resume_reception','cancel_reception'];
const processingOperations=['dispatch_extraction','accept_extraction_result'];
const generic=closed({...common,operation:choice(...Object.keys(BINDINGS).filter(op=>!loadOperations.includes(op)&&!processingOperations.includes(op))),kind:choice('act'),mode:choice('person','authorized_consequence')},{predecessor:exactReference,authorization,comparison:exactReference});
const personal=closed({...common,operation:choice(...loadOperations),kind:choice('personal_load_phase'),mode:choice('person'),load,phase},{comparison:exactReference});
const processing=closed({...common,operation:choice(...processingOperations),kind:choice('admitted_processing_phase'),load,phase,work,resolution:v=>equal(v,PROCESSING_RESOLUTION)}, {result:artifactReference});
export const BINDING_DECLARATION:Rule=v=>generic(v)||personal(v)||processing(v);

/** An exact effect realization of the pinned constraints, not an admission engine. */
export function processingSignature(operation:string,context:Record<string,unknown>){
 if(!processingOperations.includes(operation)||!load(context.load)||!phase(context.phase)||!work(context.work))return null;
 const l=context.load as Record<string,unknown>, p=context.phase as Record<string,unknown>,w=context.work as Record<string,unknown>;
 return {
  objects:operation==='dispatch_extraction'?['receipt','original_snapshot','extraction_job']:['receipt','original_snapshot','extraction_job','extraction_result','coverage','component_incidents'],
  transitions:[operation==='dispatch_extraction'?'dispatch-bounded-extraction':'accept-current-worker-result'],purpose:context.purpose,
  affected:[(l.person as Record<string,unknown>).id,(p.executor as Record<string,unknown>).id,(w.worker as Record<string,unknown>).id,(l.destination as Record<string,unknown>).id],
  surfaces:['assigned-worker-channel','authorized-operation-status','authorized-extraction'],autonomy:'fixed_processing_plan',limits:l.limits,
  residues:['isolated-original','bounded-worker-output','technical-evidence'],
 };
}

/** Validates resolved server catalog data; it performs no session/grant evaluation. */
export function bindingConsistent(value:unknown,current:unknown):boolean{
 if(!BINDING_DECLARATION(value)||!record(value)||!record(current))return false;
 const d=BINDINGS[value.operation as string];
 const isLoad=loadOperations.includes(value.operation as string),isWork=processingOperations.includes(value.operation as string);
 if(value.kind!==(isLoad?'personal_load_phase':isWork?'admitted_processing_phase':'act'))return false;
 if(value.basis!==d.basis||value.effect!==d.effect||value.holder!==d.holder||(!isWork&&!d.modes.includes(value.mode as string)))return false;
 if(isLoad&&(value.basis!=='CARGAR_MATERIAL'||value.mode!=='person'))return false;
 if(!isLoad&&!isWork){
  if((d.parent!==null)!==Object.hasOwn(value,'predecessor'))return false;
  if((value.mode==='authorized_consequence')!==Object.hasOwn(value,'authorization'))return false;
 }
 if((d.resolution==='M04-D02-effect-comparison'||d.resolution==='declared-subtractive-containment')&&!exactReference(value.comparison))return false;
 if(!closed({deployment:identifier,catalog:exactReference,entry:selector,permission:selector,support:selector,scope:selector,purpose:identifier,route:exactReference,treatment:exactReference,admission:exactReference,signature,view_partitions:array(selector)},
  {predecessor:exactReference,authorization,comparison:exactReference,load,phase,work,resolution:v=>equal(v,PROCESSING_RESOLUTION),result:artifactReference})(current))return false;
 for(const key of ['catalog','entry','permission','support','scope','purpose','route','treatment','admission']){
   if(!equal(value[key],current[key]))return false;
 }
 const s=value.signature as Record<string,unknown>;
 if(s.autonomy!==(isWork?'fixed_processing_plan':value.mode)||s.purpose!==value.purpose)return false;
 if(!equal(s.transitions,[d.effect])||!(s.objects as unknown[]).length||!(s.affected as unknown[]).length||!(s.surfaces as unknown[]).length)return false;
 if(isWork){
  if(!equal(s,processingSignature(value.operation as string,value)))return false;
  const w=value.work as Record<string,unknown>,l=value.load as Record<string,unknown>;
  if(sameId(w.acceptance_effect,l.receipt_effect)||sameId(w.id,l.intention)||sameId(w.worker,l.person))return false;
  if((value.operation==='accept_extraction_result')!==Object.hasOwn(value,'result'))return false;
 }
 if(isLoad||isWork){
  const l=value.load as Record<string,unknown>,p=value.phase as Record<string,unknown>;
  if(sameId(l.person,p.executor)||!equal(s.limits,l.limits))return false;
 }
 for(const key of ['signature','view_partitions','predecessor','authorization','comparison','load','phase','work','resolution','result'])if(!equal(value[key],current[key]))return false;
 return d.resolution!=='partition-and-purpose'&&d.resolution!=='record-partition'||(value.view_partitions as unknown[]).length>0;
}

/** Obligations only: no booleans here authorize protected reads or durable effects. */
export function bindingRequirements(value:unknown,disposition:'new'|'known'|'incompatible'|'uncertain'){
 if(!BINDING_DECLARATION(value)||!record(value))throw Error('BINDING_SHAPE');
 const base=operationRequirements(value.operation as string,disposition);
 if(disposition!=='new')return {...base,checks:['current-query-authority'],dispatch:false,reactivate:false};
 const isWork=value.kind==='admitted_processing_phase';
 return {...base,checks:[...(!isWork||((value.work as Record<string,unknown>).session_dependency==='origin_session')?['current-origin-session']:[]),
  'current-exercise-authority','current-support','current-treatment','current-route','before-protected-read','before-effect',
  ...(isWork?['current-service-assignment','current-job-generation','current-processing-authority','job-expiry']:[])],
  sessionDisconnect:'not-revocation',history:'preserve-receipt',temporalConformity:'not-established'};
}
function equal(a:unknown,b:unknown):boolean{
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
 if(record(a)&&record(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
 return a===b;
}
function sameId(a:unknown,b:unknown):boolean{return record(a)&&record(b)&&a.id===b.id;}

/** Each operation has separate query/new-effect requirements; no authorization booleans. */
export function operationRequirements(operation:string,disposition:'new'|'known'|'incompatible'|'uncertain'){
 const d=BINDINGS[operation];if(!d)throw Error('BINDING_OPERATION');
 if(!['new','known','incompatible','uncertain'].includes(disposition))throw Error('BINDING_DISPOSITION');
 if(disposition==='known')return {effect:'none',binding:'lookup_operation',disclose:'current-query-only',preserve:'historical-effect'} as const;
 if(disposition==='incompatible')return {effect:'none',binding:'lookup_operation',disclose:'permitted-conflict',preserve:'original-intention'} as const;
 if(disposition==='uncertain')return {effect:'none',binding:'lookup_operation',disclose:'permitted-uncertainty',preserve:'pending-reconciliation'} as const;
 return {effect:d.effect,binding:operation,disclose:d.projection,preserve:'logical-intention'};
}
export function bindingInventoryComplete():boolean{
 return Object.keys(INTAKE_ROUTES).every(key=>Object.hasOwn(BINDINGS,key))&&Object.keys(BINDINGS).length===Object.keys(INTAKE_ROUTES).length+2;
}
