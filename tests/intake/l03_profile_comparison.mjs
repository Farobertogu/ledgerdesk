import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import * as kernel from '../../ci/intake_kernel_origin.mjs';import {observeL03} from '../../ci/intake_l03_observer.mjs';
import {compare,configuration,hostGate,loadOriginal,verdict,CASES,BUDGET,privilegedCommand,correctedOpportunity,fixedHostDiagnostic} from '../../ci/l03_profile_comparison.mjs';
import {readHierarchy} from '../../ci/l03_profile_hierarchy.mjs';
import {linuxPorts} from '../../ci/l03_profile_host.mjs';
import {binding,position,window,ctx,victim,row,text,baseMono,group,composed} from './l03_profile_fixtures.mjs';
// This closed comparison tests its exact retained input, not a later L03 test.
const source=fs.readFileSync(new URL('./l03_compared_runner.txt',import.meta.url),'utf8');
const options=JSON.parse(fs.readFileSync(new URL('./l03_journal_options.json',import.meta.url),'utf8'));
const commands=[kernel.journalCommand(null),kernel.journalCommand(binding.boot,{cursor:position.cursor,untilUs:window.toUs})];
const unknown=cmd=>cmd.args.slice(cmd.args.indexOf('/usr/bin/journalctl')+1).filter(a=>a.startsWith('--')&&!options.options.includes(a.slice(2).split('=')[0]));
test('KO-01: actual before and after commands match the pinned primary option interface',()=>{
 assert.equal(options.options.length,65);assert(options.options.includes('dmesg'));assert(!options.options.includes('kernel'));
 for(const cmd of commands){assert.deepEqual(unknown(cmd),[]);assert(cmd.args.includes('--dmesg'));const broken={...cmd,args:cmd.args.map(v=>v==='--dmesg'?'--kernel':v)};assert.deepEqual(unknown(broken),['--kernel']);}
});
test('KO-02: same valid reference passes; 24-hour monotonic shift cannot match the 250ms window',()=>{
 assert.equal(kernel.projectKernel(text(row(ctx),row(victim,3)),binding,window,position).status,'matched');
 assert.throws(()=>kernel.projectKernel(text(row(ctx,2,{mono:baseMono+86400000000n}),row(victim,3,{mono:baseMono+86400001000n})),binding,window,position),/CLOCK_INCOHERENT/);
 assert.throws(()=>kernel.projectKernel(text(row(ctx,2,{mono:baseMono+110000n}),row(victim,3,{mono:baseMono+111000n})),binding,window,position),/CLOCK_INCOHERENT/);
 assert.equal(kernel.projectKernel(text(row(ctx,2,{mono:baseMono+12000n}),row(victim,3,{mono:baseMono+13000n})),binding,window,position).status,'matched');
});
for(const mode of ['control','later-failure','primary-throw'])test('KO-03 actual probe/observer: '+mode,async()=>{
 const r=await composed({source,observeL03,kernel,mode});assert.equal(r.launches,1);
 if(mode==='control'){assert.equal(r.record.kernelOrigin.status,'matched');assert.equal(r.clients,2);}
 else{assert.equal(r.record.later,undefined);assert.equal(r.record.kernelOrigin.status,'unavailable');assert.equal(r.record.kernelOrigin.reason,'REQUIRED_LATER_INSPECTION_MISSING');assert.equal(r.record.kernelOrigin.calls.length,1);assert.equal(r.clients,1);}
 if(mode!=='primary-throw')assert.deepEqual([r.primary.OOMKilled,r.primary.ExitCode],[false,137]);
});
test('Supporting child transport still terminates bounded synthetic output and preserves UTF8 cause',async()=>{
 const command=code=>({executable:process.execPath,args:['-e',code]});
 const good=await kernel.boundedKernelClient(command('process.stdout.write("x");process.stderr.write("L03_RESOURCE user=0.01 system=0.00 rss=1234\\n")'));assert.equal(good.complete,true);
 const bad=await kernel.boundedKernelClient(command('process.stdout.write(Buffer.from([255]))'));assert.equal(bad.reason,'invalid_output_utf8');
 const slow=await kernel.boundedKernelClient(command('setInterval(()=>{},1000)'),{callMs:50});assert.equal(slow.reason,'journal_timeout');assert.equal(slow.closed,true);
});
test('The exact original memory clause accepts true/137, rejects false/137 and other exits',async()=>{
 const loaded=loadOriginal(source,{});await loaded.assertMemory({state:{OOMKilled:true,ExitCode:137}});
 for(const state of [{OOMKilled:false,ExitCode:137},{OOMKilled:true,ExitCode:1}])await assert.rejects(loaded.assertMemory({state}));
 assert.throws(()=>loadOriginal(source.replace('assert.equal(r.state.OOMKilled,true);',''),{}));
 assert.equal(loaded.flags.filter(v=>v==='--memory=512m').length,1);assert(loaded.flags.includes('--memory-swap=512m'));
});
const facts={platform:'linux',provider:'github-hosted',imageOS:'ubuntu24',imageVersion:'measured-image',event:'pull_request',action:'synchronize',number:32,before:'ad466b40cbd41c418199b8f2cd5d9894198d58c3',parent:'ad466b40cbd41c418199b8f2cd5d9894198d58c3',after:'c'.repeat(40),headSha:'c'.repeat(40),headRepository:'Farobertogu/ledgerdesk',attempt:'1',repository:'Farobertogu/ledgerdesk',branch:'card/INC-03-l03-single-profile-comparison',workflow:'l03-profile-comparison',commit:'a'.repeat(40),checkout:'a'.repeat(40),vm:'microsoft',socket:'/run/docker.sock',socketType:'socket',rootless:false,cgroupVersion:'2',driver:'systemd',containers:[]};
test('Host gate refuses shared, non-Linux, wrong-context and nonempty daemons including stopped containers',()=>{
 assert.equal(hostGate(facts).qualified,true);
 for(const changed of [{platform:'win32'},{provider:'self-hosted'},{imageOS:'ubuntu-slim'},{containers:['stopped-container']},{socket:'tcp://remote'},{rootless:true},{vm:'docker'},{checkout:'b'.repeat(40)},{attempt:'2'}])assert.throws(()=>hostGate({...facts,...changed}));
});
test('Configuration preserves unrelated values; duplicate keys/drivers and conflicting flags are rejected',()=>{
 const original='{ "debug": false, "log-driver": "local", "exec-opts":["other=value","native.cgroupdriver=systemd"] }';
 const next=JSON.parse(configuration(original,'cgroupfs',['/usr/bin/dockerd','-H','fd://']));assert.deepEqual(next,{debug:false,'log-driver':'local','exec-opts':['other=value','native.cgroupdriver=cgroupfs']});
 for(const value of ['{"debug":false,"debug":true}','{"exec-opts":["native.cgroupdriver=systemd","native.cgroupdriver=systemd"]}','{"cgroup-parent":"custom.slice"}','{"exec-opts":[3]}','{"nested":{"a":1,"a":2}}'])assert.throws(()=>configuration(value,'systemd',[]));
 for(const argv of [['--exec-opt=native.cgroupdriver=cgroupfs'],['--exec-opt','other=value'],['--config-file=/elsewhere'],['--cgroup-parent','custom']])assert.throws(()=>configuration('{}','systemd',argv));
 assert.equal(JSON.parse(configuration(null,'systemd',[]))['exec-opts'][0],'native.cgroupdriver=systemd');
});
const originalText='{\r\n  "debug": false, "exec-opts": ["native.cgroupdriver=systemd"]\r\n}\r\n';
function model(fault){
 const trace=[],saved=new Map();let current=originalText,driver='systemd',runs=0,restarts=0,restoring=false;
 const ports={inventory:async()=>({...facts,containers:fault==='initial-stopped'?['stopped']:[]}),snapshot:async()=>({text:originalText,argv:[],driver:'systemd'}),prepare:async()=>{trace.push('prepare');},containers:async()=>fault==='cleanup'&&runs?['unexpected']:[],validate:async text=>{trace.push('validate');if(fault==='invalid-config')throw Error('INVALID_CONFIG');},install:async text=>{trace.push('install');current=text;driver=JSON.parse(text)['exec-opts'][0].split('=')[1];},restart:async()=>{restarts++;trace.push('restart');},ready:async expected=>{if(fault==='readiness'&&!restoring)throw Error('READINESS_FAILED');assert.equal(driver,expected);return{driver,cgroupVersion:'2'};},record:async(name,value)=>{saved.set(name,structuredClone(value));},
 run:async entry=>{runs++;trace.push(entry.id);const passed=!(fault==='A-fail'&&entry.profile==='A'&&entry.kind==='memory')&&!(fault==='B-fail'&&entry.profile==='B'&&entry.kind==='memory')&&!(fault==='control-fail'&&entry.kind==='external');return {...entry,passed,measurement:fault!=='measurement'};},cleanupCase:async()=>{trace.push('cleanup');if(fault==='cleanup'&&runs)throw Error('OWNER_MISMATCH');},restore:async snapshot=>{trace.push('restore');restoring=true;assert.equal(snapshot.text,originalText);if(fault==='restore')throw Error('RESTORE_FAILED');current=snapshot.text;driver='systemd';},verifyRestored:async()=>assert.equal(current,originalText),releaseImage:async()=>trace.push('image-release'),finalize:async()=>trace.push('lease-release')};
 return {ports,trace,saved,get runs(){return runs;},get restarts(){return restarts;},get current(){return current;}};
}
test('PC-01 normal counterpart: one primary per slot, grouped 14-slot order and restoration',async()=>{
 const m=model(),r=await compare(m.ports);assert.equal(r.status,'no_discrimination');assert.equal(r.rows.length,14);assert.equal(m.runs,14);assert.equal(m.restarts,2);assert.equal(r.restoration,'confirmed');assert.equal(m.current,originalText);
 for(const profile of ['A','B'])assert.deepEqual(['memory','external','watchdog'].map(kind=>r.rows.filter(v=>v.profile===profile&&v.kind===kind).length),[5,1,1]);
 assert.deepEqual(r.rows.map(v=>v.id),['A-1','A-2','A-3','A-4','A-5','A-6','A-7','B-1','B-2','B-3','B-4','B-5','B-6','B-7']);
 assert.equal(m.trace.filter(v=>v==='validate').length,1);assert.equal(m.trace.filter(v=>v==='install').length,1);
 assert(m.trace.indexOf('A-7')<m.trace.indexOf('install'));assert(m.trace.indexOf('restart')<m.trace.indexOf('B-1'));assert(m.trace.indexOf('restore')>m.trace.indexOf('B-7'));
 assert.deepEqual({switches:r.switches,cleanup:r.cleanup,maxRestarts:BUDGET.restarts},{switches:1,cleanup:'confirmed',maxRestarts:2});
 assert.deepEqual(r.caseFailures,[]);for(const entry of CASES)assert.equal(m.trace.filter(v=>v===entry.id).length,1);
});

// Preserve the independent review's actual comparison invocation and three
// failure modes. Only their expected retained outcomes change after PC-01.
function retentionModel(mode,{failCaseWrite=false,failFinalWrite=false}={}){
 const records=[],trace=[];let started=false;
 const ports={inventory:async()=>facts,snapshot:async()=>({text:'{}',argv:[],driver:'systemd'}),prepare:async()=>{},containers:async()=>[],validate:async()=>{},install:async()=>{},restart:async()=>{},ready:async driver=>({driver,cgroupVersion:'2'}),
 record:async(name,value)=>{if(failCaseWrite&&name==='A-1-failure'||failFinalWrite&&name==='comparison-result')throw Error('private write failure: token=do-not-export');records.push({name,value:structuredClone(value)});},
 run:async entry=>{started=true;trace.push('primary');if(mode!=='returned-row-cleanup-error')throw Object.assign(Error('private primary payload: token=do-not-export'),{code:'ORIGINAL_PRIMARY_FAILURE',cause:{secret:'do-not-export'},actual:'private comparison payload'});return{...entry,measurement:true,passed:false,state:{OOMKilled:false,ExitCode:137},marker:'ORIGINAL_CASE_RESULT'};},
 cleanupCase:async()=>{trace.push('cleanup');if(started&&mode!=='primary-error-cleanup-ok')throw Object.assign(Error('private cleanup payload: token=do-not-export'),{code:'OWNED_CLEANUP_FAILURE'});},
 restore:async()=>trace.push('restore'),verifyRestored:async()=>trace.push('verify-restored'),releaseImage:async()=>{},finalize:async()=>{}};
 return {ports,records,trace};
}
for(const mode of ['primary-error-cleanup-ok','primary-error-cleanup-error','returned-row-cleanup-error'])test('PC-01 exact outcome retention: '+mode,async()=>{
 const m=retentionModel(mode),r=await compare(m.ports),failedCleanup=mode!=='primary-error-cleanup-ok',returned=mode==='returned-row-cleanup-error';
 assert.equal(m.trace.filter(v=>v==='primary').length,1);assert.equal(r.switches,0);assert.equal(r.status,'setup_or_measurement_failure');
 const expected=[...(!returned?['ORIGINAL_PRIMARY_FAILURE']:[]),...(failedCleanup?['OWNED_CLEANUP_FAILURE','CLEANUP_UNCONFIRMED']:[])];
 assert.deepEqual(r.errors,expected);assert.deepEqual(r.caseFailures,[...(!returned?[{caseId:'A-1',phase:'primary',code:'ORIGINAL_PRIMARY_FAILURE'}]:[]),...(failedCleanup?[{caseId:'A-1',phase:'cleanup',code:'OWNED_CLEANUP_FAILURE'}]:[])]);
 assert.equal(r.restoration,'not_needed');assert.equal(m.trace.includes('restore'),false);assert.equal(m.trace.includes('verify-restored'),false);assert.equal(r.cleanup,failedCleanup?'owned_cleanup_failed':'confirmed');
 assert.deepEqual(r.rows,returned?[{...CASES[0],measurement:true,passed:false,state:{OOMKilled:false,ExitCode:137},marker:'ORIGINAL_CASE_RESULT'}]:[]);
 if(returned)assert.deepEqual(m.records.find(v=>v.name==='A-1-result').value,r.rows[0]);
 assert.deepEqual(m.records.find(v=>v.name==='A-1-failure').value,{case:CASES[0],failures:r.caseFailures});assert.deepEqual(m.records.find(v=>v.name==='comparison-result').value,r);
 const encoded=JSON.stringify({r,records:m.records});for(const privateValue of ['do-not-export','private primary','private cleanup','private comparison','stack'])assert(!encoded.includes(privateValue));
});
test('PC-01 write failure is reported without erasing outcomes or claiming guaranteed durable evidence',async()=>{
 const m=retentionModel('primary-error-cleanup-error',{failCaseWrite:true}),r=await compare(m.ports);
 assert.equal(m.trace.filter(v=>v==='primary').length,1);assert.deepEqual(r.errors,['ORIGINAL_PRIMARY_FAILURE','OWNED_CLEANUP_FAILURE','CASE_EVIDENCE_WRITE_FAILED','CLEANUP_UNCONFIRMED']);
 assert.deepEqual(r.caseFailures.map(v=>[v.caseId,v.phase,v.code]),[['A-1','primary','ORIGINAL_PRIMARY_FAILURE'],['A-1','cleanup','OWNED_CLEANUP_FAILURE'],['A-1','evidence','CASE_EVIDENCE_WRITE_FAILED']]);
 assert.equal(r.restoration,'not_needed');assert.equal(r.cleanup,'owned_cleanup_failed');assert(!m.records.some(v=>v.name==='A-1-failure'));assert.deepEqual(m.records.find(v=>v.name==='comparison-result').value,r);assert(!JSON.stringify(m.records).includes('do-not-export'));
 const unavailable=retentionModel('primary-error-cleanup-error',{failCaseWrite:true,failFinalWrite:true});await assert.rejects(compare(unavailable.ports),/private write failure/);assert.equal(unavailable.trace.filter(v=>v==='primary').length,1);assert(!unavailable.records.some(v=>v.name==='comparison-result'));
 const bounded=retentionModel('primary-error-cleanup-error');bounded.ports.run=async()=>{bounded.trace.push('primary');throw Object.assign(Error('private'),{code:'x'.repeat(10000)});};const limited=await compare(bounded.ports);assert.equal(bounded.trace.filter(v=>v==='primary').length,1);assert.equal(limited.caseFailures[0].code,'CASE_ERROR');assert(!JSON.stringify(limited).includes('x'.repeat(100)));
});
test('Observed A failures plus valid B and controls support only limited mitigation, preserving all failed rows',async()=>{
 const r=await compare(model('A-fail').ports);assert.equal(r.status,'limited_mitigation_supported');assert.equal(r.rows.filter(v=>!v.passed).length,5);assert.equal(r.rows.length,14);
});

for(const [mode,status,phase,code]of [
 ['normal','no_discrimination',null,null],
 ['last-cleanup-error','setup_or_measurement_failure','cleanup','OWNED_CLEANUP_FAILURE'],
 ['last-case-write-error','setup_or_measurement_failure','evidence','CASE_EVIDENCE_WRITE_FAILED']
])test('PC-01 B-7 classification: '+mode,async t=>{
 // The independent B-7 fixture's actual comparison ports, narrowed to its
 // final-slot negatives and positive. These are not physical runtime cases.
 const records=[],attempts=[],primaries=[],returned=[];let current,cleanupFaults=0,restarts=0,restores=0,verified=0;
 const ports={inventory:async()=>facts,snapshot:async()=>({text:'{}',argv:[],driver:'systemd'}),prepare:async()=>{},containers:async()=>[],validate:async()=>{},install:async()=>{},restart:async()=>{restarts++;},ready:async driver=>({driver,cgroupVersion:'2'}),
 record:async(name,value)=>{attempts.push(name);if(mode==='last-case-write-error'&&name==='B-7-result')throw Object.assign(Error('private write payload'),{code:'WRITE_UNAVAILABLE'});records.push({name,value:structuredClone(value)});},
 run:async entry=>{current=entry;primaries.push(entry.id);const row={...entry,measurement:true,passed:true,state:{OOMKilled:true,ExitCode:137},marker:'ORIGINAL_CASE_RESULT'};returned.push(structuredClone(row));return row;},
 cleanupCase:async()=>{if(mode==='last-cleanup-error'&&current?.id==='B-7'&&cleanupFaults++===0)throw Object.assign(Error('private cleanup payload'),{code:'OWNED_CLEANUP_FAILURE'});},
 restore:async()=>{restores++;},verifyRestored:async()=>{verified++;},releaseImage:async()=>{},finalize:async()=>{}};
 const r=await compare(ports),lastRecord=records.find(v=>v.name==='comparison-result');
 const observed={status:r.status,errors:r.errors,caseFailures:r.caseFailures,rows:r.rows.length,primaries,restarts,restores,verified,restoration:r.restoration,caseRecord:records.some(v=>v.name==='B-7-result'),finalStatus:lastRecord?.value.status,maximumWriteAttempts:Math.max(...attempts.map(name=>attempts.filter(v=>v===name).length))};
 assert.deepEqual(observed,{status,errors:code?[code]:[],caseFailures:code?[{caseId:'B-7',phase,code}]:[],rows:14,primaries:['A-1','A-2','A-3','A-4','A-5','A-6','A-7','B-1','B-2','B-3','B-4','B-5','B-6','B-7'],restarts:2,restores:1,verified:1,restoration:'confirmed',caseRecord:mode!=='last-case-write-error',finalStatus:status,maximumWriteAttempts:1});
 assert.deepEqual(r.rows,returned);assert.deepEqual(lastRecord.value,r);assert.equal(attempts.filter(v=>v==='B-7-result').length,1);assert(!JSON.stringify({r,records}).includes('private'));
 if(mode==='last-cleanup-error')assert.deepEqual(records.find(v=>v.name==='B-7-failure').value,{case:CASES.at(-1),failures:r.caseFailures});
 const host=fs.readFileSync(new URL('../../ci/l03_profile_host.mjs',import.meta.url),'utf8');assert(host.includes("process.exitCode=result.status==='no_discrimination'?0:1;"));
 t.diagnostic(JSON.stringify({...observed,impliedUnchangedExit:status==='no_discrimination'?0:1}));
});
for(const [fault,status,runs,restoration]of [
 ['initial-stopped','setup_or_measurement_failure',0,'not_needed'],['invalid-config','setup_or_measurement_failure',7,'not_needed'],['readiness','setup_or_measurement_failure',0,'not_needed'],['measurement','setup_or_measurement_failure',1,'not_needed'],['B-fail','candidate_unqualified',9,'confirmed'],['control-fail','candidate_unqualified',1,'not_needed'],['restore','setup_or_measurement_failure',14,'unconfirmed'],['cleanup','setup_or_measurement_failure',1,'not_needed']
])test('Comparison stop/restore: '+fault,async()=>{const m=model(fault),r=await compare(m.ports);assert.equal(r.status,status);assert.equal(m.runs,runs);assert.equal(r.restoration,restoration);assert(m.trace.includes('lease-release'));if(fault==='cleanup')assert(!m.trace.includes('restore'));});
test('A comparison deadline does not allocate replacement cases',async()=>{let ticks=0;const m=model(),r=await compare(m.ports,{clock:()=>ticks++===0?0:BUDGET.totalMs+1});assert.equal(m.runs,0);assert.equal(r.status,'setup_or_measurement_failure');});

for(const inventory of ['unknown','unexpected','empty'])test('Grouped host failure retains restart and distinct final inventory: '+inventory,async()=>{
 const m=model();let failed=false;const restart=m.ports.restart,containers=m.ports.containers;
 m.ports.restart=async()=>{
  await restart();if(failed)return;failed=true;
  const command=privilegedCommand('systemctl',['restart','docker'],15);
  await m.ports.record('failed-restart',{diagnostic:fixedHostDiagnostic(command.bin,command.args,{code:1,closed:true,stderr:'Job for docker.service failed.\n',stderrBytes:31})});
  throw Object.assign(Error('HOST_COMMAND_FAILED'),{code:'HOST_COMMAND_FAILED',commandRecord:'failed-restart'});
 };
 m.ports.containers=async()=>{
  if(!failed)return containers();
  if(inventory==='unexpected')return ['unexpected-owned-by-nobody-here'];
  if(inventory==='unknown'){
   await m.ports.record('failed-inventory',{diagnostic:fixedHostDiagnostic('/usr/bin/docker',['--host','unix:///var/run/docker.sock','ps','-a','--no-trunc','--format','{{.ID}}'],{code:1,closed:true,stderr:'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n'})});
   throw Object.assign(Error('DOCKER_COMMAND_FAILED'),{code:'DOCKER_COMMAND_FAILED',commandRecord:'failed-inventory'});
  }
  return [];
 };
 const r=await compare(m.ports);
 assert.deepEqual({status:r.status,rows:r.rows.map(v=>v.id),primaries:m.runs,switches:r.switches,restarts:m.restarts,cleanup:r.cleanup,restoration:r.restoration},
  {status:'setup_or_measurement_failure',rows:['A-1','A-2','A-3','A-4','A-5','A-6','A-7'],primaries:7,switches:1,restarts:inventory==='empty'?2:1,cleanup:inventory==='unknown'?'inventory_unknown':inventory==='unexpected'?'unexpected_resources':'confirmed',restoration:inventory==='unknown'?'blocked_inventory_unknown':inventory==='unexpected'?'blocked_unexpected_resources':'confirmed'});
 assert.deepEqual(r.errors,inventory==='empty'?['HOST_COMMAND_FAILED']:['HOST_COMMAND_FAILED','CLEANUP_UNCONFIRMED']);
 assert.deepEqual(r.hostFailures,[{phase:'primary',code:'HOST_COMMAND_FAILED',commandRecord:'failed-restart'},...(inventory==='unknown'?[{phase:'cleanup',code:'INVENTORY_UNAVAILABLE',commandRecord:'failed-inventory'}]:[])]);
 assert.equal(m.trace.includes('restore'),inventory==='empty');assert.equal(m.trace.includes('image-release'),inventory==='empty');
 assert.equal(m.saved.get('failed-restart').diagnostic.operation,'docker-service-restart');assert(m.saved.get('failed-restart').diagnostic.stderr.includes('docker.service failed'));
 if(inventory==='unknown'){assert(!JSON.stringify(r).includes('unexpected'));assert.equal(m.saved.get('failed-inventory').diagnostic.operation,'docker-inventory');}
 assert.deepEqual(m.saved.get('comparison-result'),r);
});

test('Only fixed failing restart/inventory commands retain bounded stderr, never stdout or configuration',()=>{
 const command=privilegedCommand('systemctl',['restart','docker'],15),result={code:1,closed:true,stderr:'é'.repeat(2000),stderrBytes:4000,stdout:'private configuration',environment:'private environment'};
 const d=fixedHostDiagnostic(command.bin,command.args,result);
 assert.deepEqual({bytes:d.retainedBytes,received:d.receivedBytes,truncated:d.truncated,code:d.code},{bytes:1024,received:4000,truncated:true,code:1});
 assert.equal(Buffer.byteLength(d.stderr),1024);assert(!d.stderr.includes('\ufffd'));assert(!JSON.stringify(d).includes('private'));
 assert.equal(fixedHostDiagnostic(command.bin,command.args,{...result,code:0}),null);
 for(const tool of ['cp','install','dockerd']){const other=privilegedCommand(tool,[]);assert.equal(fixedHostDiagnostic(other.bin,other.args,result),null);}
 assert.equal(fixedHostDiagnostic('/usr/bin/docker',['inspect','arbitrary'],result),null);
 const host=fs.readFileSync(new URL('../../ci/l03_profile_host.mjs',import.meta.url),'utf8');
 assert.equal(typeof linuxPorts,'function');assert(host.includes('const failureDiagnostic=fixedHostDiagnostic(bin,args,result)'));assert(host.includes('commands.at(-1).diagnostic=failureDiagnostic'));
});

test('Unknown cleanup inventory before any profile change is still a setup failure, not a passed cleanup',async()=>{
 const m=model('control-fail');let closing=false;const cleanup=m.ports.cleanupCase;
 m.ports.finalize=async()=>{};
 m.ports.cleanupCase=async()=>{await cleanup();closing=m.runs>0;};
 m.ports.containers=async()=>{if(closing)throw Object.assign(Error('DOCKER_COMMAND_FAILED'),{code:'DOCKER_COMMAND_FAILED',commandRecord:'inventory-down'});return [];};
 const r=await compare(m.ports);
 assert.deepEqual({status:r.status,cleanup:r.cleanup,restoration:r.restoration,restarts:m.restarts,primaries:m.runs},{status:'setup_or_measurement_failure',cleanup:'inventory_unknown',restoration:'not_needed',restarts:0,primaries:1});
 assert(!m.trace.includes('restore'));assert(!m.trace.includes('image-release'));
});

test('The same PR has one corrected synchronize transition, with parent and checkout guards',()=>{
 const workflow=fs.readFileSync(new URL('../../.github/workflows/l03-profile-comparison.yml',import.meta.url),'utf8');
 const condition=workflow.match(/if: \$\{\{ (.+) \}\}/)[1];
 const evaluate=new Function('github','return '+condition);
 const context=f=>({event:{action:f.action,number:f.number,before:f.before,after:f.after,pull_request:{head:{sha:f.headSha,repo:{full_name:f.headRepository}}}},head_ref:f.branch,repository:f.repository,run_attempt:Number(f.attempt)});
 assert.equal(evaluate(context(facts)),true);assert.equal(correctedOpportunity(facts),true);
 for(const change of [{action:'opened'},{action:'reopened'},{number:33},{before:'d'.repeat(40)},{after:'e'.repeat(40)},{attempt:'2'},{headRepository:'other/repo'},{repository:'other/repo',headRepository:'other/repo'},{branch:'card/INC-03-other'}]){
  assert.equal(evaluate(context({...facts,...change})),false);assert.equal(correctedOpportunity({...facts,...change}),false);
 }
 assert.equal(correctedOpportunity({...facts,parent:'f'.repeat(40)}),false);
 assert.throws(()=>hostGate({...facts,checkout:'f'.repeat(40)}));
 assert(workflow.includes('fetch-depth: 3'));assert(!workflow.includes('run_number'));assert(!workflow.includes('workflow_dispatch'));
 const host=fs.readFileSync(new URL('../../ci/l03_profile_host.mjs',import.meta.url),'utf8');assert(host.includes("['rev-parse',event.after+'^']"));
});
test('Hierarchy keeps exact target limits and ancestor constraints without using counters as an oracle',async()=>{
 const values={'memory.max':'536870912','memory.high':'max','memory.swap.max':'0','cpu.max':'100000 100000','pids.max':'64'};
 const io={realpath:async p=>p,readFile:async p=>values[p.split('/').at(-1)]};const h=await readHierarchy(binding,io);assert.equal(h.status,'observed');assert.deepEqual(h.rows.map(v=>v.path),[group,'/system.slice','/']);
 await assert.rejects(readHierarchy(binding,{...io,readFile:async p=>p.endsWith('/memory.max')?'max':io.readFile(p)}),/TARGET_MEMORY_LIMIT/);
 await assert.rejects(readHierarchy(binding,{...io,realpath:async p=>p==='/sys/fs/cgroup'?p:'/unrelated'}),/PROFILE_PATH_ESCAPE/);
 const rows=CASES.map(e=>({...e,measurement:true,passed:true,sharedAncestorOomKill:999}));rows.find(e=>e.profile==='B'&&e.kind==='memory').passed=false;assert.equal(verdict(rows),'candidate_unqualified');
});
test('Runtime route has no automatic pair, old branch gate or hidden memory calibration',()=>{
 const host=fs.readFileSync(new URL('../../ci/l03_profile_host.mjs',import.meta.url),'utf8'),workflow=fs.readFileSync(new URL('../../.github/workflows/l03-profile-comparison.yml',import.meta.url),'utf8');
 assert(!host.includes('runKernelControl'));assert(!source.includes('kernelIdleControl'));assert(!workflow.includes('workflow_dispatch'));assert(workflow.includes('types: [opened, synchronize]'));assert(workflow.includes('runs-on: ubuntu-24.04'));assert(!workflow.includes('continue-on-error'));
 assert(host.includes("loadOriginal("));assert(host.includes("loaded.probe(['memory'])"));assert(host.includes("loaded.assertMemory(result)"));assert(!host.includes('prune'));
 assert(host.includes("'--validate','--config-file='"));assert(host.includes("'restart','docker'"));assert(host.includes("'--preserve=all'"));
 assert(!host.includes("fs.readFile('/etc/docker/daemon.json')"),'All daemon configuration reads retain the declared byte cap');
 const validate=privilegedCommand('dockerd',['--validate','--config-file=/owned/candidate.json']);
 assert.deepEqual(validate,{bin:'/usr/bin/sudo',args:['-n','/usr/bin/timeout','--signal=KILL','4s','/usr/bin/dockerd','--validate','--config-file=/owned/candidate.json'],timeout:5000});
 assert.deepEqual(privilegedCommand('systemctl',['restart','docker'],15).args,['-n','/usr/bin/timeout','--signal=KILL','15s','/usr/bin/systemctl','restart','docker']);
 assert.throws(()=>privilegedCommand('arbitrary',[]));assert.throws(()=>privilegedCommand('dockerd',[],99));
});
