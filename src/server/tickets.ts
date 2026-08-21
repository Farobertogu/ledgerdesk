import type { PoolClient } from 'pg';

import { sha256Hex } from '@agents/canonical.ts';
import {
  DEFAULT_DEDUPE_WINDOW_MS,
  dedupeDecision,
  type DedupeIncumbent,
} from '@/alg/priority';
import { withAppSession, type Claims } from '@/server/db';
import { AppError } from '@/server/errors';
import { findTransition, isGuardAvailable, type TicketState } from '@/server/states';

/**
 * Every read below is written WITHOUT a tenant predicate, and that is the point: the rows a
 * session may see are decided by the policies on `ticket`, so a missing WHERE clause here cannot
 * leak another organisation's rows. Where a predicate does appear it narrows the result further
 * (one row by primary key), never widens it.
 */

/**
 * A ticket as a console renders it.
 *
 * The six triage fields and the two escalation fields are `null` until a triage cycle writes them,
 * and a console shows that absence rather than filling it: a dash is the truth about a ticket
 * nothing has looked at yet, and a zero would be a number nobody computed.
 *
 * The three fixed-scale decimals stay TEXT all the way to the screen. `numeric` arrives from the
 * driver as text at the scale the column declares — `0.750`, not `0.75` — and that string is what
 * was stored and what an auditor re-runs against. Parsing it into a float here would be the one
 * place a re-run could diverge from the record by a digit nobody chose.
 */
export type Ticket = {
  id: string;
  subject: string;
  status: TicketState;
  created_at: string;
  customer_id: string;
  sla_due_at: string | null;
  category: string | null;
  severity: number | null;
  /** `numeric(4,3)` as text, or null. */
  sentiment: string | null;
  /** `numeric(4,3)` as text, or null. */
  confidence: string | null;
  /** `numeric(9,6)` as text, or null. */
  priority: string | null;
  escalation_reason: string | null;
  escalation_clause: string | null;
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
  category: string | null;
  severity: number | null;
  sentiment: string | null;
  confidence: string | null;
  priority: string | null;
  escalation_reason: string | null;
  escalation_clause: string | null;
};

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    created_at: row.created_at.toISOString(),
    customer_id: row.customer_id,
    sla_due_at: row.sla_due_at ? row.sla_due_at.toISOString() : null,
    category: row.category,
    severity: row.severity === null ? null : Number(row.severity),
    sentiment: row.sentiment,
    confidence: row.confidence,
    priority: row.priority,
    escalation_reason: row.escalation_reason,
    escalation_clause: row.escalation_clause,
  };
}

const TICKET_COLUMNS =
  'id, subject, status, created_at, customer_id, sla_due_at, category, severity, sentiment, ' +
  'confidence, priority, escalation_reason, escalation_clause';

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
 * The instant a row's collapse group is named by, in the milliseconds the algorithm speaks in.
 *
 * `floor` and not a cast: `::bigint` rounds half-up, so a `created_at` of `…999.6ms` would produce
 * an anchor one millisecond ahead of the row it names. Every place this figure is derived uses the
 * same expression, so the anchor written into a key and the anchor read back out of a row agree by
 * construction rather than by coincidence.
 */
const ANCHOR_MS = '(floor(extract(epoch from created_at) * 1000))::bigint';

export type IntakeOutcome = {
  acknowledgement: TicketAcknowledgement;
  /**
   * True when this submission folded into a ticket that already held the same words. The customer
   * is told the same thing either way and given the same tracking number; only the status code
   * differs, because 201 would claim something was created.
   */
  collapsed: boolean;
};

type IncumbentRow = TicketRow & { anchor_ms: string };

/**
 * Creates a ticket for the customer whose claims the session carries — or recognises that it has
 * already been created — and returns the acknowledgement they are shown.
 *
 * `org_id` and `customer_id` are read from the claims BY THE DATABASE, not chosen by this
 * function: the row's tenant and owner are therefore the same values the policy checks on the way
 * in, and no application mistake can file a ticket into another organisation.
 *
 * Two columns are still left as the schema defaults them:
 *   · status         — 'NEW' by default. The intake path never writes any other state.
 *   · body_redacted  — the redaction of a body is the gateway's, and the gateway runs at triage.
 *
 * `sla_policy_id` remains unset here for the reason it always did: the policy is chosen from tier
 * and severity, and severity is the triage agent's to assign. Guessing one at intake would put a
 * deadline on screen that no written policy backs.
 *
 * ## The collapse, and why it needs a lock
 *
 * Inside the same transaction as the insert: the body is digested, an advisory lock is taken on
 * the pair (organisation, digest), the most recent live ticket carrying that digest is read, and
 * the pure decision function says whether this submission is a duplicate of it.
 *
 * **The lock is a correction and not a courtesy.** The uniqueness constraint on
 * `(org_id, dedupe_key)` cannot close the race on its own, because the key contains the instant
 * that opened the group: two requests arriving together each read no incumbent, each name
 * themselves as the anchor of a new group, and each build a *different* key. Both insert. The lock
 * is what makes the second one see the first.
 *
 * **And the cache downstream cannot absorb it either**, which is the reason this matters in money
 * rather than in tidiness. The digest the chokepoint caches on includes the ticket identifier, so
 * two tickets holding identical words are two different calls and two different charges. Every
 * duplicate that is not collapsed here is paid for later.
 *
 * **What the session can see is what the collapse considers.** The read carries no tenant
 * predicate — the policies decide that — and under a customer's claims the restrictive policy also
 * limits it to their own rows. That narrows the rule in the one direction that is always right: two
 * different people who happen to write the same words raise two tickets, and only a person
 * repeating themselves folds into one.
 *
 * A row whose `body_sha256` is null — every row written before that column existed — takes no part
 * in this, on either side. ADR-023 §3 declares it.
 */
export async function createTicket(
  claims: Claims,
  input: { subject: string; body: string },
): Promise<IntakeOutcome> {
  // The digest is of the body EXACTLY as it is persisted: `validateDraft` has already trimmed it,
  // and hashing anything but the stored string would make the column describe a body that is not
  // in the row.
  const bodySha256 = sha256Hex(input.body);

  try {
    return await withAppSession(claims, async (client) => {
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

      // Namespace 2. Namespace 0 is the ledger's, per run; namespace 1 is the audit chain's, per
      // organisation. A shared namespace would have two unrelated mechanisms serialising each
      // other on a hash collision that nothing would ever explain.
      await client.query(
        `select pg_advisory_xact_lock(
                  hashtextextended((auth.jwt() ->> 'org_id') || ':' || $1, 2))`,
        [bodySha256],
      );

      const incumbent = await client.query<IncumbentRow>(
        `select ${TICKET_COLUMNS}, ${ANCHOR_MS} as anchor_ms
           from ticket
          where body_sha256 = $1
            and status not in ('RESOLVED', 'CLOSED')
          order by created_at desc, id desc
          limit 1`,
        [bodySha256],
      );

      // The instant comes from the database and not from this process: it is what `created_at`
      // will hold, and the key has to name that instant and no other.
      const clock = await client.query<{ ts: Date; ms: string }>(
        `select now() as ts, (floor(extract(epoch from now()) * 1000))::bigint as ms`,
      );
      const createdAt = clock.rows[0].ts;
      const createdMs = Number(clock.rows[0].ms);

      const held = incumbent.rows[0];
      const decision = dedupeDecision(
        { id: 'pending', orgId: claims.org_id, bodySha256, createdAt: createdMs },
        held ? incumbentOf(held) : null,
        DEFAULT_DEDUPE_WINDOW_MS,
      );

      if (decision.collapse && held) {
        return acknowledge(toTicket(held), true);
      }

      const result = await client.query<TicketRow>(
        `insert into ticket (id, org_id, account_id, customer_id, subject, body_raw,
                             created_at, body_sha256, dedupe_key)
         values (gen_random_uuid(),
                 (auth.jwt() ->> 'org_id')::uuid,
                 $1,
                 auth.uid(),
                 $2, $3, $4, $5, $6)
         returning ${TICKET_COLUMNS}`,
        [accountId, input.subject, input.body, createdAt, bodySha256, decision.key],
      );
      return acknowledge(toTicket(result.rows[0]), false);
    });
  } catch (error) {
    // The uniqueness constraint firing on the collapse key means another writer holds this group.
    // It is the same fact the lookup above reports and it is answered the same way — never as an
    // unhandled 500, which is where an untranslated 23505 would land.
    if (isDedupeKeyConflict(error)) {
      const held = await withAppSession(claims, async (client) => {
        const result = await client.query<TicketRow>(
          `select ${TICKET_COLUMNS} from ticket
            where body_sha256 = $1 and status not in ('RESOLVED', 'CLOSED')
            order by created_at desc, id desc limit 1`,
          [bodySha256],
        );
        return result.rows[0] ?? null;
      });
      if (held) return acknowledge(toTicket(held), true);
    }
    throw error;
  }
}

/**
 * The incumbent as the pure decision function reads it.
 *
 * Its anchor is its own `created_at`, and that is exact rather than approximate: a submission that
 * collapses is never inserted, so every row that exists opened a group of its own and its key
 * carries the instant it was created at.
 */
function incumbentOf(row: IncumbentRow): DedupeIncumbent {
  return { id: row.id, anchorCreatedAt: Number(row.anchor_ms), open: true };
}

function acknowledge(ticket: Ticket, collapsed: boolean): IntakeOutcome {
  return {
    acknowledgement: {
      tracking_id: ticket.id,
      status: ticket.status,
      subject: ticket.subject,
      created_at: ticket.created_at,
      acknowledgement: `Ticket received. Your tracking number is ${ticket.id}.`,
    },
    collapsed,
  };
}

function isDedupeKeyConflict(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return candidate?.code === '23505' && candidate?.constraint === 'ticket_org_id_dedupe_key_key';
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
    if (!isGuardAvailable(transition)) {
      throw new AppError(
        'E_TRANSITION_GUARD_UNAVAILABLE',
        409,
        `the guard of ${current.status} → ${to} is evaluated by ${transition.guardedBy}, not by a console`,
        { from: current.status, to, guard: transition.guard, guarded_by: transition.guardedBy },
      );
    }

    // Some edges are narrower than the write path. The console disables what it knows it cannot
    // take, but that is a courtesy to the person clicking; standing is decided here.
    if (transition.requiresRole && !transition.requiresRole.includes(claims.role)) {
      throw new AppError(
        'E_ROLE_NOT_PERMITTED',
        403,
        `${current.status} → ${to} is taken by ${transition.requiresRole.join(' or ')}`,
        { from: current.status, to, role: claims.role, requires_role: transition.requiresRole },
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
