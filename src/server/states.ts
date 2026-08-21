/**
 * The ticket state machine, transcribed from the specification's frozen core.
 *
 * The enum is the one the database declares (`ticket_state`); the edges and their guards are the
 * ones the specification publishes. Nothing here is inferred: an edge that is not published is not
 * legal, and a guard whose mechanism has not been built yet is named with the component that owns
 * it rather than quietly treated as satisfied.
 *
 *   NEW ──triage ok──► TRIAGED ──draft ok──► DRAFTED ──validator ok──► AWAITING_AGENT
 *    │                    │                     │                          │
 *    │                    │                     │                   agent approves
 *    │              escalate rule            not grounded                  ▼
 *    │                    ▼                     ▼                        SENT ──► RESOLVED ──► CLOSED
 *    └──triage fails──► TRIAGE_FAILED ──────► ESCALATED ◄──────────────────┘             │
 *                                                ▲                                  customer replies
 *                                                └──────── REOPENED ◄────────────────────┘
 */

import type { UserRole } from '@/server/db';

export const TICKET_STATES = [
  'NEW',
  'TRIAGED',
  'DRAFTED',
  'AWAITING_AGENT',
  'SENT',
  'ESCALATED',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
  'TRIAGE_FAILED',
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

export function isTicketState(value: unknown): value is TicketState {
  return typeof value === 'string' && (TICKET_STATES as readonly string[]).includes(value);
}

/**
 * Who decides that a guard is satisfied.
 *
 * `console` is a decision a person makes on screen and the row records. Every other value names a
 * component that does not exist yet; its edges are legal in the machine and refused by the API,
 * because a transition whose guard nobody evaluated is not a transition that was guarded.
 */
export type GuardOwner =
  | 'console'
  | 'triage-agent'
  | 'draft-agent'
  | 'grounding-validator'
  | 'escalation-rule'
  | 'approval-constraint'
  | 'reopen-window';

export type Transition = {
  from: TicketState;
  to: TicketState;
  /** The guard as the specification states it. */
  guard: string;
  guardedBy: GuardOwner;
  /**
   * The roles that may take this edge, when it is narrower than the write path itself.
   *
   * Kept apart from `guardedBy` because they answer different questions — *has anyone evaluated
   * the guard yet?* and *who has standing to take this edge?* — and folding the second into the
   * enum of the first would tangle them the moment a third combination appears. Absent means
   * every role the write path admits, which the schema already limits to staff.
   */
  requiresRole?: readonly UserRole[];
};

/** Every state except ESCALATED itself can escalate: the published guard row reads `* → ESCALATED`. */
const ESCALATION_GUARD =
  'a clause of the escalation rule fires, and the firing clause is recorded';

const ESCALATION_EDGES: Transition[] = TICKET_STATES.filter((state) => state !== 'ESCALATED').map(
  (state) => ({
    from: state,
    to: 'ESCALATED',
    guard: ESCALATION_GUARD,
    guardedBy: 'escalation-rule',
  }),
);

export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'NEW',
    to: 'TRIAGED',
    guard: 'triage returned a schema-valid object carrying its confidence',
    guardedBy: 'triage-agent',
  },
  {
    from: 'NEW',
    to: 'TRIAGE_FAILED',
    guard: 'schema violation, timeout, or an empty body after redaction',
    guardedBy: 'triage-agent',
  },
  {
    from: 'TRIAGED',
    to: 'DRAFTED',
    guard: 'a draft was produced for the ticket',
    guardedBy: 'draft-agent',
  },
  {
    from: 'DRAFTED',
    to: 'AWAITING_AGENT',
    guard: 'the validator reports grounded = true and the policy check passes',
    guardedBy: 'grounding-validator',
  },
  {
    from: 'AWAITING_AGENT',
    to: 'SENT',
    guard: 'approved_by is not null — a database constraint, not a convention',
    guardedBy: 'approval-constraint',
  },
  {
    from: 'SENT',
    to: 'RESOLVED',
    guard: 'the ticket is resolved; no further guard is published for this edge',
    guardedBy: 'console',
  },
  {
    from: 'RESOLVED',
    to: 'CLOSED',
    guard: 'the resolution is closed out; no further guard is published for this edge',
    guardedBy: 'console',
  },
  {
    from: 'ESCALATED',
    to: 'RESOLVED',
    guard: 'taken from the supervisor console; the human closes what was escalated to a human',
    guardedBy: 'console',
    requiresRole: ['supervisor'],
  },
  {
    from: 'CLOSED',
    to: 'REOPENED',
    guard:
      'a customer reply inside the retention window; the SLA clock restarts and retries are preserved. ' +
      'The customer supplies the event (their reply); staff or the system executes the state transition — ' +
      'the staff-only write policy is correct and permanent',
    guardedBy: 'reopen-window',
  },
  {
    from: 'REOPENED',
    to: 'TRIAGED',
    guard: 'the reopened ticket is triaged again',
    guardedBy: 'triage-agent',
  },
  ...ESCALATION_EDGES,
];

/** Every edge the machine publishes out of `from`, in the order the table declares them. */
export function transitionsFrom(from: TicketState): Transition[] {
  return TRANSITIONS.filter((transition) => transition.from === from);
}

export function findTransition(from: TicketState, to: TicketState): Transition | undefined {
  return TRANSITIONS.find((transition) => transition.from === from && transition.to === to);
}

/** True when the edge's guard is evaluated by a person at a console rather than by a component. */
export function isGuardAvailable(transition: Transition): boolean {
  return transition.guardedBy === 'console';
}

/** True when `role` may take this edge today. The server decides this; a console only mirrors it. */
export function isAvailableTo(transition: Transition, role: UserRole): boolean {
  if (!isGuardAvailable(transition)) return false;
  return transition.requiresRole ? transition.requiresRole.includes(role) : true;
}
