import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** Exercise the actual continuation, not only the SQL helper's return code. */
export async function fenceContinuationCase(t, { env, client, request, retained, setBarrier }) {
  for (const changedSource of ['treatment', 'session']) await t.test(`F14 ${changedSource} changes after closure are rejected at the continuation epoch boundary`, async () => {
    const records = [], url = `/api/intake/receptions/${retained.receptionId}/original`;
    let originalSessions = [];
    const positive = await request(url, { client });
    assert.deepEqual({ status: positive.status, bytes: positive.bytes }, { status: 200, bytes: retained.bytes });
    let crossed = false;
    setBarrier(async (label, event) => {
      if (label !== 'phase_retired_before_snapshot' || crossed) return;
      const phase = (await env.admin.query('SELECT * FROM intake_control.private_phase WHERE id=$1', [event.phaseId])).rows[0];
      if (phase?.reception_id !== retained.receptionId) return;
      crossed = true;
      const before = {
        head: (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0],
        completion: (await env.admin.query('SELECT * FROM intake_control.phase_completion WHERE phase_id=$1', [phase.id])).rows[0],
        backend: (await env.admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1', [event.backendPid])).rows[0],
      };
      assert.deepEqual({ active: before.head.active_phase, state: before.backend.state, transaction: before.backend.xact_start,
        completion: before.completion.kind }, { active: null, state: 'idle', transaction: null, completion: 'participants_closed' });
      // Controlled installation-owner source mutation, not an ordinary user's
      // authority. It reaches the same statement guard without an advisory wait.
      const start = Date.now();
      if (changedSource === 'treatment') await env.admin.query('UPDATE intake_control.treatment_current SET enabled=false');
      else {
        originalSessions = (await env.admin.query('SELECT digest,revoked FROM access_trial.session WHERE account_id::text=$1', [phase.principal])).rows;
        assert.ok(originalSessions.some(row => !row.revoked));
        await env.runtime.query('UPDATE access_trial.session SET revoked=true WHERE account_id::text=$1', [phase.principal]);
      }
      const after = (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0];
      assert.ok(BigInt(after.epoch) > BigInt(before.head.epoch)); assert.equal(after.active_phase, null);
      assert.ok(Date.now() - start < 1000);
      records.push({ event, before, after, changedSource,
        writer: changedSource === 'treatment' ? 'controlled installation owner; direct guarded statement' : 'existing access runtime; direct guarded session mutation',
        writerCompletedAtMs: Date.now() });
    });
    try {
      const denied = await request(url, { client });
      assert.equal(crossed, true, 'The source write must occur after actual worker closure and before the continuation snapshot');
      assert.deepEqual({ status: denied.status, originalIncluded: denied.bytes.includes(retained.bytes) },
        { status: 503, originalIncluded: false });
      records.push({ denied: { status: denied.status, bytes: denied.bytes.length } });
    } finally {
      setBarrier(async () => {});
      if (changedSource === 'treatment') await env.admin.query('UPDATE intake_control.treatment_current SET enabled=true');
      else for (const row of originalSessions) await env.admin.query('UPDATE access_trial.session SET revoked=$2 WHERE digest=$1', [row.digest, row.revoked]);
      writeFileSync('/work/output/fence-continuation-' + changedSource + '.json', JSON.stringify(records, null, 2), { flag: 'wx' });
    }
    const restored = await request(url, { client });
    assert.deepEqual({ status: restored.status, bytes: restored.bytes }, { status: 200, bytes: retained.bytes });
  });
}
