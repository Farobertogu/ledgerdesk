'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Runs one drafting cycle over one ticket.
 *
 * Like its triage sibling it sends no target state and no reason: it asks for a cycle and reports
 * what the cycle concluded. What the ticket becomes is decided by the retrieval, the two agents and
 * the rule, and a console that could name it would be a console that could overrule it.
 *
 * Shown only in `TRIAGED`, which is the one state the machine gives the drafting agent an edge out
 * of. On any other state the endpoint answers that there was nothing to do, and a control whose
 * only outcome is a shrug is a control that should not be on screen.
 *
 * **The two silences are told apart, deliberately.** A cycle that escalated because the corpus had
 * no answer and a cycle the ceiling refused to let run both leave the screen looking similar and
 * are completely different facts. Pressing a control and watching nothing happen, in front of an
 * audience, is worse than an escalation — so `ABANDONED` says the system could not attempt this and
 * names the code, rather than refreshing quietly.
 */
export function DraftButton({ ticketId, enabled }: { ticketId: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/tickets/${ticketId}/draft`, { method: 'POST' });
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
        draft?: { outcome?: string; reason?: string | null; clause?: string | null; code?: string };
      } | null;

      if (!response.ok) {
        setNote(
          `${payload?.error?.code ?? `HTTP ${response.status}`} — ${
            payload?.error?.message ?? 'the cycle was refused'
          }`,
        );
        return;
      }

      const outcome = payload?.draft;
      if (outcome?.outcome === 'ABANDONED') {
        setNote(
          `the system could not attempt this — ${outcome.code ?? 'no code reported'}; the ticket is untouched`,
        );
      } else if (outcome?.outcome === 'ESCALATED_NO_SOURCES') {
        setNote('no source was retrieved, so no draft was written and the ticket went to a person');
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
        title="Searches the knowledge base at the snapshot in force, drafts a reply from what it finds, and has the draft checked against those sources."
        className="rounded border border-accent px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
      >
        {busy ? 'drafting…' : 'run draft'}
      </button>
      {note ? <p className="text-[11px] text-rose-800">{note}</p> : null}
    </div>
  );
}
