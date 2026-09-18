import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {collectProcessOutput} from '../../../ci/intake/extraction/collector.mjs';
import {collectProcessOutput as retained} from '../t01/reviewed/process-output.mjs';

test('operational collector preserves the identified decoder plus one retained-byte accessor', () => {
  const added='    retainedStdout() { return Buffer.concat(out, retained); },\n';
  assert.equal(collectProcessOutput.toString().split(added).length,2);
  assert.equal(collectProcessOutput.toString().replace(added,''), retained.toString());
});
test('all UTF-8 boundaries and legitimate replacement character remain exact', () => {
  const bytes = Buffer.from('{"value":"é€😀�"}');
  for (let i = 0; i <= bytes.length; i++) {
    const stdout = new EventEmitter(), stderr = new EventEmitter();
    const collector = collectProcessOutput(stdout, stderr, {outputBytes: 1024});
    stdout.emit('data', bytes.subarray(0, i)); stdout.emit('data', bytes.subarray(i));
    assert.equal(collector.finish().stdout, bytes.toString());
  }
});
test('output cut keeps the primary cause while diagnosing only retained bytes', () => {
  const stdout = new EventEmitter(), stderr = new EventEmitter(); let stops = 0;
  const collector = collectProcessOutput(stdout, stderr, {outputBytes: 1, diagnosticBytes: 2, stop: () => stops++});
  stdout.emit('data', Buffer.from('é')); stderr.emit('data', Buffer.from('abcd'));
  const result = collector.finish();
  assert.deepEqual({reason: result.reason, encoding: result.stdoutEncodingError, kept: result.stdoutRetainedBytes, received: result.stdoutBytes, stops},
    {reason: 'output_limit', encoding: true, kept: 1, received: 2, stops: 1});
  assert.equal(result.stderr, 'ab'); assert.equal(result.stderrTruncated, true);
  assert.deepEqual(collector.retainedStdout(),Buffer.from([0xc3]));
  const copy=collector.retainedStdout();copy[0]=0;
  assert.deepEqual(collector.retainedStdout(),Buffer.from([0xc3]),'Inspection cannot mutate conserved raw bytes');
});
