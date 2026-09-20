import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { collectProcessOutput } from '../tests/intake/t01/reviewed/process-output.mjs';
import { expectedStoppedPoll,failedRuntimeStoppedPoll } from './intake/reception/bridge_status.mjs';
import { suspendedAppendCopy,rejectRetainedIncarnationCopy } from './intake/reception/fencing_fault.mjs';
import {coupledEnvironmentCopy,coupledDockerCopy,coupledIgnoreCopy,coupledLegacyLaunchCopy} from '../tests/intake/t02/access_fence_coupling.mjs';
import {withSourceComposition} from './access_final_routes.mjs';
import {lostPrivateAckCopy} from './intake/reception/ack_fault.mjs';
import {privateCommitFaultCopy} from './intake/reception/commit_fault.mjs';
import {continuationObservedCopy} from './intake/reception/continuation_fault.mjs';
import {observerFaultCopy} from './intake/reception/observer_fault.mjs';
import {producerFaultCopy,producerFaultGroups} from './intake/reception/producer_fault.mjs';
import {receiptCommitFaultCopy} from './intake/reception/receipt_commit_fault.mjs';
import {observationActions,eventObservationTarget} from './intake/reception/admin_observation.mjs';
import {observationFaultCopy} from './intake/reception/observation_fault.mjs';
import {commandDiagnostic} from './intake/command_diagnostic.mjs';
import {supervisedBudgetCopy} from '../tests/intake/extraction/budget_fault.mjs';
import {interruptedSealCopy} from '../tests/intake/extraction/seal_fault.mjs';
import {semanticFaultCopy} from '../tests/intake/extraction/semantic_fault.mjs';
import {mixedComponentsCopy} from '../tests/intake/extraction/mixed_fault.mjs';
import {preparationAssociationCopy} from './intake/preparation_association_input.mjs';
import {containmentProbeCopy} from '../tests/intake/extraction/containment_fault.mjs';
import {associationBoundaryCopy} from '../tests/intake/extraction/association_fault.mjs';
import {summarizeNodeTests} from './intake_test_summary.mjs';
import {preparationFaultCopy} from './intake/preparation_fault.mjs';
import {workspaceFaultCopy} from './intake/workspace_fault.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const group=process.argv[process.argv.indexOf('--group')+1];
const extractionCases=process.argv.includes('--extraction-cases')?process.argv[process.argv.indexOf('--extraction-cases')+1]:'service';
const formatCase=process.argv.includes('--format-case')?process.argv[process.argv.indexOf('--format-case')+1]:null;
const preparationCases=process.argv.includes('--preparation-cases')?process.argv[process.argv.indexOf('--preparation-cases')+1]:'first-slice';
if(!['first-slice','ui-first-slice','ui-reception','ui-preparation','ui-protection','ui-resources','ui-adoption-reception','ui-adoption-preparation','ui-disclosure-navigation','fidelity','formats','resources','mixed','identity','concurrency','prior-act','temporal','ordering','units','recovery','disclosure','bounds'].includes(preparationCases)||(preparationCases!=='first-slice'&&(group!=='extraction'||extractionCases!=='preparation')))throw Error('PREPARATION_CASE_SCOPE');
const uiFirstSlice=group==='extraction'&&extractionCases==='preparation'&&['ui-first-slice','ui-reception','ui-preparation','ui-protection','ui-resources','ui-adoption-reception','ui-adoption-preparation','ui-disclosure-navigation'].includes(preparationCases);
const preparationMutation=process.argv.includes('--preparation-mutation')?process.argv[process.argv.indexOf('--preparation-mutation')+1]:null;
const workspaceMutation=process.argv.includes('--workspace-mutation')?process.argv[process.argv.indexOf('--workspace-mutation')+1]:null;
const adoptionSite=process.argv.includes('--adoption-site')?process.argv[process.argv.indexOf('--adoption-site')+1]:null;
if(workspaceMutation&&(preparationCases!=='ui-adoption-reception'||workspaceMutation!=='omit-post-response-session'||adoptionSite!=='original-inspection'))throw Error('WORKSPACE_MUTATION_SCOPE');
if(adoptionSite&&(preparationCases!=='ui-adoption-reception'||!['original-inspection','reception-stop'].includes(adoptionSite)))throw Error('WORKSPACE_SITE_SCOPE');
if(preparationMutation&&!({fidelity:['drop-retained-context'],formats:['drop-retained-limitation'],resources:['swap-resource-at-birth','swap-resource-at-consume'],mixed:['flatten-component-causes'],identity:['ignore-c9-conditions'],concurrency:['drop-item-lock'],'prior-act':['drop-prior-target']}[preparationCases]??[]).includes(preparationMutation))throw Error('PREPARATION_MUTATION_SCOPE');
if(formatCase&&(group!=='extraction'||extractionCases!=='formats'||!['escaped-limit.csv','combined-limit.csv','control-at-byte-limit.txt'].includes(formatCase)))throw Error('EXTRACTION_FORMAT_FILTER_SCOPE');
if(!['service','formats','format-negatives','temporal','fencing','budgets','retry','restart','restore','storage-recovery','semantics','mixed','capacity','private-loss','controller-loss','resources','authority-original','authority-result','authority-effect','compatibility','containment','browser-disconnect','extraction-privileges','lineage','associations','preparation'].includes(extractionCases)||(extractionCases!=='service'&&group!=='extraction'))throw Error('EXTRACTION_CASE_SCOPE');
const extractionMutation=process.argv.includes('--extraction-mutation')?process.argv[process.argv.indexOf('--extraction-mutation')+1]:null;
if(extractionMutation&&(group!=='extraction'||!({semantics:['omit-condition-store','omit-limitation-store','omit-incident-query'],
  resources:['omit-resource-relation-store','read-resource-before-validation','allow-resource-swap'],
  'format-negatives':['xlsx-recalculate-store','xlsx-hide-sheet-store','xlsx-context-store']}[extractionCases]??[]).includes(extractionMutation)))throw Error('EXTRACTION_MUTATION_SCOPE');
if(!['units','runtime','extraction','authority','missing-catalog','transitions','neutrality','original-scope','fragment-permissions','privileges','transactions','delivery-order','finite-stream','finite-quota','finite-attempts','boundaries','temporal','integrity','browser','observer','observer-canonical','phase-lineage','fencing-probe','phase-prototype','fence-sql','fence-loss','fence-coupled','fence-ack','fence-commit','fence-continuation','fence-ipc','fence-restore'].includes(group))throw Error('Explicit T02 group required');
const isObserver=['observer','observer-canonical'].includes(group);
const usesObjectObserver=observationActions(group).includes('observe-events');
const canonicalCase=process.argv.includes('--canonical-case')?process.argv[process.argv.indexOf('--canonical-case')+1]:'same-key';
if(group==='observer-canonical'&&!['same-key','new-key','incompatible','receipt'].includes(canonicalCase))throw Error('CANONICAL_CASE_SCOPE');
const independentRelease=process.argv.includes('--independent-release')?process.argv[process.argv.indexOf('--independent-release')+1]:null;
const independentManifestHash=process.argv.includes('--independent-manifest-sha256')?process.argv[process.argv.indexOf('--independent-manifest-sha256')+1]:null;
if(independentRelease&&(!isObserver||!(/^[a-f0-9]{64}$/i.test(independentManifestHash??''))))throw Error('INDEPENDENT_RELEASE_PIN_REQUIRED');
let independentRoot=null,independentFiles=null;
const omitEpochCheck=process.argv.includes('--omit-epoch-check');
const observerMutation=process.argv.includes('--observer-mutation')?process.argv[process.argv.indexOf('--observer-mutation')+1]:null;
const boundaryMutation=process.argv.includes('--boundary-mutation')?process.argv[process.argv.indexOf('--boundary-mutation')+1]:null;
const producerMutation=process.argv.includes('--producer-mutation')?process.argv[process.argv.indexOf('--producer-mutation')+1]:null;
const observationMutation=process.argv.includes('--observation-mutation')?process.argv[process.argv.indexOf('--observation-mutation')+1]:null;
if(observationMutation&&(group!=='delivery-order'||!['drop-fallback','destroy-after-observation'].includes(observationMutation)))throw Error('OBSERVATION_MUTATION_SCOPE');
if(producerMutation&&producerFaultGroups[producerMutation]!==group)throw Error('PRODUCER_MUTATION_SCOPE');
const lifecycleFault=process.argv.includes('--lifecycle-fault')?process.argv[process.argv.indexOf('--lifecycle-fault')+1]:null;
const receiptCommitLoss=process.argv.includes('--receipt-commit-loss');
if(receiptCommitLoss&&group!=='transactions')throw Error('RECEIPT_COMMIT_LOSS_SCOPE');
if(lifecycleFault&&(group!=='runtime'||!['before-connect','evidence-export'].includes(lifecycleFault)))throw Error('LIFECYCLE_FAULT_SCOPE');
if(boundaryMutation&&(group!=='boundaries'||boundaryMutation!=='early-read'))throw Error('BOUNDARY_MUTATION_SCOPE');
if(observerMutation&&(group!=='observer'||!['response-byte','omit-physical-read'].includes(observerMutation)))throw Error('OBSERVER_MUTATION_SCOPE');
if(omitEpochCheck&&group!=='fence-continuation')throw Error('EPOCH_MUTATION_SCOPE');
const reopenClosedPhase=process.argv.includes('--reopen-closed-phase');
if(reopenClosedPhase&&group!=='fence-ipc')throw Error('CLOSED_PHASE_MUTATION_SCOPE');
const commitKind=process.argv[process.argv.indexOf('--commit-kind')+1];
if(group==='fence-commit'&&!['rollback','reply-loss'].includes(commitKind))throw Error('PRIVATE_COMMIT_KIND');
const ackKind=process.argv[process.argv.indexOf('--ack-kind')+1];
if(group==='fence-ack'&&!['append','seal','read','close'].includes(ackKind))throw Error('PRIVATE_ACK_KIND');
const coupledSuites={runtime:'test_runtime.mjs',invitations:'test_invitations.mjs',reading:'test_authorized_reading.mjs',administration:'test_administration.mjs',journey:'test_whole_journey.mjs'};
const coupledSuite=process.argv.includes('--coupled-suite')?process.argv[process.argv.indexOf('--coupled-suite')+1]:'all';
if(coupledSuite!=='all'&&(group!=='fence-coupled'||!Object.hasOwn(coupledSuites,coupledSuite)))throw Error('COUPLED_SUITE_SCOPE');
const lossKind=process.argv[process.argv.indexOf('--loss-kind')+1];
if(group==='fence-loss'&&!['sql','runtime','supervisor'].includes(lossKind))throw Error('FENCE_LOSS_KIND');
const failRecoveryHelper=process.argv.includes('--fail-recovery-helper');
if(failRecoveryHelper&&(group!=='fence-loss'||lossKind!=='supervisor'))throw Error('RECOVERY_FAILURE_SCOPE');
const withoutWorkerStop=process.argv.includes('--without-worker-stop');
if(withoutWorkerStop&&!['fencing-probe','fence-loss'].includes(group))throw Error('FENCING_MUTATION_GROUP');
if(group==='fence-loss'&&!withoutWorkerStop)throw Error('EXPLICIT_FENCE_LOSS_FAULT_REQUIRED');
const rejectRetainedIncarnation=process.argv.includes('--reject-retained-incarnation');
if(rejectRetainedIncarnation&&group!=='fence-loss')throw Error('RETAINED_INCARNATION_MUTATION_GROUP');
const forgetUnseenClose=process.argv.includes('--forget-unseen-close');
if(forgetUnseenClose&&group!=='phase-prototype')throw Error('PHASE_MUTATION_GROUP');
const runId=(group==='extraction'?'intake-extraction-':'intake-t02-')+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const directory=path.join(root,group==='extraction'?'test-results/intake-extraction':'test-results/intake-t02',runId),claim=path.join(root,'test-results/intake-t02/.active-run');
await fs.mkdir(directory,{recursive:true});
await fs.mkdir(path.dirname(claim),{recursive:true});
await fs.writeFile(claim,runId,{flag:'wx'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=[],commands=[],resources=[];
let index=0;
async function save(name,value){await fs.writeFile(path.join(directory,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
async function source(relative) {
  // Non-checker groups do not snapshot a concurrently reserved mutable checker.
  if(relative==='tests/intake/t02/independent'&&!isObserver)return;
  const pinned=independentRoot&&relative.startsWith('tests/intake/t02/independent');
  const file=pinned?path.join(independentRoot,relative.slice('tests/intake/t02/independent'.length)):path.join(root,relative),stat=await fs.lstat(file);
  if(stat.isSymbolicLink())throw Error('SOURCE_SYMBOLIC_LINK');
  if(stat.isDirectory()){for(const name of (await fs.readdir(file)).sort())if(!['node_modules','.next'].includes(name))await source(path.posix.join(relative,name));}
  else {let bytes=await fs.readFile(file),fault=null;const originalSha256=hash(bytes),target=path.join(directory,'source',relative);
    if(group==='extraction'&&extractionCases==='budgets'&&relative==='workers/intake/extraction/entry.mjs'){
      bytes=Buffer.from(supervisedBudgetCopy(bytes.toString('utf8')));fault='instrumented-producer-output-reserve';
    }
    if(preparationMutation){const changed=preparationFaultCopy(relative,bytes.toString('utf8'),preparationMutation);
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault=preparationMutation;}}
    if(workspaceMutation){const changed=workspaceFaultCopy(relative,bytes.toString('utf8'),workspaceMutation);
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault=workspaceMutation;}}
    if(group==='extraction'&&extractionCases==='containment'&&relative==='workers/intake/extraction/entry.mjs'){
      bytes=Buffer.from(containmentProbeCopy(bytes.toString('utf8')));fault='instrumented-effective-denials-and-timeout';
    }
    if(group==='extraction'&&extractionCases==='associations'){
      const changed=associationBoundaryCopy(relative,bytes.toString('utf8'));
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault='instrumented-internal-association-input';}
    }
    if(group==='extraction'&&extractionCases==='storage-recovery'&&relative==='ci/intake/extraction/seal.mjs'){
      bytes=Buffer.from(interruptedSealCopy(bytes.toString('utf8')));fault='actual-private-child-kill-after-raw-seal';
    }
    if(extractionMutation){
      const changed=semanticFaultCopy(relative,bytes.toString('utf8'),extractionMutation);
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault=extractionMutation;}
    }
    if(group==='extraction'&&(extractionCases==='mixed'||extractionCases==='preparation'&&preparationCases==='mixed')&&relative==='src/server/intake/extraction_output.ts'){
      bytes=Buffer.from(mixedComponentsCopy(bytes.toString('utf8')));fault='instrumented-three-component-outcome';
      if(extractionCases==='preparation') bytes=Buffer.from(bytes.toString('utf8').replace("    outcome='partial';",
        "    outcome='partial';\n    if(body.elements[0]?.text === 'Known component source.\\n') body.inventory='known';"));
    }
    if(group==='extraction'&&extractionCases==='preparation'&&preparationCases==='fidelity'){
      const changed=preparationAssociationCopy(relative,bytes.toString('utf8'));
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault='instrumented-preparation-association-input';}
    }
    if(pinned){const expected=independentFiles.find(x=>x.name===path.relative(independentRoot,file).replaceAll('\\','/'));
      if(!expected||expected.bytes!==bytes.length||expected.sha256!==originalSha256)throw Error('INDEPENDENT_SOURCE_IDENTITY');}
    if(observerMutation){const changed=observerFaultCopy(relative,bytes.toString('utf8'),observerMutation);
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault='observer-'+observerMutation;}}
    if(producerMutation){
      const changed=producerFaultCopy(relative,bytes.toString('utf8'),producerMutation);
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault='producer-'+producerMutation;}
    }
    if(observationMutation){
      const changed=observationFaultCopy(relative,bytes.toString('utf8'),observationMutation);
      if(changed!==bytes.toString('utf8')){bytes=Buffer.from(changed);fault='observation-'+observationMutation;}
    }
    if(receiptCommitLoss&&relative==='src/server/intake/service.ts'){
      bytes=Buffer.from(receiptCommitFaultCopy(bytes.toString('utf8')));fault='actual-receipt-commit-reply-loss';
    }
    if(lifecycleFault==='before-connect'&&relative==='tests/access/runtime_environment.mjs'){
      const value=bytes.toString('utf8'),anchor='    await admin.connect();';
      if(value.split(anchor).length!==3)throw Error('PRECONNECT_FAULT_ANCHOR');
      bytes=Buffer.from(value.replace(anchor,"    throw Error('EXPECTED_T02_BEFORE_SQL_CONNECT');\n"+anchor));fault='before-first-sql-connect';
    }
    if(boundaryMutation&&relative==='src/server/intake/terminal.ts'){
      const value=bytes.toString('utf8'),anchor="const request=receptionEnvelope(req,access.transport,config.extraction==='intake-execution/1'),token=sessionToken(req.headers.cookie),onLoss=()=>res.destroy();";
      if(value.split(anchor).length!==2)throw Error('EARLY_READ_MUTATION_ANCHOR');
      bytes=Buffer.from(value.replace(anchor,"if(req.url==='/api/intake/receptions'&&req.headers['content-length']==='65537'){\n"+
        "if(!req.readableLength)await new Promise(resolve=>req.once('readable',resolve));\n"+
        "req.read(1); /* Deliberate explicit consumption before any intake admission. */\n}\n"+anchor));fault='explicit-read-before-intake-admission';
    }
    if(group==='fence-coupled'){
      const compose={'tests/access/runtime_environment.mjs':coupledEnvironmentCopy,'tests/access/test_runtime.mjs':coupledLegacyLaunchCopy,
        'tests/access/test_invitations.mjs':coupledLegacyLaunchCopy,'ci/access/Runtime.Dockerfile':coupledDockerCopy,
        'ci/access/Runtime.Dockerfile.dockerignore':coupledIgnoreCopy}[relative];
      if(compose){bytes=Buffer.from(compose(bytes.toString('utf8')));fault='test-composition-install-actual-shared-fence';}
    }
    if(group==='fence-ack'&&relative==='ci/intake/reception/server.mjs'){
      bytes=Buffer.from(lostPrivateAckCopy(bytes.toString('utf8')));fault='lose-exact-private-completion-ack';
    }
    if(group==='fence-commit'&&relative==='src/server/intake/private_phase.ts'){
      bytes=Buffer.from(privateCommitFaultCopy(bytes.toString('utf8')));fault='actual-phase-commit-transport-fault';
    }
    if(group==='fence-continuation'&&relative==='src/server/intake/private_phase.ts'){
      bytes=Buffer.from(continuationObservedCopy(bytes.toString('utf8'),omitEpochCheck));fault=omitEpochCheck?'omit-continuation-epoch-check':'observe-retired-phase-before-fresh-snapshot';
    }
    if(reopenClosedPhase&&relative==='ci/intake/reception/private_phase.mjs'){
      const value=bytes.toString('utf8'),guard="if(existing.state!=='open')throw Error('PHASE_CLOSED');";
      if(value.split(guard).length!==2)throw Error('CLOSED_PHASE_GUARD_ANCHOR');
      bytes=Buffer.from(value.replace(guard,'void 0; /* Deliberately acknowledge an already terminal OPEN. */'));fault='acknowledge-terminal-phase-open';
    }
    if(failRecoveryHelper&&relative==='ci/intake/reception/recovery_control.mjs'){
      const value=bytes.toString('utf8'),anchor='// Every delayed OPEN/command for this phase remains terminal after replacement.';
      if(value.split(anchor).length!==2)throw Error('RECOVERY_FAILURE_ANCHOR');
      bytes=Buffer.from(value.replace(anchor,"throw Error('INJECTED_RECOVERY_BEFORE_TERMINAL_WRITE');\n"+anchor));fault='fail-recovery-before-terminal-write';
    }
    if(['fencing-probe','fence-loss'].includes(group)&&relative==='ci/intake/reception/object_store.mjs'){bytes=Buffer.from(suspendedAppendCopy(bytes.toString('utf8')));fault='suspend-valid-append-before-write';}
    if(rejectRetainedIncarnation&&relative==='src/server/intake/postgres/003_private_fence.sql'){
      bytes=Buffer.from(rejectRetainedIncarnationCopy(bytes.toString('utf8')));fault='reject-retained-incarnation';
    }
    if(withoutWorkerStop&&relative==='ci/intake/reception/operation_supervisor.mjs'){
      const text=bytes.toString('utf8'),needle="child.kill('SIGKILL');";
      if(text.split(needle).length!==2)throw Error('SUPERVISOR_STOP_MUTATION_ANCHOR');
      bytes=Buffer.from(text.replace(needle,'void 0; /* Injected missing worker stop. */'));fault='disable-worker-stop';
    }
    if(forgetUnseenClose&&relative==='ci/intake/reception/private_phase.mjs'){
      const text=bytes.toString('utf8'),needle='const row=this.rows[id];';
      if(text.split(needle).length!==2)throw Error('PHASE_CLOSE_MUTATION_ANCHOR');
      bytes=Buffer.from(text.replace(needle,needle+"if(!row)return{profile:'intake-phase-closed/1',id,participant:this.participant};"));fault='forget-unseen-close';
    }
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});
    files.push({path:relative,bytes:bytes.length,sha256:hash(bytes),...(hash(bytes)!==originalSha256?{originalSha256,fault}:{})});}
}
async function run(program,args,{timeout=60000,limit=8388608}={}) {
  const start=Date.now();
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const collector=collectProcessOutput(child.stdout,child.stderr,{outputBytes:limit,diagnosticBytes:65536,stop:()=>child.kill()});
    const timer=setTimeout(()=>collector.terminate('worker_timeout'),timeout);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,...collector.finish(),milliseconds:Date.now()-start});});
  });
  const file=String(++index).padStart(3,'0')+'-command.json';
  const diagnostic=program===process.execPath?commandDiagnostic(args,result):null;
  await save(file,{program:path.basename(program),args,...result,...(diagnostic?{diagnostic}:{})});commands.push({file,code:result.code,reason:result.reason??null});
  console.log(JSON.stringify({command:index,program:path.basename(program),code:result.code,reason:result.reason??null,milliseconds:result.milliseconds}));
  return result;
}
const resourcePrefix='ld-i03-t02-'+randomUUID().slice(0,8);
async function docker(args,options){const result=await run('docker',args,options);if(result.code!==0||result.reason)throw Error('DOCKER_COMMAND_'+index);return result.stdout.trim();}
async function runtimeGroup() {
  for(const target of ['runtime','private_service']) {
    const name='ledgerdesk-intake-t02:'+resourcePrefix+'-'+target;
    const build=extra=>docker(['build',...extra,'-f',path.join(directory,'source/ci/intake/T02.Dockerfile'),
      '--target',uiFirstSlice&&target==='runtime'?'ui_runtime':target,'--label','intake.t02.run='+resourcePrefix,'-t',name,path.join(directory,'source')],{timeout:240000});
    if(uiFirstSlice&&target==='runtime')await withSourceComposition(root,path.join(directory,'access-source-composition.json'),
      async({filename,sha256})=>{
        if(workspaceMutation){
          const composition=JSON.parse(await fs.readFile(filename,'utf8')),changed=files.filter(file=>file.fault===workspaceMutation);
          if(changed.length!==1)throw Error('WORKSPACE_MUTATION_INVENTORY');
          for(const file of changed){const row=composition.files.find(row=>row.file===file.path);if(!row)throw Error('WORKSPACE_MUTATION_COMPOSITION');row.sha256=file.sha256;}
          await save('mutated-access-source-composition.json',composition);filename=path.join(directory,'mutated-access-source-composition.json');
          sha256=hash(await fs.readFile(filename));
        }
        return build(['--secret','id=access_composition,src='+filename,'--build-arg','ACCESS_COMPOSITION_SHA256='+sha256]);
      });
    else await build([]);
    const item=JSON.parse(await docker(['image','inspect',name]))[0];resources.push({type:'image',name,id:item.Id});
  }
  const image=target=>'ledgerdesk-intake-t02:'+resourcePrefix+'-'+target;
  const volumes={};
  for(const key of ['objects','object-ipc','verifier-ipc','object-output','verifier-output','restored']) {
    const name=resourcePrefix+'-'+key;await docker(['volume','create','--label','intake.t02.run='+resourcePrefix,name]);
    volumes[key]=name;resources.push({type:'volume',name,id:name});
  }
  async function container(suffix,args){const name=resourcePrefix+'-'+suffix,id=await docker(['create','--name',name,'--label','intake.t02.run='+resourcePrefix,...args]);
    const resource={type:'container',name,id};resources.push(resource);return resource;}
  if(group==='extraction'&&extractionCases==='preparation'){
    const checks=await container('preparation-contracts',['--network','none','--read-only','--user','1001:1001',
      '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','64',
      '--entrypoint','node',image('runtime'),'--experimental-strip-types','--test',
      'tests/intake/preparation/test_contracts.mjs','tests/intake/preparation/test_producer.mjs']);
    await save('preparation-contracts-inspect.json',JSON.parse(await docker(['inspect',checks.name])));
    const result=await run('docker',['start','-a',checks.name],{timeout:60000,limit:1048576});
    // Preserve a numeric command record for the existing flat-TAP validator.
    const record=String(index)+'.json';
    await save(record,{...result,sourceCommand:commands.at(-1).file});
    const report=summarizeNodeTests(result,record);
    await save('preparation-contracts-result.json',{platform:'linux',report});
    if(report.status!=='passed')throw Error('PREPARATION_LINUX_CONTRACTS_FAILED');
  }
  const mount=(volume,target)=>['--mount',`type=volume,source=${volumes[volume]},target=${target}`];
  const init=await container('volume-init',['--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--security-opt','no-new-privileges',
    ...Object.keys(volumes).flatMap((key,i)=>mount(key,'/owned-'+i)),'--entrypoint','node',image('private_service'),'-e',
    "const fs=require('fs');for(let i=0;i<6;i++){const ipc=i===1||i===2;fs.chmodSync('/owned-'+i,ipc?0o750:0o700);fs.chownSync('/owned-'+i,1000,ipc?20202:1000)}"]);
  await docker(['start','-a',init.name]);
  const bounded=['--network','none','--group-add','20202','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--memory-swap','512m',
    '--cpus','1','--pids-limit','64','--ulimit','nofile=128:128','--tmpfs','/tmp:rw,noexec,nosuid,size=8388608'];
  let broker=await container('objects',[...bounded,...mount('objects','/objects'),...mount('restored','/restored'),...mount('object-ipc','/run/intake-t02/objects'),...mount('object-output','/output'),
    image('private_service'),'objects','/run/intake-t02/objects/channel.sock']);
  const verifier=await container('verifier',[...bounded,...mount('verifier-ipc','/run/intake-t02/verifier'),...mount('verifier-output','/output'),
    image('private_service'),'verifier','/run/intake-t02/verifier/channel.sock']);
  await docker(['start',broker.name]);await docker(['start',verifier.name]);
  for(const resource of [broker,verifier]) {
    let ready=false;
    for(let attempt=0;attempt<10;attempt++){const result=await docker(['logs',resource.name]);if(result.includes('"ready":true')){ready=true;break;}
      await new Promise(resolve=>setTimeout(resolve,100));}
    if(!ready)throw Error('PRIVATE_SERVICE_NOT_READY');
    await save(resource.name+'-inspect.json',JSON.parse(await docker(['inspect',resource.name])));
  }
  if(group==='phase-prototype'){
    const result=await run('docker',['exec',broker.name,'node','--test','/work/test_private_phase.mjs'],{timeout:15000});
    const target=path.join(directory,'phase-prototype');await fs.mkdir(target,{recursive:true});
    await docker(['cp',broker.name+':/output/.',target]);
    if(result.code!==0||result.reason)throw Error('PHASE_PROTOTYPE_FAILED');
    return;
  }
  const extraction=group==='extraction'?await (await import(pathToFileURL(path.join(directory,'source/ci/intake/extraction/runtime_harness.mjs')))).extractionHarness({
    directory,prefix:resourcePrefix,docker,resources,container,bounded,save,originalParticipant:broker}):null;
  const runtime=await container('runtime',['--network','none','--group-add','20202','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',uiFirstSlice?'2g':'1g','--memory-swap',uiFirstSlice?'2g':'1g','--cpus','2','--pids-limit',uiFirstSlice?'256':'192',
    ...(uiFirstSlice?['--shm-size','256m']:[]),
    ...(group==='extraction'&&extractionCases==='preparation'?['--env','LEDGERDESK_PREPARATION_CASES='+preparationCases]:[]),
    ...(adoptionSite?['--env','LEDGERDESK_UI_ADOPTION_SITE='+adoptionSite]:[]),
    ...(extraction?.runtimeArgs??[]),
    ...(extraction?['--env','LEDGERDESK_EXTRACTION_CASES='+extractionCases]:[]),
    ...(formatCase?['--env','LEDGERDESK_EXTRACTION_FORMAT_CASE='+formatCase]:[]),
    ...mount('object-ipc','/run/intake-t02/objects'),...mount('verifier-ipc','/run/intake-t02/verifier'),
    ...(group==='observer'?['--env','LEDGERDESK_INTAKE_OBSERVER=1']:[]),
    ...(group==='observer-canonical'?['--env','LEDGERDESK_INTAKE_CANONICAL='+canonicalCase]:[]),
    ...(group==='browser'?['--env','LEDGERDESK_INTAKE_BROWSER=1']:[]),
    ...(group==='boundaries'?['--env','LEDGERDESK_INTAKE_BOUNDARIES=1']:[]),
    ...(group==='temporal'?['--env','LEDGERDESK_INTAKE_TEMPORAL=1']:[]),
    ...(group==='integrity'?['--env','LEDGERDESK_INTAKE_INTEGRITY=1']:[]),
    ...(['authority','missing-catalog','transitions','neutrality','original-scope','fragment-permissions'].includes(group)?['--env','LEDGERDESK_INTAKE_COMPLETION='+group]:[]),
    ...(['finite-stream','finite-quota','finite-attempts'].includes(group)?['--env','LEDGERDESK_INTAKE_FINITE='+group]:[]),
    ...(group==='privileges'?['--env','LEDGERDESK_INTAKE_PRIVILEGES=1']:[]),
    ...(group==='transactions'?['--env','LEDGERDESK_INTAKE_TRANSACTION=1']:[]),
    ...(receiptCommitLoss?['--env','LEDGERDESK_INTAKE_RECEIPT_COMMIT=1']:[]),
    ...(group==='delivery-order'?['--env','LEDGERDESK_INTAKE_DELIVERY_ORDER=1']:[]),
    ...(group==='phase-lineage'?['--env','LEDGERDESK_INTAKE_PHASE_LINEAGE=1']:[]),
    ...(group==='fencing-probe'?['--env','LEDGERDESK_INTAKE_FENCING_PROBE=1']:[]),
    ...(group==='fence-sql'?['--env','LEDGERDESK_INTAKE_FENCE_SQL=1']:[]),
    ...(group==='fence-loss'?['--env','LEDGERDESK_INTAKE_FENCE_LOSS='+lossKind]:[]),
    ...(group==='fence-ack'?['--env','LEDGERDESK_INTAKE_FENCE_ACK='+ackKind]:[]),
    ...(group==='fence-commit'?['--env','LEDGERDESK_INTAKE_FENCE_COMMIT='+commitKind]:[]),
    ...(group==='fence-continuation'?['--env','LEDGERDESK_INTAKE_FENCE_CONTINUATION=1']:[]),
    ...(group==='fence-ipc'?['--env','LEDGERDESK_INTAKE_FENCE_IPC=1']:[]),
    ...(group==='fence-restore'?['--env','LEDGERDESK_INTAKE_FENCE_RESTORE=1']:[]),image('runtime')]);
  await save('runtime-inspect.json',JSON.parse(await docker(['inspect',runtime.name])));
  if(usesObjectObserver){
    const actual=JSON.parse(await fs.readFile(path.join(directory,'runtime-inspect.json')))[0];
    await save('observer-source.json',{runId,source:{base:(await run('git',['rev-parse','HEAD'])).stdout.trim(),
      manifestSha256:hash(await fs.readFile(path.join(directory,'source-manifest.json'))),imageId:actual.Image}});
    await docker(['cp',path.join(directory,'observer-source.json'),runtime.name+':/work/output/observer-source.json']);
  }
  let running=true,bridgeFailure=null;
  const executionPromise=run('docker',['start','-a',runtime.name],{timeout:extractionCases==='temporal'?330000:240000}).finally(()=>{running=false;});
  const handled=new Set();
  try{while(running){
    await new Promise(resolve=>setTimeout(resolve,500));
    if(!running)break;
    await extraction?.bridge.tick();
    const poll=await run('docker',['exec',runtime.name,'node','-e',"const f=require('fs');const p='/work/output/admin-request.json';process.stdout.write(f.existsSync(p)?f.readFileSync(p):'null')"]);
    if(!running&&poll.code!==0){
      const record=commands.at(-1),observed=JSON.parse(await docker(['inspect',runtime.name]))[0];
      const attached=await executionPromise;
      // A corroborated failed runtime explains this poll, not the runtime failure.
      // Its nonzero command and inspected exit still fail the complete run below.
      if(observed.Id===runtime.id&&(expectedStoppedPoll(poll,runtime.id,observed.State)||
        failedRuntimeStoppedPoll(poll,runtime.id,observed.State,attached)))record.expectedExit='runtime-ended';
      else bridgeFailure='ADMIN_BRIDGE_UNRELATED_FAILURE';
      break;
    }
    if(poll.code!==0){bridgeFailure='ADMIN_BRIDGE_READ';break;}
    const request=JSON.parse(poll.stdout);
    if(!request||handled.has(request.id))continue;
    if(!/^[a-f0-9-]{36}$/.test(request.id)||!['backup','restore','inspect','complete',...(group==='extraction'?['observe-extraction','hold-next-extraction','fail-next-extraction-input','fault-extraction-output']:[]),...observationActions(group),...(group==='phase-lineage'?['observe-original']:[]),...(['fencing-probe','fence-loss'].includes(group)?['arm-stall','stall-state','continue-broker']:[]),
      ...(group==='fence-loss'?['observe-stalled-worker','terminate-stalled-worker','fence-private-process-set','recover-private-participant']:[]),
      ...(group==='fence-ack'?['arm-private-ack','private-ack-state']:[]),
      ...(['fence-commit','fence-ipc'].includes(group)?['phase-no-dispatch']:[]),
      ...(group==='extraction'&&(extractionCases==='restore'||extractionCases==='preparation'&&preparationCases==='recovery')?['extraction-backup','extraction-restore','extraction-restore-inspect']:[]),
      ...(group==='extraction'&&extractionCases==='lineage'?['replay-extraction-completion']:[]),
      ...(group==='extraction'&&extractionCases==='storage-recovery'?['replace-closed-extraction-participant','arm-extraction-seal-fault','inspect-extraction-seal']:[]),
      ...(group==='extraction'&&extractionCases==='private-loss'?['replace-unresolved-extraction-participant']:[]),
      ...(group==='extraction'&&extractionCases==='controller-loss'?['lose-next-extraction-controller']:[]),
      ...(group==='fence-ipc'?['restart-closed-participant']:[]),...(group==='integrity'?['fault-original']:[]),...(group==='privileges'?['probe-object-privileges']:[])].includes(request.action)){bridgeFailure='ADMIN_BRIDGE_REQUEST';break;}
    handled.add(request.id);
    const controlPath=path.join(directory,'admin',request.id);await fs.mkdir(controlPath,{recursive:true});
    if(request.action==='backup'){
      await docker(['cp',runtime.name+':/work/output/backup-data.json',path.join(controlPath,'cut-data.json')]);
      await docker(['cp',path.join(controlPath,'cut-data.json'),broker.name+':/output/cut-data-'+request.id+'.json']);
    }
    let response;
    if(request.action==='lose-next-extraction-controller'){
      if(Object.keys(request.body).length)throw Error('EXTRACTION_CONTROLLER_LOSS_SCOPE');
      extraction.bridge.loseNextController();response=JSON.stringify({ok:true});
    }else if(request.action==='replace-unresolved-extraction-participant'){
      if(Object.keys(request.body).join(',')!=='participant'||request.body.participant!=='outputs')throw Error('EXTRACTION_REPLACEMENT_SCOPE');
      response=JSON.stringify(await extraction.replaceClosed('outputs',{unresolved:true}));
    }else if(request.action==='replace-closed-extraction-participant'){
      if(Object.keys(request.body).join(',')!=='participant')throw Error('EXTRACTION_REPLACEMENT_SCOPE');
      response=JSON.stringify(await extraction.replaceClosed(request.body.participant));
    }else if(['arm-extraction-seal-fault','inspect-extraction-seal'].includes(request.action)){
      response=JSON.stringify(await extraction.storageFault(request.action==='arm-extraction-seal-fault'?'arm':'inspect',request.body));
    }else if(['extraction-backup','extraction-restore','extraction-restore-inspect'].includes(request.action)){
      response=JSON.stringify(await extraction.restoreArchive({'extraction-backup':'backup','extraction-restore':'restore','extraction-restore-inspect':'inspect'}[request.action],
        {...request.body,...(request.action==='extraction-restore'?{attemptId:request.id}:{})}));
    }else if(request.action==='fault-extraction-output'){
      response=JSON.stringify(await extraction.faultOutput(request.body));
    }else if(request.action==='replay-extraction-completion'){
      response=JSON.stringify(await extraction.replayCompletion(request.body));
    }else if(request.action==='hold-next-extraction'){
      if(Object.keys(request.body).length)throw Error('EXTRACTION_HOLD_SCOPE');
      extraction.bridge.holdNextInput();response=JSON.stringify({ok:true});
    }else if(request.action==='fail-next-extraction-input'){
      if(Object.keys(request.body).length)throw Error('EXTRACTION_INPUT_FAULT_SCOPE');
      extraction.bridge.failNextInput();response=JSON.stringify({ok:true});
    }else if(request.action==='observe-extraction'){
      if(Object.keys(request.body).length!==1)throw Error('EXTRACTION_OBSERVER_SCOPE');
      response=JSON.stringify({ok:true,events:await extraction.observe(request.body.participant)});
    }else if(request.action==='arm-observer'){
      if(Object.keys(request.body).length)throw Error('OBSERVER_ARM_SCOPE');
      await docker(['exec',broker.name,'node','-e',"require('fs').writeFileSync('/output/observer-fault-armed','armed',{flag:'wx'})"]);
      response=JSON.stringify({ok:true});
    }else if(request.action==='observe-events'){
      const participant=eventObservationTarget(group,request.body);
      response=await docker(['exec',participant==='objects'?broker.name:verifier.name,'node','-e',"const f=require('fs'),p='/output/events.ndjson';let bytes,present=true;try{bytes=f.readFileSync(p)}catch(e){if(e.code!=='ENOENT')throw e;bytes=Buffer.alloc(0);present=false}if(bytes.length>4194304)throw Error('EVENT_INVENTORY_LIMIT');process.stdout.write(JSON.stringify({ok:true,present,atMs:Date.now(),events:bytes.toString('utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}))"]);
    }else if(request.action==='fault-original'){
      response=await docker(['exec',broker.name,'node','/work/original_fault.mjs',JSON.stringify(request.body)]);
    }else if(request.action==='probe-object-privileges'){
      response=await docker(['exec',broker.name,'node','/work/object_privileges.mjs',JSON.stringify(request.body)]);
    }else if(request.action==='observe-original'){
      if(Object.keys(request.body).sort().join(',')!=='artifactId,generation'||!/^[a-f0-9-]{36}$/.test(request.body.artifactId)||![1,2,3].includes(request.body.generation))throw Error('ORIGINAL_OBSERVER_SCOPE');
      response=await docker(['exec',broker.name,'node','/work/capture_original.mjs',JSON.stringify(request.body)]);
    }else if(request.action==='phase-no-dispatch'){
      if(!/^[a-f0-9-]{36}$/.test(request.body.phaseId??'')||Object.keys(request.body).join(',')!=='phaseId')throw Error('PHASE_INSPECT_SCOPE');
      const members={};
      for(const [name,resource]of [['objects',broker],['verifier',verifier]]){
        members[name]=JSON.parse(await docker(['exec',resource.name,'node','-e',
          "const f=require('fs'),id=process.argv[1];const rows=JSON.parse(f.readFileSync('/output/phase-control/phases.json')).rows;const events=f.existsSync('/output/events.ndjson')?f.readFileSync('/output/events.ndjson','utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];process.stdout.write(JSON.stringify({row:rows[id]??null,events:events.filter(e=>e.phaseId===id)}));",request.body.phaseId]));
      }
      response=JSON.stringify({ok:true,members});
    }else if(request.action==='arm-private-ack'){
      const b=request.body;
      if(!/^[a-f0-9-]{36}$/.test(b.artifactId??'')||b.generation!==1||b.action!==ackKind||Object.keys(b).sort().join(',')!=='action,artifactId,generation')throw Error('ACK_FAULT_SCOPE');
      await docker(['exec',broker.name,'node','-e',"require('fs').writeFileSync('/output/ack-fault.json',process.argv[1],{flag:'wx'})",JSON.stringify(b)]);
      response=JSON.stringify({ok:true});
    }else if(request.action==='private-ack-state'){
      response=await docker(['exec',broker.name,'node','-e',
        "const f=require('fs');const p='/output/ack-fault-used.json',used=f.existsSync(p)?JSON.parse(f.readFileSync(p)):null;const events=f.readFileSync('/output/events.ndjson','utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);const dropped=events.filter(e=>e.origin==='private-ack-boundary');const phase=dropped.at(-1)?.phaseId;const journal=JSON.parse(f.readFileSync('/output/phase-control/phases.json'));process.stdout.write(JSON.stringify({ok:true,used,dropped,phase:phase?{id:phase,...journal.rows[phase]}:null,events:events.filter(e=>e.artifactId===used?.artifactId||e.phaseId===phase)}));"]);
    }else if(request.action==='complete'){
      if(JSON.stringify(request.body)!==JSON.stringify({scope:'runtime-cleanup'}))throw Error('ADMIN_COMPLETION_SCOPE');
      response=JSON.stringify({ok:true});
    }else if(request.action==='continue-broker'){
      const owned=JSON.parse(await docker(['inspect',broker.name]))[0];
      if(owned.Id!==broker.id||owned.Config.Labels['intake.t02.run']!==resourcePrefix)throw Error('FENCING_PROBE_OWNER');
      await docker(['exec',broker.name,'node','-e',"const f=require('fs');if(!f.existsSync('/output/stall-release'))f.writeFileSync('/output/stall-release','release',{flag:'wx'})"]);
      response=JSON.stringify({ok:true,continuedAtMs:Date.now(),processRef:broker.id});
    } else if(request.action==='fence-private-process-set'){
      if(lossKind!=='supervisor')throw Error('SUPERVISOR_FAULT_SCOPE');
      const owned=JSON.parse(await docker(['inspect',broker.name]))[0];
      if(owned.Id!==broker.id||owned.Config.Labels['intake.t02.run']!==resourcePrefix||!owned.State.Running||owned.HostConfig.RestartPolicy.Name!=='no')throw Error('SUPERVISOR_OWNER');
      const child=JSON.parse(await docker(['exec',broker.name,'node','/work/process_control.mjs','observe',JSON.stringify(request.body)]));
      if(!child.before||child.closure)throw Error('SUPERVISOR_FAULT_NOT_REACHED');
      await docker(['kill','--signal','KILL',broker.id]);
      const after=JSON.parse(await docker(['inspect',broker.id]))[0];
      if(after.Id!==broker.id||after.State.Running||after.State.Pid!==0||after.State.Restarting||after.State.Status!=='exited')throw Error('SUPERVISOR_SET_NOT_FENCED');
      await save('stopped-private-supervisor.json',{before:owned,child,after});
      await run('docker',['logs',broker.id]);
      response=JSON.stringify({ok:true,containerRef:broker.id,imageRef:owned.Image,child,before:owned.State,after:after.State});
    } else if(request.action==='restart-closed-participant'){
      if(Object.keys(request.body).join(',')!=='phaseId'||!/^[a-f0-9-]{36}$/.test(request.body.phaseId??''))throw Error('CLOSED_RESTART_SCOPE');
      const old=broker,before=JSON.parse(await docker(['inspect',old.id]))[0];
      if(before.Id!==old.id||before.Config.Labels['intake.t02.run']!==resourcePrefix||!before.State.Running||before.HostConfig.RestartPolicy.Name!=='no')throw Error('CLOSED_RESTART_OWNER');
      await docker(['stop','--time','1',old.id]);
      const ended=JSON.parse(await docker(['inspect',old.id]))[0];
      if(ended.State.Running||ended.State.Pid!==0||ended.State.Status!=='exited'||ended.State.Restarting)throw Error('CLOSED_RESTART_PROCESS_SET');
      await save('closed-restart-old.json',{before,after:ended});
      await docker(['container','rm',old.id]);old.removed=true;
      broker=await container('objects-replaced',[...bounded,...mount('objects','/objects'),...mount('restored','/restored'),...mount('object-ipc','/run/intake-t02/objects'),...mount('object-output','/output'),
        image('private_service'),'objects','/run/intake-t02/objects/channel.sock']);
      const helper=await container('closed-restart',[...bounded,...mount('object-ipc','/run/intake-t02/objects'),...mount('object-output','/output'),
        '--entrypoint','node',image('private_service'),'/work/restart_closed.mjs',JSON.stringify({oldContainerId:old.id,phaseId:request.body.phaseId})]);
      const retained=JSON.parse(await docker(['start','-a',helper.id]));if(!retained.ok)throw Error('CLOSED_RESTART_CONTROL');
      await docker(['start',broker.id]);
      let ready=false;for(let i=0;i<10;i++){if((await docker(['logs',broker.id])).includes('"ready":true')){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
      if(!ready)throw Error('CLOSED_RESTART_NOT_READY');
      await save('closed-restart-new.json',JSON.parse(await docker(['inspect',broker.id]))[0]);
      response=JSON.stringify({ok:true,oldContainerRemoved:old.id,oldState:ended.State,newContainer:broker.id,retained});
    } else if(request.action==='recover-private-participant'){
      if(lossKind!=='supervisor')throw Error('SUPERVISOR_RECOVERY_SCOPE');
      const old=broker,owned=JSON.parse(await docker(['inspect',old.id]))[0];
      if(owned.Id!==old.id||owned.Config.Labels['intake.t02.run']!==resourcePrefix||owned.State.Running||owned.State.Pid!==0||owned.State.Restarting||
        owned.State.Status!=='exited'||owned.HostConfig.RestartPolicy.Name!=='no')throw Error('SUPERVISOR_RECOVERY_PREDECESSOR');
      // Removing the exact stopped container makes the old process set and IPC
      // execution configuration nonrestartable before its journal is reconciled.
      await docker(['container','rm',old.id]);old.removed=true;
      // Create, but do not start, the replacement before the recovery helper.
      // Its mounted output keeps retained evidence reachable if the helper fails.
      broker=await container('objects-recovered',[...bounded,...mount('objects','/objects'),...mount('restored','/restored'),...mount('object-ipc','/run/intake-t02/objects'),...mount('object-output','/output'),
        image('private_service'),'objects','/run/intake-t02/objects/channel.sock']);
      const helper=await container('phase-recovery',[...bounded,...mount('object-ipc','/run/intake-t02/objects'),...mount('object-output','/output'),
        '--entrypoint','node',image('private_service'),'/work/recovery_control.mjs',JSON.stringify({...request.body,
          profile:'intake-offline-phase-recovery/1',oldContainerId:old.id,oldImageId:owned.Image})]);
      const reconciled=JSON.parse(await docker(['start','-a',helper.name]));if(!reconciled.ok)throw Error('SUPERVISOR_RECOVERY_FAILED');
      await docker(['start',broker.name]);
      let ready=false;for(let i=0;i<10;i++){if((await docker(['logs',broker.name])).includes('"ready":true')){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
      if(!ready)throw Error('RECOVERED_PRIVATE_SERVICE_NOT_READY');
      const after=JSON.parse(await docker(['inspect',broker.id]))[0];await save('recovered-private-supervisor.json',after);
      response=JSON.stringify({ok:true,oldContainerRemoved:old.id,newContainer:broker.id,reconciled});
    } else if(['observe-stalled-worker','terminate-stalled-worker'].includes(request.action)){
      const owned=JSON.parse(await docker(['inspect',broker.name]))[0];
      if(owned.Id!==broker.id||owned.Config.Labels['intake.t02.run']!==resourcePrefix||!owned.State.Running)throw Error('PROCESS_CONTROL_OWNER');
      const result=await docker(['exec',broker.name,'node','/work/process_control.mjs',request.action==='observe-stalled-worker'?'observe':'stop',JSON.stringify(request.body)],{timeout:5000});
      response=JSON.stringify({...JSON.parse(result),containerRef:broker.id});
    } else if(request.action==='stall-state'){
      const state=await docker(['exec',broker.name,'node','-e',"const f=require('fs'),p='/output/stall-target-used.json',target=f.existsSync(p)?JSON.parse(f.readFileSync(p)):null;const events=f.readFileSync('/output/events.ndjson','utf8').trim().split('\\n').filter(Boolean).map(JSON.parse).filter(e=>e.origin==='private-supervisor'&&e.artifactId===target?.artifactId);process.stdout.write(JSON.stringify({reached:!!target,lifecycle:events}))"]);
      response=JSON.stringify({ok:true,...JSON.parse(state),observedAtMs:Date.now(),processRef:broker.id});
    } else response=await docker(['exec',broker.name,'node','/work/restore_cli.mjs',request.action,JSON.stringify({...request.body,cutId:request.id,attemptId:request.id})]);
    if(request.action==='restore'&&JSON.parse(response).ok){
      await docker(['cp',broker.name+':/restored/intake-data.json',path.join(controlPath,'restored-data.json')]);
      await docker(['cp',path.join(controlPath,'restored-data.json'),runtime.name+':/work/output/restore-data.json']);
    }
    // Large event inventories must not become command-line arguments (the host
    // has a much smaller argv bound than the evidence channel). Publish only
    // after a complete copied file has independently verified length and hash.
    const replyBytes=Buffer.from(response),replyPath=path.join(controlPath,'response.json');
    if(replyBytes.length>8388608)throw Error('ADMIN_RESPONSE_BOUND');
    await fs.writeFile(replyPath,replyBytes,{flag:'wx'});
    await docker(['cp',replyPath,runtime.name+':/work/output/admin-response-'+request.id+'.pending']);
    await docker(['exec',runtime.name,'node','-e',
      "const f=require('fs'),c=require('crypto'),id=process.argv[1],n=Number(process.argv[2]),h=process.argv[3];"+
      "if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(n)||n<0||n>8388608||!/^[a-f0-9]{64}$/.test(h))throw Error('ADMIN_REPLY_SCOPE');"+
      "const p='/work/output/admin-response-'+id,b=f.readFileSync(p+'.pending');"+
      "if(b.length!==n||c.createHash('sha256').update(b).digest('hex')!==h||f.existsSync(p+'.json'))throw Error('ADMIN_REPLY_INTEGRITY');"+
      "f.renameSync(p+'.pending',p+'.json');",request.id,String(replyBytes.length),hash(replyBytes)]);
    // The test waits for this reply after its cleanup. Stop polling before exit;
    // still require the actual attached process and container to exit successfully.
    if(request.action==='complete')break;
  }}catch(error){bridgeFailure=error.message;}
  if(bridgeFailure&&running){
    const observed=JSON.parse(await docker(['inspect',runtime.name]))[0];
    if(observed.Id!==runtime.id||observed.Config.Labels['intake.t02.run']!==resourcePrefix)throw Error('BRIDGE_STOP_OWNER_MISMATCH');
    await docker(['stop','--time','3',runtime.name]);
  }
  try{await extraction?.bridge.close();}catch(error){bridgeFailure??=error.message;}
  const execution=await executionPromise;
  const state=JSON.parse(await docker(['inspect',runtime.name]))[0];await save('runtime-state.json',state.State);
  const exports=[];
  for(const [resource,source,destination] of [[runtime,'/work/output/.','runtime'],[broker,'/output/.','objects'],[verifier,'/output/.','verifier'],...(extraction?.exports??[])]) {
    const target=path.join(directory,destination);await fs.mkdir(target,{recursive:true});
    const actualSource=lifecycleFault==='evidence-export'&&destination==='runtime'?'/work/__expected_missing_evidence__':source;
    try{await docker(['cp',resource.name+':'+actualSource,target]);exports.push({destination,complete:true});}
    catch(error){exports.push({destination,complete:false,error:error.message});}
    await run('docker',['logs',resource.name]);
  }
  await save('evidence-exports.json',exports);
  if(exports.some(row=>!row.complete))throw Error('T02_EVIDENCE_EXPORT_INCOMPLETE');
  if(execution.code!==0||execution.reason||state.State.ExitCode!==0||bridgeFailure)throw Error(bridgeFailure??'T02_RUNTIME_FAILED');
}
async function cleanup() {
  for(const resource of [...resources].reverse()) {
    if(resource.removed)continue;
    const inspected=JSON.parse(await docker([resource.type,'inspect',resource.name]))[0];
    const label=resource.type==='volume'?inspected.Labels?.['intake.t02.run']:inspected.Config.Labels?.['intake.t02.run'];
    if(label!==resourcePrefix||(inspected.Id??inspected.Name)!==resource.id)throw Error('RESOURCE_OWNER_MISMATCH');
    await docker([resource.type,'rm',...(resource.type==='container'?['-f']:[]),resource.name]);resource.removed=true;
  }
}
async function coupledGroup(){
  const selected=coupledSuite==='all'?Object.keys(coupledSuites):[coupledSuite];
  for(const final of [false,true]){
    const suites=selected.filter(name=>(name==='journey')===final);if(!suites.length)continue;
    const name='ledgerdesk-intake-t02:'+resourcePrefix+(final?'-coupled-final':'-coupled');
    const build=extra=>docker(['build',...extra,'-f',path.join(directory,'source/ci/access/Runtime.Dockerfile'),
      '--build-arg','ACCESS_FINAL_ROUTES='+(final?'1':'0'),'--label','intake.t02.run='+resourcePrefix,'-t',name,path.join(directory,'source')],{timeout:240000});
    if(final)await withSourceComposition(root,path.join(directory,'access-source-composition.json'),({filename,sha256})=>
      build(['--secret','id=access_composition,src='+filename,'--build-arg','ACCESS_COMPOSITION_SHA256='+sha256]));
    else await build([]);
    const built=JSON.parse(await docker(['image','inspect',name]))[0];resources.push({type:'image',name,id:built.Id});
    for(const suite of suites){
      const containerName=resourcePrefix+'-coupled-'+suite;
      const id=await docker(['create','--init','--name',containerName,'--label','intake.t02.run='+resourcePrefix,
        '--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','2g','--memory-swap','2g','--cpus','2',
        '--pids-limit','256','--shm-size','256m','--env','INTAKE_COUPLED_SUITE='+suite,built.Id,'node','--experimental-strip-types','--test','--test-concurrency=1','tests/access/'+coupledSuites[suite]]);
      resources.push({type:'container',name:containerName,id});
      await save('coupled-'+suite+'-inspect.json',JSON.parse(await docker(['inspect',id]))[0]);
      const result=await run('docker',['start','-a',id],{timeout:300000});
      const target=path.join(directory,'coupled-'+suite);await fs.mkdir(target,{recursive:true});
      await docker(['cp',id+':/work/output/.',target]);
      const state=JSON.parse(await docker(['inspect',id]))[0];await save('coupled-'+suite+'-state.json',state.State);
      if(result.code!==0||result.reason||state.State.ExitCode!==0)throw Error('COUPLED_SUITE_FAILED_'+suite);
      const markers=(await fs.readdir(target)).filter(file=>/^intake-fence-coupling-.*\.json$/.test(file));
      if(!markers.length)throw Error('COUPLED_INSTALLATION_NOT_OBSERVED');
      for(const file of markers){const marker=JSON.parse(await fs.readFile(path.join(target,file),'utf8'));if(!marker.installed||!marker.complete)throw Error('COUPLED_GUARD_INCOMPLETE');}
    }
  }
}
let failure=null;
try {
  if(independentRelease){
    const release=path.resolve(independentRelease),manifestBytes=await fs.readFile(path.join(release,'run.json'));
    if(hash(manifestBytes)!==independentManifestHash.toLowerCase())throw Error('INDEPENDENT_RELEASE_MANIFEST_HASH');
    const manifest=JSON.parse(manifestBytes);independentFiles=manifest.sources;
    if(!Array.isArray(independentFiles)||independentFiles.length<1||independentFiles.length>64||
      new Set(independentFiles.map(x=>x.name)).size!==independentFiles.length||
      !independentFiles.every(x=>/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(mjs|md)$/.test(x.name)&&Number.isSafeInteger(x.bytes)&&x.bytes>0&&/^[a-f0-9]{64}$/.test(x.sha256))||
      !['index.mjs','observation.mjs','references.mjs'].every(name=>independentFiles.some(x=>x.name===name)))throw Error('INDEPENDENT_RELEASE_INVENTORY');
    independentRoot=path.join(release,'sources');
    const names=(await fs.readdir(independentRoot)).sort();
    if(JSON.stringify(names)!==JSON.stringify(independentFiles.map(x=>x.name).sort()))throw Error('INDEPENDENT_RELEASE_FILE_SET');
    await save('independent-pin.json',{manifestSha256:hash(manifestBytes),sourceCount:independentFiles.length,
      status:'Immutable delivered checker; provisional integration use, not acceptance of unresolved findings'});
  }
  for(const relative of ['src/contracts','src/server/access','src/server/intake','src/server/reading','src/server/kb/reading.ts','ci/intake','ci/intake_t02_check.mjs','ci/intake_boundary_check.mjs','ci/access_boundary_check.mjs',
    'ci/reading_boundary_check.mjs','ci/access_material_schema.mjs','tests/access','tests/reading/T04_seed.mjs','tests/reading/timing_comparison.mjs','tests/intake/t02','tests/intake/t01/fixtures','tests/intake/t01/reviewed/process-output.mjs','package.json','package-lock.json','tsconfig.app.json'])await source(relative);
  if(group==='fence-coupled'||uiFirstSlice)for(const relative of ['ci/access','ci/access_final_routes.mjs','src/components/access','src/components/reading','src/components/intake','src/app/access',
    'src/app/layout.tsx','src/app/globals.css','src/instrumentation.ts','next.config.mjs','postcss.config.mjs',
    'tests/reading/browser_diagnostics.mjs'])await source(relative);
  if(uiFirstSlice)await source('tests/intake/ui');
  await source('tests/intake/extraction');await source('tests/intake/t01/boundaries');
  await source('tests/intake/preparation');await source('tests/intake/t01/fixtures.mjs');await source('ci/intake_test_summary.mjs');
  if(group==='extraction')await source('workers/intake/extraction');
  await save('source-manifest.json',{profile:'intake-t02-source/1',runId,files});
  await run('git',['rev-parse','HEAD']);await run('git',['status','--porcelain=v1']);
  if(group==='units') {
    for(const args of [
      ['--experimental-strip-types','--test','tests/intake/t02/test_contracts.mjs'],
      ['--test','tests/intake/t02/test_minimum_form.mjs'],
      ['--test','tests/intake/t02/test_bridge.mjs'],
      ['--test','tests/intake/t02/test_request_observer.mjs'],
      ['ci/intake_boundary_check.mjs'],['ci/access_boundary_check.mjs'],
      ['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.app.json'],
    ])await run(process.execPath,args);
  } else if(group==='fence-coupled'){
    await coupledGroup();
  } else {
    await runtimeGroup();
  }
}catch(error){failure={name:error.name,message:error.message};}
finally {
  try{await cleanup();}catch(error){failure={...(failure??{}),cleanup:error.message};}
  await save('manifest.json',{profile:'intake-t02-run/1',runId,group,node:process.version,commands,resources,failure,
    sourceManifestSha256:hash(await fs.readFile(path.join(directory,'source-manifest.json'))),
    completed:!failure&&commands.every(c=>(c.code===0||c.expectedExit==='runtime-ended')&&c.reason===null)});
  if(await fs.readFile(claim,'utf8')!==runId)throw Error('T02 run claim owner changed');
  await fs.unlink(claim);
}
console.log(JSON.stringify({directory,group,completed:!failure&&commands.every(c=>(c.code===0||c.expectedExit==='runtime-ended')&&c.reason===null)}));
if(failure||commands.some(c=>(c.code!==0&&c.expectedExit!=='runtime-ended')||c.reason!==null))process.exitCode=1;
