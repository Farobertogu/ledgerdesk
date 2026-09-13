import path from 'node:path';
import { canonicalReference } from './canonical.mjs';
import { diagnosticInventory, digest, openBeneath, rows, shape, success } from './observation.mjs';

const id=x=>typeof x==='string' && x.length>0 && x.length<=512;
const nat=x=>Number.isSafeInteger(x) && x>=0;
const pos=x=>nat(x)&&x>0;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const bool=x=>typeof x==='boolean';
const str=x=>typeof x==='string';
const nullable=f=>x=>x===null||f(x);
const word=(...xs)=>x=>xs.includes(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const memberFields={name:id,bytes:nat,sha256:hash};
const targetFields={receptionId:nullable(id),artifactId:nullable(id),generation:nullable(pos),expectedRevision:nullable(pos)};
const rowSignature={bytes:nat,sha256:hash,rowCount:nat};
const keyVersion=x=>pos(x)||id(x);

function reference(c,o,locations) {
  const bytes=openBeneath(c,locations.fixtureRoot,`references/${o.caseId}/${o.variant}.json`,1048576,'independent-case-reference');
  let value;
  try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { c.ok(false,'independent-case-reference.valid-json'); }
  return value;
}
function nonempty(c,value,label) { c.ok(Array.isArray(value)&&value.length>0,`${label}.nonempty-evidence`); }
function distinct(c,xs,key,label) { c.eq(new Set(xs.map(x=>x[key])).size,xs.length,`${label}.unique-${key}`); }
function preserved(c,o,namespaces) {
  nonempty(c,o.preservedData,'preserved');
  rows(c,o.preservedData,{origin:word('independent-sql-observer','independent-file-observer'),label:id,namespace:id,objectRef:id,before:object,after:object},'preserved');
  for(const p of o.preservedData) {
    shape(c,p.before,rowSignature,'preserved.before');shape(c,p.after,rowSignature,'preserved.after');
    c.ok(p.before.rowCount>0||p.before.bytes>0,'preserved.populated-positive');
    c.eq(p.after,p.before,'preserved.exact-existing-data');
  }
  for(const ns of namespaces)c.ok(o.preservedData.some(x=>x.namespace===ns),'preserved.required-namespace');
}
function noDependentDelivery(c,o,since=0) {
  const subject=x=>o.interfaceRevision!==3||x.callId===o.input.subject.callId;
  const reads=o.storage.filter(x=>subject(x)&&x.atMs>=since&&['open','read'].includes(x.kind));
  const sends=o.transport.filter(x=>subject(x)&&x.atMs>=since&&x.kind==='handoff');
  c.eq([reads.length,sends.length],[0,0],'restoration.no-dependent-access-or-handoff');
}
function invocations(c,o,locations) {
  const ref=reference(c,o,locations);
  shape(c,ref,{executorRef:id,invocations:Array.isArray},'invocation-reference');
  nonempty(c,ref.invocations,'invocation-reference');
  nonempty(c,o.invocations,'invocations');nonempty(c,o.comparisons,'comparisons');
  rows(c,ref.invocations,{label:id,principal:id,clientKey:id,act:id,variant:id,target:object,canonicalProfile:word('canon_m09_1'),keyVersion,wireFile:id,canonicalFile:id},'invocation-reference.rows');
  rows(c,o.invocations,{origin:word('https-client-and-sql-observer'),label:id,principal:id,clientKey:id,act:id,variant:id,target:object,wireBodySha256:hash,canonicalPayloadSha256:hash,canonicalProfile:word('canon_m09_1'),keyVersion,operationId:id,storedPayloadDigest:hash,responseLabel:id},'invocations');
  rows(c,o.comparisons,{origin:word('canonical-comparison-boundary'),label:id,operationId:id,principal:id,act:id,variant:id,clientKey:id,canonicalProfile:word('canon_m09_1'),keyVersion,comparedCanonicalSha256:hash,storedPayloadDigest:hash,outcome:word('new','compatible','incompatible','uncertain'),atMs:nat},'comparisons');
  distinct(c,ref.invocations,'label','invocation-reference');
  distinct(c,o.invocations,'label','invocations');distinct(c,o.comparisons,'label','comparisons');
  c.eq(o.invocations.length,ref.invocations.length,'invocations.complete-reference-set');
  c.eq(o.comparisons.length,ref.invocations.length,'invocations.complete-comparison-set');
  for(const expected of ref.invocations) {
    shape(c,expected.target,targetFields,'reference.target');
    const call=o.invocations.find(x=>x.label===expected.label);
    c.ok(call,'invocations.reference-label');shape(c,call.target,targetFields,'invocations.target');
    const wire=openBeneath(c,locations.fixtureRoot,expected.wireFile,65536,'independent-wire');
    const canonical=openBeneath(c,locations.fixtureRoot,expected.canonicalFile,262144,'independent-canonical');
    const canonicalBytes=canonicalReference(canonical,c), packet=JSON.parse(canonicalBytes.toString('utf8'));
    shape(c,packet,{profile:word('canon_m09_1'),contract:word('intake/1'),variant:word(expected.variant),path:object,query:object,body:object},'independent-canonical.envelope');
    shape(c,packet.path,{template:id,parameters:object},'independent-canonical.typed-path');
    const templates={reserve_reception:'/api/intake/receptions',finalize_reception:'/api/intake/receptions/:id/finalize',resume_reception:'/api/intake/receptions/:id/resume',cancel_reception:'/api/intake/receptions/:id/cancel'};
    c.ok(Object.hasOwn(templates,expected.variant),'independent-canonical.supported-act');
    c.eq(packet.path.template,templates[expected.variant],'independent-canonical.route-template');
    c.eq(packet.path.parameters,expected.target.receptionId===null?{}:{id:expected.target.receptionId},'independent-canonical.target-path');
    c.eq(packet.query,{},'independent-canonical.query');
    c.eq(packet.body,JSON.parse(canonicalReference(wire,c).toString('utf8')),'independent-canonical.wire-body');
    c.eq(packet.body.profile,'intake/1','independent-canonical.body-profile');
    if(expected.target.expectedRevision!==null)c.eq(packet.body.expected_revision,expected.target.expectedRevision,'independent-canonical.target-revision');
    if(expected.variant==='finalize_reception'||expected.variant==='resume_reception')c.eq([packet.body.original?.id,packet.body.original?.generation],[expected.target.artifactId,expected.target.generation],'independent-canonical.target-original');
    const canonicalHash=digest(canonicalBytes);
    c.eq([call.principal,call.clientKey,call.act,call.variant,call.target,call.canonicalProfile,call.keyVersion,call.wireBodySha256,call.canonicalPayloadSha256], [expected.principal,expected.clientKey,expected.act,expected.variant,expected.target,expected.canonicalProfile,expected.keyVersion,digest(wire),canonicalHash],'invocations.independent-request-identity');
    const compared=o.comparisons.find(x=>x.label===call.label);
    c.ok(compared,'invocations.actual-comparison-required');
    c.eq([compared.operationId,compared.principal,compared.act,compared.variant,compared.clientKey,compared.canonicalProfile,compared.keyVersion,compared.comparedCanonicalSha256,compared.storedPayloadDigest], [call.operationId,call.principal,call.act,call.variant,call.clientKey,call.canonicalProfile,call.keyVersion,canonicalHash,call.storedPayloadDigest],'invocations.actual-canonical-comparison');
    c.ok(o.responses.some(x=>x.label===call.responseLabel),'invocations.client-response-required');
  }
  return ref;
}

function invocationCase(c,o,locations,h) {
  const ref=invocations(c,o,locations);
  if(o.caseId==='IC05') {
    if(o.variant==='invalid-linkage') { h.denied(c,o,[403,409]);return; }
    h.successfulReceipt(c,o);
    const r=o.after.receipts[0], ev=o.evidence.filter(x=>x.phase==='effect'&&x.operationId===r.operationId);
    c.eq(ev.length,1,'executor.one-durable-effect-observation');
    c.ok(ref.executorRef!==o.input.principal,'executor.technical-and-human-distinct');
    c.eq([r.executorRef,ev[0].personRef,ev[0].executorRef,ev[0].artifactId,ev[0].generation],[ref.executorRef,r.personId,ref.executorRef,r.artifactId,r.generation],'executor.persisted-identity-and-lineage');
    return;
  }
  c.eq(o.invocations.length,2,'intention.two-discriminating-invocations');
  const [a,b]=o.invocations, ca=o.comparisons.find(x=>x.label===a.label),cb=o.comparisons.find(x=>x.label===b.label);
  const ra=h.response(c,o,a.responseLabel),rb=h.response(c,o,b.responseLabel);
  c.ok(success(ra),'intention.first-producer-positive');
  if(o.variant==='other-principal') {
    c.ok(a.principal!==b.principal,'intention.distinct-principals');
    c.eq([a.clientKey,a.act,a.variant],[b.clientKey,b.act,b.variant],'intention.same-key-other-principal');
    c.eq({success:success(rb),distinct:a.operationId!==b.operationId,receipts:o.after.receipts.length,jobs:o.after.jobs.length},{success:true,distinct:true,receipts:2,jobs:2},'intention.separate-namespaces-effects');
    const first=o.after.receipts.find(x=>x.operationId===a.operationId),second=o.after.receipts.find(x=>x.operationId===b.operationId);
    c.ok(first&&second,'intention.both-receipts-present');
    c.eq([first.personId,second.personId],[a.principal,b.principal],'intention.receipt-principals');
    const values=[];const collect=x=>{if(x!==null&&typeof x==='object')Object.values(x).forEach(collect);else values.push(x);};collect(rb.body);
    c.ok(!values.includes(first.id)&&!values.includes(a.operationId),'intention.no-other-principal-disclosure');
  } else {
    c.eq([a.principal,a.clientKey,a.act,a.variant],[b.principal,b.clientKey,b.act,b.variant],'intention.stable-namespace');
    c.eq(a.storedPayloadDigest,b.storedPayloadDigest,'intention.stored-identity-preserved');
    const incompatible=o.variant==='incompatible';
    c.eq(a.canonicalPayloadSha256===b.canonicalPayloadSha256,!incompatible,'intention.reference-compatibility');
    c.eq({status:incompatible?rb.status:success(rb),same:a.operationId===b.operationId,outcome:cb.outcome,receipts:o.after.receipts.length,jobs:o.after.jobs.length},{status:incompatible?409:true,same:true,outcome:incompatible?'incompatible':'compatible',receipts:1,jobs:1},'intention.outcome-namespace-and-effects');
    c.eq(ca.outcome,'new','intention.first-actual-producer');h.oneReceipt(c,o);
  }
}

function restoreCase(c,o,locations,h) {
  const r=o.restoration;
  shape(c,r,{origin:word('restore-controller-and-sql-observer'),backupId:id,cutAtMs:nat,cutObservation:object,restoredNamespaces:Array.isArray,excludedNamespaces:Array.isArray,archiveMembers:Array.isArray,archiveManifest:object,retainedAnchor:object,retainedAnchorAfter:object,currentSource:object,withdrawal:nullable(object),admission:object,namespaceBefore:object,namespaceAfter:object},'restoration');
  shape(c,r.cutObservation,{namespace:id,transactionSnapshot:id,receiptIds:Array.isArray},'restoration.cut');
  shape(c,r.archiveManifest,{file:id,bytes:nat,sha256:hash},'restoration.manifest');
  for(const anchor of [r.retainedAnchor,r.retainedAnchorAfter]) {
    shape(c,anchor,{origin:word('independent-sql-observer'),sourceId:id,namespace:word('intake_control'),relation:word('backup_anchor'),id,createdAtMs:nat,manifestSha256:hash,members:Array.isArray},'restoration.anchor');
    rows(c,anchor.members,memberFields,'restoration.anchor.members');distinct(c,anchor.members,'name','restoration.anchor.members');
  }
  c.eq(r.retainedAnchorAfter,r.retainedAnchor,'restoration.anchor-not-replaced');
  shape(c,r.currentSource,{origin:word('independent-sql-observer'),id,namespace:word('intake_control'),available:bool},'restoration.current-source');
  shape(c,r.admission,{origin:word('restore-controller'),startedAtMs:nat,finishedAtMs:nat,status:word('admitted','rejected','unavailable','interrupted'),sqlState:nullable(str)},'restoration.admission');
  for(const n of [r.namespaceBefore,r.namespaceAfter])shape(c,n,{origin:word('independent-sql-observer'),rows:Array.isArray},'restoration.activation-rows');
  c.eq(r.namespaceBefore.rows,[],'restoration.fresh-isolated-target');
  c.ok(r.cutAtMs<=r.retainedAnchor.createdAtMs&&r.retainedAnchor.createdAtMs<r.admission.startedAtMs&&r.admission.startedAtMs<=r.admission.finishedAtMs,'restoration.cut-anchor-admission-order');
  c.ok(r.restoredNamespaces.length>0&&r.restoredNamespaces.every(id),'restoration.actual-targets-required');
  c.eq([...r.excludedNamespaces].sort(),['access_trial','intake_control'],'restoration.excluded-authority-and-control');
  c.ok(r.restoredNamespaces.every(x=>!r.excludedNamespaces.includes(x)),'restoration.current-source-not-restored');
  preserved(c,o,r.excludedNamespaces);
  const ref=reference(c,o,locations);
  shape(c,ref,{backupId:id,currentSourceId:id,manifestSha256:hash,members:Array.isArray},'restore-reference');
  rows(c,ref.members,memberFields,'restore-reference.members');
  c.eq([r.backupId,r.currentSource.id,r.retainedAnchor.sourceId,r.retainedAnchor.id,r.retainedAnchor.manifestSha256,r.retainedAnchor.members],[ref.backupId,ref.currentSourceId,ref.currentSourceId,ref.backupId,ref.manifestSha256,ref.members],'restoration.independent-retained-reference');
  const manifest=openBeneath(c,locations.evidenceRoot,r.archiveManifest.file,1048576,'arriving-manifest');
  c.eq([manifest.length,digest(manifest)],[r.archiveManifest.bytes,r.archiveManifest.sha256],'restoration.actual-manifest-capture');
  rows(c,r.archiveMembers,memberFields,'restoration.arriving-members');distinct(c,r.archiveMembers,'name','restoration.arriving-members');nonempty(c,r.archiveMembers,'restoration.arriving-members');
  for(const m of r.archiveMembers) {
    const file=path.posix.join(path.posix.dirname(r.archiveManifest.file),m.name);
    // Check the member path before joining, so normalization cannot hide traversal.
    c.ok(!m.name.includes('\\')&&!m.name.split('/').some(x=>x==='..'||x==='.'||x==='')&&!path.posix.isAbsolute(m.name),'restoration.safe-member-name');
    const bytes=openBeneath(c,locations.evidenceRoot,file,8388608,'arriving-member');
    c.eq([bytes.length,digest(bytes)],[m.bytes,m.sha256],'restoration.actual-member-capture');
  }
  const matches=r.archiveManifest.sha256===ref.manifestSha256&&JSON.stringify(r.archiveMembers)===JSON.stringify(ref.members);
  c.eq(r.cutObservation.receiptIds,[...o.before.receipts.map(x=>x.id)],'restoration.cut-receipt-lineage');
  h.unchanged(c,o);
  if(o.variant==='restore') {
    c.eq([r.currentSource.available,matches,r.admission.status],[true,true,'admitted'],'restoration.legitimate-admission');
    c.ok(r.namespaceBefore.rows.length===0&&r.namespaceAfter.rows.length>0,'restoration.fresh-target-populated');
    c.ok(o.storage.some(x=>x.kind==='restore_write'&&x.artifactId===o.input.artifactId),'restoration.actual-original-install');
    h.exactBody(c,o,h.response(c,o),locations);
  } else if(o.variant==='post-backup-withdrawal') {
    shape(c,r.withdrawal,{origin:word('independent-sql-observer'),permissionId:id,grantId:id,committedAtMs:nat,revisionBefore:pos,revisionAfter:pos,withdrawnBefore:bool,withdrawnAfter:bool},'restoration.withdrawal');
    c.ok(r.cutAtMs<r.withdrawal.committedAtMs&&r.withdrawal.committedAtMs<r.admission.startedAtMs,'restoration.withdrawal-after-backup');
    c.eq([r.withdrawal.withdrawnBefore,r.withdrawal.withdrawnAfter],[false,true],'restoration.actual-withdrawal');
    c.ok(r.withdrawal.revisionAfter>r.withdrawal.revisionBefore,'restoration.withdrawal-revision');
    c.eq([r.currentSource.available,matches],[true,true],'restoration.withdrawal-is-only-negative');
    const w=h.control(c,o,'withdraw');c.eq([w.atMs,w.revision,w.sourceId],[r.withdrawal.committedAtMs,r.withdrawal.revisionAfter,ref.currentSourceId],'restoration.current-withdrawal-corroborated');
    h.denied(c,o,[403,404],{read:true,retained:true});noDependentDelivery(c,o,r.admission.startedAtMs);
  } else {
    if(o.variant==='control-unavailable') {
      c.eq([r.currentSource.available,matches,r.admission.status],[false,true,'unavailable'],'restoration.unavailable-current-control');
      const unavailable=h.control(c,o,'unavailable');c.eq(unavailable.sourceId,ref.currentSourceId,'restoration.unavailable-source-identity');
      h.denied(c,o,[503],{read:true,retained:true});
    } else {
      c.eq([r.currentSource.available,matches,r.admission.status],[true,false,'rejected'],'restoration.forgery-against-separate-anchor');
      h.denied(c,o,[409],{read:true,retained:true});
    }
    c.eq(r.namespaceAfter.rows,r.namespaceBefore.rows,'restoration.no-activation-after-rejection');noDependentDelivery(c,o,r.admission.startedAtMs);
  }
}

function privilegeCase(c,o,locations) {
  preserved(c,o,[]);
  nonempty(c,o.privilegeProbes,'privileges');nonempty(c,o.roleInventory,'roles');
  rows(c,o.roleInventory,{origin:word('sql-observer'),role:id,superuser:bool,createDatabase:bool,createRole:bool,bypassRls:bool,replication:bool,memberships:Array.isArray,grants:Array.isArray},'roles');
  distinct(c,o.roleInventory,'role','roles');
  rows(c,o.privilegeProbes,{origin:word('sql-client','os-process'),label:id,processRole:id,effectiveRole:x=>id(x)||object(x),sourceNamespace:id,targetNamespace:id,objectRef:id,action:id,startedAtMs:nat,finishedAtMs:nat,status:word('succeeded','denied','failed'),sqlState:nullable(str),errno:nullable(str),observedRows:nat,observedBytes:nat,beforeSha256:hash,afterSha256:hash,positiveLabel:nullable(id)},'privileges');
  distinct(c,o.privilegeProbes,'label','privileges');
  const ref=reference(c,o,locations);
  shape(c,ref,{probes:Array.isArray,preservedNamespaces:Array.isArray},'privilege-reference');
  rows(c,ref.probes,{label:id,processRole:id,effectiveRole:x=>id(x)||object(x),sourceNamespace:id,targetNamespace:id,objectRef:id,action:id,permitted:bool,positiveLabel:nullable(id)},'privilege-reference.probes');
  c.eq(o.privilegeProbes.length,ref.probes.length,'privileges.complete-independent-probes');
  c.ok(ref.probes.some(x=>x.permitted)&&ref.probes.some(x=>!x.permitted),'privileges.positive-and-negative-required');
  for(const ns of ref.preservedNamespaces)c.ok(o.preservedData.some(x=>x.namespace===ns),'privileges.preserved-namespace');
  for(const r of ref.probes) {
    const p=o.privilegeProbes.find(x=>x.label===r.label);c.ok(p,'privileges.probe-required');
    c.eq([p.processRole,p.effectiveRole,p.sourceNamespace,p.targetNamespace,p.objectRef,p.action,p.positiveLabel],[r.processRole,r.effectiveRole,r.sourceNamespace,r.targetNamespace,r.objectRef,r.action,r.positiveLabel],'privileges.actual-identity-and-target');
    c.ok(p.startedAtMs<=p.finishedAtMs,'privileges.time-order');
    if(p.origin==='sql-client') {
      const role=o.roleInventory.find(x=>x.role===p.effectiveRole);c.ok(role,'privileges.actual-role-inventory');
      c.eq([role.superuser,role.createDatabase,role.createRole,role.bypassRls,role.replication],[false,false,false,false,false],'privileges.no-bootstrap-identity');
    } else shape(c,p.effectiveRole,{uid:nat,gid:nat,groups:Array.isArray},'privileges.os-identity');
    if(r.permitted) {
      c.eq(p.status,'succeeded','privileges.reachable-positive');
      c.ok(p.observedRows>0||p.observedBytes>0,'privileges.nonempty-positive-target');
    } else {
      const positive=o.privilegeProbes.find(x=>x.label===p.positiveLabel);
      c.ok(positive&&positive.status==='succeeded'&&(positive.observedRows>0||positive.observedBytes>0),'privileges.linked-positive');
      const owner=o.privilegeProbes.find(x=>x.objectRef===p.objectRef&&x.targetNamespace===p.targetNamespace&&x.status==='succeeded'&&(x.observedRows>0||x.observedBytes>0));
      c.ok(owner,'privileges.denied-target-proven-to-exist');
      c.eq({status:p.status,rows:p.observedRows,bytes:p.observedBytes,unchanged:p.afterSha256===p.beforeSha256,denial:p.origin==='sql-client'?p.sqlState==='42501':['EACCES','EPERM','EROFS','EEXIST'].includes(p.errno)},{status:'denied',rows:0,bytes:0,unchanged:true,denial:true},'privileges.denial-and-no-effect');
    }
  }
  if(o.variant==='isolation') {
    const denied=ref.probes.filter(x=>!x.permitted);
    c.ok(denied.some(x=>x.sourceNamespace.startsWith('intake')&&!x.targetNamespace.startsWith('intake'))&&denied.some(x=>!x.sourceNamespace.startsWith('intake')&&x.targetNamespace.startsWith('intake')),'privileges.two-directions');
  }
  if(o.variant==='overwrite')c.ok(ref.probes.some(x=>!x.permitted&&x.action==='overwrite'),'privileges.immutable-overwrite-attempt');
}

function outputCase(c,o,locations,h) {
  if(o.variant==='safe-output') {
    nonempty(c,o.diagnosticFiles,'diagnostics');
    rows(c,o.diagnosticFiles,{origin:word('evidence-collector'),path:id,bytes:nat,sha256:hash,kind:word('stdout','stderr','diagnostic','summary')},'diagnostics');
    distinct(c,o.diagnosticFiles,'path','diagnostics');
    const ref=reference(c,o,locations);shape(c,ref,{diagnosticPaths:Array.isArray,protectedMarkers:Array.isArray},'diagnostic-reference');
    c.eq(o.diagnosticFiles.map(x=>x.path).sort(),[...ref.diagnosticPaths].sort(),'diagnostics.complete-fixed-inventory');
    c.eq(o.diagnosticFiles.map(x=>x.path).sort(),diagnosticInventory(c,locations.evidenceRoot),'diagnostics.complete-captured-log-directory');
    c.ok(ref.protectedMarkers.every(x=>typeof x==='string'&&x.length>0),'diagnostics.nonempty-markers');
    const markers=['T02_PRIVATE_PAYLOAD_CANARY_7c18',...ref.protectedMarkers];
    for(const d of o.diagnosticFiles) {
      const bytes=openBeneath(c,locations.evidenceRoot,d.path,8388608,'diagnostic-file');
      c.eq([bytes.length,digest(bytes)],[d.bytes,d.sha256],'diagnostics.actual-capture');
      c.ok(markers.every(m=>!bytes.includes(Buffer.from(m,'utf8'))),'diagnostics.no-protected-markers');
    }
    return;
  }
  nonempty(c,o.profileControls,'profiles.control');
  rows(c,o.profileControls,{origin:word('independent-sql-observer'),observedAtMs:nat,format:id,configuration:id,scope:id,purpose:id,revealable:bool,receptionEnabled:bool,processingImplemented:bool},'profiles.control');
  shape(c,o.routeInventory,{origin:word('actual-dispatch-probe'),probes:Array.isArray,workerPorts:Array.isArray},'profiles.inventory');
  rows(c,o.routeInventory.probes,{method:word('GET','POST'),path:id,status:x=>Number.isInteger(x)&&x>=100&&x<=599,bodySha256:hash},'profiles.probes');
  c.eq(o.routeInventory.workerPorts,[],'profiles.no-processing-workers');
  const ref=reference(c,o,locations);
  shape(c,ref,{controlRows:Array.isArray,responseBody:object,requiredRoutes:Array.isArray},'profile-reference');
  c.eq(o.profileControls,ref.controlRows,'profiles.independent-control-snapshot');
  c.ok(o.profileControls.some(x=>x.revealable&&x.receptionEnabled)&&o.profileControls.some(x=>!x.revealable),'profiles.visible-positive-and-hidden-negative');
  c.ok(o.profileControls.every(x=>!x.processingImplemented),'profiles.no-invented-processing');
  const r=h.response(c,o);c.eq({success:success(r),body:r.body},{success:true,body:ref.responseBody},'profiles.exact-independent-projection');
  const strings=[];const keys=[];const collect=x=>{if(x&&typeof x==='object')for(const [k,v]of Object.entries(x)){keys.push(k);collect(v);}else if(typeof x==='string')strings.push(x);};collect(r.body);
  c.ok(!keys.some(k=>/hidden|revealable/i.test(k)),'profiles.no-concealment-metadata');
  for(const hidden of o.profileControls.filter(x=>!x.revealable))c.ok(!strings.includes(hidden.configuration),'profiles.hidden-identity-omitted');
  c.ok(o.profileControls.filter(x=>x.revealable&&x.receptionEnabled).every(x=>strings.includes(x.configuration)),'profiles.offered-positive-present');
  nonempty(c,ref.requiredRoutes,'profiles.required-routes');
  const receptionRoutes=[['GET',/^\/api\/intake\/profiles$/],['POST',/^\/api\/intake\/receptions$/],['POST',/^\/api\/intake\/receptions\/[^/]+\/attempts\/[^/]+\/original$/],['POST',/^\/api\/intake\/receptions\/[^/]+\/finalize$/],['POST',/^\/api\/intake\/operations\/lookup$/],['POST',/^\/api\/intake\/receptions\/[^/]+\/resume$/],['POST',/^\/api\/intake\/receptions\/[^/]+\/cancel$/],['GET',/^\/api\/intake\/receptions\/[^/]+$/],['GET',/^\/api\/intake\/receptions\/[^/]+\/original$/]];
  for(const [method,pattern]of receptionRoutes)c.ok(ref.requiredRoutes.some(x=>x.method===method&&pattern.test(x.path)&&x.implemented),'profiles.all-nine-reception-routes');
  for(const target of ref.requiredRoutes) {
    shape(c,target,{method:word('GET','POST'),path:id,implemented:bool},'profile-reference.route');
    const probe=o.routeInventory.probes.find(x=>x.method===target.method&&x.path===target.path);c.ok(probe,'profiles.actual-route-probe');
    c.ok(target.implemented?probe.status>=200&&probe.status<300:[404,405].includes(probe.status),'profiles.truthful-route-reachability');
  }
}

export function extendedCase(c,o,locations,helpers) {
  c.ok([2,3].includes(o.interfaceRevision),'extensions.declared-revision-required');
  if(o.caseId==='IC04'||o.caseId==='IC05')invocationCase(c,o,locations,helpers);
  else if(o.caseId==='IC12')restoreCase(c,o,locations,helpers);
  else if(o.caseId==='IC17')privilegeCase(c,o,locations);
  else if(o.caseId==='IC18')outputCase(c,o,locations,helpers);
  else c.ok(false,'extensions.unsupported-family');
}
