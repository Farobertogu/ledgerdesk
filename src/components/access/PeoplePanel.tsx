'use client';
import { useEffect, useRef, useState } from 'react';
import { validateAccess, validateAccessProblem } from '../../contracts/access';
import { StaleView, verifySession, ViewLifetime } from './view_lifecycle';
export default function PeoplePanel({
  apiOrigin,
  sessionToken,
  onSessionChanged,
}: {
  apiOrigin: string;
  sessionToken: string;
  onSessionChanged: () => void;
}) {
  const lifetime = useRef(new ViewLifetime());
  const [people, setPeople] = useState<
      { account_id: string; display_name: string }[]
    >([]),
    [cursor, setCursor] = useState(''),
    [message, setMessage] = useState(
      'Load the people this session is authorized to see.',
    ),
    [busy, setBusy] = useState(false);
  useEffect(() => () => lifetime.current.reset(), []);
  async function load(next: string) {
    const lease = lifetime.current.capture();
    setBusy(true);
    setPeople([]);
    setCursor('');
    try {
      const signal = AbortSignal.any([
        lease.signal,
        AbortSignal.timeout(10000),
      ]);
      await verifySession(apiOrigin, sessionToken, signal);
      const r = await fetch(
        apiOrigin +
          '/api/access/v1/people' +
          (next ? '?cursor=' + encodeURIComponent(next) : ''),
        {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          signal,
        },
      );
      const raw = await r.text();
      if (raw.length > 262144) throw Error('Invalid census response.');
      const body = JSON.parse(raw);
      lifetime.current.assert(lease.epoch);
      await verifySession(apiOrigin, sessionToken, signal);
      lifetime.current.assert(lease.epoch);
      if (!r.ok) {
        if (
          !validateAccessProblem(
            body,
            r.status,
            r.headers.get('content-type') ?? '',
          )
        )
          throw Error('Invalid census response.');
        throw Error(
          body.code === 'unavailable'
            ? 'This view is unavailable. Reload from the first page.'
            : 'The census could not be confirmed. Try again.',
        );
      }
      if (
        r.headers.get('content-type')?.split(';')[0] !== 'application/json' ||
        !validateAccess('people', 'response', body)
      )
        throw Error('Invalid census response.');
      setPeople(body.people);
      setCursor(body.next_cursor);
      setMessage(
        body.people.length
          ? 'Authorized people in this page.'
          : 'No people in this authorized page.',
      );
    } catch (e) {
      if (lease.epoch !== lifetime.current.epoch) return;
      if (e instanceof StaleView) onSessionChanged();
      else
        setMessage(
          e instanceof Error ? e.message : 'The census could not be confirmed.',
        );
    } finally {
      if (lease.epoch === lifetime.current.epoch) setBusy(false);
    }
  }
  return (
    <section className="people-panel" aria-label="Authorized people">
      <h2>Authorized people</h2>
      <p>
        This is a scoped census, not a directory of every account. It does not
        reveal roles, permissions or credentials.
      </p>
      <button disabled={busy} onClick={() => void load('')}>
        Load authorized people
      </button>
      <ul>
        {people.map((p) => (
          <li key={p.account_id}>
            <strong>{p.display_name}</strong>
            <span className="person-reference">{p.account_id}</span>
          </li>
        ))}
      </ul>
      {cursor && (
        <button disabled={busy} onClick={() => void load(cursor)}>
          Next authorized page
        </button>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
