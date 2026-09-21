import test from 'node:test';
import assert from 'node:assert/strict';
import {receptionStatus, extractionStatus, recoveredPreparationStatus, rejectedReceptionStatus} from '../../../src/components/intake/status.ts';

test('SUI01 a recorded reservation is not an uncertain result or a completed preparation', () => {
  assert.deepEqual(recoveredPreparationStatus('reserved'), {phase: 'recorded',
    detail: 'Retained preparation result: reserved. No operation was repeated.'});
  assert.equal(receptionStatus({state: 'reserved', work: null}).phase, 'recorded');
  assert.equal(receptionStatus({state: 'uncertain', work: null}).phase, 'uncertain');
});
test('SUI02 reception, running extraction and accepted result remain different facts', () => {
  assert.equal(receptionStatus({state: 'received', work: {state: 'eligible'}}).phase, 'received');
  for (const state of ['claimed', 'running', 'result_staged', 'stopping'])
    assert.deepEqual(receptionStatus({state: 'received', work: {state}}), {phase: 'extracting',
      detail: `Original received. Extraction state: ${state}. No accepted result is implied.`});
  assert.equal(receptionStatus({state: 'stopped', work: {state: 'stopped'}}).phase, 'stopped');
});
test('SUI03 partial and failed content are not silently presented as completed', () => {
  for (const outcome of ['completed', 'partial', 'failed'])
    assert.deepEqual(extractionStatus('content', {outcome}), {phase: outcome === 'failed' ? 'failed' : 'extracted',
      detail: `Extraction observed: ${outcome}. Preparation is a separate human act.`});
  assert.deepEqual(extractionStatus('metadata', null), {phase: 'received', detail: 'Only extraction metadata is currently available.'});
});

test('SUI04 a returned rejection is not a lost response or proof that earlier work was erased', () => {
  assert.deepEqual(rejectedReceptionStatus(415), {phase: 'failed',
    detail: 'The service rejected this reception request (415). Earlier recorded work is retained; reconcile its current state.'});
});
