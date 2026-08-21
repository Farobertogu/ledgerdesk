import Link from 'next/link';

import { formatInstant } from '@/components/format';
import { Notice, PageHeading, Panel } from '@/components/Panel';
import { StatusPill } from '@/components/StatusPill';
import { claimsFor, currentIdentity } from '@/server/session';
import { listTickets } from '@/server/tickets';
import { NewTicketForm } from './NewTicketForm';

export const dynamic = 'force-dynamic';

export default async function PortalPage() {
  const identity = await currentIdentity();

  if (!identity) {
    return (
      <>
        <PageHeading title="Customer portal" lead="File a ticket and follow it by its tracking number." />
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

  if (identity.role !== 'customer') {
    return (
      <>
        <PageHeading title="Customer portal" lead="File a ticket and follow it by its tracking number." />
        <Notice>
          This console belongs to the customer role; the session in force is{' '}
          <span className="font-medium">{identity.role}</span>.{' '}
          <Link href="/session" className="text-accent underline-offset-4 hover:underline">
            Change session
          </Link>
          .
        </Notice>
      </>
    );
  }

  const tickets = await listTickets(claimsFor(identity));

  return (
    <>
      <PageHeading
        title="Customer portal"
        lead={`Filing as a customer of ${identity.org_name}. A filed ticket comes back with its tracking number and starts in NEW.`}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="New ticket" hint="Subject and description; everything else is assigned downstream.">
          <NewTicketForm />
        </Panel>

        <Panel
          title="Your tickets"
          hint="Only your own rows appear here, and that is the database's doing: the policy on the ticket table narrows a customer to the rows they filed."
        >
          {tickets.length === 0 ? (
            <p className="text-sm text-muted">No tickets yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {tickets.map((ticket) => (
                <li key={ticket.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{ticket.subject}</p>
                    <StatusPill status={ticket.status} />
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted">tracking {ticket.id}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    filed {formatInstant(ticket.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
