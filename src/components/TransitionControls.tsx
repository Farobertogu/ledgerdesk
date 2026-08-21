'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { TicketState } from '@/server/states';

/** One edge as a console needs it: where it goes, what its guard says, and whether this session may take it. */
export type ControlTransition = {
  to: TicketState;
  guard: string;
  guardedBy: string;
  available: boolean;
};

/**
 * The edges out of one ticket's current state.
 *
 * Edges this session cannot take are shown, disabled, with the reason — a component that has not
 * been built, or a role this session does not hold. A queue that hid them would make the machine
 * look smaller than it is. `available` is computed on the server and the server refuses anything
 * that arrives regardless of what this component rendered.
 */
export function TransitionControls({
  ticketId,
  transitions,
}: {
  ticketId: string;
  transitions: ControlTransition[];
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
        {transitions.map((transition) => (
          <button
            key={transition.to}
            type="button"
            disabled={!transition.available || busy !== null}
            onClick={() => void apply(transition.to)}
            title={
              transition.available
                ? transition.guard
                : `guard: ${transition.guard} — evaluated by ${transition.guardedBy}`
            }
            className={
              transition.available
                ? 'rounded border border-accent px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-50'
                : 'cursor-not-allowed rounded border border-dashed border-line px-2 py-0.5 font-mono text-[11px] text-muted'
            }
          >
            {busy === transition.to ? '…' : `→ ${transition.to}`}
          </button>
        ))}
      </div>
      {failure ? <p className="text-[11px] text-rose-800">{failure}</p> : null}
    </div>
  );
}
