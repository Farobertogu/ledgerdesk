import { formatInstant } from '@/components/format';
import { StatusPill } from '@/components/StatusPill';
import { TransitionControls } from '@/components/TransitionControls';
import { TriageButton } from '@/components/TriageButton';
import type { UserRole } from '@/server/db';
import { isAvailableTo, transitionsFrom } from '@/server/states';
import type { Ticket } from '@/server/tickets';

/** The states the machine gives the triage agent an edge out of. */
const TRIAGEABLE = new Set(['NEW', 'REOPENED']);

/**
 * A dash, and not a zero or a blank.
 *
 * Every triage column is null until a cycle writes it, and the three readings are different facts:
 * "nothing has looked at this yet", "the model said 0.000", and "there is no value here". A dash
 * says the first without pretending to be the second.
 */
function orDash(value: string | number | null): string {
  return value === null || value === '' ? '—' : String(value);
}

/**
 * Whether the SLA instant has passed, computed at render.
 *
 * `breached_at` is a column and it is not this: nothing writes it, and a breach is a fact about
 * the clock rather than a fact about the row. The same comparison the rule makes — strictly
 * after the due instant — is the one made here, so the screen and the rule cannot disagree.
 */
function isBreached(slaDueAt: string | null): boolean {
  return slaDueAt !== null && Date.now() > new Date(slaDueAt).getTime();
}

export function QueueTable({
  tickets,
  role,
  actionable,
}: {
  tickets: Ticket[];
  role: UserRole;
  actionable: boolean;
}) {
  if (tickets.length === 0) {
    return <p className="text-sm text-muted">No tickets are visible to this session.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[72rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-4 font-medium">Ticket</th>
            <th className="py-2 pr-4 font-medium">State</th>
            <th className="py-2 pr-4 font-medium">Triage</th>
            <th className="py-2 pr-4 font-medium" title="Sentiment and confidence, at the three decimals the columns store.">
              Signals
            </th>
            <th className="py-2 pr-4 font-medium" title="The stored composite score, at six decimals.">
              Priority
            </th>
            <th className="py-2 pr-4 font-medium">First response due</th>
            <th className="py-2 pr-4 font-medium">Filed</th>
            {actionable ? <th className="py-2 font-medium">Transitions</th> : null}
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => {
            const breached = isBreached(ticket.sla_due_at);
            return (
              <tr key={ticket.id} className="border-b border-line align-top last:border-0">
                <td className="py-3 pr-4">
                  <p className="font-medium">{ticket.subject}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted">{ticket.id}</p>
                </td>

                <td className="py-3 pr-4">
                  <StatusPill status={ticket.status} />
                  {ticket.escalation_reason ? (
                    <p
                      className="mt-1 font-mono text-[11px] text-rose-800"
                      title={`clause: ${ticket.escalation_clause ?? 'unnamed'}`}
                    >
                      {ticket.escalation_reason}
                      <span className="ml-1 text-muted">· {orDash(ticket.escalation_clause)}</span>
                    </p>
                  ) : null}
                </td>

                <td className="py-3 pr-4">
                  <p>{orDash(ticket.category)}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted">
                    sev {orDash(ticket.severity)}
                  </p>
                </td>

                <td className="py-3 pr-4 font-mono text-[11px] text-muted">
                  <p>sent {orDash(ticket.sentiment)}</p>
                  <p className="mt-0.5">conf {orDash(ticket.confidence)}</p>
                </td>

                <td className="py-3 pr-4 font-mono text-[11px] tabular-nums">
                  {orDash(ticket.priority)}
                </td>

                <td className="py-3 pr-4 font-mono text-[11px]">
                  <span className={breached ? 'text-rose-800' : 'text-muted'}>
                    {formatInstant(ticket.sla_due_at)}
                  </span>
                  {breached ? (
                    <p className="mt-0.5 text-rose-800" title="The due instant has passed.">
                      breached
                    </p>
                  ) : null}
                </td>

                <td className="py-3 pr-4 font-mono text-[11px] text-muted">
                  {formatInstant(ticket.created_at)}
                </td>

                {actionable ? (
                  <td className="py-3 space-y-2">
                    <TriageButton ticketId={ticket.id} enabled={TRIAGEABLE.has(ticket.status)} />
                    <TransitionControls
                      ticketId={ticket.id}
                      // Availability is decided here, with the session's role, and travels to the
                      // client already resolved — the console never works it out for itself.
                      transitions={transitionsFrom(ticket.status).map((transition) => ({
                        to: transition.to,
                        guard: transition.guard,
                        guardedBy: transition.requiresRole
                          ? `${transition.guardedBy} (${transition.requiresRole.join(' or ')})`
                          : transition.guardedBy,
                        available: isAvailableTo(transition, role),
                      }))}
                    />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
