import {readFileSync} from 'node:fs';
import {catalog,configuration,limits,ref} from '../t02/fixtures.mjs';
import {BINDINGS} from '../../../src/contracts/intake_bindings.ts';

export const processingTreatment=ref('intake-extraction-treatment-1');
export const plan=ref('bounded-extraction-plan-1'),request=ref('bounded-extraction-request-1');
export const worker={id:'bounded-extraction-worker-3',revision:1,sha256:process.env.LEDGERDESK_EXTRACTION_SOURCE_SHA256??'7585de532da8f99de93eb4a80e13f54a45a6a45752057ac905c7a1d75d16f1c0'};
export const executor=ref('declared-extraction-executor-1');
/** Installs controlled declarations only. The invitation has already granted the separate faculty. */
export async function extractionControl(env,{allFormats=false}={}){
  // The trusted harness checks source bytes inside the built image before
  // installing this declaration. Parser sources/dependencies are not copied
  // into the runtime, and no metadata from a reply selects its own authority.
  if(!/^[a-f0-9]{64}$/.test(process.env.LEDGERDESK_EXTRACTION_SOURCE_SHA256??'')||
    !/^sha256:[a-f0-9]{64}$/.test(process.env.LEDGERDESK_EXTRACTION_IMAGE??''))throw Error('EXTRACTION_CONTROLLED_SOURCE');
  for(const file of ['004_extraction_control.sql','005_extraction_data.sql','006_extraction_fence.sql','007_extraction_capacity.sql'])
    await env.admin.query(readFileSync(new URL('../../../src/server/intake/postgres/'+file,import.meta.url),'utf8'));
  const account=(await env.admin.query("SELECT * FROM access_trial.account WHERE office IS NULL")).rows;
  if(account.length!==1)throw Error('EXTRACTION_FIXTURE_ACCOUNT');
  const person=account[0];
  for(const operation of ['dispatch_extraction','accept_extraction_result']){
    // Independent literal expectation, not processingSignature(output-of-the-system).
    const signature={objects:operation==='dispatch_extraction'?['receipt','original_snapshot','extraction_job']:
      ['receipt','original_snapshot','extraction_job','extraction_result','coverage','component_incidents'],
      transitions:[operation==='dispatch_extraction'?'dispatch-bounded-extraction':'accept-current-worker-result'],purpose:'synthetic-reading-trial',
      affected:[person.person_ref,executor.id,worker.id,'storage'],
      surfaces:['assigned-worker-channel','authorized-operation-status','authorized-extraction'],autonomy:'fixed_processing_plan',limits,
      residues:['isolated-original','bounded-worker-output','technical-evidence']};
    await env.admin.query('INSERT INTO intake_control.catalog_entry VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,true)',
      [operation,catalog,BINDINGS[operation],signature,ref('source-comparison-'+operation),'intake_processing','organisation',
        'synthetic-reading-trial','extraction_record',ref('route-'+operation)]);
  }
  await env.admin.query('INSERT INTO intake_control.catalog_entry VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,true)',
    ['extraction',catalog,BINDINGS.extraction,{objects:['receipt','extraction'],transitions:['disclose-extraction'],purpose:'synthetic-reading-trial',
      affected:['admitted-query-population'],surfaces:['current-session-origin'],autonomy:'person',limits,residues:['evidence']},
      ref('source-comparison-extraction'),'intake_extraction_read','organisation','synthetic-reading-trial','extraction_content',ref('route-extraction')]);
  await env.admin.query('INSERT INTO intake_control.treatment VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [processingTreatment.id,processingTreatment.sha256,'organisation','synthetic-reading-trial',
      ['intake-metadata','original-body','extraction-body'],['capture','conserve','read','process','deliver','processor-destination'],
      {reference:ref('receiver'),function:'FN-AMBITO',responsible_person:'synthetic-operator',coverage:'first-receiver'},
      {reference:ref('storage'),kind:'private-object-broker'},
      {reference:ref('processors'),kind:'bounded-intake-workers',verification:{kind:'bounded-form-verifier',reference:ref('verifier')},
        extraction:{kind:'bounded-extraction-worker',reference:worker}},
      {reference:ref('delivery'),kind:'current-session-origin'},'destroy-owned-trial',env.root.termination.at-1000]);
  await env.admin.query('SELECT intake_control.set_treatment($1,1,true)',[processingTreatment.id]);
  await env.admin.query('UPDATE intake_control.profile SET processing_request=$1,processing_plan=$2',[request,plan]);
  const image=process.env.LEDGERDESK_EXTRACTION_IMAGE;if(!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error('EXTRACTION_FIXTURE_IMAGE');
  await env.admin.query('INSERT INTO intake_control.processing_declaration VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    ['text-extraction-1','b'.repeat(64),'text-utf8/1',configuration,limits,request,plan,ref('worker-assignment-1'),worker,person.id,executor,
      'organisation','synthetic-reading-trial','independent_of_origin_session',image,env.root.termination.at-1000]);
  await env.admin.query("SELECT intake_control.set_processing('text-utf8/1','text-extraction-1',1,$1,true)",['b'.repeat(64)]);
  if(allFormats)for(const [format,name,digest]of [['markdown-inert/1','markdown-extraction-1','d'],['csv-utf8/1','csv-extraction-1','e'],['xlsx-cells/1','xlsx-extraction-1','f']]){
    await env.admin.query(`INSERT INTO intake_control.processing_declaration SELECT $1,1,$2,$3,configuration,limits,
      request,plan,assignment,worker,executor_account,executor_reference,scope_ref,purpose_ref,session_dependency,image,expires_at
      FROM intake_control.processing_declaration WHERE id='text-extraction-1'`,[name,digest.repeat(64),format]);
    await env.admin.query('SELECT intake_control.set_processing($1,$2,1,$3,true)',[format,name,digest.repeat(64)]);
  }
  return {account:person};
}
