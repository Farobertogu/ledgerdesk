import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const sdkImport=['import sdk','from',JSON.stringify('@anthropic-ai/sdk')+';\n'].join(' ');
function fixture(t){
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(path.join(parent,'intake-seam-'));
  t.after(()=>{assert.equal(path.dirname(realpathSync(dir)),parent);rmSync(dir,{recursive:true});});
  for(const name of ['ci/seam_check.mjs','src/alg/channels.ts','src/alg/escalation.ts','agents/triage/schema.ts','agents/gateway.ts']){
    mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});copyFileSync(path.join(root,name),path.join(dir,name));
  }
  return {put(name,body){mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});writeFileSync(path.join(dir,name),body);},
    run(){return spawnSync(process.execPath,['ci/seam_check.mjs'],{cwd:dir,encoding:'utf8',timeout:10000,windowsHide:true});}};
}
test('archived checkout providers are not active imports, but active provider protection remains',t=>{
  const f=fixture(t);
  f.put('agents/providers/permitted.ts',sdkImport);
  f.put('test-results/retained/source/agents/providers/provider.ts',sdkImport);
  const positive=f.run();assert.equal(positive.status,0,positive.stderr);
  f.put('src/forbidden.ts',sdkImport);
  const negative=f.run();assert.equal(negative.status,1);assert.match(negative.stderr,/src\/forbidden\.ts imports '@anthropic-ai\/sdk'/);
  assert.doesNotMatch(negative.stderr,/test-results\/retained/);
});
test('nested provider and evidence names inside active source do not grant an exemption',t=>{
  const f=fixture(t);
  f.put('src/test-results/agents/providers/forbidden.ts',sdkImport);
  const observed=f.run();assert.equal(observed.status,1);
  assert.match(observed.stderr,/src\/test-results\/agents\/providers\/forbidden\.ts imports '@anthropic-ai\/sdk'/);
});
