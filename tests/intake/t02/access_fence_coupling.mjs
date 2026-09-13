import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { authorizedReadingMigration } from '../../../ci/access_material_schema.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Install the actual intake fence after its actual access/reading prerequisites.
 * The delayed hook preserves the populated migration case in the invitation suite.
 * Existing scenarios/assertions and the original migration order are unchanged.
 */
export function watchInvitationMigration(admin) {
  const suite = process.env.INTAKE_COUPLED_SUITE;
  assert.ok(['runtime', 'invitations', 'reading', 'administration', 'journey'].includes(suite));
  const supplyReading = ['runtime', 'invitations'].includes(suite);
  const invitation = readFileSync(new URL('../../../src/server/access/postgres/002_invitations.sql', import.meta.url), 'utf8');
  const reading = authorizedReadingMigration();
  const migrations = ['001_reception.sql', '002_data.sql', '003_private_fence.sql'].map(name => ({
    name, bytes: readFileSync(new URL('../../../src/server/intake/postgres/' + name, import.meta.url)),
  }));
  const originalQuery = admin.query.bind(admin);
  const id = randomUUID();
  const record = { profile: 'access-intake-fence-coupling/1', id, suite,
    readingPrerequisite: { sha256: hash(reading), installedBy: supplyReading ? 'coupled setup after invitation migration' : 'unchanged suite setup' },
    migrations: migrations.map(({ name, bytes }) => ({ name, sha256: hash(bytes) })), installed: false };
  const save = () => writeFileSync('/work/output/intake-fence-coupling-' + id + '.json', JSON.stringify(record, null, 2));
  admin.query = async (...args) => {
    const result = await originalQuery(...args);
    if (args[0] === (supplyReading ? invitation : reading)) {
      assert.equal(record.installed, false, 'One intake installation per populated access cluster');
      if (supplyReading) {
        await originalQuery(reading);
        // A full installed reading schema requires its launcher-supplied current
        // generation even for identity calls. No material or visible surfaces are
        // seeded. This is captured launch composition, not a control bypass.
        const generation = 'intake-coupled-empty-reading-1', password = randomBytes(24).toString('hex');
        await originalQuery(`ALTER ROLE inc02_reader LOGIN PASSWORD '${password}'`);
        await originalQuery(`INSERT INTO material_trial.control(singleton,generation,revision,active,
          capture_ready,processing_ready,conservation_ready,trace_ready,destination_ready)
          VALUES(true,$1,1,true,true,true,true,true,true)`, [generation]);
        for (const surface of ['people', 'material-list', 'material-exact'])
          await originalQuery('INSERT INTO material_trial.surface VALUES($1,$2,$3,$4,false,false,true,1)',
            [surface, 'not-offered', 'synthetic-disabled-scope', 'synthetic-coupled-regression']);
        check.reading = { connectionString: `postgresql://inc02_reader:${password}@127.0.0.1:55432/inc02_synthetic`,
          expectedPort: 55432, generation, cursorSeconds: 120, cursorLimit: 50, pageSize: 5 };
        record.launchComposition = { generation, materialRows: 0, disabledHiddenSurfaces: ['people', 'material-list', 'material-exact'], treatmentReady: true };
      }
      for (const { name, bytes } of migrations) {
        try { await originalQuery(bytes.toString('utf8')); }
        catch (error) { record.installationFailure = { migration: name, code: error.code ?? null, message: error.message }; save(); throw error; }
      }
      const head = (await originalQuery('SELECT * FROM intake_control.fence_head')).rows;
      assert.deepEqual(head, [{ singleton: true, epoch: '1', active_phase: null }]);
      record.installed = true;
      record.initialHead = head[0];
      save();
      console.log('INTAKE_COUPLED_GUARDS_INSTALLED ' + id);
    }
    return result;
  };
  const check = async () => {
    try {
      assert.equal(record.installed, true, 'The coupled suite must exercise the installed migration');
      const head = (await originalQuery('SELECT * FROM intake_control.fence_head')).rows;
      const triggers = (await originalQuery("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='intake_private_fence' AND tgenabled='O'")).rows[0].n;
      assert.equal(head.length, 1); assert.equal(head[0].active_phase, null);
      assert.ok(BigInt(head[0].epoch) > 1n, 'At least one real governed source mutation must advance the head');
      assert.equal(triggers, 16, 'The suite must not remove or disable the installed guards');
      record.finalHead = head[0]; record.enabledGuards = triggers; record.complete = true;
    } catch (error) { record.error = error.message; throw error; }
    finally { save(); }
  };
  return check;
}

/** Captured test composition only. Never edits the shared environment in place. */
export function coupledEnvironmentCopy(text) {
  const replace = (needle, value) => {
    assert.equal(text.split(needle).length, 2, 'Exact coupled environment anchor: ' + needle);
    text = text.replace(needle, value);
  };
  replace('let admin;', 'let admin; let checkIntakeFence = async () => {};');
  replace('await admin?.end();', 'try { await checkIntakeFence(); } finally { await admin?.end(); }');
  replace('const password = randomBytes(24)',
    "checkIntakeFence = (await import('../intake/t02/access_fence_coupling.mjs')).watchInvitationMigration(admin);\n    const password = randomBytes(24)");
  replace('return {\n      admin,', 'return {\n      get coupledReading() { return checkIntakeFence.reading; },\n      admin,');
  replace('await close();\n    throw e;',
    "try { await close(); } catch (cleanupError) { throw new AggregateError([e, cleanupError], 'COUPLED_SETUP_AND_CLEANUP_FAILED'); }\n    throw e;");
  return text;
}

export function coupledLegacyLaunchCopy(text) {
  const needle = 'terminal = await start({ config, tls: env.tls, mailbox, hooks });';
  assert.equal(text.split(needle).length, 2, 'Exact legacy suite launch composition anchor');
  return text.replace(needle, 'terminal = await start({ config, tls: env.tls, mailbox, hooks, reading: env.coupledReading });');
}

export function coupledDockerCopy(text) {
  const needle = 'COPY tests/access ./tests/access';
  assert.equal(text.split(needle).length, 2, 'Exact coupled Docker copy anchor');
  return text.replace(needle, needle + '\nCOPY tests/intake/t02/access_fence_coupling.mjs ./tests/intake/t02/access_fence_coupling.mjs');
}

export function coupledIgnoreCopy(text) {
  return text + '\n!tests/intake/\n!tests/intake/t02/\n!tests/intake/t02/access_fence_coupling.mjs\n';
}
