import type { PoolClient } from 'pg';

import { withAppSession, type Claims } from '@/server/db';
import { AppError } from '@/server/errors';
import { findTransition, isAvailableNow, type TicketState } from '@/server/states';

/**
 * Every read below is written WITHOUT a tenant predicate, and that is the point: the rows a
 * session may see are decided by the policies on `ticket`, so a missing WHERE clause here cannot
 * leak another organisation's rows. Where a predicate does appear it narrows the result further
 * (one row by primary key), never widens it.
 */

export type Ticket = {
  id: string;
  subject: string;
  status: TicketState;
  created_at: string;
  customer_id: string;
  sla_due_at: string | null;
};

export type TicketAcknowledgement = {
  tracking_id: string;
  status: TicketState;
  subject: string;
  created_at: string;
  acknowledgement: string;
};

const SUBJECT_MAX = 200;
const BODY_MAX = 8000;

type TicketRow = {
  id: string;
  subject: string;
  status: TicketState;
  created_at: Date;
  customer_id: string;
  sla_due_at: Date | null;
};

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    created_at: row.created_at.toISOString(),
    customer_id: row.customer_id,
    sla_due_at: row.sla_due_at ? row.sla_due_at.toISOString() : null,
  };
}

const TICKET_COLUMNS = 'id, subject, status, created_at, customer_id, sla_due_at';

export function validateDraft(input: { subject: unknown; body: unknown }): {
  subject: string;
  body: string;
} {
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';

  if (!subject) {
    throw new AppError('E_FIELD_INVALID', 400, 'subject is required', { field: 'subject' });
  }
  if (subject.length > SUBJECT_MAX) {
    throw new AppError('E_FIELD_INVALID', 400, `subject exceeds ${SUBJECT_MAX} characters`, {
      field: 'subject',
      max: SUBJECT_MAX,
    });
  }
  if (!body) {
    throw new AppError('E_FIELD_INVALID', 400, 'body is required', { field: 'body' });
  }
  if (body.length > BODY_MAX) {
    throw new AppError('E_FIELD_INVALID', 400, `body exceeds ${BODY_MAX} characters`, {
      field: 'body',
      max: BODY_MAX,
    });
  }
  return { subject, body };
}

/**
 * Creates a ticket for the customer whose claims the session carries and returns the
 * acknowledgement they are shown.
 *
 * `org_id` and `customer_id` are read from the claims BY THE DATABASE, not chosen by this
 * function: the row's tenant and owner are therefore the same values the policy checks on the way
 * in, and no application mistake can file a ticket into another organisation.
 *
 * Three columns are deliberately left as the schema defaults them:
 *   · status         — 'NEW' by default. The intake path never writes any other state.
 *   · body_redacted  — the redaction of a body is the gateway's, and there is no gateway yet.
 *   · sla_policy_id  — the policy is chosen from (tier, severity), and severity is assigned by
 *                      triage. Guessing one at intake would put a number on screen that no
 *                      written policy backs.
 */
export async function createTicket(
  claims: Claims,
  input: { subject: string; body: string },
): Promise<TicketAcknowledgement> {
  const row = await withAppSession(claims, async (client) => {
    // Resolved under the claims organisation, which the database reads — this function never
    // chooses a tenant. The count travels with the id so that "which account" is answered or
    // REFUSED in one statement: nothing in the schema links a customer to an account, so with
    // more than one on the organisation, filing against the lowest id would be a silent wrong
    // answer. min() has no uuid form, hence the ordered aggregate.
    const account = await client.query<{ n: number; account_id: string | null }>(
      `select count(*)::int as n, (array_agg(a.id order by a.id))[1] as account_id
         from account a
        where a.org_id = (auth.jwt() ->> 'org_id')::uuid`,
    );
    const { n, account_id: accountId } = account.rows[0];

    if (n === 0 || !accountId) {
      throw new AppError(
        'E_NO_ACCOUNT_FOR_ORG',
        409,
        'the organisation of this session has no account row, so a ticket cannot be filed',
        { org_id: claims.org_id },
      );
    }
    if (n > 1) {
      throw new AppError(
        'E_ACCOUNT_AMBIGUOUS',
        409,
        `the organisation of this session has ${n} accounts and nothing says which one a ticket belongs to`,
        { org_id: claims.org_id, accounts: n },
      );
    }

    const result = await client.query<TicketRow>(
      `insert into ticket (id, org_id, account_id, customer_id, subject, body_raw)
       values (gen_random_uuid(),
               (auth.jwt() ->> 'org_id')::uuid,
               $1,
               auth.uid(),
               $2, $3)
       returning ${TICKET_COLUMNS}`,
      [accountId, input.subject, input.body],
    );
    return result.rows[0];
  });

  const ticket = toTicket(row);
  return {
    tracking_id: ticket.id,
    status: ticket.status,
    subject: ticket.subject,
    created_at: ticket.created_at,
    acknowledgement: `Ticket received. Your tracking number is ${ticket.id}.`,
  };
}

/**
 * The tickets this session may see, newest first.
 *
 * A customer gets their own; an agent or supervisor gets the organisation's. Neither outcome is
 * produced by this query — both are produced by the policies on `ticket`.
 */
export async function listTickets(claims: Claims): Promise<Ticket[]> {
  const rows = await withAppSession(claims, async (client) => {
    const result = await client.query<TicketRow>(
      `select ${TICKET_COLUMNS} from ticket order by created_at desc, id`,
    );
    return result.rows;
  });
  return rows.map(toTicket);
}

export type StateCount = { status: TicketState; n: number };

/** The queue counted by state, over exactly the rows this session may see. */
export async function countTicketsByState(claims: Claims): Promise<StateCount[]> {
  return withAppSession(claims, async (client) => {
    const result = await client.query<{ status: TicketState; n: number }>(
      'select status, count(*)::int as n from ticket group by status order by status',
    );
    return result.rows;
  });
}

/**
 * Applies one transition, server side.
 *
 * The order of the checks is the contract: visibility first (a row this session cannot see is
 * reported as not visible, never as a rejected transition, which would confirm it exists), then
 * the machine, then the guard, then the write.
 *
 * The role check is an application check and is marked as one. `ticket` carries a restrictive
 * SELECT policy that keeps a customer to their own rows, and a permissive FOR ALL tenant policy
 * that does NOT distinguish roles on the write path — so today the database would let a
 * customer's claims update any ticket of their organisation. Until a role-scoped write policy
 * exists in the schema, this line is what stands between them, and it is the weaker of the two
 * kinds of guarantee this repository uses.
 */
export async function transitionTicket(
  claims: Claims,
  ticketId: string,
  to: TicketState,
): Promise<Ticket> {
  if (claims.role !== 'agent' && claims.role !== 'supervisor') {
    throw new AppError('E_ROLE_NOT_PERMITTED', 403, 'only an agent or a supervisor transitions a ticket', {
      role: claims.role,
    });
  }

  const row = await withAppSession(claims, async (client) => {
    const current = await readOne(client, ticketId);
    if (!current) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no ticket with that id is visible to this session', {
        ticket_id: ticketId,
      });
    }

    const transition = findTransition(current.status, to);
    if (!transition) {
      throw new AppError(
        'E_TRANSITION_ILLEGAL',
        409,
        `the state machine publishes no transition from ${current.status} to ${to}`,
        { from: current.status, to },
      );
    }
    if (!isAvailableNow(transition)) {
      throw new AppError(
        'E_TRANSITION_GUARD_UNAVAILABLE',
        409,
        `the guard of ${current.status} → ${to} is evaluated by ${transition.guardedBy}, which is not built yet`,
        { from: current.status, to, guard: transition.guard, guarded_by: transition.guardedBy },
      );
    }

    // Compare-and-set on the state read a moment ago: two consoles pressing at once cannot both
    // apply their transition, and the loser is told the row moved instead of overwriting it.
    const applied = await client.query<TicketRow>(
      `update ticket set status = $1 where id = $2 and status = $3 returning ${TICKET_COLUMNS}`,
      [to, ticketId, current.status],
    );
    if (applied.rowCount !== 1) {
      throw new AppError('E_TRANSITION_STALE', 409, 'the ticket changed state before the update applied', {
        ticket_id: ticketId,
        expected_from: current.status,
      });
    }
    return applied.rows[0];
  });

  return toTicket(row);
}

export async function getTicket(claims: Claims, ticketId: string): Promise<Ticket | null> {
  const row = await withAppSession(claims, (client) => readOne(client, ticketId));
  return row ? toTicket(row) : null;
}

async function readOne(client: PoolClient, ticketId: string): Promise<TicketRow | undefined> {
  const result = await client.query<TicketRow>(
    `select ${TICKET_COLUMNS} from ticket where id = $1`,
    [ticketId],
  );
  return result.rows[0];
}
