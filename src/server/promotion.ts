import { rowFromDatabase } from '@agents/ledger/pg.ts';
import { verifyRowHash } from '@agents/ledger/row.ts';

import type { AttemptLedgerRow } from '@/alg/promotion_panel';
import { withAppSession, type SessionClaims } from '@/server/db';

/**
 * The read behind the promotion panel.
 *
 * **As the tenant, through the console's own session, and never as anything else.** The statement
 * runs under `withAppSession` with the claims of the identity in force, which drops the connection to
 * `app_rw` — so `ledger_tenant_select` is what decides which rows come back, and the policy is
 * load-bearing rather than decorative. The alternative that has to be named to be refused is
 * `quality_ro`: its select policy on `ledger_entry` is `using (true)`, so it sees the chain of every
 * organisation in the cluster. A screen that reached for that role would put every tenant's rows in
 * front of an examiner, live, in the beat whose whole argument is discipline. This module also opens
 * no pool of its own: the one pool is `src/server/db.ts`'s, which is the only place a connection is
 * built.
 *
 * **The digest is recomputed, not trusted.** A panel that printed `output` without checking
 * `row_hash` would paint a tampered row exactly as green as a sound one. `verifyRowHash` is the SAME
 * implementation the writer used to link the row (`agents/ledger/row.ts:14-16`) — which is what makes
 * this a check and not a second opinion — and `rowFromDatabase` is the one conversion in the tree
 * that puts a driver's row back into the form the digest was taken over.
 */

const ATTEMPT_ROWS = `
  select *
    from ledger_entry
   where class in ('start', 'promotion_attempt')
   order by run_id, seq`;

/**
 * Every promotion-attempt row this session may see, in the shape the panel's view model consumes.
 *
 * The scope is the tenant's, and the panel says so on screen: the reconciliation counted over these
 * rows is a tenant total and never a statement about the cluster.
 */
export async function attemptRowsFor(claims: SessionClaims): Promise<AttemptLedgerRow[]> {
  return withAppSession(claims, async (client) => {
    const result = await client.query<Record<string, unknown>>(ATTEMPT_ROWS);

    return result.rows.map((record) => {
      const row = rowFromDatabase(record);
      const output = (row.output ?? {}) as Record<string, unknown>;
      const attemptId = output.attempt_id;

      return {
        kind: row.class === 'start' ? ('start' as const) : ('terminal' as const),
        attempt_id: typeof attemptId === 'string' ? attemptId : '',
        run_id: row.run_id,
        seq: row.seq,
        ticket_id: row.ticket_id,
        output,
        verified: verifyRowHash(row),
      };
    });
  });
}
