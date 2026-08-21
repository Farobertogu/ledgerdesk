/**
 * The component path through the state machine.
 *
 * Sixteen of the machine's edges are guarded by a component rather than by a person, and the HTTP
 * surface refuses every one of them — deliberately, and it goes on refusing them after this file
 * exists. `transitionTicket` is the console's path: it answers a request, it checks a person's
 * standing, and it takes only edges whose guard a person evaluates. A component's edge is not a
 * request and there is no person; the guard was evaluated by the component itself, and what
 * remains is to record that it was.
 *
 * So this is a second path and not a widened first one, and the difference is worth stating
 * plainly because the tempting shortcut is to widen the first:
 *
 *   · **The payload of the HTTP transition is not extended.** No `reason` field travels over
 *     HTTP. A reason that a caller could supply is a reason a caller could choose, and the whole
 *     value of the escalation record is that the rule chose it. The component writes it.
 *   · **No edge becomes a console edge.** `{console: 3, guarded: 16, illegal: 81}` is the same
 *     partition after this file as before it, and `test_APP_state_machine_enforced_server_side`
 *     measures exactly that.
 *   · **The guard's owner is checked, not assumed.** A caller may only take an edge whose
 *     `guardedBy` names the component it says it is. The triage runner cannot take the drafting
 *     agent's edge by passing the right pair of states.
 *
 * The claims are the machine actor's — an organisation, the role `agent`, no subject — and
 * `src/server/db.ts` says why the subject is absent.
 */

import type { PoolClient } from 'pg';

import { withAppSession, type MachineClaims } from '@/server/db';
import { AppError } from '@/server/errors';
import { findTransition, type GuardOwner, type TicketState } from '@/server/states';

/**
 * The role a component asserts.
 *
 * `agent` and not a fourth role: the write policy admits `agent` and `supervisor`, and the machine
 * actor takes the narrower of the two — it has no business holding the supervisor's escalation
 * exit. A role of its own would be a change to a frozen enum and would need its own record.
 */
export const COMPONENT_ROLE = 'agent' as const;

export function componentClaims(orgId: string): MachineClaims {
  return { org_id: orgId, role: COMPONENT_ROLE };
}

/**
 * The columns a component may write alongside a transition, as a closed set.
 *
 * Closed because the assignment is turned into SQL by name. A map whose keys reached the statement
 * unchecked would be an injection point in the one place in this tree that builds a statement from
 * anything but a literal, and "the callers are all ours" is the argument that stops being true
 * later.
 */
export const ASSIGNABLE_COLUMNS = [
  'category',
  'severity',
  'sentiment',
  'confidence',
  'body_redacted',
  'sla_policy_id',
  'sla_due_at',
  'priority',
  'escalation_reason',
  'escalation_clause',
  'retries',
] as const;

export type AssignableColumn = (typeof ASSIGNABLE_COLUMNS)[number];

export type ComponentAssignment = Partial<Record<AssignableColumn, unknown>>;

export type ComponentTransition = {
  ticketId: string;
  /** The state the component read a moment ago. The compare-and-set is against this value. */
  from: TicketState;
  to: TicketState;
  /** The component claiming the edge. Checked against the machine's own table. */
  owner: GuardOwner;
  /** Columns written in the same statement, so a crash cannot separate them from the state. */
  assign?: ComponentAssignment;
};

/**
 * One component transition, on a client the caller already holds.
 *
 * This is the form the runner uses, and the reason it takes a client rather than opening its own
 * session: a triage verdict that both triages and escalates is two compare-and-sets that have to
 * be one transaction, and a helper that opened a transaction per edge could not give it that. The
 * intermediate state is never committed and therefore never visible — there is no history table
 * for it to be missing from, and no sweeper would ever have to find a ticket stranded in it.
 */
export async function applyComponentTransitionOn(
  client: PoolClient,
  transition: ComponentTransition,
): Promise<void> {
  const edge = findTransition(transition.from, transition.to);
  if (!edge) {
    throw new AppError(
      'E_TRANSITION_ILLEGAL',
      409,
      `the state machine publishes no transition from ${transition.from} to ${transition.to}`,
      { from: transition.from, to: transition.to },
    );
  }

  // A defect of the caller rather than a condition of the world: the component asked for an edge
  // that belongs to a different component. It fails loudly here instead of writing a state whose
  // guard nobody with standing evaluated.
  if (edge.guardedBy !== transition.owner) {
    throw new Error(
      `${transition.from} → ${transition.to} is guarded by ${edge.guardedBy}, and ${transition.owner} asked to take it`,
    );
  }

  const assign = transition.assign ?? {};
  const columns: string[] = [];
  const values: unknown[] = [transition.to, transition.ticketId, transition.from];

  for (const [column, value] of Object.entries(assign)) {
    if (!(ASSIGNABLE_COLUMNS as readonly string[]).includes(column)) {
      throw new Error(`'${column}' is not a column a component may write beside a transition`);
    }
    values.push(value);
    columns.push(`${column} = $${values.length}`);
  }

  const setClause = ['status = $1', ...columns].join(', ');

  // Compare-and-set on the state the component read. A console that moved the ticket in between
  // wins, and this side is told the row moved rather than overwriting a person's decision.
  const applied = await client.query(
    `update ticket set ${setClause} where id = $2 and status = $3 returning id`,
    values,
  );

  if (applied.rowCount !== 1) {
    throw new AppError('E_TRANSITION_STALE', 409, 'the ticket changed state before the update applied', {
      ticket_id: transition.ticketId,
      expected_from: transition.from,
      to: transition.to,
    });
  }
}

/**
 * One component transition, in a session of its own.
 *
 * The convenience form, for a component that has a single edge to take and nothing to write with
 * it. Anything that has to write columns and a state together uses the form above inside its own
 * transaction — that is the whole ordering contract of the triage cycle.
 */
export async function applyComponentTransition(
  orgId: string,
  ticketId: string,
  to: TicketState,
  owner: GuardOwner,
  evidence: { from: TicketState; assign?: ComponentAssignment },
): Promise<void> {
  await withAppSession(componentClaims(orgId), (client) =>
    applyComponentTransitionOn(client, {
      ticketId,
      from: evidence.from,
      to,
      owner,
      assign: evidence.assign,
    }),
  );
}
