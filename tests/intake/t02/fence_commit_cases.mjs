import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { PrivateIntakePort } from '../../../src/server/intake/ports.ts';
import { administration } from './recovery_cases.mjs';
import { treatment } from './fixtures.mjs';

async function until(read, accept, label) {
  const end = Date.now() + 4000; let value;
  do { value = await read(); if (accept(value)) return value; await delay(10); } while (Date.now() < end);
  assert.fail(label + ': ' + JSON.stringify(value));
}

/** Independent PostgreSQL observer; no accepted COMMIT result is manufactured. */
export async function fenceCommitCase(t, { env, intake, client, request, application, retained, reserve, declare, text, storage, setBarrier }) {
  const kind = process.env.LEDGERDESK_INTAKE_FENCE_COMMIT;
  await t.test(`F07 ${kind} before private OPEN preserves durable truth and zero body consumption`, async () => {
    const r = await reserve(declare(text)), observed = { kind, receptionId: r.reception_id, original: r.original };
    let controller;
    const inspect = async (phaseId, evidenceId) => ({
      phase: (await env.admin.query('SELECT * FROM intake_control.private_phase WHERE id=$1', [phaseId])).rows[0] ?? null,
      evidence: (await env.admin.query('SELECT * FROM intake_trial.evidence WHERE id=$1', [evidenceId])).rows[0] ?? null,
      head: (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0],
      atMs: Date.now(),
    });
    setBarrier(async (label, event) => {
      if (event.original?.id !== r.original.id) return;
      if (label === 'phase_commit_reply_held') {
        observed.boundary = event;
        observed.durableWhileReplyHeld = await until(() => inspect(event.phaseId, event.evidenceId),
          value => value.phase && value.evidence && value.head.active_phase === event.phaseId, 'COMMIT_NOT_DURABLE');
        observed.producerWhileReplyHeld = (await env.admin.query('SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1', [event.backendPid])).rows[0];
        assert.deepEqual({ state: observed.producerWhileReplyHeld.state, transaction: observed.producerWhileReplyHeld.xact_start },
          { state: 'idle', transaction: null });
      } else if (label === 'phase_commit_rolled_back') {
        observed.boundary = event; observed.rolledBack = await inspect(event.phaseId, event.evidenceId);
        assert.deepEqual({ phase: observed.rolledBack.phase, evidence: observed.rolledBack.evidence, head: observed.rolledBack.head.active_phase },
          { phase: null, evidence: null, head: null });
      } else if (label === 'phase_commit_reply_lost') {
        observed.commitResult = { ...event, observedAtMs: Date.now() }; assert.equal(event.commitResolved, false);
      }
    });
    try {
      writeFileSync('/work/output/commit-fault.json', JSON.stringify({ artifactId: r.original.id, generation: 1, kind }), { flag: 'wx' });
      const response = await request(`/api/intake/receptions/${r.reception_id}/attempts/1/original`, { bytes: text, client })
        .catch(error => ({ status: null, errorCode: error.code ?? null, errorName: error.name }));
      observed.response = { status: response.status, errorCode: response.errorCode ?? null };
      assert.ok(response.status === 503 || (kind === 'reply-loss' && response.status === null), 'No successful response is invented after the database transport loss');
      await until(() => observed.boundary, Boolean, 'FAULT_BOUNDARY_NOT_REACHED');
      if (kind === 'reply-loss') await until(() => observed.commitResult, Boolean, 'COMMIT_REJECTION_NOT_OBSERVED');
      assert.deepEqual(JSON.parse(readFileSync('/work/output/commit-fault-used.json', 'utf8')),
        { artifactId: r.original.id, generation: 1, kind });
      const p = observed.boundary;
      observed.privateBeforeClosure = await administration('phase-no-dispatch', { phaseId: p.phaseId });
      for (const member of Object.values(observed.privateBeforeClosure.members)) assert.deepEqual(member, { row: null, events: [] });
      observed.physical = await administration('inspect', {});
      assert.deepEqual(observed.physical.objects.filter(x => x.name.startsWith(r.original.id + '-')), []);
      assert.deepEqual(storage.filter(e => e.artifactId === r.original.id), [], 'No application body capture/read occurs before confirmed durable admission');
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_trial.receipt WHERE reception_id=$1', [r.reception_id])).rows[0].n, 0);
      observed.after = await inspect(p.phaseId, p.evidenceId);
      assert.equal(observed.after.head.active_phase, kind === 'reply-loss' ? p.phaseId : null);
      if (kind === 'reply-loss') {
        let sqlState = null;
        try { await env.admin.query('SELECT intake_control.set_treatment($1,$2,false)', [treatment.id, treatment.revision]); }
        catch (error) { sqlState = error.code; }
        assert.deepEqual({ sqlState, enabled: (await env.admin.query('SELECT enabled FROM intake_control.treatment_current')).rows[0].enabled },
          { sqlState: '55P03', enabled: true });
      }
      observed.runtimeClosed = await application.crash(); assert.equal(observed.runtimeClosed.signal, 'SIGKILL');
      await until(async () => (await env.admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1', [p.backendPid])).rows[0].n,
        n => n === 0, 'OLD_ADMISSION_BACKEND_REMAINS');
      if (kind === 'reply-loss') {
        const phase = observed.after.phase, participants = {};
        for (const participant of Object.keys(phase.participant_plan)) {
          const port = new PrivateIntakePort(participant === 'objects' ? intake.brokerSocket : intake.verifierSocket, 1500000, 1000, intake.namespace);
          participants[participant] = await port.closePhase(phase.id);
          await assert.rejects(() => port.openPhase({ id: phase.id, incarnation: phase.incarnation, namespace: phase.namespace,
            original: r.original, evidenceId: phase.evidence_id, participant, actions: phase.participant_plan[participant] }), /INTAKE_PHASE_OPEN/);
        }
        observed.closedBeforeAnyOpen = await administration('phase-no-dispatch', { phaseId: phase.id });
        const password = randomBytes(24).toString('hex');
        await env.admin.query(`ALTER ROLE inc03_intake_control LOGIN PASSWORD '${password}'`);
        controller = new Client({ connectionString: `postgresql://inc03_intake_control:${password}@127.0.0.1:55432/inc02_synthetic`, statement_timeout: 2000, lock_timeout: 250 });
        await controller.connect();
        const closure = { profile: 'intake-controller-closure/1', phaseId: phase.id, backendPid: phase.backend_pid,
          mode: 'runtime-ended-participants-closed', runtimeProcess: { observed: 'closed', ...observed.runtimeClosed }, participants };
        await controller.query('SELECT intake_control.reconcile_phase($1,$2,$3,$4)', [phase.id, phase.source_id, phase.incarnation, JSON.stringify(closure)]);
        observed.completion = (await env.admin.query('SELECT * FROM intake_control.phase_completion WHERE phase_id=$1', [phase.id])).rows[0];
        assert.equal(observed.completion.kind, 'controller_reconciled');
      }
      assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase, null);
      const next = { ...intake, incarnation: 'intake-commit-recovered-2' };
      await env.admin.query('UPDATE intake_control.live SET incarnation=$1,revision=revision+1 WHERE singleton', [next.incarnation]);
      await application.restart(next);
      const valid = await request(`/api/intake/receptions/${retained.receptionId}/original`, { client });
      assert.deepEqual({ status: valid.status, bytes: valid.bytes }, { status: 200, bytes: retained.bytes });
      const fresh = await reserve(declare(text));
      assert.equal((await request(`/api/intake/receptions/${fresh.reception_id}/attempts/1/original`, { bytes: text, client })).status, 200);
      observed.progress = { retainedRead: valid.status, freshReception: fresh.reception_id };
    } finally {
      setBarrier(async () => {}); await controller?.end();
      writeFileSync('/work/output/fence-commit-' + kind + '.json', JSON.stringify(observed, null, 2), { flag: 'wx' });
    }
  });
}
