import test from 'node:test';
import assert from 'node:assert/strict';
import {runProcess} from './reviewed/process-output.mjs';
import {summarizeNodeTests} from '../../../ci/intake_test_summary.mjs';
import './l03_observation.mjs';

const run=script=>runProcess(process.execPath,['-e',script],{cwd:process.cwd(),outputBytes:65536,timeoutMs:5000});
const tap='TAP version 13\nok 1 - positive\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

test('Real child tests and the retained-byte collector produce observed counts',async()=>{
 const result=await run("const test=require('node:test'); test('first',()=>{}); test('second',()=>{})");
 const report=summarizeNodeTests(result,'0001.json');
 assert.deepEqual({status:report.status,summary:report.summary,code:report.code,record:report.commandRecord},
  {status:'passed',summary:{tests:2,suites:0,pass:2,fail:0,cancelled:0,skipped:0,todo:0},code:0,record:'0001.json'});
});

const negatives=[
 ['empty zero-exit child','', 'invalid_tests'],
 ['zero-test report','TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n','no_tests'],
 ['incomplete summary',tap.replace('# cancelled 0\n',''),'invalid_cancelled'],
 ['invalid numeric summary',tap.replace('# tests 1','# tests one'),'invalid_tests'],
 ['incoherent summary',tap.replace('# pass 1','# pass 2'),'tests_not_all_passed'],
 ['duplicated summary',tap+'# tests 1\n','invalid_tests'],
 ['wrong plan',tap.replace('1..1','1..2'),'plan_count_mismatch'],
 ['no test records',tap.replace('ok 1 - positive\n',''),'record_count_mismatch'],
];
for(const [name,output,expected]of negatives)test('Zero exit does not credit '+name,async t=>{
 const result=await run('process.stdout.write('+JSON.stringify(output)+')');
 assert.equal(result.code,0);
 const report=summarizeNodeTests(result,'0002.json');
 assert.deepEqual({credited:report.status==='passed',reason:report.errors.includes(expected)},{credited:false,reason:true});
 t.diagnostic(JSON.stringify({name,observed:report}));
});
test('A nonzero exit cannot be hidden by a passing summary',async()=>{
 const result=await run('process.stdout.write('+JSON.stringify(tap)+');process.exitCode=1');
 const report=summarizeNodeTests(result,'0003.json');
 assert.equal(report.status,'invalid');assert.ok(report.errors.includes('nonzero_exit'));
});
test('A truncated collector result cannot be credited',async()=>{
 const result=await runProcess(process.execPath,['-e','process.stdout.write('+JSON.stringify(tap)+')'],{cwd:process.cwd(),outputBytes:20,timeoutMs:5000});
 assert.equal(result.reason,'output_limit');
 const report=summarizeNodeTests(result,'0004.json');
 assert.equal(report.status,'invalid');assert.ok(report.errors.includes('incomplete_capture'));
});
