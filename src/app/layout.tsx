import type { Metadata } from 'next';
import Link from 'next/link';

import './globals.css';
import { currentIdentity } from '@/server/session';

export const metadata: Metadata = {
  title: 'LedgerDesk',
  description: 'Support consoles over a versioned knowledge corpus.',
};

const CONSOLES = [
  { href: '/portal', label: 'Customer portal' },
  { href: '/queue', label: 'Agent queue' },
  { href: '/supervisor', label: 'Supervisor' },
  // A first-level route with an entry of its own, because the second act arrives here from a ticket
  // screen and a nested route would cost a live rescue. Named for what it shows and not for the
  // quality surface it does not stand in for.
  { href: '/promotion', label: 'Promotion gate' },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const identity = await currentIdentity();

  return (
    <html lang="en-AU">
      <body className="min-h-screen">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-3 px-6 py-4">
            <Link href="/" className="text-sm font-semibold tracking-tight text-ink">
              LedgerDesk
            </Link>
            <nav className="flex items-center gap-6 text-sm">
              {CONSOLES.map((console) => (
                <Link
                  key={console.href}
                  href={console.href}
                  className="text-muted transition-colors hover:text-accent"
                >
                  {console.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto text-sm">
              {identity ? (
                <Link href="/session" className="group flex items-center gap-2">
                  <span className="text-muted">{identity.org_name}</span>
                  <span className="rounded border border-line bg-accent-soft px-2 py-0.5 font-medium text-accent">
                    {identity.role}
                  </span>
                  <span className="text-muted underline-offset-4 group-hover:underline">change</span>
                </Link>
              ) : (
                <Link href="/session" className="font-medium text-accent underline-offset-4 hover:underline">
                  Choose a session
                </Link>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>

        <footer className="mx-auto max-w-5xl px-6 pb-10 text-xs text-muted">
          Development build. The session selector stands in for the platform sign-in; the row-level
          policies in the database are the ones that decide what each session can see.
        </footer>
      </body>
    </html>
  );
}
