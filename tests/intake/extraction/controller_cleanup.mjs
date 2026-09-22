import test from 'node:test';
import assert from 'node:assert/strict';
import {removeLostControllerWorker} from '../../../ci/intake/extraction/controller_loss.mjs';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';

async function isolatedSource(relative,mocks){
  const url=new URL('../../../ci/intake/extraction/'+relative,import.meta.url);
  const context=vm.createContext({setTimeout,clearTimeout,setInterval,clearInterval,process,URL,AbortController});
  const module=new vm.SourceTextModule(await fs.readFile(url,'utf8'),{context,initializeImportMeta:meta=>{meta.url=url.href;}});
  await module.link(spec=>{
    const values=mocks[spec];assert.ok(values,'Unexpected dependency '+spec);
    return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});
  });await module.evaluate();return module.namespace;
}

const id='a'.repeat(64),image='sha256:'+'b'.repeat(64),runId='controller-cleanup-test';
const channel='00000000-0000-4000-8000-000000000001';
function fixture({initiallyClosed=false,killFails=false,staysRunning=false,changed=null,removeFails=false}={}){
  const events=[],calls=[];let inspections=0,removed=false,closed=initiallyClosed;
  const command=async args=>{
    calls.push(args);
    if(args[0]==='inspect'){
      const value={Id:id,Image:image,Name:'/intake-t03-'+channel,Config:{Labels:{'intake.t03.run':runId}},
        State:{Running:!closed,Pid:closed?0:123,Restarting:false}};
      if(++inspections===2&&changed)changed(value);
      return {stdout:JSON.stringify([value])};
    }
    if(args[0]==='kill'){
      if(!staysRunning)closed=true;
      if(killFails)throw Object.assign(Error('EXTRACTION_DOCKER_CONTROL'),{observed:{code:1}});
      return {stdout:id};
    }
    if(args[0]==='rm'){
      if(removeFails)throw Error('REMOVE_FAILED');
      assert.equal(closed,true);removed=true;return {stdout:id};
    }
    throw Error('Unexpected command');
  };
  return {events,calls,removed:()=>removed,execute:()=>removeLostControllerWorker({live:{id},image,runId,channel,events},command)};
}
test('owned running and already exited workers are verified and removed',async()=>{
  for(const initiallyClosed of [false,true]){
    const f=fixture({initiallyClosed});await f.execute();
    assert.equal(f.removed(),true);
    assert.deepEqual(f.calls.map(x=>x[0]),initiallyClosed?['inspect','inspect','rm']:['inspect','kill','inspect','rm']);
    assert.equal(f.events.at(-1).kind,'owned-worker-removed');
  }
});
test('worker exit between inspect and kill is reconciled before removal',async()=>{
  const f=fixture({killFails:true});await f.execute();
  assert.deepEqual({removed:f.removed(),calls:f.calls.map(x=>x[0]),events:f.events.map(x=>x.kind)},
    {removed:true,calls:['inspect','kill','inspect','rm'],events:['worker-after-controller-loss',
      'owned-worker-kill-unconfirmed','owned-worker-cleanup-observed','owned-worker-removed']});
});
test('failed kill with a still running worker remains a failure without removal',async()=>{
  const f=fixture({killFails:true,staysRunning:true});
  await assert.rejects(f.execute(),/EXTRACTION_DOCKER_CONTROL/);assert.equal(f.removed(),false);
  assert.equal(f.calls.some(x=>x[0]==='rm'),false);
});
test('successful kill is not sufficient when closed state is unconfirmed',async()=>{
  for(const changed of [v=>{v.State.Running=true;},v=>{v.State.Pid=123;},v=>{v.State.Restarting=true;}]){
    const f=fixture({changed});await assert.rejects(f.execute(),/CONTROLLER_LOSS_WORKER_NOT_CLOSED/);
    assert.equal(f.removed(),false);
  }
});
test('reconciliation rechecks every ownership dimension before removal',async()=>{
  for(const changed of [v=>{v.Id='c'.repeat(64);},v=>{v.Image='sha256:'+'c'.repeat(64);},
    v=>{v.Config.Labels['intake.t03.run']='other-owner';},v=>{v.Name='/other-worker';}]){
    const f=fixture({killFails:true,changed});await assert.rejects(f.execute(),/CONTROLLER_LOSS_OWNERSHIP/);
    assert.equal(f.removed(),false);
  }
});
test('failed removal stays failed and never records an owned-worker-removed event',async()=>{
  const f=fixture({removeFails:true});await assert.rejects(f.execute(),/REMOVE_FAILED/);
  assert.equal(f.removed(),false);assert.equal(f.events.some(x=>x.kind==='owned-worker-removed'),false);
});

test('the full controller-loss path keeps its diagnostic when cleanup fails',async()=>{
  for(const removeFails of [false,true]){
    const saved=[];let inspections=0;
    const live={kind:'running',id,image,pid:123,started_at:'fixed-start'};
    const fork=()=>{
      const child=new EventEmitter();child.pid=101;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
      child.send=()=>queueMicrotask(()=>child.emit('message',{kind:'observation',event:live}));
      child.kill=()=>{queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;};return child;
    };
    const module=await isolatedSource('controller_loss.mjs',{
      'node:child_process':{fork},'node:url':{fileURLToPath:()=>'/unused'},'node:path':{default:{join:(...s)=>s.join('/')}},
      'node:fs/promises':{default:{writeFile:async(name,body)=>saved.push(JSON.parse(body))}},
      './launcher.mjs':{dockerCommand:async args=>{
        if(args[0]==='inspect'){const running=++inspections===1;return {stdout:JSON.stringify([{Id:id,Image:image,
          Name:'/intake-t03-'+channel,Config:{Labels:{'intake.t03.run':runId}},
          State:{Running:running,Pid:running?123:0,Restarting:false,StartedAt:'fixed-start'}}])};}
        assert.equal(args[0],'rm');if(removeFails)throw Error('REMOVE_FAILED');return {stdout:id};
      }}});
    await assert.rejects(module.loseControllerAfterLaunch({request:{binding:{channel_id:channel}},image,runId,
      originalPath:'/synthetic',directory:'/private',observe:async()=>{}}),removeFails?/REMOVE_FAILED/:/EXTRACTION_HOST_CONTROLLER_LOST/);
    assert.equal(saved.length,1);assert.equal(saved[0].settled,true);
    assert.equal(saved[0].events.some(e=>e.kind==='owned-worker-cleanup-observed'),true);
    assert.equal(saved[0].events.some(e=>e.kind==='owned-worker-removed'),!removeFails);
  }
});

test('the host bridge fails on unexpected controller cleanup errors, not on the intended loss',async()=>{
  for(const reason of ['EXTRACTION_HOST_CONTROLLER_LOST','REMOVE_FAILED']){
    let published,finish;
    const completed=new Promise(resolve=>{finish=resolve;});
    const item={channel,id:channel,image,subject:{},request:{binding:{channel_id:channel,original:{}}}};
    const module=await isolatedSource('host_bridge.mjs',{
      'node:fs/promises':{default:{mkdir:async()=>{},writeFile:async(name,body)=>{
        if(name.endsWith('/completion.json'))published=JSON.parse(body);
      }}},'node:path':{default:{join:(...s)=>s.join('/')}},'node:crypto':{createHash:()=>{throw Error('Unexpected hashing');}},
      './launcher.mjs':{launchExtraction:()=>{throw Error('Wrong launcher');}},
      './controller_loss.mjs':{loseControllerAfterLaunch:async()=>{throw Error(reason);}},
      './granted_original.mjs':{grantOriginalCopy:async()=>'/synthetic'}});
    const bridge=module.extractionHostBridge({image,runId,broker:'test',directory:'/private',docker:async args=>{
      if(args[0]==='cp')return '';
      if(args[5]==='pending')return JSON.stringify([item]);
      assert.equal(args[5],'publish');finish();return '';
    }});
    bridge.loseNextController();await bridge.tick();await completed;
    if(reason==='REMOVE_FAILED')await assert.rejects(bridge.close(),/REMOVE_FAILED/);else await bridge.close();
    assert.deepEqual({closed:published.closed,failed:published.failed,metadata:published.metadata,error:published.error},
      {closed:false,failed:true,metadata:null,error:reason});
  }
});
