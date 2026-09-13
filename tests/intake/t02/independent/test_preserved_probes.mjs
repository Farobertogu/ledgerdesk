import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { upgradeIllustration } from './illustrative_revision3.mjs';
import { assertCase } from './index.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');

export function registerPreservedProbes(root) {
  test('Preserved audit false positives remain reproducible; corrected claims reject the same attacked facts',async()=>{
    const baseline=process.env.T02_BASELINE_ROOT,probes=process.env.T02_PROBE_ROOT;
    assert.ok(baseline&&probes,'Pass the explicit read-only baseline sources and probe roots to run_self.mjs.');
    const originalManifest=readFileSync(path.join(baseline,'..','run.json'));
    assert.equal(sha(originalManifest),'134552a7320e697371870a17657a348c628d311e0769a2530328480ac8728009');
    const fixedSources=JSON.parse(originalManifest).sources;
    assert.equal(fixedSources.length,8);
    for(const source of fixedSources){const bytes=readFileSync(path.join(baseline,source.name));assert.equal(bytes.length,source.bytes);assert.equal(sha(bytes),source.sha256);}
    const index=readFileSync(path.join(baseline,'index.mjs'));
    assert.equal(sha(index),'9bd2f18b7e1748b6024b47c8d0ddcbcb59aeb5e7f8b399e63b87552efedb01b4');
    const old=await import(pathToFileURL(path.join(baseline,'index.mjs')).href);
    const out=path.join(root,'preserved-probe-replay');mkdirSync(out);
    const outcomes=[];
    for(const name of ['access-current-generation','access-old-generation','invocation-detached-effect']) {
      const original=path.join(probes,name),destination=path.join(out,name);mkdirSync(destination);
      const identities=[];
      function copy(from,to) {
        mkdirSync(to,{recursive:true});
        for(const entry of readdirSync(from,{withFileTypes:true})) {
          const a=path.join(from,entry.name),b=path.join(to,entry.name);
          assert.equal(lstatSync(a).isSymbolicLink(),false);
          if(entry.isDirectory())copy(a,b);
          else {const bytes=readFileSync(a);writeFileSync(b,bytes,{flag:'wx'});identities.push({source:path.relative(original,a),bytes:bytes.length,sha256:sha(bytes)});}
        }
      }
      copy(path.join(original,'fixtures'),path.join(destination,'fixtures'));
      copy(path.join(original,'capture'),path.join(destination,'capture'));
      const locations={fixtureRoot:path.join(destination,'fixtures'),evidenceRoot:path.join(destination,'capture')};
      const positive=JSON.parse(readFileSync(path.join(original,'positive-observation.json'))),negative=JSON.parse(readFileSync(path.join(original,'changed-observation.json')));
      const invoke=(module,o)=>{try{return {accepted:true,result:module.assertCase(o.caseId,o.variant,o,locations)};}catch(e){assert.ok(e instanceof assert.AssertionError);return {accepted:false,error:e.message};}};
      const priorPositive=invoke(old,positive),priorNegative=invoke(old,negative);
      assert.equal(priorPositive.accepted,true);
      assert.equal(priorNegative.accepted,name!=='access-current-generation');
      const updated=structuredClone(positive);upgradeIllustration(updated,locations);
      const currentPositive=invoke({assertCase},updated);assert.equal(currentPositive.accepted,true,JSON.stringify(currentPositive));
      const changed=structuredClone(updated);
      if(name.startsWith('access-')) {
        // The only attacked old fact is the successful read and its actual
        // generation. Add the explicit new call/reception identity, not a filter.
        const extra=structuredClone(negative.storage[negative.storage.length-1]);
        extra.callId=updated.input.subject.callId;extra.receptionId=updated.input.subject.receptionId;extra.operationId=updated.input.subject.queryIntentionId;
        changed.storage.push(extra);
      } else {
        // R3.1 has no stored identity on a client invocation. Keep the absent
        // comparison absent; substitute the actual later linkage plus the
        // existing replay comparator, leaving every SQL/effect row intact.
        const unobserved=negative.invocations[0].operationId;
        for(const c of changed.correlations){c.observation.operationId=unobserved;c.observation.matchedIntentionIds=[unobserved];}
        changed.comparisons.find(x=>x.row==='present').operationId=unobserved;
      }
      const currentNegative=invoke({assertCase},changed),rule=name.startsWith('access-')?'denial.outcome-and-effects-and-access':'correlation.actual-durable-linkage';
      assert.equal(currentNegative.accepted,false);assert.ok(currentNegative.error.includes(rule),currentNegative.error);
      const result={name,identities,oldPositive:priorPositive,oldNegative:priorNegative,currentPositive,currentNegative,expectedRule:rule};
      writeFileSync(path.join(destination,'replay-result.json'),JSON.stringify(result,null,2),{flag:'wx'});
      writeFileSync(path.join(destination,'adapted-positive.json'),JSON.stringify(updated,null,2),{flag:'wx'});
      writeFileSync(path.join(destination,'adapted-negative.json'),JSON.stringify(changed,null,2),{flag:'wx'});
      outcomes.push(result);
    }
    writeFileSync(path.join(out,'summary.json'),JSON.stringify(outcomes,null,2),{flag:'wx'});
  });
}
