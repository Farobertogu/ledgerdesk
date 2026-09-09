import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createPgTrial } from './pg_trial.mjs';
import { trialContext, trialEnv, treatment, original, policy, seedTrial } from './T04_seed.mjs';
import { startReadingTerminal } from '../../src/server/reading/terminal.ts';
import { PgReadingStore } from '../../src/server/reading/postgres/store.ts';
import { PROBLEMS } from '../../src/contracts/material_reading.ts';
import { compareTiming, TIMING_PROTOCOL } from './timing_comparison.mjs';
import { createObserverGates, cleanupSteps } from './lifecycle.mjs';

const detail = (id) => `/api/v1/material/${id}/versions/v1`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('T04 exclusive PostgreSQL 16 and actual HTTP terminal', { timeout: 180000 }, async (t) => {
  const trial = await createPgTrial();
  const gates = createObserverGates();
  const deferred = gates.deferred;
  let terminal; let admin = trial.admin;
  let writer;
  // Register immediately after cluster creation, before a writer connection or seed can fail.
  t.after(async () => {
    gates.releaseAll();
    await cleanupSteps([
      { label: 'terminal close', close: () => terminal?.close() },
      { label: 'writer close', close: () => writer?.end(), timeoutMs: 5000 },
      { label: 'owned cluster removal', close: () => trial.close(), timeoutMs: 90000 },
    ]);
  });
  t.afterEach(() => gates.releaseAll());
  writer = new Client(trial.writerConfig); await writer.connect();
  await seedTrial(admin);
  const createStore = (onLoss) => new PgReadingStore(trial.store, onLoss);
  const update = (id, hierarchy) => writer.query('SELECT reading_trial.replace_policy($1,$2,$3)', [JSON.stringify(id), JSON.stringify('v1'), JSON.stringify(hierarchy)]);
  const control = (generation = trialContext.generation, active = true, flags = treatment) =>
    writer.query('SELECT reading_trial.set_control($1,$2,$3)', [generation, active, JSON.stringify(flags)]);
  async function start(observer, env = trialEnv) {
    await terminal?.close(); terminal = await startReadingTerminal({ env, createStore, observer }); return terminal;
  }
  async function get(path, init) {
    const result = await fetch(`${terminal.url}${path}`, init);
    const text = await result.text(); await terminal.idle();
    return { status: result.status, headers: [...result.headers], text, body: text ? JSON.parse(text) : null };
  }

  await t.test('real PG16 identity, dedicated runtime and fresh synthetic records', async () => {
    assert.ok(trial.identity.version >= 160000 && trial.identity.version < 170000);
    assert.match(trial.identity.system_id, /^\d+$/);
    await start();
    const result = await get('/api/v1/material');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items.map((x) => x.reference.unit_id), ['content', 'excerpt', 'reference']);
    assert.equal(result.body.existence_signal, true);
    assert.equal(result.text.includes(original), false);
    const full = await get(detail('content')); assert.equal(full.body.projection.original_text, original);
    const excerpt = await get(detail('excerpt')); assert.equal(excerpt.body.projection.kind, 'EXCERPT');
    assert.deepEqual(excerpt.body.projection.fragments.map((x) => x.text), ['Regla.', 'Excepto los domingos.']);
    const reference = await get(detail('reference')); assert.equal(reference.body.projection.kind, 'REFERENCE');
    assert.equal('original_text' in reference.body.projection, false);
  });

  await t.test('second terminal cannot acquire the same deployment while its owner is alive', async () => {
    await assert.rejects(startReadingTerminal({ env: trialEnv, createStore }), /unavailable/);
    assert.equal((await get(detail('content'))).status, 200);
  });

  await t.test('headers and bodies share refusal behavior, not just the status code', async () => {
    const expected = await get(detail('absent'));
    assert.deepEqual(expected.body, PROBLEMS[404]);
    for (const id of ['hidden', 'unknown', 'existence', 'unknown%00pair']) {
      const actual = await get(detail(id));
      assert.deepEqual(actual, expected);
    }
    assert.ok(expected.headers.some(([key, value]) => key === 'cache-control' && value === 'private, no-store'));
    assert.equal(expected.headers.some(([key]) => key === 'etag' || key === 'date'), false);
  });

  await t.test('declared repeated timing experiment includes four neutral refusal classes', async () => {
    const ids = ['absent', 'hidden', 'unknown', 'existence'];
    const groups = Object.fromEntries(ids.map((id) => [id, []]));
    for (let round = -TIMING_PROTOCOL.warmupRounds; round < TIMING_PROTOCOL.rounds; round++) {
      for (let position = 0; position < ids.length; position++) {
        const id = ids[((round % ids.length) + ids.length + position) % ids.length];
        const start = performance.now(); const result = await fetch(`${terminal.url}${detail(id)}`);
        const text = await result.text(); const elapsed = performance.now() - start;
        assert.equal(result.status, 404); assert.equal(text, JSON.stringify(PROBLEMS[404]));
        await terminal.idle(); if (round >= 0) groups[id].push(elapsed);
      }
    }
    const result = compareTiming(groups);
    t.diagnostic(JSON.stringify({ experiment: 'neutral-refusal-timing', ...result, universalNoninterference: false }));
    assert.equal(result.signalDetected, false, 'The declared experiment detected a timing signal; investigate, do not retune the rule.');
    const shifted = compareTiming({ a: Array.from({ length: 128 }, (_, i) => i % 3), b: Array.from({ length: 128 }, (_, i) => 20 + i % 3) });
    assert.equal(shifted.signalDetected, true, 'Timing detector failed its intentionally shifted control.');
  });

  await t.test('syntactic rejection and forged historical credentials do not supply context', async () => {
    assert.equal((await get('/api/v1/material?subject=synthetic-reader')).status, 400);
    await start(undefined, { LEDGERDESK_READING_TRIAL: '0' });
    const rejected = await get(detail('content'), { headers: { cookie: 'ld_dev_user=admin', 'x-role': 'admin', 'x-subject': 'synthetic-reader' } });
    assert.deepEqual(rejected.body, PROBLEMS[403]);
    await start();
  });

  await t.test('opaque keys, original and metadata retain escaped controls without replacement', async () => {
    const id = 'opaque\u0000pair', title = 'Title\u0000\ud800';
    await admin.query(`INSERT INTO reading_trial.material
      (deployment_id,scope_id,unit_key,version_key,original_value,original_language,metadata,fragments,requirements)
      VALUES ('inc01-synthetic','inc01-material',$1,'"v1"',$2,'en',$3,'[]',$4)`,
      [JSON.stringify(id), JSON.stringify(original), JSON.stringify({ title, editorial_state: 'PUBLISHED' }),
        JSON.stringify({ REFERENCE: { metadata: ['title'] }, CONTENT: { metadata: ['title'] } })]);
    await admin.query(`INSERT INTO reading_trial.policy VALUES ('inc01-synthetic','inc01-material',$1,'"v1"',$2)`,
      [JSON.stringify(id), JSON.stringify(policy('CONTENT'))]);
    const actual = await get(detail(encodeURIComponent(id)));
    assert.equal(actual.status, 200);
    assert.equal(actual.body.projection.reference.unit_id, id);
    assert.equal(actual.body.projection.original_text, original);
    assert.equal(actual.body.projection.metadata.title, title);
    assert.ok((await get('/api/v1/material')).body.items.some((item) => item.reference.unit_id === id));
    await update(id, policy('NONE'));
    assert.deepEqual((await get(detail(encodeURIComponent(id)))).body, PROBLEMS[404]);
  });

  await t.test('each of the five treatment gates and generation is checked independently', async () => {
    for (const key of Object.keys(treatment)) {
      await control(trialContext.generation, true, { ...treatment, [key]: false });
      assert.deepEqual((await get(detail('content'))).body, PROBLEMS[503]);
      assert.deepEqual((await get(detail('absent'))).body, PROBLEMS[503]);
    }
    await control('stale-generation'); assert.equal((await get(detail('content'))).status, 503);
    await control(trialContext.generation, false); assert.equal((await get(detail('content'))).status, 503);
    await control();
  });

  await t.test('another subject in the same scope receives no inherited claims or cached material', async () => {
    await start(undefined, { ...trialEnv, LEDGERDESK_READING_SUBJECT: 'synthetic-other-reader' });
    const listing = await get('/api/v1/material');
    assert.deepEqual(listing.body.items, []); assert.equal(listing.body.existence_signal, false);
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[404]);
    await start(); assert.equal((await get(detail('content'))).body.projection.original_text, original);
    await assert.rejects(startReadingTerminal({ env: { ...trialEnv, LEDGERDESK_READING_SUBJECT: '' }, createStore }));
    assert.equal((await get(detail('content'))).status, 200);
  });

  await t.test('a persisted historical pair returns its own original, never the current version', async () => {
    const prior = 'Earlier original\r\n  Not the current text.';
    await admin.query(`INSERT INTO reading_trial.material
      (deployment_id,scope_id,unit_key,version_key,original_value,original_language,metadata,fragments,requirements)
      VALUES ('inc01-synthetic','inc01-material','"content"','"v0"',$1,'en',$2,'[]',$3)`,
      [JSON.stringify(prior), JSON.stringify({ title: 'Prior content', editorial_state: 'SUPERSEDED',
        reading_conditions: ['Historical inspection only; do not apply as current policy.'] }),
      JSON.stringify({ REFERENCE: { metadata: ['title', 'editorial_state', 'reading_conditions'] },
        CONTENT: { metadata: ['title', 'editorial_state', 'reading_conditions'] } })]);
    await admin.query(`INSERT INTO reading_trial.policy VALUES ('inc01-synthetic','inc01-material','"content"','"v0"',$1)`, [JSON.stringify(policy('CONTENT'))]);
    const result = await get('/api/v1/material/content/versions/v0');
    assert.equal(result.body.projection.original_text, prior);
    assert.equal(result.body.projection.metadata.editorial_state, 'SUPERSEDED');
    assert.equal((await get(detail('content'))).body.projection.original_text, original);
    for (const path of ['/api/v1/material/reference/versions/v0', '/api/v1/material/content/versions/missing']) {
      assert.deepEqual((await get(path)).body, PROBLEMS[404]);
    }
  });

  await t.test('known durable receipt precedes material bytes, SQL is idle at handoff', async () => {
    const reached = deferred(), resume = deferred(); let receipt;
    await start(async (event, prepared) => { if (event === 'committed') { receipt = prepared.receiptId; reached.resolve(); await resume.promise; } });
    const pending = fetch(`${terminal.url}${detail('content')}`); await reached.promise;
    const evidence = await admin.query('SELECT * FROM reading_trial.access_evidence WHERE receipt_id = $1', [receipt]);
    assert.equal(evidence.rows.length, 1); assert.equal(evidence.rows[0].result_status, 200);
    const activity = await admin.query("SELECT state, xact_start FROM pg_stat_activity WHERE application_name = 'inc01-reading-terminal'");
    assert.equal(activity.rows[0].state, 'idle'); assert.equal(activity.rows[0].xact_start, null);
    assert.equal((await admin.query('SELECT count(*)::int n FROM reading_trial.transport_observation WHERE receipt_id = $1', [receipt])).rows[0].n, 0);
    resume.resolve(); assert.equal((await (await pending).json()).projection.original_text, original);
    await terminal.idle();
    const observations = await admin.query('SELECT outcome, observed_bytes FROM reading_trial.transport_observation WHERE receipt_id = $1', [receipt]);
    assert.deepEqual(observations.rows, [{ outcome: 'finished', observed_bytes: null }]);
  });

  await t.test('revocation committed before admission refuses the next read', async () => {
    await start(); await update('content', policy('NONE'));
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[404]);
    await update('content', policy('CONTENT'));
  });

  await t.test('remote writer between commit and handoff cannot overtake the admitted transfer', async () => {
    const reached = deferred(), resume = deferred(); const order = [];
    await start(async (event) => {
      if (event === 'committed') { reached.resolve(); await resume.promise; }
      if (event === 'finished') order.push('finished');
    });
    const pending = fetch(`${terminal.url}${detail('content')}`); await reached.promise;
    const revoked = update('content', policy('NONE')).then(() => order.push('revoked'));
    // Observe an actual PostgreSQL lock wait rather than assuming scheduling from a sleep.
    let waiting = false;
    for (let i = 0; i < 30 && !waiting; i++) {
      const result = await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='inc01_writer' AND wait_event_type='Lock'");
      waiting = result.rows[0].n > 0; if (!waiting) await delay(10);
    }
    assert.equal(waiting, true); assert.deepEqual(order, []);
    resume.resolve(); assert.equal((await (await pending).json()).projection.original_text, original);
    await terminal.idle(); await revoked;
    assert.deepEqual(order, ['finished', 'revoked']);
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[404]);
    await update('content', policy('CONTENT'));
  });

  await t.test('every operational control invalidator uses that same admission', async () => {
    const changes = [
      ['generation', () => control('generation-revoked')], ['active', () => control(trialContext.generation, false)],
      ...Object.keys(treatment).map((key) => [key, () => control(trialContext.generation, true, { ...treatment, [key]: false })]),
    ];
    for (const [name, change] of changes) {
      const reached = deferred(), resume = deferred(); let completed = false;
      await start(async (event) => { if (event === 'committed') { reached.resolve(); await resume.promise; } });
      const pending = fetch(`${terminal.url}${detail('content')}`); await reached.promise;
      const invalidating = change().then(() => { completed = true; });
      let waiting = false;
      for (let i = 0; i < 30 && !waiting; i++) {
        waiting = (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='inc01_writer' AND wait_event_type='Lock'")).rows[0].n > 0;
        if (!waiting) await delay(10);
      }
      assert.equal(waiting, true, name); assert.equal(completed, false, name);
      resume.resolve(); assert.equal((await (await pending).json()).projection.original_text, original);
      await terminal.idle(); await invalidating;
      assert.equal((await get(detail('content'))).status, 503, name);
      await control();
    }
  });

  await t.test('INSERT evidence failure releases no material and does not masquerade as empty', async () => {
    await start();
    await admin.query('REVOKE INSERT ON reading_trial.access_evidence FROM inc01_reader');
    const before = (await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n;
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[503]);
    assert.deepEqual((await get(detail('absent'))).body, PROBLEMS[503]);
    assert.equal((await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n, before);
    await admin.query('GRANT INSERT ON reading_trial.access_evidence TO inc01_reader');
  });

  await t.test('an abort after evidence commit records interruption without inventing receipt', async () => {
    const reached = deferred(), resume = deferred(); let receipt;
    await start(async (event, prepared) => { if (event === 'committed') { receipt = prepared.receiptId; reached.resolve(); await resume.promise; } });
    const controller = new AbortController();
    const pending = fetch(`${terminal.url}${detail('content')}`, { signal: controller.signal }).catch(() => null);
    await reached.promise; controller.abort(); await pending; await delay(20); resume.resolve(); await terminal.idle();
    const observation = (await admin.query('SELECT * FROM reading_trial.transport_observation WHERE receipt_id=$1', [receipt])).rows;
    assert.equal(observation.length, 1); assert.equal(observation[0].outcome, 'interrupted');
    assert.equal(observation[0].observed_bytes, null);
    assert.equal(observation[0].response_status, null, 'No status was transferred before this abort.');
    await start();
  });

  await t.test('failure to store the observed outcome stops subsequent delivery', async () => {
    await start();
    const before = (await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n;
    await admin.query('REVOKE INSERT ON reading_trial.transport_observation FROM inc01_reader');
    assert.equal((await get(detail('content'))).body.projection.original_text, original);
    assert.equal((await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n, before + 1);
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[503]);
    await admin.query('GRANT INSERT ON reading_trial.transport_observation TO inc01_reader');
    await start();
  });

  await t.test('an incomplete selected excerpt downgrades, malformed hidden policy stays local', async () => {
    const restricted = policy('EXCERPT'); restricted.unit.forEach((row) => { row.grant.fragmentIds = ['rule']; });
    await update('excerpt', restricted);
    assert.equal((await get(detail('excerpt'))).body.projection.kind, 'REFERENCE');
    const before = (await get('/api/v1/material')).body;
    await update('hidden', { unit: [{ binding: null }], inherited: [], general: [] });
    assert.deepEqual((await get('/api/v1/material')).body, before);
    assert.deepEqual((await get(detail('hidden'))).body, PROBLEMS[404]);
    await update('hidden', policy('NONE')); await update('excerpt', policy('EXCERPT'));
  });

  await t.test('deferred evidence constraint fails COMMIT before transport', async () => {
    await admin.query(`CREATE FUNCTION public.fail_trial_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected evidence commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON reading_trial.access_evidence
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fail_trial_commit()`);
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[503]);
    await admin.query('DROP TRIGGER fail_commit ON reading_trial.access_evidence; DROP FUNCTION public.fail_trial_commit()');
    assert.equal((await get(detail('content'))).status, 200);
  });

  await t.test('writer-free expiration is an observed limit, not a pre-passed guarantee', async () => {
    let observedDeadline;
    await update('content', policy('CONTENT', Date.now() + 250));
    await start(async (event, prepared) => {
      if (event === 'after-clock' && prepared?.earliestExpiry) {
        observedDeadline = prepared.earliestExpiry;
        // Pause the entire JS emitter after its time check, not just a cooperative async timer.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, observedDeadline - Date.now() + 30));
      }
    });
    const result = await get(detail('content'));
    assert.ok(observedDeadline && Date.now() >= observedDeadline);
    t.diagnostic(JSON.stringify({ experiment: 'writer-free-expiry', status: result.status,
      materialReceivedAfterDeadline: result.body.projection?.original_text === original,
      fullTemporalConformity: false }));
    // This test validates observation and the neutral/current subsequent read, not a safe first handoff.
    assert.ok([200, 503].includes(result.status));
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[404]);
    await update('content', policy('CONTENT'));
  });

  await t.test('expiration observed before the final check reprojects locally to the neutral refusal', async () => {
    await update('content', policy('CONTENT', Date.now() + 150));
    await start(async (event, prepared) => {
      if (event === 'before-clock' && prepared?.earliestExpiry) await delay(Math.max(1, prepared.earliestExpiry - Date.now() + 20));
    });
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[404]);
    await update('content', policy('CONTENT'));
  });

  await t.test('loss of the SQL session after commit contains the observed live response', async () => {
    const reached = deferred(), resume = deferred();
    const events = [];
    await start(async (event) => {
      events.push(event);
      if (event === 'committed') { reached.resolve(); await resume.promise; }
    });
    const pending = fetch(`${terminal.url}${detail('content')}`).then(async (result) => result.text()).catch(() => null);
    await reached.promise;
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='inc01-reading-terminal'");
    await delay(30); resume.resolve();
    const received = await pending; await terminal.idle();
    assert.ok(received === null || received === JSON.stringify(PROBLEMS[503]));
    // The socket reset alone also passes without available(). Check this guard's own boundary,
    // not an invented requirement that a destroyed socket must receive an HTTP 503.
    assert.equal(events.includes('after-clock'), true);
    assert.equal(events.includes('released'), true);
    for (const event of ['handoff', 'finished', 'interrupted']) {
      assert.equal(events.includes(event), false, `Control loss reached ${event}`);
    }
    await start(); assert.equal((await get(detail('content'))).status, 200);
  });

  await t.test('failed re-preparation does not duplicate the abandoned receipt observation', async () => {
    await update('content', policy('CONTENT', Date.now() + 150)); let receipt;
    await start(async (event, prepared) => {
      if (event === 'before-clock' && prepared?.earliestExpiry) {
        receipt = prepared.receiptId;
        await delay(Math.max(1, prepared.earliestExpiry - Date.now() + 20));
        await admin.query('REVOKE INSERT ON reading_trial.access_evidence FROM inc01_reader');
      }
    });
    assert.deepEqual((await get(detail('content'))).body, PROBLEMS[503]);
    const observations = (await admin.query('SELECT * FROM reading_trial.transport_observation WHERE receipt_id=$1', [receipt])).rows;
    assert.equal(observations.length, 1); assert.equal(observations[0].outcome, 'interrupted');
    assert.equal(observations[0].observed_bytes, '0'); assert.equal(observations[0].response_status, null);
    await admin.query('GRANT INSERT ON reading_trial.access_evidence TO inc01_reader');
    await update('content', policy('CONTENT')); await start();
  });

  await t.test('privileges prevent direct writes, role escalation and access in both directions', async () => {
    await start();
    await admin.query(`CREATE ROLE inc01_legacy LOGIN PASSWORD 'synthetic-legacy-only';
      CREATE ROLE app_rw NOLOGIN; GRANT app_rw TO inc01_legacy;
      GRANT CONNECT ON DATABASE inc01_synthetic TO inc01_legacy;
      CREATE SCHEMA legacy_trial; CREATE TABLE legacy_trial.tickets (id integer);
      GRANT USAGE ON SCHEMA legacy_trial TO inc01_legacy, app_rw;
      GRANT SELECT ON legacy_trial.tickets TO inc01_legacy, app_rw`);
    const reader = new Client({ connectionString: trial.store.connectionString }); await reader.connect();
    const legacyUrl = new URL(trial.store.connectionString); legacyUrl.username = 'inc01_legacy'; legacyUrl.password = 'synthetic-legacy-only';
    const legacy = new Client({ connectionString: legacyUrl.toString() }); await legacy.connect();
    try {
      for (const sql of ['SELECT * FROM legacy_trial.tickets', 'SET ROLE app_rw', 'SET ROLE inc01_schema_owner',
        'UPDATE reading_trial.material SET original_value = original_value', 'DELETE FROM reading_trial.access_evidence',
        "SELECT reading_trial.set_control('new',true,'{}')", 'CREATE TABLE public.bypass (id integer)']) {
        await assert.rejects(reader.query(sql), (error) => error.code === '42501');
      }
      for (const sql of ['SELECT * FROM reading_trial.material', 'SELECT count(*) FROM reading_trial.material',
        'UPDATE reading_trial.policy SET hierarchy = hierarchy', 'SET ROLE inc01_reader',
        "SELECT reading_trial.replace_policy('content','v1','{}')"]) {
        await assert.rejects(legacy.query(sql), (error) => error.code === '42501');
      }
      await assert.rejects(writer.query('UPDATE reading_trial.policy SET hierarchy=hierarchy'), (error) => error.code === '42501');
      // Exercise the actual retained session boundary, not a hand-written approximation of it.
      // Its pool is isolated to this test process and uses only this freshly created cluster.
      const previousDsn = process.env.DATABASE_URL;
      const { withAppSession } = await import('../../src/server/db.ts');
      try {
        process.env.DATABASE_URL = legacyUrl.toString();
        await assert.rejects(withAppSession(null, (client) => client.query('SELECT * FROM reading_trial.material')), (error) => error.code === '42501');
        await globalThis.ledgerdeskPool.end(); delete globalThis.ledgerdeskPool;
        process.env.DATABASE_URL = trial.store.connectionString;
        let entered = false;
        await assert.rejects(withAppSession(null, async () => { entered = true; }), (error) => error.code === '42501');
        assert.equal(entered, false, 'The new reader credential acquired the legacy application role.');
      } finally {
        if (globalThis.ledgerdeskPool) { await globalThis.ledgerdeskPool.end(); delete globalThis.ledgerdeskPool; }
        if (previousDsn === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDsn;
      }
      const functions = await admin.query(`SELECT p.proname, p.proconfig,
        has_function_privilege('inc01_legacy',p.oid,'EXECUTE') AS legacy_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='reading_trial' AND p.prosecdef`);
      assert.equal(functions.rows.length, 2);
      assert.ok(functions.rows.every((row) => row.legacy_execute === false && row.proconfig.includes('search_path=pg_catalog')));
      await assert.rejects(admin.query(`UPDATE reading_trial.material SET original_value='"changed"' WHERE unit_key='"content"'`), (error) => error.code === '55000');
    } finally { await reader.end(); await legacy.end(); }
  });

  await t.test('same stored original and restrictions survive terminal and PG restart', async () => {
    await terminal.close(); terminal = null; await writer.end();
    admin = await trial.restart();
    await start();
    assert.equal((await get(detail('content'))).body.projection.original_text, original);
    assert.deepEqual((await get(detail('hidden'))).body, PROBLEMS[404]);
    assert.ok((await admin.query('SELECT count(*)::int n FROM reading_trial.access_evidence')).rows[0].n > 5);
  });
});
