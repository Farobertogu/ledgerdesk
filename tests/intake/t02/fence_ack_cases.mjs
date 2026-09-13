import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrivateIntakePort } from '../../../src/server/intake/ports.ts';
import { administration } from './recovery_cases.mjs';
import { treatment } from './fixtures.mjs';

/** The copied server drops only the ACK, after real work and child/journal completion. */
export async function fenceAckCase(t, { env, intake, client, request, application, retained, reserve, declare, text }) {
  const kind = process.env.LEDGERDESK_INTAKE_FENCE_ACK;
  await t.test(`F06 lost ${kind} acknowledgment preserves the physical outcome without implicit replay`, async () => {
    let controller;
    const records = { kind, physicalExpectation: 'fixed original bytes, not the operation reply' };
    const r = kind === 'read' ? (await request(`/api/intake/receptions/${retained.receptionId}`, { client })).body : await reserve(declare(text));
    const original = r.original, bytes = kind === 'read' ? retained.bytes : text;
    try {
      if (kind === 'read') {
        const positive = await request(`/api/intake/receptions/${r.reception_id}/original`, { client });
        assert.deepEqual({ status: positive.status, bytes: positive.bytes }, { status: 200, bytes });
      }
      records.before = {
        receipts: (await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1', [r.reception_id])).rows,
        phaseCount: (await env.admin.query('SELECT count(*)::int AS n FROM intake_control.private_phase WHERE reception_id=$1', [r.reception_id])).rows[0].n,
      };
      assert.equal((await administration('arm-private-ack', { artifactId: original.id, generation: original.generation, action: kind })).ok, true);
      const response = kind === 'read'
        ? await request(`/api/intake/receptions/${r.reception_id}/original`, { client })
        : await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`, { bytes, client });
      records.response = { status: response.status, body: response.body, bytes: response.bytes.length };
      const fault = await administration('private-ack-state', {}); records.fault = fault;
      assert.equal(fault.dropped.length, 1, 'The exact successful private action must reach the lost-ACK boundary');
      const dropped = fault.dropped[0];
      assert.deepEqual({ action: dropped.action, artifactId: dropped.artifactId, generation: dropped.generation },
        { action: kind, artifactId: original.id, generation: original.generation });
      assert.equal(fault.phase.id, dropped.phaseId); assert.equal(fault.phase.state, 'closed');
      if (kind !== 'close') {
        assert.equal(dropped.termination.profile, 'intake-child-stop/1');
        assert.ok(dropped.termination.closedAtMs <= dropped.atMs);
      } else assert.equal(dropped.journalState, 'closed');
      const p = (await env.admin.query('SELECT * FROM intake_control.private_phase WHERE id=$1', [dropped.phaseId])).rows[0]; assert.ok(p);
      const after = {
        receiptRows: (await env.admin.query('SELECT * FROM intake_trial.receipt WHERE reception_id=$1', [r.reception_id])).rows,
        reception: (await env.admin.query('SELECT * FROM intake_trial.reception WHERE id=$1', [r.reception_id])).rows[0],
        attempts: (await env.admin.query('SELECT * FROM intake_trial.attempt WHERE reception_id=$1 ORDER BY generation', [r.reception_id])).rows,
        head: (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0],
      };
      records.after = after;
      assert.deepEqual({ status: response.status, receipts: after.receiptRows, state: after.reception.state,
        activePhase: after.head.active_phase },
      { status: 503, receipts: records.before.receipts, state: kind === 'read' ? 'received' : 'uncertain',
        activePhase: kind === 'close' ? p.id : null });
      // Independently inspect the actual private volume; a SQL byte counter does
      // not imply the physical append failed merely because its response was lost.
      const physical = await administration('inspect', {});
      const member = physical.objects.find(x => x.name === original.id + '-1.' + (['read', 'seal'].includes(kind) ? 'sealed' : 'stage'));
      assert.ok(member); records.physical = member;
      assert.deepEqual({ bytes: member.bytes, sha256: member.sha256 },
        { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      const actualOperations = fault.events.filter(e => e.origin === 'private-supervisor' && e.kind === 'started' && e.phaseId === p.id);
      assert.equal(actualOperations.filter(e => e.action === (kind === 'close' ? 'append' : kind)).length, 1,
        'The selected operation executes once, not until an ACK happens to arrive');

      if (kind === 'close') {
        let code = null; try { await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)', [treatment.id, treatment.revision]); }
        catch (error) { code = error.code; }
        assert.deepEqual({ code, enabled: (await env.admin.query('SELECT enabled FROM intake_control.treatment_current')).rows[0].enabled },
          { code: '55P03', enabled: true });
      }
      // Observe the real application's exit before the external technical actor
      // reconciles any leftover phase. Never use the old runtime's self-report.
      records.runtimeClosed = await application.crash(); assert.equal(records.runtimeClosed.signal, 'SIGKILL');
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1', [p.backend_pid])).rows[0].n, 0);
      const participants = {};
      for (const participant of Object.keys(p.participant_plan)) {
        const port = new PrivateIntakePort(participant === 'objects' ? intake.brokerSocket : intake.verifierSocket, 1500000, 1000, intake.namespace);
        participants[participant] = await port.closePhase(p.id);
        await assert.rejects(() => port.openPhase({ id: p.id, incarnation: p.incarnation, namespace: p.namespace,
          original, evidenceId: p.evidence_id, participant, actions: p.participant_plan[participant] }), /INTAKE_PHASE_OPEN/);
      }
      if (kind === 'close') {
        const password = randomBytes(24).toString('hex');
        await env.admin.query(`ALTER ROLE inc03_intake_control LOGIN PASSWORD '${password}'`);
        controller = new Client({ connectionString: `postgresql://inc03_intake_control:${password}@127.0.0.1:55432/inc02_synthetic`,
          statement_timeout: 2000, lock_timeout: 250 }); await controller.connect();
        const observation = { profile: 'intake-controller-closure/1', phaseId: p.id, backendPid: p.backend_pid,
          mode: 'runtime-ended-participants-closed', runtimeProcess: { observed: 'closed', ...records.runtimeClosed }, participants };
        await controller.query('SELECT intake_control.reconcile_phase($1,$2,$3,$4)', [p.id, p.source_id, p.incarnation, JSON.stringify(observation)]);
      }
      const completed = (await env.admin.query('SELECT * FROM intake_control.phase_completion WHERE phase_id=$1', [p.id])).rows[0];
      assert.equal(completed.kind, kind === 'close' ? 'controller_reconciled' : 'participants_closed'); records.completion = completed;
      const newConfig = { ...intake, incarnation: 'intake-ack-recovered-2' };
      await env.admin.query('UPDATE intake_control.live SET incarnation=$1,revision=revision+1 WHERE singleton', [newConfig.incarnation]);
      await application.restart(newConfig);
      const status = await request(`/api/intake/receptions/${r.reception_id}`, { client });
      assert.deepEqual({ status: status.status, state: status.body.state }, { status: 200, state: kind === 'read' ? 'received' : 'uncertain' });
      if (kind !== 'read') {
        const retry = await request(`/api/intake/receptions/${r.reception_id}/resume`, { client, key: randomUUID(), body: {
          profile: 'intake/1', expected_revision: status.body.revision, expected_generation: 1, cause: 'interrupted', original } });
        assert.equal(retry.status, 409, 'Uncertain bytes are not silently treated as an interrupted, safely resumable attempt');
      }
      const valid = await request(`/api/intake/receptions/${retained.receptionId}/original`, { client });
      assert.deepEqual({ status: valid.status, bytes: valid.bytes }, { status: 200, bytes: retained.bytes });
      const fresh = await reserve(declare(text));
      assert.equal((await request(`/api/intake/receptions/${fresh.reception_id}/attempts/1/original`, { bytes: text, client })).status, 200);
      records.progress = { retainedRead: valid.status, freshReception: fresh.reception_id,
        uncertainty: kind === 'read' ? 'known receipt preserved' : 'queriable, not automatically resumed; business-outcome recovery remains separate' };
    } finally {
      await controller?.end();
      writeFileSync('/work/output/fence-ack-' + kind + '.json', JSON.stringify(records, null, 2), { flag: 'wx' });
    }
  });
}
