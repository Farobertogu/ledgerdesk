import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrivateIntakePort } from '../../../src/server/intake/ports.ts';
import { administration } from './recovery_cases.mjs';

function queued(socketPath, body) {
  const id = randomUUID(), bytes = Buffer.from(JSON.stringify({ id, ...body })), socket = net.createConnection(socketPath), chunks = [];
  const observation = { id, connectedAtMs: null, initialWriteAtMs: null, releasedAtMs: null, endedAtMs: null, closedAtMs: null, errorCode: null };
  const completion = new Promise(resolve => {
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', error => { observation.errorCode = error.code; });
    socket.once('end', () => { observation.endedAtMs = Date.now(); });
    socket.once('close', () => { observation.closedAtMs = Date.now(); resolve({ ...observation, bytes: Buffer.concat(chunks) }); });
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      observation.connectedAtMs = Date.now();
      socket.write(bytes.subarray(0, bytes.length - 1), error => {
        if (error) reject(error); else { observation.initialWriteAtMs = Date.now(); resolve(); }
      });
    });
  });
  socket.setTimeout(10000, () => socket.destroy(Error('QUEUED_PRIVATE_DEADLINE')));
  return { id, ready, completion, observation,
    release() { observation.releasedAtMs = Date.now(); socket.end(bytes.subarray(bytes.length - 1)); },
    destroy() { socket.destroy(); } };
}

export async function fenceIpcCase(t, { env, intake, client, request, retained, setBarrier }) {
  await t.test('F12 queued old channels cannot reopen a terminal phase before or after participant replacement', async () => {
    const records = {}, queues = [];
    let selected;
    setBarrier(async (label, event) => {
      if (label !== 'before_original_read' || event.receptionId !== retained.receptionId || selected) return;
      selected = (await env.admin.query('SELECT * FROM intake_control.private_phase WHERE evidence_id=$1', [event.evidenceId])).rows[0];
      assert.ok(selected);
      const original = (await requestOriginalRow(env, selected)), binding = { id: selected.id, incarnation: selected.incarnation,
        namespace: selected.namespace, original, evidenceId: selected.evidence_id, participant: 'objects', actions: selected.participant_plan.objects };
      records.binding = binding;
      queues.push(queued(intake.brokerSocket, { profile: 'intake-phase-control/1', action: 'open', binding }));
      queues.push(queued(intake.brokerSocket, { profile: 'intake-object/1', phaseId: selected.id, action: 'read',
        original, incarnation: selected.incarnation, evidenceId: selected.evidence_id, namespace: selected.namespace }));
      queues.push(queued(intake.brokerSocket, { profile: 'intake-phase-control/1', action: 'open', binding }));
      await Promise.all(queues.map(queue => queue.ready));
      records.queuedWhileActive = (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0];
      assert.equal(records.queuedWhileActive.active_phase, selected.id);
    });
    try {
      const positive = await request(`/api/intake/receptions/${retained.receptionId}/original`, { client });
      assert.deepEqual({ status: positive.status, bytes: positive.bytes }, { status: 200, bytes: retained.bytes });
      assert.ok(selected); setBarrier(async () => {});
      records.completion = (await env.admin.query('SELECT * FROM intake_control.phase_completion WHERE phase_id=$1', [selected.id])).rows[0];
      assert.equal(records.completion.kind, 'participants_closed');
      assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase, null);
      for (const queue of queues.slice(0, 2)) {
        queue.release(); const reply = await queue.completion, parsed = JSON.parse(reply.bytes.toString('utf8'));
        assert.deepEqual({ id: parsed.id, ok: parsed.ok, outcome: parsed.outcome, bytes: parsed.bytes, dispatch: parsed.dispatch },
          { id: queue.id, ok: false, outcome: 'denied', bytes: 0, dispatch: 'not-started' });
        assert.ok(reply.releasedAtMs >= Number(records.completion.completed_at));
        (records.delayedBeforeRestart ??= []).push({ ...reply, bytes: reply.bytes.length, parsed });
      }
      records.beforeRestart = await administration('phase-no-dispatch', { phaseId: selected.id });
      assert.equal(records.beforeRestart.members.objects.row.state, 'closed');
      const beforeReads = records.beforeRestart.members.objects.events.filter(e => e.origin === 'private-supervisor' && e.kind === 'started' && e.action === 'read');
      assert.equal(beforeReads.length, 1, 'The real positive executes once; neither queued command starts');
      records.replacement = await administration('restart-closed-participant', { phaseId: selected.id });
      assert.equal(records.replacement.oldState.Running, false); assert.equal(records.replacement.oldState.Pid, 0);
      assert.notEqual(records.replacement.oldContainerRemoved, records.replacement.newContainer);
      const oldChannel = await queues[2].completion;
      assert.equal(oldChannel.bytes.length, 0); assert.ok(oldChannel.closedAtMs); records.closedOldChannel = { ...oldChannel, bytes: 0 };
      const port = new PrivateIntakePort(intake.brokerSocket, 1500000, 1000, intake.namespace);
      await assert.rejects(() => port.openPhase(records.binding), /INTAKE_PHASE_OPEN/);
      const late = await port.call({ phaseId: selected.id, action: 'read', original: records.binding.original,
        incarnation: selected.incarnation, evidenceId: selected.evidence_id });
      assert.deepEqual({ ok: late.ok, outcome: late.outcome, bytes: late.bytes }, { ok: false, outcome: 'denied', bytes: 0 });
      records.afterRestart = await administration('phase-no-dispatch', { phaseId: selected.id });
      assert.equal(records.afterRestart.members.objects.row.state, 'closed');
      assert.equal(records.afterRestart.members.objects.events.filter(e => e.origin === 'private-supervisor' && e.kind === 'started').length, 1);
      const fresh = await request(`/api/intake/receptions/${retained.receptionId}/original`, { client });
      assert.deepEqual({ status: fresh.status, bytes: fresh.bytes }, { status: 200, bytes: retained.bytes });
      records.progress = { status: fresh.status, originalBytes: fresh.bytes.length };
    } finally {
      setBarrier(async () => {}); for (const queue of queues) queue.destroy();
      await Promise.all(queues.map(queue => queue.completion));
      writeFileSync('/work/output/fence-ipc.json', JSON.stringify(records, null, 2), { flag: 'wx' });
    }
  });
}

async function requestOriginalRow(env, phase) {
  const row = (await env.admin.query('SELECT id,generation,bytes,sha256 FROM intake_trial.artifact WHERE id=$1', [phase.artifact_id])).rows[0];
  assert.ok(row); return row;
}
