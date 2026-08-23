'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The two acts a person performs on an open knowledge gap: letting a document in, and asking the
 * question again.
 *
 * **A control and not a script**, and that is the whole reason this exists as a form. The admission
 * ties the approver to the session that performed it — the database refuses the advance unless the
 * subject of the session is the approver the chain row names — so **a COMPONENT cannot do it at
 * all**: the machine actor carries an organisation and a role and no subject, and there is no
 * session it can present that satisfies the tie. A script is a different matter and the distinction
 * is worth keeping straight: a script holding a signed-in supervisor's session admits perfectly
 * well, and the suite's own harness does exactly that. What the tie buys is not that a terminal is
 * locked out; it is that whatever admits is acting as a named person, which is what makes the
 * approver on the panel afterwards mean something.
 *
 * **`citable` starts with neither option chosen.** Whether a document may be quoted back to a
 * customer is a decision, and a pre-selected radio is a decision taken on somebody's behalf and
 * attributed to them. The form will not submit until it is answered.
 *
 * **The outcome is reported, never assumed.** A verification that did not close the gap says why, in
 * the sentence the server produced. A control that appears to do nothing, in front of an audience,
 * is worse than one that reports a refusal.
 */
export function GapControls({
  gapId,
  state,
  role,
  admitted,
}: {
  gapId: string;
  state: string;
  role: string;
  /** Whether material has already been admitted against this gap. */
  admitted: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [citable, setCitable] = useState<'yes' | 'no' | null>(null);

  const isOpen = state === 'OPEN';
  const isSupervisor = role === 'supervisor';
  const isStaff = role === 'agent' || role === 'supervisor';

  async function admit(form: FormData) {
    if (citable === null) {
      setNote('say whether this document may be quoted to a customer before admitting it');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/gaps/${gapId}/admit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          canonical_key: String(form.get('canonical_key') ?? ''),
          title: String(form.get('title') ?? ''),
          body: String(form.get('body') ?? ''),
          citable: citable === 'yes',
          provenance: {
            source: String(form.get('source') ?? ''),
            obtained_at: String(form.get('obtained_at') ?? ''),
            citability: String(form.get('citability') ?? ''),
          },
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
        admission?: { snapshot_from?: string; snapshot_to?: string; resumed?: boolean };
      } | null;

      if (!response.ok) {
        setNote(
          `${payload?.error?.code ?? `HTTP ${response.status}`} — ${
            payload?.error?.message ?? 'the admission was refused'
          }`,
        );
        return;
      }

      setNote(
        `admitted: ${payload?.admission?.snapshot_from} → ${payload?.admission?.snapshot_to}` +
          (payload?.admission?.resumed ? ' (an earlier attempt had already recorded it)' : ''),
      );
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/gaps/${gapId}/verify`, { method: 'POST' });
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
        verification?: { outcome?: string; because?: string; canonical_key?: string; code?: string };
      } | null;

      if (!response.ok) {
        setNote(
          `${payload?.error?.code ?? `HTTP ${response.status}`} — ${
            payload?.error?.message ?? 'the re-run was refused'
          }`,
        );
        return;
      }

      const outcome = payload?.verification;
      if (outcome?.outcome === 'CLOSED') {
        setNote(`closed by verification against ${outcome.canonical_key}`);
      } else if (outcome?.outcome === 'ABANDONED') {
        setNote(`the system could not attempt this — ${outcome.code ?? 'no code reported'}`);
      } else {
        setNote(`still open — ${outcome?.because ?? 'no reason reported'}`);
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!isStaff || !isOpen) return null;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {isSupervisor ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setOpen((was) => !was)}
            title="Lets one document into this organisation's corpus, under your own name, and moves the snapshot."
            className="rounded border border-accent px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
          >
            {open ? 'cancel' : 'admit material'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || !admitted}
          onClick={() => void verify()}
          title={
            admitted
              ? 'Asks the stored question again under the snapshot in force, and closes the gap only if the answer cites the admitted source.'
              : 'Nothing has been admitted against this gap yet, so the corpus has not changed.'
          }
          className="rounded border border-line px-2 py-0.5 font-mono text-[11px] transition-colors hover:bg-accent-soft disabled:opacity-40"
        >
          {busy ? 'running…' : 're-run the question'}
        </button>
      </div>

      {open && isSupervisor ? (
        <form
          action={admit}
          className="space-y-2 rounded border border-line p-3"
        >
          <Field name="canonical_key" label="canonical key" placeholder="ops/audit-trail-visibility" />
          <Field name="title" label="title" placeholder="Who can see the audit trail of a shipment" />
          <div className="space-y-1">
            <label htmlFor="body" className="block font-mono text-[11px] text-muted">
              body
            </label>
            <textarea
              id="body"
              name="body"
              required
              rows={5}
              className="w-full rounded border border-line bg-transparent p-2 text-sm"
            />
          </div>
          <Field name="source" label="source" placeholder="Operations handbook, section 4" />
          <Field name="obtained_at" label="obtained at" placeholder="2026-08-24" />
          <Field name="citability" label="citability" placeholder="cleared for customer replies by operations" />

          <fieldset className="space-y-1">
            <legend className="font-mono text-[11px] text-muted">
              may this be quoted to a customer?
            </legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="citable"
                  checked={citable === 'yes'}
                  onChange={() => setCitable('yes')}
                />
                yes
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="citable"
                  checked={citable === 'no'}
                  onChange={() => setCitable('no')}
                />
                no
              </label>
            </div>
          </fieldset>

          <button
            type="submit"
            disabled={busy}
            className="rounded border border-accent px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
          >
            {busy ? 'admitting…' : 'admit under my name'}
          </button>
        </form>
      ) : null}

      {note ? <p className="font-mono text-[11px] text-rose-800">{note}</p> : null}
    </div>
  );
}

function Field({ name, label, placeholder }: { name: string; label: string; placeholder: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={name} className="block font-mono text-[11px] text-muted">
        {label}
      </label>
      <input
        id={name}
        name={name}
        required
        placeholder={placeholder}
        className="w-full rounded border border-line bg-transparent p-1.5 text-sm"
      />
    </div>
  );
}
