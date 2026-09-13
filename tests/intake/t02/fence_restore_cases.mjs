import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { IntakeAuthority } from '../../../src/server/intake/authority.ts';
import { selected } from '../../../src/server/intake/reception.ts';
import { sessionToken } from '../../../src/server/access/transport.ts';
import { administration, dataSnapshot, tables } from './recovery_cases.mjs';

export async function fenceRestoreCase(t, { env, intake, client, request, retained, setBarrier, freshSession, digestSession, application }) {
  await t.test('F13 a real archive restores data without removing a pending current private barrier or admitting its target', async () => {
    const observed = {}, controller = new IntakeAuthority(intake, digestSession);
    let admission, crossed = false;
    const reader = await freshSession(); // Same account, independently authenticated session and lock owner.
    await env.admin.query('SELECT pg_advisory_lock(20202,1)');
    let cut, anchor;
    try {
      await env.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      cut = await dataSnapshot(env.admin, 'intake_trial');
      writeFileSync('/work/output/backup-data.json', JSON.stringify(cut));
      const backup = await administration('backup', { objects: cut.artifact.map(({ id, generation, bytes, sha256 }) => ({ id, generation, bytes, sha256 })) });
      assert.equal(backup.ok, true);
      assert.ok(!backup.members.some(member => /access_trial|intake_control/.test(member.name)));
      const id = randomUUID();
      await env.admin.query('INSERT INTO intake_control.backup_anchor VALUES($1,$2,$3,$4,$5)',
        [id, intake.controlSource, backup.manifestSha256, JSON.stringify(backup.members), Date.now()]);
      await env.admin.query('COMMIT');
      anchor = (await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1', [id])).rows[0];
      observed.backup = { backup, anchor, tables: Object.keys(cut) };
    } catch (error) { await env.admin.query('ROLLBACK'); throw error; }
    finally { await env.admin.query('SELECT pg_advisory_unlock(20202,1)'); }
    const restoreRows = async () => {
      for (const table of tables) await env.admin.query(`INSERT INTO intake_restore.${table} SELECT * FROM jsonb_populate_recordset(NULL::intake_restore.${table},$1::jsonb)`, [JSON.stringify(cut[table])]);
      assert.deepEqual(await dataSnapshot(env.admin, 'intake_restore'), cut);
    };
    try {
      admission = await controller.open({ route: 'original', parameters: { id: retained.receptionId }, method: 'GET', contentLength: 0,
        clientKey: null, csrf: null }, sessionToken(client.cookie), ['intake:restore'], () => {}, 'inc03_intake_reader');
      await controller.beforeMetadata(admission, 'original');
      for (const receipt of cut.receipt) {
        const { reception } = await selected(admission.db, receipt.reception_id, admission.session.account_id);
        await controller.resolve(admission, 'original', undefined, reception);
      }
      await admission.db.commit();
      setBarrier(async (label, event) => {
        if (label !== 'before_original_read' || event.receptionId !== retained.receptionId || crossed) return;
        crossed = true;
        const phase = (await env.admin.query('SELECT * FROM intake_control.private_phase WHERE evidence_id=$1', [event.evidenceId])).rows[0];
        assert.ok(phase);
        observed.pendingBefore = { phase, head: (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0] };
        assert.equal(observed.pendingBefore.head.active_phase, phase.id);
        assert.deepEqual((await env.admin.query('SELECT * FROM intake_control.backup_anchor WHERE id=$1', [anchor.id])).rows[0], anchor);
        const imported = await administration('restore', { variant: 'intact', anchorSha256: anchor.manifest_sha256 });
        assert.equal(imported.ok, true); observed.imported = imported;
        const bytes = readFileSync('/work/output/restore-data.json'), member = anchor.members.find(row => row.name === 'intake-data.json');
        assert.deepEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
          { bytes: member.bytes, sha256: member.sha256 });
        assert.deepEqual(JSON.parse(bytes), cut);
        await env.admin.query(readFileSync(new URL('../../../src/server/intake/postgres/002_data.sql', import.meta.url), 'utf8').replaceAll('intake_trial', 'intake_restore'));
        await env.admin.query('BEGIN'); let refusal = null;
        try {
          await restoreRows();
          assert.ok(await admission.db.now() < admission.deadline);
          await env.admin.query('SELECT intake_control.activate_namespace($1,$2,$3)', ['intake_restore', anchor.id, anchor.manifest_sha256]);
        } catch (error) { refusal = error.code; }
        finally { await env.admin.query('ROLLBACK'); }
        assert.equal(refusal, '55P03', 'The target must be refused by the actual current barrier, not an unrelated restore error');
        observed.pendingAfter = {
          phase: (await env.admin.query('SELECT * FROM intake_control.private_phase WHERE id=$1', [phase.id])).rows[0],
          head: (await env.admin.query('SELECT * FROM intake_control.fence_head')).rows[0],
        };
        assert.deepEqual(observed.pendingAfter, observed.pendingBefore);
        assert.equal((await env.admin.query("SELECT count(*)::int AS n FROM intake_control.namespace_admission WHERE namespace='intake_restore'")).rows[0].n, 0);
        observed.refusal = refusal;
      });
      const result = await request(`/api/intake/receptions/${retained.receptionId}/original`, { client: reader });
      assert.equal(crossed, true);
      assert.deepEqual({ status: result.status, bytes: result.bytes }, { status: 200, bytes: retained.bytes });
      setBarrier(async () => {});
      assert.equal((await env.admin.query('SELECT active_phase FROM intake_control.fence_head')).rows[0].active_phase, null);
      observed.completedPhase = (await env.admin.query('SELECT * FROM intake_control.phase_completion WHERE phase_id=$1', [observed.pendingBefore.phase.id])).rows[0];
      assert.equal(observed.completedPhase.kind, 'participants_closed');
      await env.admin.query('BEGIN');
      try {
        await restoreRows(); assert.ok(await admission.db.now() < admission.deadline);
        await env.admin.query('SELECT intake_control.activate_namespace($1,$2,$3)', ['intake_restore', anchor.id, anchor.manifest_sha256]);
        await env.admin.query('COMMIT');
      } catch (error) { await env.admin.query('ROLLBACK'); throw error; }
      await admission.db.close(); admission = null;
      await application.restart({ ...intake, namespace: 'intake_restore' });
      const served = await request(`/api/intake/receptions/${retained.receptionId}/original`, { client });
      assert.deepEqual({ status: served.status, bytes: served.bytes }, { status: 200, bytes: retained.bytes });
      observed.progress = { restoredOriginalStatus: served.status, bytes: served.bytes.length,
        receipts: (await env.admin.query('SELECT id FROM intake_restore.receipt ORDER BY id')).rows };
      assert.deepEqual(observed.progress.receipts.map(row => row.id), cut.receipt.map(row => row.id).sort());
    } finally {
      setBarrier(async () => {}); await admission?.db.close();
      writeFileSync('/work/output/fence-restore.json', JSON.stringify(observed, null, 2), { flag: 'wx' });
    }
  });
}
