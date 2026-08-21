'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import type { Identity } from '@/server/session';

const DESTINATION: Record<Identity['role'], string> = {
  customer: '/portal',
  agent: '/queue',
  supervisor: '/supervisor',
};

export function IdentityPicker({
  identities,
  activeUserId,
}: {
  identities: Identity[];
  activeUserId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(identity: Identity) {
    setBusyId(identity.user_id);
    setError(null);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: identity.user_id }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? 'the session could not be selected');
        return;
      }
      startTransition(() => {
        router.push(DESTINATION[identity.role]);
        router.refresh();
      });
    } finally {
      setBusyId(null);
    }
  }

  const byOrg = new Map<string, Identity[]>();
  for (const identity of identities) {
    const bucket = byOrg.get(identity.org_name) ?? [];
    bucket.push(identity);
    byOrg.set(identity.org_name, bucket);
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900">
          {error}
        </p>
      ) : null}

      {[...byOrg.entries()].map(([orgName, members]) => (
        <div key={orgName}>
          <h3 className="text-sm font-semibold tracking-tight">{orgName}</h3>
          <ul className="mt-3 divide-y divide-line rounded border border-line">
            {members.map((identity) => {
              const active = identity.user_id === activeUserId;
              return (
                <li
                  key={identity.user_id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                >
                  <span className="w-24 text-sm font-medium">{identity.role}</span>
                  <span className="font-mono text-[11px] text-muted">{identity.user_id}</span>
                  <button
                    type="button"
                    onClick={() => void choose(identity)}
                    disabled={active || pending || busyId !== null}
                    className="ml-auto rounded border border-line px-3 py-1 text-sm text-accent transition-colors hover:border-accent disabled:cursor-not-allowed disabled:border-line disabled:text-muted"
                  >
                    {active ? 'in force' : busyId === identity.user_id ? 'selecting…' : 'act as'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
