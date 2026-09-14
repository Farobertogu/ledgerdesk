import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {captureClient,observeL03} from '../../../ci/intake_l03_observer.mjs';

// Explicit, finite observer calibration; never part of automatic CI or A/B retries.
const image=process.argv[2];
if(process.argv[3]!=='--execute'||!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error('Supply an existing parser image ID and --execute');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const runId='l03-observer-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const out=path.join(root,'test-results/intake-t01',runId),owner='ld-l03-observer-'+randomUUID().slice(0,8);
await fs.mkdir(out,{recursive:false});
const lockPath=path.join(root,'test-results/intake-t01/.active-run');
await fs.writeFile(lockPath,owner,{flag:'wx'});
const hash=b=>createHash('sha256').update(b).digest('hex');
const save=(name,value)=>fs.writeFile(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
let seq=0;const owned=[],cases=[];
async function docker(args,options){
  const r=await captureClient('docker',args,{timeoutMs:10000,...options}).done;
  await save('command-'+(++seq)+'.json',{args,...r,stdout:r.stdout.toString('utf8')});
  return r;
}
const required=async(args,options)=>{const r=await docker(args,options);assert.equal(r.code,0);assert.equal(r.reason,null);return r.stdout.toString('utf8').trim();};
const inspect=async id=>JSON.parse(await required(['inspect',id]))[0];
let failed=false;
try{
  for(const [name,file]of [['calibration-source.mjs',fileURLToPath(import.meta.url)],['observer-source.mjs',path.join(root,'ci/intake_l03_observer.mjs')]])
    await fs.copyFile(file,path.join(out,name),fs.constants.COPYFILE_EXCL);
  await save('baseline.json',{image,owner,head:await required(['version','--format','{{.Server.Version}}']),containers:await required(['ps','-a','--no-trunc','--format','{{.ID}} {{.Names}} {{.State}}'])});
  const runner=await fs.readFile(path.join(root,'ci/intake_t01_check.mjs'),'utf8');
  const literal=runner.match(/const parserFlags=(\[[^;]+\]);/)[1];
  const flags=JSON.parse(literal.replaceAll("'",'"'));
  const expectedProbeSha256=hash(await fs.readFile(path.join(root,'tests/intake/t01/probe.mjs')));
  await save('protocol.json',{meaning:'Two observer calibration controls, not a new causal comparison or a remote repair',
    order:['known-oom','external-kill'],image,flags,expectedProbeSha256,timeoutMs:10000,
    noRetries:true,observerSourceSha256:hash(await fs.readFile(path.join(root,'ci/intake_l03_observer.mjs')))});
  for(const mode of ['known-oom','external-kill']){
    const id=await required(['create','--name',owner+'-'+mode,'--label','l03.observer='+owner,...flags,'--network','none',image,
      'node','--max-old-space-size=128','/work/probe.mjs',mode==='known-oom'?'memory':'cpu']);
    owned.push(id);const entry=await inspect(id);assert.equal(entry.Id,id);assert.equal(entry.Config.Labels['l03.observer'],owner);
    assert.deepEqual([entry.HostConfig.Memory,entry.HostConfig.MemorySwap,entry.HostConfig.NanoCpus,entry.HostConfig.PidsLimit],[536870912,536870912,1000000000,64]);
    let observation;const exportFailures=[];
    const state=await observeL03({target:id,expectedProbeSha256,onFailure:f=>exportFailures.push(f),
      save:async(name,value)=>{observation=value;await save(mode+'-'+name,value);}},async observer=>{
      const started=docker(['start','-a',id],{timeoutMs:10000});
      if(mode==='external-kill'){
        let running=false;
        for(let i=0;i<5;i++){if((await inspect(id)).State.Running){running=true;break;}await new Promise(r=>setTimeout(r,50));}
        assert.equal(running,true,'Control must be alive before external termination');
        await required(['kill','--signal=KILL',id]);
      }
      const r=await started;
      if(r.reason)await required(['stop','-t','1',id]);
      const first=await inspect(id);await save(mode+'-first.json',{code:r.code,reason:r.reason,state:first.State});
      observer.recordPrimary({...r,milliseconds:Date.parse(r.finishedAt)-Date.parse(r.startedAt),commandRecord:'retained by calibration'},first);
      return first.State;
    });
    const expected=mode==='known-oom';
    assert.deepEqual({exit:state.ExitCode,oom:state.OOMKilled,observedOOM:observation.assessment.oomEvent,
      kill:observation.assessment.killEvent,complete:observation.assessment.eventsComplete,probe:observation.identity.probeMatchesSource,exports:exportFailures},
      {exit:137,oom:expected,observedOOM:expected,kill:!expected,complete:true,probe:true,exports:[]});
    assert.ok(observation.identity.entrypoint?.sha256,'Actual entrypoint bytes must be identified');
    cases.push({mode,passed:true,assessment:observation.assessment,identity:observation.identity,leaf:observation.leaf});
  }
}catch(error){failed=true;await save('failure.json',{message:error.message,actual:error.actual,expected:error.expected});console.error(error.message);}
finally{
  const cleanup=[];
  // A failed create can have reached the daemon before the client lost its result.
  const found=(await required(['ps','-a','--no-trunc','--filter','label=l03.observer='+owner,'--format','{{.ID}}'])).split('\n').filter(Boolean);
  for(const id of found)if(!owned.includes(id))owned.push(id);
  for(const id of owned)try{
    const entry=await inspect(id);assert.equal(entry.Id,id);assert.equal(entry.Config.Labels['l03.observer'],owner);
    await required(['rm','-f',id]);cleanup.push({id,removed:true});
  }catch(error){cleanup.push({id,removed:false,error:error.message});failed=true;}
  await save('results.json',{cases,failed,cleanup,after:await required(['ps','-a','--no-trunc','--format','{{.ID}} {{.Names}} {{.State}}'])});
  if(await fs.readFile(lockPath,'utf8')===owner)await fs.unlink(lockPath);
  console.log('Evidence: '+path.relative(root,out).replaceAll('\\','/'));if(failed)process.exitCode=1;
}
