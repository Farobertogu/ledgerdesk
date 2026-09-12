import {ref,resource} from './fixtures.mjs';
// Independent expected inventory and effects, not obtained from BINDINGS.
export const rows={
 profiles:['existing-capability-projection','disclose-visible-intake-surfaces','FN-ACCESO'],
 reserve_reception:['CARGAR_MATERIAL','reserve-one-original','FN-APROBACION'],
 upload_original:['CARGAR_MATERIAL','stage-exact-original-attempt','FN-APROBACION'],
 finalize_reception:['CARGAR_MATERIAL','commit-one-receipt-and-job','FN-APROBACION'],
 resume_reception:['CARGAR_MATERIAL','advance-attempt-after-authoritative-absence','FN-APROBACION'],
 cancel_reception:['CARGAR_MATERIAL','stop-uncompleted-dependent-work','FN-APROBACION'],
 lookup_operation:['VER_EL_REGISTRO','disclose-owned-intention-result','FN-ACCESO'],
 reception:['VER_EL_REGISTRO','disclose-receipt-without-body','FN-ACCESO'],
 original:['LEER_PARTICION_GOBERNADA','disclose-whole-original','FN-ACCESO'],
 extraction:['LEER_PARTICION_GOBERNADA','disclose-extraction','FN-ACCESO'],
 reserve_preparation:['existing-internal-prepare-candidate-material','reserve-exact-preparation','FN-APROBACION'],
 upload_preparation:['existing-internal-prepare-candidate-material','stage-exact-prepared-payload','FN-APROBACION'],
 finalize_preparation:['existing-internal-prepare-candidate-material','persist-exact-new-preparation-revision','FN-APROBACION'],
 preparation:['LEER_PARTICION_GOBERNADA','disclose-preparation','FN-ACCESO'],
 resource:['LEER_PARTICION_GOBERNADA','disclose-selected-resource','FN-ACCESO'],
 difference:['LEER_PARTICION_GOBERNADA','disclose-difference','FN-ACCESO'],
 propose:['existing-internal-prepare-candidate-material','freeze-closed-constitution-proposal','FN-APROBACION'],
 constitute:['CONSTITUIR_CANDIDATA','constitute-exact-proposal-or-C9-disposition','FN-APROBACION'],
 dispatch_extraction:['intake-extraction-resolution/1','dispatch-bounded-extraction','FN-APROBACION'],
 accept_extraction_result:['intake-extraction-resolution/1','accept-current-worker-result','FN-APROBACION'],
};
export const loads=['reserve_reception','upload_original','finalize_reception','resume_reception','cancel_reception'];
export const workers=['dispatch_extraction','accept_extraction_result'];
const compared=['reserve_preparation','upload_preparation','finalize_preparation','propose','cancel_reception'];
export const selector=id=>({id,revision:1});
export const resolution={
 profile:'intake-extraction-resolution/1',operation:'analizar',recordOperation:'conservar estados',
 sources:[
  {document:'B1',sha256:'74d403954d20927dabc4cc7868f88234cb2ef3da1a1a4f978003aedd1ab72341',sections:['3.4','4.1','4.2','4.3']},
  {document:'C2_C3_C4_C7_C8_C11_C12',sha256:'cdcbe3fc244e2e8dc50e93418a6c4bf3036ca535f5a2aec650fe18db44c7d213',sections:['2.1','2.3','2.5','5.3']},
  {document:'G11',sha256:'3e89fef33aff9987f0e6b316d375a48a5351b8369a1499c16899c84ea548767e',sections:['1','2','3.1','3.2']},
 ],scope:'exact-snapshot-extraction-only',adoption:'synthetic-contract-not-operational-admission',
};
function facts(operation,mode){
 const isLoad=loads.includes(operation),isWork=workers.includes(operation);
 const s={objects:['exact-object'],transitions:[rows[operation][1]],purpose:'synthetic-purpose',affected:['P-17'],surfaces:['exact-route'],autonomy:mode,limits:ref('limits'),residues:[]};
 const f={signature:s,view_partitions:[selector('permitted-partition')]};
 if(compared.includes(operation))f.comparison=ref('individual-effect-comparison');
 if(isLoad||isWork){
  f.load={code:'CARGAR_MATERIAL',mode:'person',person:ref('P-17'),intention:ref('I-17'),original:resource('O-17',1),format:'text-utf8/1',configuration:ref('config'),destination:ref('local-parser'),limits:ref('limits'),session:ref('S-17'),receipt_effect:ref('E-receipt-17')};
  f.phase={executor:ref('service-17'),reservation:ref('Q-17'),attempt:3,predecessor:ref(isWork?'receipt-event-17':'reservation-event-17')};
 }
 if(isWork){
  f.work={id:ref('W-17'),generation:1,originating_act:ref('L-17'),receipt:ref('R-17'),request:ref('processing-request-17'),plan:ref('PP-17'),worker:ref('worker-17'),acceptance_effect:ref('E-accept-17'),expires_at:2000,session_dependency:'independent_of_origin_session'};
  f.resolution=structuredClone(resolution);
  f.signature={objects:operation==='dispatch_extraction'?['receipt','original_snapshot','extraction_job']:['receipt','original_snapshot','extraction_job','extraction_result','coverage','component_incidents'],
   transitions:[rows[operation][1]],purpose:'synthetic-purpose',affected:['P-17','service-17','worker-17','local-parser'],surfaces:['assigned-worker-channel','authorized-operation-status','authorized-extraction'],
   autonomy:'fixed_processing_plan',limits:ref('limits'),residues:['isolated-original','bounded-worker-output','technical-evidence']};
  if(operation==='accept_extraction_result'){f.result=resource('X-17');f.phase.predecessor=ref('dispatch-event-17');}
 }else if(!isLoad){
  if(['upload_preparation','finalize_preparation'].includes(operation))f.predecessor=ref('preparation-reservation');
  if(mode==='authorized_consequence')f.authorization={act:ref('actual-human-act'),express_authorization:ref('explicit-authorization'),target:ref('exact-proposal')};
 }
 return f;
}
export function pair(operation,mode=operation==='upload_preparation'?'authorized_consequence':'person'){
 const [basis,effect,holder]=rows[operation];
 const common=()=>({catalog:ref('catalog'),entry:selector('resolved-entry'),permission:selector('resolved-permission'),support:selector('resolved-support'),scope:selector('receiving-scope'),purpose:'synthetic-purpose',route:ref('route'),treatment:ref('treatment'),admission:ref('admission')});
 const binding={profile:'intake-binding/2',operation,...common(),faculty:'exercise',basis,effect,holder,
  kind:loads.includes(operation)?'personal_load_phase':workers.includes(operation)?'admitted_processing_phase':'act',
  ...(!workers.includes(operation)?{mode}:{}),...facts(operation,mode)};
 // Construct from independent input facts, not by copying binding.signature to current.
 const current={deployment:'synthetic-deployment',...common(),...facts(operation,mode)};
 return {binding,current};
}
