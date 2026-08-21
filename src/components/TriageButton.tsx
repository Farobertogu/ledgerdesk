'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Runs one triage cycle over one ticket.
 *
 * It is deliberately not a transition control. It sends no target state and no reason — it asks
 * for a cycle and reports what the cycle concluded. The state the ticket lands in is the
 * component's decision, taken from the rule, and a console that could name it would be a console
 * that could overrule it.
 *
 * Shown only where the machine gives the triage agent an edge, which is `NEW` and `REOPENED`. On
 * any other state the endpoint answers that there was nothing to do, and a button that reported
 * that would be a button whose only outcome is a shrug.
 */
export function TriageButton({ ticketId, enabled }: { ticketId: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/tickets/${ticketId}/triage`, { method: 'POST' });
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
        triage?: { outcome?: string; reason?: string | null; code?: string };
      } | null;

      if (!response.ok) {
        setNote(
          `${payload?.error?.code ?? `HTTP ${response.status}`} — ${
            payload?.error?.message ?? 'the cycle was refused'
          }`,
        );
        return;
      }

      const outcome = payload?.triage;
      // Reported rather than hidden: a cycle that abandoned the ticket because the ceiling had cut
      // looks exactly like a cycle that never ran, and the difference is the one an operator needs.
      if (outcome?.outcome === 'ABANDONED') {
        setNote(`abandoned — ${outcome.code ?? 'the system could not try'}; the ticket is untouched`);
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        title="Calls the model through the gateway, judges the envelope, and applies whatever the rule decides."
        className="rounded border border-accent px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
      >
        {busy ? 'triaging…' : 'run triage'}
      </button>
      {note ? <p className="text-[11px] text-rose-800">{note}</p> : null}
    </div>
  );
}
