import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { ReadingContext } from '../context.ts';
import type { ReadingOperation, TransportObservation } from '../../kb/reading.ts';
import { evaluatePolicy, prepareReading } from '../policy.ts';
import type { StoredMaterial } from '../policy.ts';
import type { CommittedReading, ReadingPersistencePort } from '../persistence.ts';

export class ReadingStoreError extends Error {
  constructor() { super('Reading persistence unavailable'); }
}
export type StoreConfig = Readonly<{ connectionString: string; expectedPort: number }>;

/** Explicit PG16 synthetic connection, never DATABASE_URL or a legacy pool.
 * This runtime check complements the harness's Docker identity/mount checks, not replaces them.
 */
export function validateStoreConfig(config: StoreConfig): void {
  const url = new URL(config.connectionString);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1'
      || url.username !== 'inc01_reader' || url.pathname !== '/inc01_synthetic'
      || !url.password || url.search || url.hash
      || !Number.isInteger(config.expectedPort) || config.expectedPort < 1024
      || config.expectedPort > 65535 || Number(url.port) !== config.expectedPort) throw new ReadingStoreError();
}

export class PgReadingStore implements ReadingPersistencePort {
  private readonly client: Client;
  private healthy = true;
  private admitted = false;
  private transaction = false;
  private readonly onLoss: () => void;
  constructor(config: StoreConfig, onLoss: () => void) {
    validateStoreConfig(config);
    this.onLoss = onLoss;
    this.client = new Client({ connectionString: config.connectionString,
      connectionTimeoutMillis: 3000, statement_timeout: 5000,
      application_name: 'inc01-reading-terminal', options: '-c search_path=pg_catalog' });
    this.client.on('error', () => { this.healthy = false; this.onLoss(); });
  }
  async connect(): Promise<void> {
    try {
      await this.client.connect();
      const { rows: [row] } = await this.client.query(`SELECT current_user AS role,
        current_database() AS database, current_setting('server_version_num')::int AS version,
        r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
        (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
        FROM pg_roles r WHERE r.rolname = current_user`);
      if (!row || row.role !== 'inc01_reader' || row.database !== 'inc01_synthetic'
          || row.version < 160000 || row.version >= 170000 || row.rolsuper || row.rolcreatedb
          || row.rolcreaterole || row.rolreplication || row.rolbypassrls || row.memberships) throw new ReadingStoreError();
      const owner = await this.client.query('SELECT pg_try_advisory_lock(10404, 2) AS acquired');
      if (!owner.rows[0].acquired) throw new ReadingStoreError();
    } catch { this.healthy = false; throw new ReadingStoreError(); }
  }
  async acquire(): Promise<void> {
    if (!this.healthy || this.admitted) throw new ReadingStoreError();
    try {
      // Session admission survives COMMIT. No SQL transaction is held while sending bytes.
      await this.client.query('SELECT pg_advisory_lock(10404, 1)');
      this.admitted = true;
    } catch { throw new ReadingStoreError(); }
  }
  async release(): Promise<void> {
    if (!this.admitted) return;
    this.admitted = false;
    try { await this.client.query('SELECT pg_advisory_unlock(10404, 1)'); }
    catch { this.healthy = false; this.onLoss(); }
  }
  async prepare(context: ReadingContext, operation: ReadingOperation): Promise<CommittedReading> {
    if (!this.healthy || !this.admitted || this.transaction) throw new ReadingStoreError();
    const receiptId = randomUUID();
    try {
      await this.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); this.transaction = true;
      await this.client.query('SET LOCAL synchronous_commit = on');
      const { rows: [control] } = await this.client.query(`SELECT *,
        extract(epoch FROM clock_timestamp()) * 1000 AS now FROM reading_trial.control`);
      if (!control || !control.active || !control.capture_ready || !control.processing_ready
          || !control.conservation_ready || !control.trace_ready || !control.destination_ready
          || control.generation !== context.generation || control.deployment_id !== context.deploymentId
          || control.scope_id !== context.scopeId) throw new ReadingStoreError();
      const { rows } = await this.client.query(`SELECT m.deployment_id, m.scope_id, m.unit_key, m.version_key,
        p.hierarchy FROM reading_trial.material m
        LEFT JOIN reading_trial.policy p USING (deployment_id, scope_id, unit_key, version_key)
        WHERE m.deployment_id = $1 AND m.scope_id = $2`, [context.deploymentId, context.scopeId]);
      const selected = rows.flatMap((row) => {
        const decision = evaluatePolicy(row.hierarchy, context, operation.kind, Number(control.now));
        const maximum = decision.grant?.maximum;
        return maximum && !['NONE', 'EXISTENCE'].includes(maximum)
          ? [{ unit_key: row.unit_key, version_key: row.version_key, needs_text: operation.kind === 'exact'
            && ['EXCERPT', 'CONTENT'].includes(maximum) }] : [];
      });
      // Never pull a hidden original merely to discard it in the projector. Policy headers and
      // selected payloads share this snapshot. The same batched path is used for every exact ID.
      const payloads = await this.client.query(`SELECT m.unit_key, m.version_key, m.original_language,
        CASE WHEN s.needs_text THEN m.original_value ELSE '""'::json END AS original_value,
        m.metadata, CASE WHEN s.needs_text THEN m.fragments ELSE '[]'::json END AS fragments, m.requirements
        FROM reading_trial.material m JOIN jsonb_to_recordset($3::jsonb)
          AS s(unit_key text, version_key text, needs_text boolean) USING (unit_key,version_key)
        WHERE m.deployment_id=$1 AND m.scope_id=$2`, [context.deploymentId, context.scopeId, JSON.stringify(selected)]);
      const byPair = new Map(payloads.rows.map((row) => [JSON.stringify([row.unit_key, row.version_key]), row]));
      const population: StoredMaterial[] = rows.map((row) => ({
        deploymentId: row.deployment_id, scopeId: row.scope_id,
        reference: { unit_id: JSON.parse(row.unit_key), version_id: JSON.parse(row.version_key) },
        originalText: byPair.get(JSON.stringify([row.unit_key, row.version_key]))?.original_value ?? '',
        originalLanguage: byPair.get(JSON.stringify([row.unit_key, row.version_key]))?.original_language ?? 'en',
        metadata: byPair.get(JSON.stringify([row.unit_key, row.version_key]))?.metadata ?? {},
        fragments: byPair.get(JSON.stringify([row.unit_key, row.version_key]))?.fragments ?? [],
        requirements: byPair.get(JSON.stringify([row.unit_key, row.version_key]))?.requirements ?? {},
        policy: row.hierarchy ?? { unit: [], inherited: [], general: [] },
      }));
      const prepared = prepareReading(population, context, operation, Number(control.now));
      const status = 'status' in prepared.response ? prepared.response.status : 200;
      await this.client.query(`INSERT INTO reading_trial.access_evidence
        (receipt_id, decision_id, subject_id, generation, restriction_revision, action, requested_pair, result_status, decisions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [receiptId, randomUUID(), context.subjectId,
        context.generation, control.revision, operation.kind,
        operation.kind === 'exact' ? JSON.stringify(operation.reference) : null, status, JSON.stringify(prepared.decisions)]);
      await this.client.query('COMMIT'); this.transaction = false;
      return { ...prepared, receiptId, revision: control.revision };
    } catch {
      if (this.transaction) { try { await this.client.query('ROLLBACK'); } catch { this.healthy = false; } }
      this.transaction = false;
      throw new ReadingStoreError();
    }
  }
  async observe(receiptId: string, observation: TransportObservation, responseStatus: number | null): Promise<void> {
    try {
      await this.client.query(`INSERT INTO reading_trial.transport_observation
        (observation_id, receipt_id, outcome, observed_bytes, response_status) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), receiptId, observation.outcome, observation.observedBytes, responseStatus]);
    } catch { throw new ReadingStoreError(); }
  }
  available(): boolean { return this.healthy; }
  async close(): Promise<void> { this.healthy = false; await this.client.end().catch(() => undefined); }
}
