import Link from 'next/link';

import { PageHeading, Panel } from '@/components/Panel';
import { currentIdentity } from '@/server/session';

export const dynamic = 'force-dynamic';

const CONSOLES = [
  {
    href: '/portal',
    title: 'Customer portal',
    role: 'customer',
    description: 'File a ticket and follow it by its tracking number.',
  },
  {
    href: '/queue',
    title: 'Agent queue',
    role: 'agent',
    description: 'The organisation’s tickets, with the transitions each one publishes.',
  },
  {
    href: '/supervisor',
    title: 'Supervisor',
    role: 'supervisor',
    description: 'The same queue, counted by state.',
  },
];

export default async function HomePage() {
  const identity = await currentIdentity();

  return (
    <>
      <PageHeading
        title="LedgerDesk consoles"
        lead="Three consoles over one tenanted database. Which rows a console shows is decided by the row-level policies in the schema, not by the queries on this side of the connection."
      />

      <Panel
        title="Session"
        hint="Identity for the build: the seeded users of the two organisations."
      >
        {identity ? (
          <p className="text-sm">
            Acting as{' '}
            <span className="font-medium">
              {identity.role} of {identity.org_name}
            </span>
            .{' '}
            <Link href="/session" className="text-accent underline-offset-4 hover:underline">
              Change session
            </Link>
          </p>
        ) : (
          <p className="text-sm">
            No session selected.{' '}
            <Link href="/session" className="text-accent underline-offset-4 hover:underline">
              Choose one
            </Link>{' '}
            to reach the consoles — without claims the policies return nothing, which is the correct
            answer and not an error.
          </p>
        )}
      </Panel>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {CONSOLES.map((console) => (
          <Link
            key={console.href}
            href={console.href}
            className="rounded border border-line bg-surface px-5 py-4 transition-colors hover:border-accent"
          >
            <h2 className="text-sm font-semibold tracking-tight">{console.title}</h2>
            <p className="mt-1 font-mono text-[11px] text-muted">{console.role}</p>
            <p className="mt-3 text-sm text-muted">{console.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
