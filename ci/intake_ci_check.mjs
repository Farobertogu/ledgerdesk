import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {plans} from './intake/t02_plan.mjs';
import {producerFaultGroups} from './intake/reception/producer_fault.mjs';
import {readingDependencies} from './reading_result_gate.mjs';
import {guardCases} from './intake_t02_guard_checks.mjs';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url));
// Already pinned by @playwright/test. A missing/moved parser fails, never falls
// back to a regex that might miss a YAML conditional or duplicate key.
assert.equal(require('playwright-core/package.json').version,'1.63.0');
const {yaml}=require(path.join(path.dirname(require.resolve('playwright-core/package.json')),'lib/utilsBundle.js'));
export function parseWorkflow(text){const d=yaml.parseDocument(text,{uniqueKeys:true});assert.deepEqual(d.errors,[]);return d.toJS();}
export const previousWorkflow=fs.readFileSync(path.join(root,'tests/intake/t02/ci_previous_workflow.txt'),'utf8');
const previous=parseWorkflow(previousWorkflow);
const requiredFinite=['authority','missing-catalog','transitions','neutrality','original-scope','fragment-permissions','privileges','transactions','delivery-order','finite-stream','finite-quota','finite-attempts'];
const requiredNormal=['units','runtime','boundaries','temporal','integrity','browser','phase-prototype'];
const requiredRecovery=[['fence-sql'],['fence-loss','--loss-kind','sql','--without-worker-stop'],['fence-loss','--loss-kind','runtime','--without-worker-stop'],['fence-loss','--loss-kind','supervisor','--without-worker-stop'],
  ['fence-ack','--ack-kind','append'],['fence-ack','--ack-kind','seal'],['fence-ack','--ack-kind','read'],['fence-ack','--ack-kind','close'],
  ['fence-commit','--commit-kind','rollback'],['fence-commit','--commit-kind','reply-loss'],['fence-continuation'],['fence-ipc'],['fence-restore'],['fence-coupled']];
const requiredMutations=['original-selection','actual-digest','actual-chunk-cap','type-recognition','compatible-payload','sealed-as-receipt','whole-original-faculty','delivery-evidence','deferred-dispatch','runtime-source'];
const same=(a,b,label)=>assert.deepEqual(a,b,label);
const commands=job=>job.steps.filter(s=>Object.hasOwn(s,'run')).map(s=>s.run);
export function verifyCoupledInventory(text){
  const ast=ts.createSourceFile('intake_t02_check.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let value;
  function visit(node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='coupledSuites'){
    assert.ok(ts.isObjectLiteralExpression(node.initializer));value=Object.fromEntries(node.initializer.properties.map(p=>{
      assert.ok(ts.isPropertyAssignment(p)&&ts.isStringLiteral(p.initializer));return[p.name.getText(ast),p.initializer.text];}));
  }ts.forEachChild(node,visit);}visit(ast);
  same(value,{runtime:'test_runtime.mjs',invitations:'test_invitations.mjs',reading:'test_authorized_reading.mjs',administration:'test_administration.mjs',journey:'test_whole_journey.mjs'},'all five actual coupled consumers');return true;
}
export function verifyWiring(workflow,executedPlans=plans,mutations=producerFaultGroups){
  verifyCoupledInventory(fs.readFileSync(path.join(root,'ci/intake_t02_check.mjs'),'utf8'));
  const scripts=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts;
  const baselineScripts=JSON.parse(fs.readFileSync(path.join(root,'tests/intake/t02/ci_previous_scripts.json'),'utf8'));
  for(const command of commands(previous.jobs.reading))if(command.startsWith('npm run ')){
    const name=command.slice(8);same(scripts[name],baselineScripts[name],'retained script '+name);
  }
  same(workflow.on,previous.on,'unchanged triggers');same(workflow.concurrency,previous.concurrency,'unchanged concurrency');
  for(const name of ['check','db','app'])same(workflow.jobs[name],previous.jobs[name],name+' remains unchanged');
  const gate=workflow.jobs.reading;assert.ok(gate);same(gate.needs,[...readingDependencies]);same(gate.if,'${{ always() }}');
  same(commands(gate),['node ci/reading_result_gate.mjs']);same(gate.steps.at(-1).env,{READING_NEEDS:'${{ toJSON(needs) }}',READING_CANCELLED:'${{ cancelled() }}'});
  assert.ok(!Object.hasOwn(gate,'continue-on-error'));assert.ok(gate.steps.every(s=>!Object.hasOwn(s,'if')&&!Object.hasOwn(s,'continue-on-error')));
  const moved=['runtime','invitations','reading','administration','journey'].map(n=>'npm run test:access:'+n);
  const baselineCommands=commands(previous.jobs.reading).filter(c=>!moved.includes(c));
  const base=workflow.jobs['reading-foundations'];assert.ok(base);
  const wanted=[...baselineCommands];wanted.splice(wanted.indexOf('npm ci')+1,0,'node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs');
  wanted.splice(wanted.indexOf('npm run test:access:journey:unit')+1,0,'node --test --test-concurrency=1 tests/access/test_runtime_packaging.mjs');
  wanted.splice(wanted.indexOf('npm run typecheck:app'),0,'npm run typecheck');same(commands(base),wanted,'all original commands and packaging retained');
  for(const name of readingDependencies){const job=workflow.jobs[name];assert.ok(job);same(job['runs-on'],'ubuntu-latest');same(job['timeout-minutes'],20);
    same(job.env,previous.jobs.reading.env);assert.ok(!Object.hasOwn(job,'if')&&!Object.hasOwn(job,'continue-on-error')&&!Object.hasOwn(job,'strategy'));
    assert.ok(job.steps.every(s=>!Object.hasOwn(s,'continue-on-error')));
    for(const s of job.steps)if(Object.hasOwn(s,'run')&&!s.run.startsWith('node ci/intake_t02_artifacts.mjs'))assert.ok(!Object.hasOwn(s,'if'));
    assert.ok(job.steps.some(s=>s.uses==='actions/setup-node@v4'&&s.with['node-version']==='22'));
    assert.ok(job.steps.some(s=>s.run==='node --test tests/intake/t02/test_ci_wiring.mjs'));
  }
  for(const [part,run]of [['behavior',['node ci/intake_t02_matrix.mjs --suite behavior']],['recovery',['node ci/intake_t02_matrix.mjs --suite recovery-with-access']],
    ['mutations',['node ci/intake_t02_producer_checks.mjs','node ci/intake_t02_guard_checks.mjs','node ci/intake_t02_failure_checks.mjs']]]){
    const job=workflow.jobs['intake-reception-'+part];same(commands(job),['npm ci','node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',...run,'node ci/intake_t02_artifacts.mjs --job '+part]);
    same(job.steps.at(-2).if,'always()');same(job.steps.at(-1),{uses:'actions/upload-artifact@v4',if:'always()',with:{name:'intake-reception-'+part+'-evidence',path:'test-results/intake-t02-public/'+part+'/','if-no-files-found':'error'}});
  }
  same(executedPlans.behavior.map(r=>r[1]),[...requiredNormal,...requiredFinite].map(g=>['--group',g]).concat([['--group','transactions','--receipt-commit-loss']]),'behavior obligation list');
  same(executedPlans['recovery-with-access'].map(r=>r[1]),requiredRecovery.map(args=>['--group',...args]),'recovery obligation list');
  same(Object.keys(mutations).sort(),[...requiredMutations].sort(),'producer mutation obligations');
  same(guardCases.map(c=>[c.name,c.group,...c.args]),[
    ['pre-capture','boundaries','--boundary-mutation','early-read'],['continuation-epoch','fence-continuation','--omit-epoch-check'],
    ['closed-before-open','phase-prototype','--forget-unseen-close']],'guard mutation obligations');
  for(const name of readingDependencies){for(const s of workflow.jobs[name].steps.filter(s=>s.uses==='actions/upload-artifact@v4'))same(s.if,'always()');}
  const retainedArtifacts=previous.jobs.reading.steps.filter(s=>s.uses==='actions/upload-artifact@v4'&&!s.with.name.startsWith('access-'));
  same(base.steps.filter(s=>s.uses==='actions/upload-artifact@v4'),retainedArtifacts,'foundation artifacts');
  return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyWiring(parseWorkflow(fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8')));console.log('Intake CI obligation mapping OK');
}
