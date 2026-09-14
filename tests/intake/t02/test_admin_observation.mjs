import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {observationActions,eventObservationTarget} from '../../../ci/intake/reception/admin_observation.mjs';

// Fixed expected consumers, independent of the bridge's admission inventory.
const consumers=['fencing-probe','fence-sql','fence-loss','fence-ack','fence-commit','fence-continuation','fence-ipc','fence-restore'];
const runtime=readFileSync(new URL('./test_runtime.mjs',import.meta.url),'utf8');
const runner=readFileSync(new URL('../../../ci/intake_t02_check.mjs',import.meta.url),'utf8');
const policy=readFileSync(new URL('../../../ci/intake/reception/admin_observation.mjs',import.meta.url),'utf8');
function requests(){
  const ast=ts.createSourceFile('runtime.mjs',runtime,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let trunk;const calls=[];
  function locate(n){if(ts.isCallExpression(n)&&n.arguments.length&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text==='wrong actual digest cannot produce a receipt even if the declaration is valid')trunk=n.arguments[1];ts.forEachChild(n,locate);}locate(ast);
  assert.ok(trunk&&ts.isArrowFunction(trunk));
  function collect(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='administration'){
    assert.ok(ts.isStringLiteral(n.arguments[0])&&ts.isObjectLiteralExpression(n.arguments[1]));
    calls.push([n.arguments[0].text,Object.fromEntries(n.arguments[1].properties.map(p=>{
      assert.ok(ts.isPropertyAssignment(p)&&ts.isIdentifier(p.name)&&ts.isStringLiteral(p.initializer));return[p.name.text,p.initializer.text];
    }))]);
  }ts.forEachChild(n,collect);}collect(trunk);return calls;
}
function compose(api){
  const actual=requests();assert.deepEqual(actual,[['observe-events',{}],['observe-events',{participant:'verifier'}]]);
  for(const group of ['runtime',...consumers])for(const [i,[action,body]]of actual.entries()){
    assert.ok(api.observationActions(group).includes(action),group+' action');
    assert.equal(api.eventObservationTarget(group,body),i===0?'objects':'verifier',group+' participant');
  }
}
test('shared digest requests are admitted by the actual bridge policy for all eight FENCE consumers',()=>{
  compose({observationActions,eventObservationTarget});
  assert.ok(runner.includes('...observationActions(group)'));
  assert.ok(runner.includes('const participant=eventObservationTarget(group,request.body);'));
  assert.ok(runner.includes('participant===\'objects\'?broker.name:verifier.name'));
});
test('FENCE observation does not arm faults, select arbitrary participants, or accept extra payload',()=>{
  for(const group of consumers){
    assert.deepEqual(observationActions(group),['observe-events']);
    for(const body of [null,[],false,{participant:'objects'},{participant:'runtime'},{participant:'supervisor'},
      {participant:'verifier',key:'another'},{participant:'verifier',action:'arm-observer'},{action:'arm-stall'}])
      assert.throws(()=>eventObservationTarget(group,body),/EVENT_OBSERVER_SCOPE/);
  }
  for(const group of ['fence-coupled','unknown','units']){
    assert.deepEqual(observationActions(group),[]);assert.throws(()=>eventObservationTarget(group,{}),/EVENT_OBSERVER_SCOPE/);
  }
});
test('removing either observer permission is detected independently for every FENCE consumer',async()=>{
  for(const group of consumers){
    const altered=policy.replace("'"+group+"'", "'omitted-"+group+"'");assert.notEqual(altered,policy);
    const module=await import('data:text/javascript;base64,'+Buffer.from(altered).toString('base64'));
    assert.throws(()=>compose(module),error=>error instanceof assert.AssertionError&&error.message.includes(group+' action'));
  }
  const restricted=policy.replace("(group==='runtime'||fenceGroups.has(group))", "group==='runtime'");assert.notEqual(restricted,policy);
  const module=await import('data:text/javascript;base64,'+Buffer.from(restricted).toString('base64'));
  assert.throws(()=>compose(module),/EVENT_OBSERVER_SCOPE/);
});
