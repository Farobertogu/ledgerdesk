export const producerFaultGroups=Object.freeze({
  'original-selection':'neutrality','actual-digest':'runtime','actual-chunk-cap':'boundaries','type-recognition':'boundaries',
  'compatible-payload':'runtime','sealed-as-receipt':'runtime','whole-original-faculty':'authority','delivery-evidence':'runtime',
  'deferred-dispatch':'runtime','runtime-source':'runtime',
});
function once(text,anchor,replacement){if(text.split(anchor).length!==2)throw Error('PRODUCER_FAULT_ANCHOR: '+anchor);return text.replace(anchor,replacement);}
/** Deliberate captured-source mutations only; never imported by a product service. */
export function producerFaultCopy(relative,text,fault){
  if(relative==='src/server/intake/stream.ts'){
    if(fault==='actual-digest')return once(text,"if(digest.digest('hex')!==original.sha256)throw new IntakeFailure(400);","digest.digest('hex');");
    if(fault==='actual-chunk-cap')return once(text,'Math.min(RECEPTION_BOUNDS.chunkBytes,stream.readableLength,request.contentLength-consumed)',
      'Math.min(131072,stream.readableLength,request.contentLength-consumed)');
  }
  if(relative==='ci/intake/reception/minimum_form.mjs'&&fault==='type-recognition')return once(text,
    "if(format==='xlsx-cells/1')await workbookIdentity(bytes);else strictUtf8(bytes);","if(format!=='xlsx-cells/1')strictUtf8(bytes);");
  if(relative==='src/server/intake/service.ts'){
    if(fault==='deferred-dispatch')return once(text,"'not_started',false]);","'not_started',true]);");
    if(fault==='original-selection')return once(text,"const originalContext=request.route==='original'?await this.authority.beforeOriginalSelection(admission):undefined;",'const originalContext=undefined;');
    if(fault==='compatible-payload')return once(text,'const compatible=intention.payload_digest===this.digest(canonical);','const compatible=true;');
    if(fault==='sealed-as-receipt')return once(text,'// A previous staging check is not current availability. Evidence commits before this open.',
      "const stagedIntention=(await admission.db.query(\"SELECT id FROM $INTAKE.intention WHERE reception_id=$1 AND variant='reserve_reception'\",[reception.id])).rows[0].id;\n    return this.prepared(admission,request,200,await projection(admission.db,reception,attempt,stagedIntention),stagedIntention);\n    // Deliberately report a sealed preparation as completion without the receipt transaction.");
    if(fault==='delivery-evidence')return once(text,"await admission.db.query(`INSERT INTO $INTAKE.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,",
      "if(!(kind==='delivery'&&route==='original'))await admission.db.query(`INSERT INTO $INTAKE.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,");
  }
  if(relative==='ci/intake/T02.Dockerfile.dockerignore'&&fault==='runtime-source')return text+'\n# Deliberate omission from the actual runtime image context.\nsrc/server/intake/authority.ts\n';
  if(relative==='src/server/intake/authority.ts'&&fault==='whole-original-faculty'){
    text=once(text,"!authority.contains(entry.scope_ref, scopeId) || !authority.allows(actor, permission.id, 'exercise', scopeId)",
      "!authority.contains(entry.scope_ref, scopeId) || (operation!=='original'&&!authority.allows(actor, permission.id, 'exercise', scopeId))");
    return once(text,"g.faculty === 'exercise' && authority.contains(g.scope_ref, scopeId) && authority.grantAlive(g)",
      "g.faculty === 'exercise' && authority.contains(g.scope_ref, scopeId) && (operation==='original'||authority.grantAlive(g))");
  }
  return text;
}
