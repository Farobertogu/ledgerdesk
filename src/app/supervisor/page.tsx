import Link from 'next/link';

import { Notice, PageHeading, Panel } from '@/components/Panel';
import { QueueTable } from '@/components/QueueTable';
import { StatusPill } from '@/components/StatusPill';
import { claimsFor, currentIdentity } from '@/server/session';
import { TICKET_STATES } from '@/server/states';
import { countTicketsByState, listTickets } from '@/server/tickets';

export const dynamic = 'force-dynamic';

export default async function SupervisorPage() {
  const identity = await currentIdentity();

  if (!identity) {
    return (
      <>
        <PageHeading title="Supervisor" lead="The queue, counted by state." />
        <Notice>
          No session is selected.{' '}
          <Link href="/session" className="text-accent underline-offset-4 hover:underline">
            Choose one
          </Link>{' '}
          to continue.
        </Notice>
      </>
    );
  }

  if (identity.role !== 'supervisor') {
    return (
      <>
        <PageHeading title="Supervisor" lead="The queue, counted by state." />
        <Notice>
          This console belongs to the supervisor role; the session in force is{' '}
          <span className="font-medium">{identity.role}</span>.{' '}
          <Link href="/session" className="text-accent underline-offset-4 hover:underline">
            Change session
          </Link>
          .
        </Notice>
      </>
    );
  }

  const claims = claimsFor(identity);
  const [counts, tickets] = await Promise.all([
    countTicketsByState(claims),
    listTickets(claims),
  ]);

  const byState = new Map(counts.map((row) => [row.status, row.n]));
  const total = counts.reduce((sum, row) => sum + row.n, 0);
  const occupied = TICKET_STATES.filter((state) => (byState.get(state) ?? 0) > 0);

  return (
    <>
      <PageHeading
        title="Supervisor"
        lead={`${identity.org_name}: the same queue an agent sees, with the count per state. Volume, service levels and the accuracy panel arrive with the measurement cards; this page reports only what the rows themselves say.`}
      />

      <Panel
        title={`Tickets by state · ${total} visible`}
        hint="Counted over exactly the rows this session may see, so the total is a tenant total and not a system total."
      >
        {occupied.length === 0 ? (
          <p className="text-sm text-muted">No tickets are visible to this session.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-8 gap-y-4">
            {occupied.map((state) => (
              <li key={state} className="min-w-24">
                <p className="text-2xl font-semibold tabular-nums">{byState.get(state) ?? 0}</p>
                <p className="mt-1">
                  <StatusPill status={state} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="mt-6">
        <Panel
          title="Queue"
          hint="A supervisor holds the agent's write role and one edge the agent does not: closing out what was escalated."
        >
          <QueueTable tickets={tickets} role={identity.role} actionable />
        </Panel>
      </div>
    </>
  );
}
