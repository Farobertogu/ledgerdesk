'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Acknowledgement = {
  tracking_id: string;
  status: string;
  acknowledgement: string;
};

/**
 * The form posts to the same route handler the tests exercise. There is no second write path for
 * the browser: what a person clicks and what the test asserts are the one endpoint.
 */
export function NewTicketForm() {
  const router = useRouter();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Acknowledgement | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      const response = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject, body }),
      });
      const payload = (await response.json().catch(() => null)) as
        | (Acknowledgement & { error?: { message?: string } })
        | null;

      if (response.status !== 201 || !payload) {
        setError(payload?.error?.message ?? `the ticket was not filed (HTTP ${response.status})`);
        return;
      }

      setReceipt(payload);
      setSubject('');
      setBody('');
      router.refresh();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      {receipt ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p>{receipt.acknowledgement}</p>
          <p className="mt-2 font-mono text-[11px]">
            tracking {receipt.tracking_id} · status {receipt.status}
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="subject" className="block text-sm font-medium">
            Subject
          </label>
          <input
            id="subject"
            name="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            required
            maxLength={200}
            className="mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            placeholder="Duplicate charge on invoice INV-10021"
          />
        </div>

        <div>
          <label htmlFor="body" className="block text-sm font-medium">
            What happened
          </label>
          <textarea
            id="body"
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            rows={5}
            maxLength={8000}
            className="mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            placeholder="My card was billed twice for the same invoice on 3 March."
          />
        </div>

        <button
          type="submit"
          disabled={sending || !subject.trim() || !body.trim()}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? 'Filing…' : 'File ticket'}
        </button>
      </form>
    </div>
  );
}
