import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {plans} from './intake/t02_plan.mjs';
import {producerFaultGroups} from './intake/reception/producer_fault.mjs';
import {readingDependencies} from './reading_result_gate.mjs';
import {guardCases} from './intake_t02_guard_checks.mjs';
import {extractionGuards} from './intake_extraction_guard_checks.mjs';
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
const requiredRecovery=[['creation'],['fence-sql'],['fence-loss','--loss-kind','sql','--without-worker-stop'],['fence-loss','--loss-kind','runtime','--without-worker-stop'],['fence-loss','--loss-kind','supervisor','--without-worker-stop'],
  ['fence-ack','--ack-kind','append'],['fence-ack','--ack-kind','seal'],['fence-ack','--ack-kind','read'],['fence-ack','--ack-kind','close'],
  ['fence-commit','--commit-kind','rollback'],['fence-commit','--commit-kind','reply-loss'],['fence-continuation'],['fence-ipc'],['fence-restore'],['fence-coupled']];
const requiredMutations=['original-selection','actual-digest','actual-chunk-cap','type-recognition','compatible-payload','sealed-as-receipt','whole-original-faculty','delivery-evidence','deferred-dispatch','runtime-source'];
const same=(a,b,label)=>assert.deepEqual(a,b,label);
const commands=job=>job.steps.filter(s=>Object.hasOwn(s,'run')).map(s=>s.run);
// Bounded profile, not a general GitHub expression parser or remote validator.
// Source: docs.github.com/en/actions/reference/workflows-and-actions/contexts
// Only whole-scalar expressions used by the reading aggregator are supported.
export const readingExpressionProfile='reading-expression-context/2';
export function verifyReadingExpressionContexts(workflow){
  const gate=workflow.jobs.reading,statusFunctions=['always','cancelled','success','failure'];
  function expression(value,where,kind){
    if(typeof value!=='string'||!value.includes('${{'))return;
    const match=/^\$\{\{\s*(.*?)\s*\}\}$/.exec(value);
    assert.ok(match,`${where}: outside ${readingExpressionProfile}`);
    const body=match[1],call=/^(!\s*)?([a-zA-Z]+)\s*\(\s*\)$/.exec(body);
    if(call&&statusFunctions.includes(call[2].toLowerCase())&&(!call[1]||call[2].toLowerCase()==='cancelled')){
      assert.ok(kind==='if',`${where}: status function ${call[2]} is unavailable in this expression context`);return;
    }
    if(kind==='env'&&(body==='job.status'||/^toJSON\(\s*needs\s*\)$/i.test(body)))return;
    assert.fail(`${where}: unsupported expression in ${readingExpressionProfile}`);
  }
  function visit(value,parts=[]){
    if(value!==null&&typeof value==='object'){for(const [key,child]of Object.entries(value))visit(child,[...parts,key]);return;}
    const isIf=parts.join('.')==='if'||(parts.length===3&&parts[0]==='steps'&&parts[2]==='if');
    const isEnv=parts.length===4&&parts[0]==='steps'&&parts[2]==='env';
    expression(value,'jobs.reading.'+parts.join('.'),isIf?'if':isEnv?'env':'unsupported');
  }
  visit(gate);return true;
}
export function verifyCoupledInventory(text){
  const ast=ts.createSourceFile('intake_t02_check.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let value;
  function visit(node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='coupledSuites'){
    assert.ok(ts.isObjectLiteralExpression(node.initializer));value=Object.fromEntries(node.initializer.properties.map(p=>{
      assert.ok(ts.isPropertyAssignment(p)&&ts.isStringLiteral(p.initializer));return[p.name.getText(ast),p.initializer.text];}));
  }ts.forEachChild(node,visit);}visit(ast);
  same(value,{runtime:'test_runtime.mjs',invitations:'test_invitations.mjs',reading:'test_authorized_reading.mjs',administration:'test_administration.mjs',journey:'test_whole_journey.mjs'},'all five actual coupled consumers');return true;
}
export function verifyWiring(workflow,executedPlans=plans,mutations=producerFaultGroups){
  verifyReadingExpressionContexts(workflow);
  verifyCoupledInventory(fs.readFileSync(path.join(root,'ci/intake_t02_check.mjs'),'utf8'));
  const scripts=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts;
  const baselineScripts=JSON.parse(fs.readFileSync(path.join(root,'tests/intake/t02/ci_previous_scripts.json'),'utf8'));
  for(const command of commands(previous.jobs.reading))if(command.startsWith('npm run ')){
    const name=command.slice(8);same(scripts[name],baselineScripts[name],'retained script '+name);
  }
  same(workflow.on,previous.on,'unchanged triggers');same(workflow.concurrency,previous.concurrency,'unchanged concurrency');
  for(const name of ['check','db','app'])same(workflow.jobs[name],previous.jobs[name],name+' remains unchanged');
  const gate=workflow.jobs.reading;assert.ok(gate);same(gate.needs,[...readingDependencies]);same(gate.if,'${{ !cancelled() }}','running aggregate must be cancellable');
  same(gate.steps,[{uses:'actions/checkout@v4'},{uses:'actions/setup-node@v4',with:{'node-version':'22'}},
    {name:'Require every producer result',if:'${{ always() }}',env:{READING_NEEDS:'${{ toJSON(needs) }}',READING_JOB_STATUS:'${{ job.status }}'},run:'node ci/reading_result_gate.mjs'}],
    'explicit always gate and supported current-job status transport');
  assert.ok(!Object.hasOwn(gate,'continue-on-error'));assert.ok(gate.steps.every(s=>!Object.hasOwn(s,'continue-on-error')));
  const moved=['runtime','invitations','reading','administration','journey'].map(n=>'npm run test:access:'+n);
  const baselineCommands=commands(previous.jobs.reading).filter(c=>!moved.includes(c));
  const base=workflow.jobs['reading-foundations'];assert.ok(base);
  const wanted=[...baselineCommands];wanted.splice(wanted.indexOf('npm ci')+1,0,'node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs');
  wanted.splice(wanted.indexOf('npm run test:access:journey:unit')+1,0,'node --test --test-concurrency=1 tests/access/test_runtime_packaging.mjs');
  wanted.splice(wanted.indexOf('npm run typecheck:app'),0,'npm run typecheck');same(commands(base),wanted,'all original commands and packaging retained');
  for(const name of readingDependencies){const job=workflow.jobs[name];assert.ok(job);same(job['runs-on'],'ubuntu-latest');same(job['timeout-minutes'],20);
    same(job.env,previous.jobs.reading.env);assert.ok(!Object.hasOwn(job,'if')&&!Object.hasOwn(job,'continue-on-error')&&!Object.hasOwn(job,'strategy'));
    assert.ok(job.steps.every(s=>!Object.hasOwn(s,'continue-on-error')));
    for(const s of job.steps)if(Object.hasOwn(s,'run')&&!s.run.startsWith('node ci/intake_t02_artifacts.mjs')&&s.run!=='node ci/intake_extraction_artifacts.mjs')assert.ok(!Object.hasOwn(s,'if'));
    assert.ok(job.steps.some(s=>s.uses==='actions/setup-node@v4'&&s.with['node-version']==='22'));
    assert.ok(job.steps.some(s=>s.run==='node --test tests/intake/t02/test_ci_wiring.mjs'));
  }
  for(const [part,run]of [['behavior',['node ci/intake_t02_matrix.mjs --suite behavior']],['recovery',['node ci/intake_t02_matrix.mjs --suite recovery-with-access']],
    ['mutations',['node ci/intake_t02_producer_checks.mjs','node ci/intake_t02_guard_checks.mjs','node ci/intake_t02_failure_checks.mjs']]]){
    const job=workflow.jobs['intake-reception-'+part];same(commands(job),['npm ci',...(part==='behavior'?['npm ci --prefix ci/intake/reception --ignore-scripts --no-audit --no-fund']:[]),
      'node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',...run,'node ci/intake_t02_artifacts.mjs --job '+part]);
    same(job.steps.at(-2).if,'always()');same(job.steps.at(-1),{uses:'actions/upload-artifact@v4',if:'always()',with:{name:'intake-reception-'+part+'-evidence',path:'test-results/intake-t02-public/'+part+'/','if-no-files-found':'error'}});
  }
  same(executedPlans.behavior.map(r=>r[1]),[...requiredNormal,...requiredFinite].map(g=>['--group',g]).concat([['--group','transactions','--receipt-commit-loss']]),'behavior obligation list');
  same(executedPlans['recovery-with-access'].map(r=>r[1]),requiredRecovery.map(args=>['--group',...args]),'recovery obligation list');
  const extraction=workflow.jobs['intake-extraction'];
  same(commands(extraction),['npm ci','node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',
    'node --test tests/intake/extraction/ci_evidence.mjs','docker pull postgres:16',
    'npm run test:intake:extraction:unit','npm run test:intake:extraction:schema','npm run test:intake:extraction:worker -- --qualified-memory',
    'npm run test:intake:extraction:service','node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases retry',
    'npm run test:intake:extraction:formats','npm run test:intake:extraction:budgets','npm run test:intake:extraction:semantics','npm run test:intake:extraction:mixed',
    'node ci/intake_extraction_artifacts.mjs'],'extraction obligation list');
  const recovery=workflow.jobs['intake-extraction-recovery'];
  same(commands(recovery),['npm ci','node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',
    'node --test tests/intake/extraction/ci_evidence.mjs','docker pull postgres:16',
    'npm run test:intake:extraction:restart','npm run test:intake:extraction:restore','npm run test:intake:extraction:storage-recovery',
    'npm run test:intake:extraction:temporal','npm run test:intake:extraction:fencing','node ci/intake_extraction_artifacts.mjs'],
    'extraction recovery obligation list');
  same(scripts['test:intake:extraction:formats'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases formats','extraction format executable');
  const addedExtraction={
    'intake-extraction-admission':['authority-original','authority-result','authority-effect','compatibility','capacity','extraction-privileges'],
    'intake-extraction-boundaries':['resources','associations','lineage','browser-disconnect','containment','private-loss','controller-loss'],
  };
  for(const [name,cases]of Object.entries(addedExtraction)){
    same(commands(workflow.jobs[name]),['npm ci','node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',
      'node --test tests/intake/extraction/ci_evidence.mjs','docker pull postgres:16',
      ...cases.map(g=>'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases '+g),
      'node ci/intake_extraction_artifacts.mjs'],name+' complete finite obligations');
  }
  for(const [name,suite]of [['intake-extraction-resource-guards','resources'],['intake-extraction-format-guards','formats']]){
    same(commands(workflow.jobs[name]),['npm ci','node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',
      'node --test tests/intake/extraction/ci_evidence.mjs','docker pull postgres:16',
      'node ci/intake_extraction_guard_checks.mjs --suite '+suite,'node ci/intake_extraction_artifacts.mjs'],name+' required directed negatives');
  }
  same(extractionGuards.resources.map(c=>[c.group,c.name]),[
    ['resources','omit-resource-relation-store'],['resources','read-resource-before-validation'],['resources','allow-resource-swap'],
    ['semantics','omit-condition-store'],['semantics','omit-limitation-store'],['semantics','omit-incident-query']],'resource and semantic negative inventory');
  same(extractionGuards.formats.map(c=>[c.group,c.name]),[
    ['format-negatives','xlsx-recalculate-store'],['format-negatives','xlsx-hide-sheet-store'],['format-negatives','xlsx-context-store']],'XLSX internal negative inventory');
  for(const name of [...Object.keys(addedExtraction),'intake-extraction-resource-guards','intake-extraction-format-guards']){
    same(workflow.jobs[name].steps.at(-2).if,'always()');
    same(workflow.jobs[name].steps.at(-1),{uses:'actions/upload-artifact@v4',if:'always()',with:{name:name+'-evidence',
      path:'test-results/intake-extraction-public/','if-no-files-found':'error'}});
  }
  same(scripts['test:intake:extraction:budgets'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases budgets','extraction budget executable');
  same(scripts['test:intake:extraction:restart'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases restart','extraction process restart executable');
  same(scripts['test:intake:extraction:restore'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases restore','extraction populated restore executable');
  same(scripts['test:intake:extraction:storage-recovery'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases storage-recovery','extraction private replacement and interrupted seal executable');
  same(scripts['test:intake:extraction:semantics'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases semantics','extraction independent internal-content oracle executable');
  same(scripts['test:intake:extraction:mixed'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases mixed','extraction labeled mixed-component fidelity executable');
  same(scripts['test:intake:extraction:temporal'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases temporal','extraction temporal executable');
  same(scripts['test:intake:extraction:fencing'],'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases fencing','extraction fencing executable');
  for(const [name,runner,group]of [['unit','intake_extraction_check','units'],['schema','intake_extraction_check','schema'],
    ['worker','intake_extraction_check','worker'],['service','intake_t02_check','extraction']])
    same(scripts['test:intake:extraction:'+name],`node --experimental-strip-types ci/${runner}.mjs --group ${group}`,'extraction executable '+name);
  same(extraction.steps.at(-2).if,'always()');
  same(extraction.steps.at(-1),{uses:'actions/upload-artifact@v4',if:'always()',with:{name:'intake-extraction-evidence',
    path:'test-results/intake-extraction-public/','if-no-files-found':'error'}});
  same(recovery.steps.at(-2).if,'always()');
  same(recovery.steps.at(-1),{uses:'actions/upload-artifact@v4',if:'always()',with:{name:'intake-extraction-recovery-evidence',
    path:'test-results/intake-extraction-public/','if-no-files-found':'error'}});
  same(Object.keys(mutations).sort(),[...requiredMutations].sort(),'producer mutation obligations');
  same(guardCases.map(c=>[c.name,c.group,...c.args]),[
    ['pre-capture','boundaries','--boundary-mutation','early-read'],['continuation-epoch','fence-continuation','--omit-epoch-check'],
    ['closed-before-open','phase-prototype','--forget-unseen-close']],'guard mutation obligations');
  for(const name of readingDependencies){for(const s of workflow.jobs[name].steps.filter(s=>s.uses==='actions/upload-artifact@v4'))same(s.if,'always()');}
  const retainedArtifacts=previous.jobs.reading.steps.filter(s=>s.uses==='actions/upload-artifact@v4'&&!s.with.name.startsWith('access-'));
  for(const [part,cases]of Object.entries({behavior:['fidelity','formats','resources','mixed','units','bounds'],
    admission:['identity','concurrency','prior-act','temporal','ordering','recovery','disclosure'],guards:[]})){
    const name='intake-preparation-'+part,job=workflow.jobs[name];
    same(commands(job),['npm ci','node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',
      'node --test tests/intake/extraction/ci_evidence.mjs tests/intake/preparation/test_ci.mjs','docker pull postgres:16',
      ...(part==='behavior'?['npm run test:intake:preparation:unit','npm run test:intake:preparation:schema']:[]),
      ...(part==='guards'?['node ci/intake_preparation_guards.mjs']:cases.map(c=>
        'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases preparation --preparation-cases '+c)),
      'node ci/intake_extraction_artifacts.mjs'],name+' finite obligations');
    same(job.steps.at(-2).if,'always()');
    same(job.steps.at(-1),{uses:'actions/upload-artifact@v4',if:'always()',with:{name:name+'-evidence',
      path:'test-results/intake-extraction-public/','if-no-files-found':'error'}});
  }
  for(const [part,cases]of Object.entries({behavior:['ui-first-slice','ui-reception','ui-preparation','ui-resources'],
    admission:['ui-protection','ui-adoption-reception','ui-adoption-preparation','ui-disclosure-navigation']})){
    const name='intake-workspace-'+part,job=workflow.jobs[name];
    same(commands(job),['npm ci','node --test tests/intake/t02/test_ci_wiring.mjs','node ci/intake_ci_check.mjs',
      'node --test tests/intake/ui/test_ci.mjs','docker pull postgres:16',
      ...(part==='behavior'?['node --experimental-strip-types ci/intake_ui_check.mjs --group units','node --test tests/intake/ui/views/test_views.mjs']:[]),
      ...cases.map(c=>'node --experimental-strip-types ci/intake_t02_check.mjs --group extraction --extraction-cases preparation --preparation-cases '+c),
      ...(part==='admission'?['node ci/intake_workspace_guards.mjs']:[]),'node ci/intake_extraction_artifacts.mjs'],name+' finite obligations');
    same(job.steps.at(-2).if,'always()');
    same(job.steps.at(-1),{uses:'actions/upload-artifact@v4',if:'always()',with:{name:name+'-evidence',
      path:'test-results/intake-extraction-public/','if-no-files-found':'error'}});
  }
  same(scripts['test:intake:preparation:unit'],'node --experimental-strip-types ci/intake_preparation_check.mjs --group contracts');
  same(scripts['test:intake:preparation:schema'],'node --experimental-strip-types ci/intake_preparation_check.mjs --group schema');
  same(base.steps.filter(s=>s.uses==='actions/upload-artifact@v4'),retainedArtifacts,'foundation artifacts');
  return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyWiring(parseWorkflow(fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8')));console.log('Intake CI obligation mapping OK');
}
