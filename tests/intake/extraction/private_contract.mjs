import test from 'node:test';
import assert from 'node:assert/strict';
import {sameStructure} from '../../../ci/intake/extraction/storage.mjs';
import {decodePrivateIntakeJson,decodeObservedJson} from '../../../src/contracts/intake.ts';
import {resolveIntakePath} from '../../../src/server/intake/protocol.ts';
import {intakeViolations} from '../../../ci/intake_boundary_check.mjs';
import {extractionControlRequest} from '../../../ci/intake/extraction/control_scope.mjs';
import {randomUUID} from 'node:crypto';
import {extractionDataRequest} from '../../../ci/intake/extraction/data_scope.mjs';
import {EXTRACTION_BOUNDS,decodeExtractionPrivate} from '../../../src/contracts/intake_extraction.ts';
import {requestFixture} from './interface_fixtures.mjs';

test('stop and launch observation have a closed metadata-only method set',()=>{
  const subject={job_id:randomUUID(),channel_id:randomUUID(),attempt_generation:1,binding_sha256:'a'.repeat(64)};
  const stop={id:randomUUID(),profile:'intake-extraction-stop/1',subject};
  const observation={...stop,profile:'intake-extraction-observation/1',phaseId:randomUUID()};
  for(const [kind,positive]of [['stop',stop],['observation',observation]]){
    assert.equal(extractionControlRequest(positive,kind),true);
    for(const field of ['action','body','data','path','binding','evidenceId','authority'])
      assert.equal(extractionControlRequest({...positive,[field]:'read'},kind),false,field);
    for(const invalid of [null,{...subject,attempt_generation:0},{...subject,job_id:'arbitrary'},
      {...subject,extra:1},{...subject,binding_sha256:'none'}])
      assert.equal(extractionControlRequest({...positive,subject:invalid},kind),false);
  }
});

test('private association compares values, including closed membership, not jsonb member order',()=>{
  const first={id:'resource',generation:1,bytes:3,sha256:'a'.repeat(64)};
  const jsonb={bytes:3,generation:1,id:'resource',sha256:'a'.repeat(64)};
  assert.equal(sameStructure(first,jsonb),true);
  for(const second of [{...jsonb,id:'other'},{...jsonb,generation:2},{...jsonb,extra:1},{...jsonb,bytes:'3'},[jsonb]])assert.equal(sameStructure(first,second),false);
});
test('private base64 envelopes have a separate bound without widening observed artifacts',()=>{
  const bytes=Buffer.from(JSON.stringify({data:'a'.repeat(8388608)}));
  assert.throws(()=>decodeObservedJson(bytes));assert.equal(decodePrivateIntakeJson(bytes).data.length,8388608);
  assert.throws(()=>decodePrivateIntakeJson(Buffer.alloc(16777217)));
});

test('full raw and normalized quotas fit the closed private frame without borrowing either quota',()=>{
  const artifact=(bytes)=>({id:randomUUID(),generation:1,bytes,sha256:'a'.repeat(64)});
  const frame={id:randomUUID(),profile:'intake-extraction-private/1',phaseId:randomUUID(),incarnation:'trial',namespace:'intake_trial',
    original:{...requestFixture().binding.original,id:randomUUID()},evidenceId:randomUUID(),
    subject:{job_id:randomUUID(),channel_id:randomUUID(),attempt_generation:1,binding_sha256:'a'.repeat(64)},action:'seal',
    raw:artifact(EXTRACTION_BOUNDS.stdoutBytes),normalized:artifact(EXTRACTION_BOUNDS.normalizedBytes),
    data:Buffer.alloc(EXTRACTION_BOUNDS.stdoutBytes).toString('base64'),normalizedData:Buffer.alloc(EXTRACTION_BOUNDS.normalizedBytes).toString('base64')};
  assert.equal(extractionDataRequest(frame,'outputs'),true);assert.equal(extractionDataRequest(frame,'extraction'),false);
  const bytes=Buffer.from(JSON.stringify(frame));assert.ok(bytes.length<EXTRACTION_BOUNDS.privateBytes);
  assert.equal(decodeExtractionPrivate(bytes).data.length,frame.data.length);
  assert.throws(()=>decodePrivateIntakeJson(bytes),/INTAKE_BODY_LIMIT/);
  for(const bad of [{...frame,extra:'unbounded metadata'},{...frame,raw:{...frame.raw,bytes:EXTRACTION_BOUNDS.stdoutBytes+1}},
    {...frame,normalized:{...frame.normalized,bytes:EXTRACTION_BOUNDS.normalizedBytes+1}},{...frame,data:'!AAA'}])
    assert.equal(extractionDataRequest(bad,'outputs'),false);
});
test('extraction routing requires the explicit composition and has no later-consumer alias',()=>{
  assert.equal(resolveIntakePath('GET','/api/intake/extractions/one'),null);
  assert.deepEqual(resolveIntakePath('GET','/api/intake/extractions/one',true),{route:'extraction',parameters:{id:'one'}});
  for(const path of ['/api/intake/extractions/one?x=1','/api/intake/extractions/%31','/api/intake/preparations/one/revisions/1'])
    assert.equal(resolveIntakePath('GET',path,true),null);
  assert.equal(resolveIntakePath('POST','/api/intake/extractions/one',true),null);
});
test('restored reads carry only a closed retained-anchor reference on the restored namespace',()=>{
  const artifact={id:randomUUID(),generation:1,bytes:5,sha256:'a'.repeat(64)};
  const subject={job_id:randomUUID(),channel_id:randomUUID(),attempt_generation:1,binding_sha256:'b'.repeat(64)};
  const frame={id:randomUUID(),profile:'intake-extraction-private/1',phaseId:randomUUID(),incarnation:'current',namespace:'intake_restore',
    original:artifact,evidenceId:randomUUID(),subject,action:'read',bundle:{id:subject.channel_id,raw:artifact,
      normalized:{...artifact,id:randomUUID()},namespace:'intake_trial',subject},restore_anchor:{id:randomUUID(),sha256:'c'.repeat(64)}};
  assert.equal(extractionDataRequest(frame,'outputs'),true);assert.equal(extractionDataRequest(frame,'extraction'),false);
  for(const bad of [{...frame,namespace:'intake_trial'},{...frame,action:'seal'},
    {...frame,restore_anchor:{...frame.restore_anchor,path:'/other'}},{...frame,restore_anchor:{id:randomUUID(),sha256:'invalid'}}])
    assert.equal(extractionDataRequest(bad,'outputs'),false);
  // Syntactic admission is not authenticity: the actual storage and SQL path
  // must separately match this reference to its independently retained cut.
});
test('shared structural rules do not admit framework or parser dependencies',()=>{
  assert.deepEqual(intakeViolations('src/contracts/intake_extraction_view.ts',"import {x} from './intake_artifact.ts'"),[]);
  for(const source of ["import x from 'next'","import x from 'xlsx'","import x from '../server/intake/extraction.ts'"])
    assert.ok(intakeViolations('src/contracts/intake_extraction_view.ts',source).length>0);
});
