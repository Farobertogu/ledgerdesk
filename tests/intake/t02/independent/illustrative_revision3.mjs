import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { callReferencePath, requestClass } from './request_boundary.mjs';

// Test-only migration of the preserved illustrative records. This is never an
// observation producer or runtime adapter. All invented SQL/call facts below are
// explicit synthetic examples, not evidence that a service observed them.
const H='a'.repeat(64),epoch=1800000000000;
const clone=x=>structuredClone(x);
const final=id=>`finalize-${id}`;
const reserve=id=>`reserve-${id}`;
export function upgradeIllustration(o,locations) {
  if(o.interfaceRevision===3)return;
  const reception=o.input.operationId;
  const actorPath=path.join(locations.fixtureRoot,'references','actors.json');
  // The fixed association is not derived from a receipt being checked.
  const actors={executorRef:'executor-1',bindings:[{accountId:'person-1',personId:'person-1'},{accountId:'person-2',personId:'person-2'}]};
  const referenceDir=path.dirname(actorPath);
  // Each fixture's directory belongs to this unique self-test run.
  return upgrade(o,locations,reception,actors,actorPath,referenceDir);
}
import { mkdirSync } from 'node:fs';
function upgrade(o,locations,reception,actors,actorPath,referenceDir) {
  mkdirSync(referenceDir,{recursive:true});
  if(!existsSync(actorPath))writeFileSync(actorPath,JSON.stringify(actors),{flag:'wx'});
  const oldInvocations=clone(o.invocations??[]),oldComparisons=clone(o.comparisons??[]);
  const hasSubjectReceipt=o.after.receipts.some(x=>x.operationId===reception);
  const subject={receptionId:reception,callId:oldInvocations[0]?.label??'subject-call',queryIntentionId:reserve(reception),finalizationIntentionId:hasSubjectReceipt?final(reception):null};
  o.interfaceRevision=3;o.interfaceAddendum='3.2';o.input.subject=subject;delete o.input.operationId;
  for(const [which,s]of [['before',o.before],['after',o.after]]) {
    const old=s.operations;
    s.receptions=old.map(x=>({id:x.id,principal:x.principal,personId:x.principal,originSessionId:x.originSessionId,generation:x.generation,revision:x.revision,state:x.state,stopped:false}));
    s.principalBindings=[...new Set(old.map(x=>x.principal))].map(accountId=>({origin:'independent-sql-observer',accountId,personId:accountId,accountRevision:1,atMs:s.atMs}));
    s.intentions=[];s.attempts=[];
    for(const row of old) {
      const r=s.receipts.find(x=>x.operationId===row.id),call=oldInvocations.find(x=>x.operationId===row.id);
      const common={receptionId:row.id,deployment:'deployment-1',principal:row.principal,act:'CARGAR_MATERIAL',canonicalProfile:'canon_m09_1',keyVersion:1,storedPayloadDigest:H};
      s.intentions.push({...common,id:reserve(row.id),variant:'reserve_reception',clientKey:`reservation-${row.id}`,effectId:null,createdAtMs:epoch});
      if(r)s.intentions.push({...common,id:final(row.id),variant:'finalize_reception',clientKey:call?.clientKey??'intention-1',effectId:r.effectId,createdAtMs:which==='before'||o.before.receipts.some(x=>x.operationId===row.id)?epoch:epoch+14});
      s.attempts.push({receptionId:row.id,generation:row.generation,artifactId:row.artifactId,incarnation:'incarnation-1',state:r?'sealed':'pending',reservedBytes:r?.bytes??17,actualBytes:r?.bytes??0,actualSha256:r?.sha256??null,expiresAtMs:epoch+1000});
    }
    for(const r of s.receipts){r.receptionId=r.operationId;r.principal=old.find(x=>x.id===r.operationId).principal;r.operationId=final(r.operationId);r.executorRef??='executor-1';}
    delete s.operations;
  }
  for(const e of [...o.storage,...o.evidence,...o.transport]) {
    e.callId=subject.callId;e.receptionId=reception;
    e.operationId=e.operationId?final(e.operationId):(hasSubjectReceipt?final(reception):null);
    if(e.phase==='effect'){e.personRef??=e.principal;e.executorRef??='executor-1';}
  }
  if(!oldInvocations.length){illustrateBoundaries(o,locations);return;}
  const refPath=path.join(locations.fixtureRoot,`references/${o.caseId}/${o.variant}.json`);
  const ref=JSON.parse(readFileSync(refPath));ref.deployment='deployment-1';writeFileSync(refPath,JSON.stringify(ref));
  o.invocations=[];o.comparisons=[];o.correlations=[];
  for(const old of oldInvocations) {
    const {operationId,storedPayloadDigest,...call}=old;
    const known=o.after.receipts.find(x=>x.operationId===final(operationId));
    call.origin='https-client-and-request-observer';call.callId=old.label;
    call.subject={receptionId:operationId,callId:old.label,queryIntentionId:reserve(operationId),finalizationIntentionId:known?final(operationId):null};
    o.invocations.push(call);
    const compared=oldComparisons.find(x=>x.label===old.label),fresh=compared.outcome==='new';
    compared.callId=old.label;compared.phase='namespace-lookup';compared.row=fresh?'absent':'present';
    compared.operationId=fresh?null:final(compared.operationId);compared.storedPayloadDigest=fresh?null:compared.storedPayloadDigest;
    o.comparisons.push(compared);
    const common={origin:'independent-sql-observer',callId:old.label,atMs:epoch+30,namespace:{deployment:'deployment-1',principal:old.principal,act:old.act,variant:old.variant,clientKey:old.clientKey}};
    if(o.caseId==='IC05'&&o.variant==='invalid-linkage')o.correlations.push({...common,outcome:'proven-absent',observation:{resolution:'no-committed-intention',operationId:null,storedPayloadDigest:null,effectId:null,receiptId:null,jobId:null,receptionId:operationId,matchedIntentionIds:[],transactionOutcome:'rolled-back',producerBackendPid:41,transactionId:'tx-1',terminalObservationAtMs:epoch+20,observerBackendPid:42,transactionSnapshot:'snapshot-2',namespaceFence:{held:true,observedAtMs:epoch+25,effectiveKeys:[20202,20203]},activeProducerCount:0}});
    else o.correlations.push({...common,outcome:'confirmed',observation:{resolution:'same-namespace',operationId:final(operationId),receptionId:operationId,storedPayloadDigest,effectId:known?.effectId??null,receiptId:known?.id??null,jobId:o.after.jobs.find(x=>x.receiptId===known?.id)?.id??null,observerBackendPid:42,transactionSnapshot:'snapshot-2',matchedIntentionIds:[final(operationId)]}});
  }
  // Stored keyed digests are separate SQL observations. The illustrative H
  // value is deliberately different from the unkeyed canonical reference hash.
  o.incumbentComparisons=[];
  for(const call of o.invocations){
    const cmp=o.comparisons.find(x=>x.callId===call.callId),co=o.correlations.find(x=>x.callId===call.callId),row=o.after.intentions.find(x=>x.id===co.observation.operationId);
    if(row)co.observation.storedPayloadDigest=row.storedPayloadDigest;
    if(cmp.row==='present'){
      cmp.storedPayloadDigest=row.storedPayloadDigest;
      o.incumbentComparisons.push({origin:'canonical-comparison-boundary',phase:'incumbent-payload',callId:call.callId,label:call.label,observedAtMs:cmp.atMs+1,selection:'same-namespace',principal:call.principal,requestVariant:call.variant,requestClientKey:call.clientKey,receptionId:row.receptionId,operationId:row.id,incumbentClientKey:row.clientKey,canonicalProfile:call.canonicalProfile,keyVersion:call.keyVersion,comparedCanonicalSha256:call.canonicalPayloadSha256,storedPayloadDigest:row.storedPayloadDigest,outcome:cmp.outcome,effectId:row.effectId,receiptId:co.observation.receiptId});
    }
  }
  illustrateBoundaries(o,locations);
}

// Deterministic invented endpoint facts for offline checker fixtures only.
// Runtime integration must collect them at the actual socket/SQL boundaries.
export function illustrateBoundaries(o,locations) {
  const calls=[];
  o.requestBoundaries=o.responses.map((r,i)=>{
    const call=o.invocations?.find(x=>x.responseLabel===r.label);
    if(call)r.route=call.variant==='reserve_reception'?'/api/intake/receptions':`/api/intake/receptions/${call.target.receptionId}/${call.variant.split('_')[0]}`;
    const subjectLabel=o.responses.some(x=>x.label==='subject')?'subject':o.responses[0].label;
    const callId=call?.callId??(r.label===subjectLabel&&!o.invocations?.length?o.input.subject.callId:`response-${r.label}`);
    const method=call?'POST':'GET',principal=call?.principal??o.input.principal,receptionId=call?.subject.receptionId??o.input.subject.receptionId;
    const b={origin:'https-client-and-server-boundary',callId,label:r.label,requestClass:requestClass(method,r.route),method,route:r.route,client:{address:'127.0.0.2',port:41000+i,peerAddress:'127.0.0.1',peerPort:8443,requestOrdinal:1,observedAtMs:epoch},server:{address:'127.0.0.1',port:8443,peerAddress:'127.0.0.2',peerPort:41000+i,requestOrdinal:1,observedAtMs:epoch+1,boundary:'application-consumer'},correlationMode:'connection-and-request',principal,receptionId,admission:{result:'accepted',source:'current-sql-admission',observedAtMs:epoch+2,backendPid:41,controlSourceId:'live-control',controlRevision:2},responseLabel:r.label};
    calls.push({label:b.label,method,route:b.route,requestClass:b.requestClass,principal,receptionId,allowedAccess:[]});return b;
  });
  const p=path.join(locations.fixtureRoot,callReferencePath(o));mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,JSON.stringify({calls}));
}

export function eventR3(event,reception='operation-1',callId='subject-call') {
  return {...event,callId,receptionId:reception,operationId:final(reception)};
}
