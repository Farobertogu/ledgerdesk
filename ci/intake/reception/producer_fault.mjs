export const producerFaultGroups=Object.freeze({
  'original-selection':'neutrality','actual-digest':'runtime','actual-chunk-cap':'boundaries','type-recognition':'boundaries',
  'compatible-payload':'runtime','sealed-as-receipt':'runtime','whole-original-faculty':'authority','delivery-evidence':'runtime',
  'deferred-dispatch':'runtime','runtime-source':'runtime',
  'incomplete-activation':'runtime','old-generation':'runtime','overwrite-original':'runtime','release-delivery-admission':'delivery-order',
});
function once(text,anchor,replacement){if(text.split(anchor).length!==2)throw Error('PRODUCER_FAULT_ANCHOR: '+anchor);return text.replace(anchor,replacement);}
/** Deliberate captured-source mutations only; never imported by a product service. */
export function producerFaultCopy(relative,text,fault){
  if(relative==='src/server/intake/stream.ts'){
    if(fault==='old-generation')return once(text,'String(attempt.generation)!==request.parameters.generation||','');
    if(fault==='actual-digest')return once(text,"if(digest.digest('hex')!==original.sha256)throw new IntakeFailure(400);","digest.digest('hex');");
    if(fault==='actual-chunk-cap')return once(text,'Math.min(RECEPTION_BOUNDS.chunkBytes,stream.readableLength,request.contentLength-consumed)',
      'Math.min(131072,stream.readableLength,request.contentLength-consumed)');
  }
  if(relative==='ci/intake/reception/minimum_form.mjs'&&fault==='type-recognition')return once(text,
    "if(format==='xlsx-cells/1')await workbookIdentity(bytes);else strictUtf8(bytes);","if(format!=='xlsx-cells/1')strictUtf8(bytes);");
  if(relative==='src/server/intake/service.ts'){
    if(fault==='incomplete-activation'){
      // Compound activation fault: trust declared metadata instead of sealed bytes.
      // The paired SQL mutation removes the independent staged predecessor guard.
      const start="if(reception.stopped||reception.state!=='staged'||attempt.state!=='sealed')throw new IntakeFailure(409);";
      const end="if(!valid)throw new IntakeFailure(503);";
      const begin=text.indexOf(start),finish=text.indexOf(end,begin)+end.length;
      if(begin<0||finish<begin)throw Error('INCOMPLETE_ACTIVATION_ANCHOR');
      const original=text.slice(begin,finish);
      return once(text,original,`let artifact;
    const format=(await admission.db.query('SELECT * FROM intake_control.profile WHERE format=$1',[reception.format])).rows[0];
    if(reception.state==='interrupted'&&attempt.actual_bytes>0&&attempt.actual_bytes<reception.declaration.bytes){
      artifact={id:attempt.artifact_id,reception_id:reception.id,generation:attempt.generation,
        bytes:reception.declaration.bytes,sha256:reception.declaration.sha256};
      await admission.db.query('INSERT INTO $INTAKE.artifact VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [artifact.id,reception.id,artifact.generation,artifact.bytes,artifact.sha256,reception.format,
          this.config.namespace+':'+artifact.id+':'+artifact.generation,JSON.stringify({scope:'deliberate-incomplete-activation'}),await admission.db.now()]);
    }else{
      ${original.replace('const artifact=','artifact=').replace("    const format=(await admission.db.query('SELECT * FROM intake_control.profile WHERE format=$1',[reception.format])).rows[0];\n",'')}
    }`);
    }
    if(fault==='release-delivery-admission')return once(text,
      "await this.hooks.barrier?.('before_handoff',{route:request.route,evidenceId:event.id,backendPid:event.pid,operationId});",
      "if(request.route==='original')await admission.db.releaseAdmission();\n    await this.hooks.barrier?.('before_handoff',{route:request.route,evidenceId:event.id,backendPid:event.pid,operationId});");
    if(fault==='deferred-dispatch')return once(text,"'not_started',false]);","'not_started',true]);");
    if(fault==='original-selection')return once(text,"const originalContext=request.route==='original'?await this.authority.beforeOriginalSelection(admission):undefined;",'const originalContext=undefined;');
    if(fault==='compatible-payload')return once(text,'const compatible=intention.payload_digest===this.digest(canonical);','const compatible=true;');
    if(fault==='sealed-as-receipt')return once(text,'// A previous staging check is not current availability. Evidence commits before this open.',
      "const stagedIntention=(await admission.db.query(\"SELECT id FROM $INTAKE.intention WHERE reception_id=$1 AND variant='reserve_reception'\",[reception.id])).rows[0].id;\n    return this.prepared(admission,request,200,await projection(admission.db,reception,attempt,stagedIntention),stagedIntention);\n    // Deliberately report a sealed preparation as completion without the receipt transaction.");
    if(fault==='delivery-evidence')return once(text,"await admission.db.query(`INSERT INTO $INTAKE.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,",
      "if(!(kind==='delivery'&&route==='original'))await admission.db.query(`INSERT INTO $INTAKE.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,");
  }
  if(relative==='src/server/intake/postgres/002_data.sql'&&fault==='incomplete-activation')return once(text,
    "r.revision=expected_revision AND r.state='staged' AND NOT r.stopped",
    "r.revision=expected_revision AND r.state IN ('staged','interrupted') AND NOT r.stopped");
  if(relative==='ci/intake/reception/object_store.mjs'&&fault==='overwrite-original')return once(text,
    "const file=request.action==='read_stage'?stage:sealed;",
    `if(request.action==='read'&&original.sha256==='8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9'&&fs.existsSync(sealed)){
      const marker=prefix+'.t06-read';
      if(!fs.existsSync(marker))save(marker,Buffer.from('first sealed read'));
      else if(!fs.existsSync(marker+'.changed')){
        const before=fs.readFileSync(sealed),changed=Buffer.from(before);changed[changed.length-1]^=1;
        fs.chmodSync(sealed,0o600);const changedFd=fs.openSync(sealed,'r+');
        try{fs.writeFileSync(changedFd,changed);fs.fsyncSync(changedFd);}finally{fs.closeSync(changedFd);}
        fs.chmodSync(sealed,0o400);const observed=fs.readFileSync(sealed);
        const evidence={artifactId:original.id,beforeSha256:hash(before),afterSha256:hash(observed),bytes:observed.length};
        save(marker+'.changed',Buffer.from(JSON.stringify(evidence)));
        fs.appendFileSync('/output/t06-overwrites.ndjson',JSON.stringify(evidence)+'\\n',{mode:0o600});
      }
    }
    const file=request.action==='read_stage'?stage:sealed;`);
  if(relative==='ci/intake/T02.Dockerfile.dockerignore'&&fault==='runtime-source')return text+'\n# Deliberate omission from the actual runtime image context.\nsrc/server/intake/authority.ts\n';
  if(relative==='src/server/intake/authority.ts'&&fault==='whole-original-faculty'){
    text=once(text,"!authority.contains(entry.scope_ref, scopeId) || !authority.allows(actor, permission.id, 'exercise', scopeId)",
      "!authority.contains(entry.scope_ref, scopeId) || (operation!=='original'&&!authority.allows(actor, permission.id, 'exercise', scopeId))");
    return once(text,"g.faculty === 'exercise' && authority.contains(g.scope_ref, scopeId) && authority.grantAlive(g)",
      "g.faculty === 'exercise' && authority.contains(g.scope_ref, scopeId) && (operation==='original'||authority.grantAlive(g))");
  }
  return text;
}
