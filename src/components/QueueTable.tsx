import { formatInstant } from '@/components/format';
import { StatusPill } from '@/components/StatusPill';
import { TransitionControls } from '@/components/TransitionControls';
import type { UserRole } from '@/server/db';
import { isAvailableTo, transitionsFrom } from '@/server/states';
import type { Ticket } from '@/server/tickets';

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
      <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-4 font-medium">Ticket</th>
            <th className="py-2 pr-4 font-medium">State</th>
            <th className="py-2 pr-4 font-medium">Filed</th>
            {actionable ? <th className="py-2 font-medium">Transitions</th> : null}
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id} className="border-b border-line align-top last:border-0">
              <td className="py-3 pr-4">
                <p className="font-medium">{ticket.subject}</p>
                <p className="mt-0.5 font-mono text-[11px] text-muted">{ticket.id}</p>
              </td>
              <td className="py-3 pr-4">
                <StatusPill status={ticket.status} />
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-muted">
                {formatInstant(ticket.created_at)}
              </td>
              {actionable ? (
                <td className="py-3">
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
