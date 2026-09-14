import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const SOURCE_SHA='4acd0e63a24939cc93da594273b51b5696679ed1392bfe41cdb4e72865d7ae63';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const PROFILE={A:'systemd',B:'cgroupfs'};
// Two profile blocks reuse the verified initial A configuration. This reduces
// restarts, but does not counterbalance time/order effects or reset between cases.
export const CASES=Object.freeze(['A','B'].flatMap(profile=>['external','memory','memory','watchdog','memory','memory','memory'].map((kind,i)=>Object.freeze({id:profile+'-'+(i+1),profile,kind}))));
export const BUDGET=Object.freeze({cases:14,memory:10,external:2,watchdog:2,restarts:2,readinessCalls:150,journalCalls:28,journalBytes:14*65536,projectionBytes:14*16384,caseMs:30000,totalMs:18*60000,restoreMs:60000});
export function correctedOpportunity(event){
 return event.event==='pull_request'&&event.action==='synchronize'&&event.number===32&&event.before==='ad466b40cbd41c418199b8f2cd5d9894198d58c3'&&event.after===event.headSha&&/^[a-f0-9]{40}$/.test(event.after??'')&&event.parent===event.before&&event.attempt==='1'&&event.repository==='Farobertogu/ledgerdesk'&&event.headRepository===event.repository&&event.branch==='card/INC-03-l03-single-profile-comparison';
}
// Only these fixed service/inventory commands may export bounded failure stderr.
// No configuration, environment, command stdout or journal is copied here.
export function fixedHostDiagnostic(bin,args,result){
 const restart=privilegedCommand('systemctl',['restart','docker'],15);
 const inventory=['--host','unix:///var/run/docker.sock','ps','-a','--no-trunc','--format','{{.ID}}'];
 const operation=bin===restart.bin&&JSON.stringify(args)===JSON.stringify(restart.args)?'docker-service-restart':bin==='/usr/bin/docker'&&JSON.stringify(args)===JSON.stringify(inventory)?'docker-inventory':null;
 if(!operation||result.code===0&&!result.reason&&!result.error)return null;
 let stderr='',bytes=0;for(const char of result.stderr??''){const n=Buffer.byteLength(char);if(bytes+n>1024)break;stderr+=char;bytes+=n;}
 return {operation,code:result.code,reason:result.reason??null,error:result.error??null,closed:result.closed,stderr,retainedBytes:bytes,receivedBytes:result.stderrBytes??Buffer.byteLength(result.stderr??''),truncated:bytes<Buffer.byteLength(result.stderr??''),stderrEncodingError:result.stderrEncodingError??false};
}
export function privilegedCommand(tool,args,seconds=4){
 assert(['cp','install','rm','dockerd','systemctl'].includes(tool),'PRIVILEGED_TOOL');assert([4,15].includes(seconds),'PRIVILEGED_BOUND');
 return {bin:'/usr/bin/sudo',args:['-n','/usr/bin/timeout','--signal=KILL',seconds+'s','/usr/bin/'+tool,...args],timeout:(seconds+1)*1000};
}
export function loadOriginal(source,context){
 assert.equal(sha(source),SOURCE_SHA,'Original runner identity changed; requalify the composition');
 const flags=source.match(/const parserFlags=(\[[^\n]+\]);/)[1];
 const body=source.slice(source.indexOf('async function probe('),source.indexOf('async function originalCase('));
 const clause=source.match(/await check\('L03',[^\n]+?async\(\)=>\{([^\n]+)\}\);/)[1];
 assert.equal(clause,"const r=await probe(['memory']);assert.equal(r.state.OOMKilled,true);assert.equal(r.state.ExitCode,137);return r.state;");
 const probe=new Function('context',`const {prefix,parserImage,container,docker,json,save,owned,sourceRoot,hash,fs,path,observeL03,loggingFailures,required}=context;let seq=0,parserActive=false;const parserFlags=${flags};return (${body});`)(context);
 const memoryAssertion=new Function('probe','assert',`return (async()=>{${clause}})();`);
 return {probe,flags:new Function('return '+flags)(),assertMemory:result=>memoryAssertion(async()=>result,assert)};
}
// JSON.parse alone accepts duplicate members. Scan every object before parsing,
// preserving the original bytes separately for exact restoration.
export function uniqueJson(text){
 assert(Buffer.byteLength(text)<=65536,'CONFIG_LIMIT');let p=0;
 const white=()=>{while(/\s/.test(text[p]??'')&&p<text.length)p++;};
 const string=()=>{const from=p++;for(;p<text.length;p++){if(text[p]==='\\'){p++;continue;}if(text[p]==='"'){p++;return JSON.parse(text.slice(from,p));}}throw Error('CONFIG_STRING');};
 function value(){white();if(text[p]==='{'){p++;const keys=new Set();white();if(text[p]==='}'){p++;return;}while(true){white();assert.equal(text[p],'"');const k=string();assert(!keys.has(k),'DUPLICATE_CONFIG_KEY');keys.add(k);white();assert.equal(text[p++],':');value();white();if(text[p]==='}'){p++;break;}assert.equal(text[p++],',');}}
 else if(text[p]==='['){p++;white();if(text[p]===']'){p++;return;}while(true){value();white();if(text[p]===']'){p++;break;}assert.equal(text[p++],',');}}
 else if(text[p]==='"')string();else{const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(p));assert(m,'CONFIG_VALUE');p+=m[0].length;}}
 value();white();assert.equal(p,text.length,'CONFIG_TRAILING');return JSON.parse(text);
}
export function configuration(original,driver,argv){
 assert(['systemd','cgroupfs'].includes(driver));
 const config=uniqueJson(original??'{}');assert(config&&!Array.isArray(config)&&typeof config==='object');
 assert(!argv.some(v=>v==='--exec-opt'||v.startsWith('--exec-opt=')||v==='--cgroup-parent'||v.startsWith('--cgroup-parent=')),'DRIVER_FLAG_CONFLICT');
 for(let n=0;n<argv.length;n++)if(argv[n]==='--config-file'||argv[n].startsWith('--config-file='))assert.equal(argv[n]==='--config-file'?argv[n+1]:argv[n].slice(14),'/etc/docker/daemon.json','NONDEFAULT_CONFIG');
 assert(!config['cgroup-parent'],'CUSTOM_CGROUP_PARENT');
 const opts=config['exec-opts']??[];assert(Array.isArray(opts)&&opts.every(x=>typeof x==='string'),'EXEC_OPTS_FORMAT');
 const drivers=opts.filter(x=>x.startsWith('native.cgroupdriver='));assert(drivers.length<=1&&drivers.every(x=>/^native\.cgroupdriver=(systemd|cgroupfs)$/.test(x)),'DUPLICATE_OR_INVALID_DRIVER');
 return JSON.stringify({...config,'exec-opts':[...opts.filter(x=>!x.startsWith('native.cgroupdriver=')),'native.cgroupdriver='+driver]},null,2)+'\n';
}
export function hostGate(facts){
 assert.equal(facts.platform,'linux');assert.equal(facts.provider,'github-hosted');assert.equal(facts.imageOS,'ubuntu24');
 assert.equal(facts.event,'pull_request');assert.equal(facts.attempt,'1');assert.equal(facts.repository,'Farobertogu/ledgerdesk');
 assert.equal(facts.branch,'card/INC-03-l03-single-profile-comparison');assert.equal(facts.workflow,'l03-profile-comparison');
 assert(correctedOpportunity(facts),'CORRECTED_OPPORTUNITY_REQUIRED');
 assert.match(facts.vm,/^(microsoft|kvm)$/);assert.equal(facts.socket,'/run/docker.sock');assert.equal(facts.socketType,'socket');
 assert.equal(facts.rootless,false);assert.equal(facts.cgroupVersion,'2');assert.equal(facts.driver,'systemd');
 assert.deepEqual(facts.containers,[],'NONEMPTY_DAEMON');assert(facts.imageVersion&&facts.commit===facts.checkout,'UNVERIFIED_JOB');
 // These are consistency checks within the trusted provider job. They cannot
 // authenticate a host when a caller fabricates its entire environment.
 return {qualified:true,trust:'GitHub-provisioned dedicated VM and reviewed workflow; local checks are not remote attestation'};
}
export function verdict(rows){
 if(rows.length!==14||rows.some(r=>r.measurement!==true))return 'setup_or_measurement_failure';
 if(rows.some(r=>r.kind!=='memory'&&!r.passed)||rows.some(r=>r.profile==='B'&&!r.passed))return 'candidate_unqualified';
 return rows.some(r=>r.profile==='A'&&r.kind==='memory'&&!r.passed)?'limited_mitigation_supported':'no_discrimination';
}
export async function compare(ports,{clock=Date.now}={}){
 const start=clock(),result={profile:'l03-comparison/1',design:'grouped-profiles/1',budget:BUDGET,order:CASES,rows:[],status:'setup_or_measurement_failure',restoration:'not_needed',cleanup:'not_attempted',errors:[],hostFailures:[],caseFailures:[],switches:0};
 const retainHostFailure=(phase,error)=>{if(error?.commandRecord)result.hostFailures.push({phase,code:error.code??'HOST_ERROR',commandRecord:error.commandRecord});};
 const emptyInventory=async()=>{let found;try{found=await ports.containers();}catch(error){throw Object.assign(Error('INVENTORY_UNAVAILABLE'),{code:'INVENTORY_UNAVAILABLE',commandRecord:error.commandRecord});}assert.deepEqual(found,[],'UNEXPECTED_RESOURCES');};
 const retainCaseFailure=(entry,phase,error)=>{
  const value=error?.code??error?.message;
  const code=typeof value==='string'&&/^[A-Z0-9_]{1,40}$/.test(value)?value:'CASE_ERROR';
  result.errors.push(code);result.caseFailures.push({caseId:entry.id,phase,code});
 };
 let snapshot,prepared=false,changed=false;
 try{
  const facts=await ports.inventory();hostGate(facts);await ports.record('host',facts);
  snapshot=await ports.snapshot();configuration(snapshot.text,PROFILE.A,snapshot.argv);prepared=true;await ports.prepare();
  for(const entry of CASES){
   assert(clock()-start<BUDGET.totalMs,'COMPARISON_DEADLINE');
   await emptyInventory();
   if(entry.profile==='B'&&!changed){
    const merged=configuration(snapshot.text,PROFILE.B,snapshot.argv);
    await ports.validate(merged);changed=true;result.switches++;
    await ports.install(merged);await ports.restart();
   }
   const effective=await ports.ready(PROFILE[entry.profile]);assert.equal(effective.driver,PROFILE[entry.profile]);assert.equal(effective.cgroupVersion,'2');
   await ports.record(entry.id+'-profile',effective);
   let row,completed=false,caseFailed=false;
   // Retain the primary outcome before attempting cleanup. Neither a cleanup
   // exception nor a later evidence-write failure may replace that outcome.
   try{
    row=await ports.run(entry);assert.equal(row.id,entry.id);assert.equal(row.kind,entry.kind);assert.equal(row.profile,entry.profile);
    result.rows.push(row);completed=true;
   }catch(error){retainCaseFailure(entry,'primary',error);caseFailed=true;}
   try{await ports.cleanupCase();assert.deepEqual(await ports.containers(),[],'CASE_CLEANUP_FAILED');}
   catch(error){retainCaseFailure(entry,'cleanup',error);caseFailed=true;}
   try{
    if(completed)await ports.record(entry.id+'-result',row);
    const failures=result.caseFailures.filter(f=>f.caseId===entry.id);
    if(failures.length)await ports.record(entry.id+'-failure',{case:entry,failures});
   }catch{
    retainCaseFailure(entry,'evidence',{code:'CASE_EVIDENCE_WRITE_FAILED'});caseFailed=true;
   }
   if(caseFailed)break;
   assert(row.measurement===true,'REQUIRED_MEASUREMENT_MISSING');
   if(entry.kind!=='memory'&&!row.passed)throw Error('CONTROL_FAILED');
   if(entry.profile==='B'&&!row.passed)throw Error('CANDIDATE_FAILED');
  }
  if(result.caseFailures.length===0)result.status=verdict(result.rows);
 }catch(e){result.errors.push(e.code??e.message);retainHostFailure('primary',e);if(e.message==='CANDIDATE_FAILED'||e.message==='CONTROL_FAILED')result.status='candidate_unqualified';}
 finally{
  let clean=true;
  if(prepared){
   try{await ports.cleanupCase();}catch(e){clean=false;result.cleanup='owned_cleanup_failed';result.errors.push('CLEANUP_UNCONFIRMED');retainHostFailure('cleanup',e);}
   if(clean)try{await emptyInventory();result.cleanup='confirmed';}catch(e){clean=false;result.cleanup=e.code==='INVENTORY_UNAVAILABLE'?'inventory_unknown':'unexpected_resources';result.errors.push('CLEANUP_UNCONFIRMED');retainHostFailure('cleanup',e);}
  }
  if(!clean)result.status='setup_or_measurement_failure';
  if(changed){
   if(!clean){result.restoration=result.cleanup==='inventory_unknown'?'blocked_inventory_unknown':result.cleanup==='unexpected_resources'?'blocked_unexpected_resources':'blocked_cleanup_failure';result.status='setup_or_measurement_failure';}
   else try{await ports.restore(snapshot);await ports.restart();await ports.ready(snapshot.driver);await ports.verifyRestored(snapshot);result.restoration='confirmed';}
   catch(e){result.restoration='unconfirmed';result.errors.push('RESTORE_UNCONFIRMED');retainHostFailure('restoration',e);result.status='setup_or_measurement_failure';}
  }
  if(prepared&&clean)try{await ports.releaseImage();}catch{result.errors.push('IMAGE_RELEASE_UNCONFIRMED');result.status='setup_or_measurement_failure';}
  if(ports.finalize)try{await ports.finalize();}catch{result.errors.push('LEASE_RELEASE_UNCONFIRMED');result.status='setup_or_measurement_failure';}
 }
 await ports.record('comparison-result',result);return result;
}
