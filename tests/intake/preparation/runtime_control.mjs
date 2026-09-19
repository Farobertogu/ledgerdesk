import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {catalog,limits,ref} from '../t02/fixtures.mjs';
import {canonicalValue} from '../../../src/contracts/access_canonical.ts';
import {BINDINGS} from '../../../src/contracts/intake_bindings.ts';
import {extractionControl,processingTreatment} from '../extraction/runtime_control.mjs';

export const preparationTreatment=ref('intake-preparation-treatment-1');
export const preparationContext={scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:preparationTreatment};
// Independent controlled realization, fixed before any preparation producer runs.
// The setup does not import preparationSignature or preparationEffectComparison.
const rows=[
  ['reserve_preparation','intake_prepare','preparation_work',['accepted-inputs','bounded-preparation-attempt'],'reserve-exact-preparation'],
  ['upload_preparation','intake_prepare','preparation_work',['predecessor-reservation','exact-staged-document'],'stage-exact-prepared-payload'],
  ['finalize_preparation','intake_prepare','preparation_work',['accepted-inputs','staged-document','preparation-revision','differences','selected-resources'],'persist-exact-new-preparation-revision'],
  ['preparation','intake_prepared_read','prepared_content',['exact-preparation','visible-differences'],'disclose-preparation'],
  ['difference','intake_difference_read','preparation_difference',['exact-difference-pair','permitted-antecedents'],'disclose-difference'],
  ['resource','intake_resource_read','prepared_resource',['preparation-association','exact-resource'],'disclose-selected-resource'],
  ['propose','intake_prepare','preparation_work',['exact-preparation','closed-item','constitution-proposal'],'freeze-closed-constitution-proposal'],
  ['constitute','intake_constitute','constitution_work',['exact-proposal','exact-preparation','candidate-or-C9-outcome'],'constitute-exact-proposal-or-C9-disposition'],
];
const signature=(objects,effect,mode)=>({objects,transitions:[effect],purpose:'synthetic-reading-trial',
  affected:['current-principal','controlled-preparation-service','current-treatment-storage'],surfaces:['current-session-origin'],
  autonomy:mode,limits,residues:['retained-preparation-history','exact-source-references','technical-evidence']});

export async function preparationControl(env,{allFormats=false}={}){
  const controlled=await extractionControl(env,{allFormats});
  for(const file of ['008_preparation_data.sql','009_preparation_control.sql'])
    await env.admin.query(readFileSync(new URL('../../../src/server/intake/postgres/'+file,import.meta.url),'utf8'));
  for(const [operation,permission,partition,objects,effect]of rows){
    const mode=operation==='upload_preparation'?'authorized_consequence':'person';
    const value=signature(objects,effect,mode);
    const catalogSignature=operation==='constitute'?{person:value,authorized_consequence:signature(objects,effect,'authorized_consequence')}:value;
    const compared=['reserve_preparation','upload_preparation','finalize_preparation','propose'].includes(operation);
    const body=compared?{profile:'preparation-effect-comparison/1',operation,
      source:{document:'M04',sha256:'0ffce4be357f2d16f2abf205643117582bc168c3f442b8b10f2e8ec0dc47dd69',sections:['M04-C01','M04-C04','M04-C05','M04-C06','M04-D02']},
      responsibility:'existing-internal-prepare-candidate-material',holder:'FN-APROBACION',scope:'organisation',purpose:'synthetic-reading-trial',mode,
      signature:value,population:'currently-authorized-selected-antecedents',
      bound:{document_bytes:8388608,prepared_bytes:8388608,pool_bytes:67108864,attempts:32},
      excluded_effects:['constitute-candidate','approve','publish','alter-previous-version','grant-authority']}:null;
    const comparison=compared?{id:'compared-'+operation,revision:1,
      sha256:createHash('sha256').update(canonicalValue({domain:'preparation-comparison/1',body})).digest('hex')}:ref('comparison-'+operation);
    await env.admin.query('INSERT INTO intake_control.catalog_entry VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,true)',
      [operation,catalog,BINDINGS[operation],catalogSignature,comparison,permission,'organisation','synthetic-reading-trial',partition,ref('route-'+operation)]);
    if(compared)await env.admin.query('INSERT INTO intake_control.preparation_comparison VALUES($1,$2,$3,1,$4,$5,$6,true)',
      [operation,comparison,catalog,'organisation','synthetic-reading-trial',body]);
  }
  // A new exact treatment, not an in-place rewrite of the retained extraction treatment.
  await env.admin.query(`INSERT INTO intake_control.treatment
    SELECT $1,1,$2,scope_ref,purpose_ref,fields||ARRAY['preparation-body','constitution-authorization'],actions||ARRAY['modify'],
      receiver,storage,processor,response_destination,disposition_ref,expires_at
    FROM intake_control.treatment WHERE id=$3 AND revision=1`,
    [preparationTreatment.id,preparationTreatment.sha256,processingTreatment.id]);
  await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[preparationTreatment.id]);
  return controlled;
}
