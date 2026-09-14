import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/** Database association/order probes. No simulated ACK is physical-work evidence. */
export async function fenceBoundaryCases(t, { env, intake, open, head, observe, expectCode }) {
  await t.test('F11 registration rejects the wrong current source, evidence, namespace and method plan', async () => {
    const cases = [
      ['source', args => { args[3] = 'unrelated-control'; }, '55000'],
      ['incarnation', args => { args[4] = 'old-executor'; }, '55000'],
      ['namespace', args => { args[1] = 'intake_restore'; }, '55000'],
      ['evidence', args => { args[2] = randomUUID(); }, '42501'],
      ['method', args => { args[5] = '{"objects":["append"]}'; }, '42501'],
      ['participant', args => { args[5] = '{"objects":["read"],"outsider":["read"]}'; }, '22023'],
      ['extra verifier', args => { args[5] = '{"objects":["read"],"verifier":["verify"]}'; }, '42501'],
      ['expired deadline', args => { args[6] = 1; }, '55000'],
    ];
    const results = [];
    for (const [name, change, code] of cases) {
      const p = await open();
      try {
        const args = [...p.args]; change(args);
        const observed = await expectCode(() => p.admission.db.query('SELECT intake_control.begin_phase($1,$2,$3,$4,$5,$6,$7)', args), code);
        await p.admission.db.query('ROLLBACK');
        const counts = (await env.admin.query(`SELECT (SELECT count(*)::int FROM intake_control.private_phase WHERE id=$1) AS phases,
          (SELECT count(*)::int FROM intake_trial.evidence WHERE id=$2) AS evidence`, [p.phase, p.evidence.id])).rows[0];
        assert.deepEqual(counts, { phases: 0, evidence: 0 }); assert.equal((await head()).active_phase, null);
        results.push({ name, code: observed, counts });
      } finally { await p.admission.db.close(); }
    }
    const positive = await open();
    try { await positive.begin(); await positive.admission.db.commit(); await positive.finish(); }
    finally { await positive.admission.db.close(); }
    await observe('registration-binding-negatives', { results, positivePhase: positive.phase });
  });

  await t.test('F11 retirement requires the exact owner association and complete participant ACK set', async () => {
    const p = await open(), results = [];
    try {
      await p.begin(); await p.admission.db.commit();
      const ack = { objects: { profile: 'intake-phase-closed/1', id: p.phase, participant: 'objects' } };
      const exact = [p.phase, intake.controlSource, intake.incarnation, p.evidence.id, JSON.stringify(ack)];
      for (const [name, change] of [
        ['source', args => { args[1] = 'unrelated-control'; }],
        ['incarnation', args => { args[2] = 'wrong-executor'; }],
        ['evidence', args => { args[3] = randomUUID(); }],
        ['missing participant', args => { args[4] = '{}'; }],
        ['wrong ACK identity', args => { args[4] = JSON.stringify({ objects: { ...ack.objects, id: randomUUID() } }); }],
        ['extra participant', args => { args[4] = JSON.stringify({ ...ack, verifier: { ...ack.objects, participant: 'verifier' } }); }],
      ]) {
        const args = [...exact]; change(args);
        const code = await expectCode(() => p.admission.db.query('SELECT intake_control.finish_phase($1,$2,$3,$4,$5)', args), '42501');
        assert.equal((await head()).active_phase, p.phase);
        assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_control.phase_completion WHERE phase_id=$1', [p.phase])).rows[0].n, 0);
        results.push({ name, code });
      }
      const other = new Client({ connectionString: intake.connectionString }); await other.connect();
      try {
        const code = await expectCode(() => other.query('SELECT intake_control.finish_phase($1,$2,$3,$4,$5)', exact), '42501');
        results.push({ name: 'same role, different actual SQL backend', code });
      } finally { await other.end(); }
      await p.finish(); const finished = await head(); await p.finish(); assert.deepEqual(await head(), finished);
      await observe('retirement-binding-negatives', { phase: p.phase, results, finished, repeat: 'same owner resolves the existing terminal effect' });
    } finally { await p.admission.db.close(); }
  });

  await t.test('F13 an absent current head refuses registration rather than creating an empty replacement', async () => {
    const original = await head(); assert.equal(original.active_phase, null);
    const p = await open();
    try {
      await env.admin.query('DELETE FROM intake_control.fence_head');
      // The original RR snapshot existed before the deletion: abort it completely
      // and establish a current one to distinguish absence from stale-row conflict.
      await p.admission.db.query('ROLLBACK'); await p.admission.db.begin([]);
      const code = await expectCode(() => p.begin(), '55000'); await p.admission.db.query('ROLLBACK');
      assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM intake_control.fence_head')).rows[0].n, 0);
      await observe('missing-current-head', { code, headRows: 0, replacementCreated: false });
    } finally {
      await p.admission.db.close();
      // Controlled synthetic fault reversal, not a production repair procedure.
      await env.admin.query('INSERT INTO intake_control.fence_head VALUES($1,$2,$3)', [original.singleton, original.epoch, original.active_phase]);
    }
    const positive = await open();
    try { await positive.begin(); await positive.admission.db.commit(); await positive.finish(); }
    finally { await positive.admission.db.close(); }
  });

  await t.test('F14 two real shared admission holders refuse head contention without an upgrade deadlock', async () => {
    const one = new Client(env.runtime.connectionParameters), two = new Client(env.runtime.connectionParameters);
    await one.connect(); await two.connect();
    try {
      for (const db of [one, two]) {
        await db.query("SET statement_timeout='1500ms'");
        await db.query('SELECT pg_advisory_lock_shared(20202,1)'); await db.query('BEGIN');
      }
      const sql = 'UPDATE access_trial.session SET expires_at=expires_at WHERE false';
      await one.query(sql); const start = Date.now();
      const code = await expectCode(() => two.query(sql), '55P03'); assert.ok(Date.now() - start < 1000);
      await two.query('ROLLBACK'); await one.query('COMMIT');
      await two.query('BEGIN'); await two.query(sql); await two.query('COMMIT');
      await observe('two-shared-entrants', { code, milliseconds: Date.now() - start, positive: 'same second source statement commits after first releases the head',
        scope: 'Statement-level head contention under two real shared 20202 locks; not two overlapping private object calls.' });
    } finally { await one.end(); await two.end(); }
  });
}
