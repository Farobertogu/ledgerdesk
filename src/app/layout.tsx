import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'LedgerDesk',
  description: 'LedgerDesk',
};

// The shared root has no session, database or legacy console composition.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
