'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { TicketState, Transition } from '@/server/states';

/**
 * The edges out of one ticket's current state.
 *
 * Edges whose guard belongs to a component that has not been built are shown, disabled, with the
 * component named — a queue that hides them would make the machine look smaller than it is. The
 * server refuses them regardless of what this component renders.
 */
export function TransitionControls({
  ticketId,
  transitions,
}: {
  ticketId: string;
  transitions: Transition[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<TicketState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function apply(to: TicketState) {
    setBusy(to);
    setFailure(null);
    try {
      const response = await fetch(`/api/tickets/${ticketId}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        setFailure(
          `${payload?.error?.code ?? `HTTP ${response.status}`} — ${
            payload?.error?.message ?? 'the transition was refused'
          }`,
        );
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (transitions.length === 0) {
    return <span className="text-xs text-muted">no transition is published out of this state</span>;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {transitions.map((transition) => {
          const available = transition.guardedBy === 'console';
          return (
            <button
              key={transition.to}
              type="button"
              disabled={!available || busy !== null}
              onClick={() => void apply(transition.to)}
              title={
                available
                  ? transition.guard
                  : `guard: ${transition.guard} — evaluated by ${transition.guardedBy}`
              }
              className={
                available
                  ? 'rounded border border-accent px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-50'
                  : 'cursor-not-allowed rounded border border-dashed border-line px-2 py-0.5 font-mono text-[11px] text-muted'
              }
            >
              {busy === transition.to ? '…' : `→ ${transition.to}`}
            </button>
          );
        })}
      </div>
      {failure ? <p className="text-[11px] text-rose-800">{failure}</p> : null}
    </div>
  );
}
