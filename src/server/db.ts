import { Pool, type PoolClient } from 'pg';

/**
 * The only path from the consoles to PostgreSQL.
 *
 * Two rules hold for every statement the application runs, and they are enforced here rather than
 * repeated at each call site:
 *
 *   1. The statement runs as `app_rw`, never as the connecting role. `app_rw` owns no table and
 *      carries no bypass, so row-level security applies to it — which is what makes the policies
 *      in the schema the thing that isolates tenants, instead of a WHERE clause the application
 *      could forget to write.
 *   2. The session carries the claims the policies read through `auth.jwt()`: `org_id`, `role`
 *      and `sub`. A request without claims is a request that sees nothing; the policies fail
 *      closed and no application check is what stops it.
 *
 * Both are set with SET LOCAL / `set_config(..., is_local => true)`, so they are scoped to the
 * transaction and cannot survive into the next borrower of a pooled connection.
 */

export type UserRole = 'customer' | 'agent' | 'supervisor';

/** The claim set the database reads. Its shape is the schema's, not this module's. */
export type Claims = {
  org_id: string;
  role: UserRole;
  sub: string;
};

/**
 * The claim set a component runs under: an organisation, a role, and no subject.
 *
 * `sub` is absent and its absence is the point. The policies that admit a ticket write read `role`
 * and `org_id` — `ticket_write_is_staff`, `tenant_isolation`, and the staff branch of
 * `customer_own_rows` — and `auth.uid()` is nullable and is not consulted on an UPDATE. Putting a
 * nil UUID there would assert that some user took the edge, which is false; leaving it out says
 * what is true, that no person did. ADR-023 §8 records the decision and the two alternatives it
 * was taken over.
 *
 * Note what this narrows: a session with no `sub` cannot satisfy `customer_id = auth.uid()`, so
 * these claims see a customer's rows only through the staff branch — which is the branch a
 * component is entitled to and the only one it ever uses.
 */
export type MachineClaims = {
  org_id: string;
  role: UserRole;
};

/**
 * The narrowest claim set there is: an organisation, and nothing else.
 *
 * It exists for readers that have no business writing anything. The knowledge-base retrieval is the
 * first of them: it selects from three tables whose select policies are tenant-only, and asserting
 * a role as well would hand it the claim that opens `ticket_write_is_staff` — standing it does not
 * need and cannot use, on a code path whose whole job is to read somebody else's documents into a
 * prompt. The ledger store's own claim set has been this shape from the start, for the reason
 * stated there: what it cannot see, it cannot leak.
 *
 * A statement running under these claims sees the tenant's rows and cannot satisfy any policy whose
 * predicate reads `role` or `auth.uid()`, which is the whole of the guarantee.
 */
export type TenantClaims = {
  org_id: string;
};

/** Any identity a statement can run under. All three are read by the policies the same way. */
export type SessionClaims = Claims | MachineClaims | TenantClaims;

const APPLICATION_ROLE = 'app_rw';

// Next.js reloads modules in development; without this the process would accumulate one pool per
// reload and exhaust the server's connection slots.
const globalForPool = globalThis as unknown as { ledgerdeskPool?: Pool };

function pool(): Pool {
  if (globalForPool.ledgerdeskPool) return globalForPool.ledgerdeskPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The consoles need a PostgreSQL instance with the migration set ' +
        'applied in order, plus the seed.',
    );
  }

  const created = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 8),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  // A pool that swallows the errors of idle clients keeps handing out dead connections.
  created.on('error', (err) => console.error('[db] idle client error:', err.message));

  globalForPool.ledgerdeskPool = created;
  return created;
}

/**
 * Runs `work` inside one transaction, as the application role, under `claims`.
 *
 * Pass `null` for the claim set of a request that has no session yet: the connection still drops
 * to `app_rw`, and every table under row-level security returns nothing.
 */
export async function withAppSession<T>(
  claims: SessionClaims | null,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${APPLICATION_ROLE}`);

    const applied = await client.query<{ role_in_force: string }>(
      'select set_config($1, $2, true) as claims, current_user as role_in_force',
      ['request.jwt.claims', claims ? JSON.stringify(claims) : ''],
    );

    // Belt and braces: if this ever reports anything but app_rw, the queries below would run with
    // privileges the policies were never written for, and every isolation test in the repository
    // would be measuring the wrong world.
    const roleInForce = applied.rows[0]?.role_in_force;
    if (roleInForce !== APPLICATION_ROLE) {
      throw new Error(
        `expected the session to run as ${APPLICATION_ROLE}, it is running as ${roleInForce}`,
      );
    }

    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
