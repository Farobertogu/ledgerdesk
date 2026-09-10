import { Client } from 'pg';
import type { AccessConfig } from '../config.ts';

/** One connection owns admission until handoff; no transaction crosses network waiting. */
export class AccessStore {
  readonly client: Client;
  private locked = false;
  private exclusive = false;
  private transaction = false;
  healthy = true;
  readonly role: 'inc02_runtime' | 'inc02_reader';
  constructor(config: AccessConfig, onLoss: () => void, role: 'inc02_runtime' | 'inc02_reader' = 'inc02_runtime') {
    this.role = role;
    const url = new URL(config.connectionString);
    if (url.username !== role || url.pathname !== '/inc02_synthetic' || url.hostname !== '127.0.0.1') throw new Error('DB_CONFIG_IDENTITY');
    this.client = new Client({
      connectionString: config.connectionString,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      lock_timeout: 3000,
      application_name: 'inc02-access',
      options: '-c search_path=pg_catalog',
    });
    this.client.on('error', () => {
      this.healthy = false;
      onLoss();
    });
  }
  async admit(exclusive: boolean) {
    await this.client.connect();
    const {
      rows: [r],
    } = await this.client
      .query(`SELECT current_user AS role,current_database() AS db,
      current_setting('server_version_num')::int AS version,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,
      (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
      FROM pg_roles r WHERE rolname=current_user`);
    if (
      !r ||
      r.role !== this.role ||
      r.db !== 'inc02_synthetic' ||
      r.version < 160000 ||
      r.version >= 170000 ||
      r.rolsuper ||
      r.rolcreatedb ||
      r.rolcreaterole ||
      r.rolbypassrls ||
      r.rolreplication ||
      r.memberships
    )
      throw new Error('DB_IDENTITY');
    this.exclusive = exclusive;
    await this.client.query(
      exclusive
        ? 'SELECT pg_advisory_lock(20202,1)'
        : 'SELECT pg_advisory_lock_shared(20202,1)',
    );
    this.locked = true;
  }
  async lockObjects(keys: string[]) {
    // Order the effective PostgreSQL lock identifiers, including hash collisions.
    const locks = (
      await this.client.query(
        'SELECT DISTINCT hashtext(k) AS key FROM unnest($1::text[]) AS k ORDER BY key',
        [keys],
      )
    ).rows;
    for (const lock of locks)
      await this.client.query('SELECT pg_advisory_lock(20203,$1)', [lock.key]);
  }
  async begin(objectKey: string | string[]) {
    // Flow/email serialisation precedes the snapshot. Different accounts can verify concurrently.
    await this.lockObjects(Array.isArray(objectKey) ? objectKey : [objectKey]);
    await this.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    this.transaction = true;
    await this.client.query('SET LOCAL synchronous_commit=on');
  }
  async now(): Promise<number> {
    return Number(
      (
        await this.client.query(
          'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n',
        )
      ).rows[0].n,
    );
  }
  async commit() {
    await this.client.query('COMMIT');
    this.transaction = false;
  }
  async releaseAdmission() {
    if (this.healthy && this.locked) {
      await this.client.query(
        this.exclusive
          ? 'SELECT pg_advisory_unlock(20202,1)'
          : 'SELECT pg_advisory_unlock_shared(20202,1)',
      );
      this.locked = false;
      await this.client.query('SELECT pg_advisory_unlock_all()');
    }
  }
  async close() {
    try {
      if (this.healthy && this.transaction) await this.client.query('ROLLBACK');
      await this.releaseAdmission();
    } finally {
      await this.client.end();
    }
  }
}
