import Link from 'next/link';

import { Notice, PageHeading, Panel } from '@/components/Panel';
import { QueueTable } from '@/components/QueueTable';
import { claimsFor, currentIdentity } from '@/server/session';
import { listTickets } from '@/server/tickets';

export const dynamic = 'force-dynamic';

export default async function QueuePage() {
  const identity = await currentIdentity();

  if (!identity) {
    return (
      <>
        <PageHeading title="Agent queue" lead="The organisation's tickets, with the transitions each state publishes." />
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

  if (identity.role !== 'agent' && identity.role !== 'supervisor') {
    return (
      <>
        <PageHeading title="Agent queue" lead="The organisation's tickets, with the transitions each state publishes." />
        <Notice>
          This console belongs to the agent and supervisor roles; the session in force is{' '}
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
        title="Agent queue"
        lead={`Every ticket of ${identity.org_name} that this session may see. Tickets of the other organisation are absent because the policy on the table removes them, not because a filter here left them out.`}
      />

      <Panel
        title="Queue"
        hint="A dashed control is an edge the machine publishes whose guard is evaluated by a component that has not been built yet; hover it for the guard and its owner."
      >
        <QueueTable tickets={tickets} actionable />
      </Panel>
    </>
  );
}
