// Controlled setup declarations. These are not grants, receipts or product-produced effects.
export const ref = id => ({id,revision:1,sha256:'a'.repeat(64)});
export const configuration=ref('intake-configuration-1'),catalog=ref('intake-catalog-1'),limits=ref('intake-limits-1');
export const treatment=ref('intake-treatment-1');
export const permissionIds=['intake_load','intake_records','intake_original','intake_profiles'];
const rows=[
  ['profiles','existing-capability-projection','disclose-visible-intake-surfaces','FN-ACCESO',null,[],[],'visible-profiles','projection-and-handoff','existing-surface','intake_profiles','visible_surfaces'],
  ['reserve_reception','CARGAR_MATERIAL','reserve-one-original','FN-APROBACION',null,[],['capture','conserve'],'reservation','reservation-commit','catalog-entry','intake_load','personal_load'],
  ['upload_original','CARGAR_MATERIAL','stage-exact-original-attempt','FN-APROBACION','reserve_reception',[],['capture','conserve'],'staged','first-byte-and-staging','catalog-entry','intake_load','personal_load'],
  ['finalize_reception','CARGAR_MATERIAL','commit-one-receipt-and-job','FN-APROBACION','reserve_reception',['staged-original'],['read','conserve','process'],'operation','receipt-commit','catalog-entry','intake_load','personal_load'],
  ['lookup_operation','VER_EL_REGISTRO','disclose-owned-intention-result','FN-ACCESO',null,['operation-record'],[],'operation','record-read-and-handoff','record-partition','intake_records','own_record'],
  ['resume_reception','CARGAR_MATERIAL','advance-attempt-after-authoritative-absence','FN-APROBACION','reserve_reception',['operation-record'],['capture','conserve','process'],'reservation','generation-commit','catalog-entry','intake_load','personal_load'],
  ['cancel_reception','CARGAR_MATERIAL','stop-uncompleted-dependent-work','FN-APROBACION','reserve_reception',['operation-record'],[],'operation','stop-commit','declared-subtractive-containment','intake_load','personal_load'],
  ['reception','VER_EL_REGISTRO','disclose-receipt-without-body','FN-ACCESO',null,['receipt-record'],[],'receipt','record-read-and-handoff','record-partition','intake_records','own_record'],
  ['original','LEER_PARTICION_GOBERNADA','disclose-whole-original','FN-ACCESO',null,['whole-original'],['read','deliver'],'whole-original','protected-read-and-handoff','partition-and-purpose','intake_original','whole_original'],
];
export async function installControl(env,{omitOperations=[]}={}) {
  await env.admin.query('INSERT INTO intake_control.live VALUES(true,$1,true,1,1,$2,$3,$4,$5,$6)',
    ['live-control','intake-runtime-1',catalog,configuration,limits,env.root.termination.at-1000]);
  await env.admin.query("INSERT INTO intake_control.namespace_admission VALUES('intake_trial','live-control',1,NULL,true)");
  for(const [operation,basis,effect,holder,parent,reads,actions,projection,point,resolution,permission,partition] of rows) {
    if(omitOperations.includes(operation))continue;
    const definition={basis,effect,holder,modes:['person'],parent,reads,treatment:actions,projection,point,resolution};
    const signature={objects:['original','reception'],transitions:[effect],purpose:'synthetic-reading-trial',
      affected:['synthetic-recipient','intake-service:intake-runtime-1','synthetic-storage'],surfaces:['current-session-origin'],autonomy:'person',limits,residues:['original','evidence']};
    await env.admin.query('INSERT INTO intake_control.catalog_entry VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,true)',
      [operation,catalog,definition,signature,ref('source-comparison-'+operation),permission,'organisation','synthetic-reading-trial',partition,ref('route-'+operation)]);
  }
  await env.admin.query('INSERT INTO intake_control.treatment VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [treatment.id,treatment.sha256,'organisation','synthetic-reading-trial',['intake-metadata','original-body'],['capture','conserve','read','process','deliver'],
      {reference:ref('receiver'),function:'FN-AMBITO',responsible_person:'synthetic-operator',coverage:'first-receiver'},
      {reference:ref('storage'),kind:'private-object-broker'}, {reference:ref('processor'),kind:'bounded-form-verifier'},
      {reference:ref('delivery'),kind:'current-session-origin'},'destroy-owned-trial',env.root.termination.at-1000]);
  await env.admin.query('INSERT INTO intake_control.treatment_current VALUES(true,$1,1,true)',[treatment.id]);
  for(const format of ['text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1'])
    await env.admin.query('INSERT INTO intake_control.profile VALUES($1,$2,true,true,$3,$4)',[format,configuration,ref('future-request'),ref('fixed-plan')]);
}
