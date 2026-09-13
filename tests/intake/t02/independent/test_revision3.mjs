import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertCase } from './index.mjs';

export function registerRevision3Tests({specimen,json,event}) {
  function run(x){return assertCase(x.o.caseId,x.o.variant,x.o,x.locations);}
  function pair(name,caseId,variant,prepare,change,rule) {
    test(name,()=>{
      const x=specimen(caseId,variant);prepare?.(x);
      const positive=run(x);json(x.locations.evidenceRoot,'r3-positive.json',{observation:x.o,result:positive});
      const bad={o:structuredClone(x.o),locations:x.locations};change(bad);let caught;
      assert.throws(()=>run(bad),error=>{caught=error;return error instanceof assert.AssertionError&&error.message.includes(rule);});
      json(x.locations.evidenceRoot,'r3-negative.json',{observation:bad.o,expectedRule:rule,observedRule:caught.message});
    });
  }
  const generation2=x=>{x.o.input.generation=2;for(const s of[x.o.before,x.o.after]){for(const r of s.receptions)r.generation=2;for(const r of s.receipts)r.generation=2;for(const j of s.jobs)j.generation=2;for(const a of s.attempts)a.generation=2;}};
  for(const generation of[1,2])pair(`M01: denied query detects generation ${generation} within current generation 2`,'IC08','query-denied',generation2,x=>x.o.storage.push(event(x.o,'read',{generation})),'denial.outcome-and-effects-and-access');
  pair('M01: wrong artifact does not disappear from a complete denied-call window','IC08','query-denied',null,x=>x.o.storage.push(event(x.o,'read',{artifactId:'other-protected-original'})),'denial.outcome-and-effects-and-access');
  pair('M01: missing call correlation is evidence failure, not excluded activity','IC08','query-denied',null,x=>{const e=event(x.o,'read');delete e.callId;x.o.storage.push(e);},'storage[0].keys');
  const zeroCalls=[['IC02','over-limit'],['IC03','denied-capture'],['IC03','wrong-origin'],['IC08','query-without-load'],['IC08','uncertain'],['IC11','query-only'],['IC13','before-capture'],['IC13','between-chunks'],['IC13','before-finalize'],['IC14','record-only'],['IC14','fragment-only'],['IC14','hidden-absent'],['IC15','evidence-failure'],['IC12','forged-manifest']];
  const zeroRule=(caseId,variant)=>caseId==='IC08'&&variant==='query-without-load'?'lookup.zero-original-access':caseId==='IC11'?'availability.record-does-not-open-original':caseId==='IC14'&&variant==='record-only'?'view.record-zero-body-access':caseId==='IC14'&&variant==='hidden-absent'?'view.hidden-absent-full-tuple':'denial.outcome-and-effects-and-access';
  for(const[caseId,variant]of zeroCalls)pair(`M01 shared caller ${caseId}/${variant} rejects a later sibling read`,caseId,variant,null,x=>x.o.storage.push(event(x.o,'read',{artifactId:'sibling-protected',generation:99,atMs:1800000000035})),zeroRule(caseId,variant));

  pair('M02: coherent comparison/correlation substitution cannot detach the persisted effect','IC04','compatible',null,x=>{
    x.o.comparisons[1].operationId='operation-with-no-observed-row';
    for(const row of x.o.correlations){row.observation.operationId='operation-with-no-observed-row';row.observation.matchedIntentionIds=['operation-with-no-observed-row'];}
  },'correlation.actual-durable-linkage');
  pair('M02: a substituted correlation alone is not SQL evidence','IC04','compatible',null,x=>x.o.correlations[0].observation.operationId='unobserved-operation','correlation.actual-durable-linkage');
  pair('M02: receipt cannot use the reservation intention','IC05','receipt',null,x=>x.o.after.receipts[0].operationId=x.o.input.subject.queryIntentionId,'after.receipt-intention-linkage');
  pair('M02: successful finalization must retain the SQL correlation','IC05','receipt',null,x=>x.o.correlations=[],'invocations.complete-reference-set');
  pair('M02: selected query and receipt finalization IDs cannot be exchanged','IC05','receipt',null,x=>x.o.input.subject.finalizationIntentionId=x.o.input.subject.queryIntentionId,'subject.finalization-not-reservation');
  pair('M02: compatible replay cannot claim a different incumbent digest','IC04','compatible',null,x=>x.o.comparisons[1].storedPayloadDigest='f'.repeat(64),'correlation.incumbent-linkage');

  function distinctActors(x) {
    const mapping={'person-1':'account-1','person-2':'account-2'};
    x.o.input.principal=mapping[x.o.input.principal];
    for(const s of[x.o.before,x.o.after]) {
      for(const row of [...s.receptions,...s.intentions,...s.receipts])row.principal=mapping[row.principal];
      for(const row of s.principalBindings)row.accountId=mapping[row.accountId];
    }
    for(const e of x.o.evidence)e.principal=mapping[e.principal];
    for(const row of [...x.o.invocations,...x.o.comparisons,...x.o.requestBoundaries,...(x.o.incumbentComparisons??[])])row.principal=mapping[row.principal];
    for(const row of x.o.correlations)row.namespace.principal=mapping[row.namespace.principal];
    const refPath=path.join(x.locations.fixtureRoot,`references/${x.o.caseId}/${x.o.variant}.json`),ref=JSON.parse(readFileSync(refPath));
    for(const row of ref.invocations)row.principal=mapping[row.principal];writeFileSync(refPath,JSON.stringify(ref));
    const callsPath=path.join(x.locations.fixtureRoot,`references/${x.o.caseId}/${x.o.variant}.calls.json`),calls=JSON.parse(readFileSync(callsPath));for(const row of calls.calls)row.principal=mapping[row.principal];writeFileSync(callsPath,JSON.stringify(calls));
    writeFileSync(path.join(x.locations.fixtureRoot,'references/actors.json'),JSON.stringify({executorRef:'executor-1',bindings:[{accountId:'account-1',personId:'person-1'},{accountId:'account-2',personId:'person-2'}]}));
  }
  pair('M03: distinct account/person mappings pass; coherently substituted human fails','IC04','other-principal',distinctActors,x=>{
    for(const s of[x.o.before,x.o.after]) {
      for(const r of s.receptions)if(r.principal==='account-1')r.personId='person-2';
      for(const r of s.receipts)if(r.principal==='account-1')r.personId='person-2';
      for(const r of s.principalBindings)if(r.accountId==='account-1')r.personId='person-2';
    }
    for(const e of x.o.evidence)if(e.phase==='effect'&&e.principal==='account-1')e.personRef='person-2';
  },'actors.independent-person-association');
  pair('M03: another account effect cannot stand in for this principal','IC04','other-principal',distinctActors,x=>{x.o.correlations[0].observation=structuredClone(x.o.correlations[1].observation);},'correlation.actual-durable-linkage');
  pair('M03: executor remains separately fixed with distinct person/account','IC05','receipt',distinctActors,x=>x.o.after.receipts[0].executorRef='person-1','executor.persisted-identity-and-lineage');
  pair('M04: new committed comparison has no fabricated stored row','IC05','receipt',null,x=>{x.o.comparisons[0].operationId=x.o.correlations[0].observation.operationId;x.o.comparisons[0].storedPayloadDigest=x.o.correlations[0].observation.storedPayloadDigest;},'comparison.truthful-absent-row');
  pair('M04: an allocated but uninserted ID is not a stored row','IC05','receipt',null,x=>x.o.comparisons[0].operationId='allocated-only','comparison.truthful-absent-row');
  pair('M04: a present replay cannot omit the actual stored digest','IC04','compatible',null,x=>x.o.comparisons[1].storedPayloadDigest=null,'comparison.actual-incumbent-required');
  pair('M04: a rollback cannot borrow its earlier reservation ID','IC05','invalid-linkage',null,x=>x.o.correlations[0].observation.operationId=x.o.input.subject.queryIntentionId,'correlation.absent.operationId');
  pair('M04: a supposedly absent operation cannot have an active producer','IC05','invalid-linkage',null,x=>x.o.correlations[0].observation.activeProducerCount=1,'correlation.absent.activeProducerCount');
  pair('M04: a stale empty snapshot before rollback cannot prove absence','IC05','invalid-linkage',null,x=>x.o.correlations[0].observation.namespaceFence.observedAtMs=1800000000010,'correlation.completed-before-fresh-fenced-query');
  pair('M04: missing namespace fence does not mean a known absence','IC05','invalid-linkage',null,x=>x.o.correlations[0].observation.namespaceFence.held=false,'correlation.namespace-fence.held');
  pair('M04: unknown transaction outcome cannot become rollback','IC05','invalid-linkage',null,x=>x.o.correlations[0].observation.transactionOutcome='unknown','correlation.absent.transactionOutcome');
  pair('M04: compared target still discriminates independently of successful response','IC04','incompatible',null,x=>x.o.comparisons[1].comparedCanonicalSha256=x.o.comparisons[0].comparedCanonicalSha256,'invocations.actual-canonical-comparison');
}
