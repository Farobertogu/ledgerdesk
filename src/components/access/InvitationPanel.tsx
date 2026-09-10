'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ACCESS_ROUTES,
  validateAccess,
  validateAccessProblem,
  type AccessRoute,
} from '../../contracts/access';
import { accessPath } from '../../contracts/access_canonical';
import type { InvitationAction } from '../../contracts/access_presentation';
import {
  assertLocalContext,
  IntentionSlot,
  StaleView,
  verifySession,
  verifySessionForView,
} from './view_lifecycle';

type Term = {
  permission_id: string;
  exercise_or_grant: 'exercise' | 'grant';
  scope_ref: string;
  support_ref: string;
  permission_label: string;
  scope_label: string;
  purpose_ref: string;
  support_label: string;
  continuity: string;
  expires_at: number;
  authority_declarations: {
    declaration_ref: string;
    revision: number;
    accreditation: string;
  }[];
};
type View = {
  invitation_id: string;
  revision: number;
  email: string;
  family: string;
  expires_at: number;
  state: string;
  terms: Term[];
  accepted_grants: { grant_id: string; revision: number }[];
  available_actions: InvitationAction[];
};
const selector = (t: Term) => ({
  permission_id: t.permission_id,
  exercise_or_grant: t.exercise_or_grant,
  scope_ref: t.scope_ref,
  support_ref: t.support_ref,
});

export default function InvitationPanel({
  apiOrigin,
  authenticated,
  sessionToken,
  onSessionChanged,
  ready,
}: {
  apiOrigin: string;
  authenticated: boolean;
  sessionToken: string;
  onSessionChanged: () => void;
  ready: boolean;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [locator, setLocator] = useState(''),
    [challenge, setChallenge] = useState(''),
    [code, setCode] = useState(''),
    [proof, setProof] = useState('');
  const [view, setView] = useState<View | null>(null),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState('');
  const [options, setOptions] = useState<{ family: string; term: Term }[]>([]),
    [choice, setChoice] = useState('0');
  const flowCsrf = useRef(''),
    sessionCsrf = useRef(''),
    pending = useRef(new IntentionSlot());
  const [operationId, setOperationId] = useState('');
  const generation = useRef(0),
    abort = useRef<AbortController | null>(null);
  async function call(
    route: AccessRoute,
    body: Record<string, unknown> = {},
    parameters: Record<string, string> = {},
  ) {
    const admittedGeneration = generation.current;
    if (!validateAccess(route, 'request', body))
      throw Error('Check the fields and try again.');
    const path = accessPath(route, parameters),
      post = ACCESS_ROUTES[route].method === 'POST';
    const request = post
      ? pending.current.prepare(route, parameters, body)
      : null;
    const administrative = [
      'issue_invitation',
      'amend_invitation',
      'withdraw_invitation',
      'withdraw_grant',
    ].includes(route);
    const provisional = [
      'invitation_challenge',
      'verify_invitation_email',
      'initial_credential',
    ].includes(route);
    const csrf =
      administrative || (authenticated && !provisional)
        ? sessionCsrf.current
        : flowCsrf.current;
    const signal = AbortSignal.any([
      AbortSignal.timeout(10000),
      abort.current!.signal,
    ]);
    if (authenticated && !provisional)
      await verifySession(apiOrigin, sessionToken, signal);
    const r = await fetch(apiOrigin + path, {
      method: ACCESS_ROUTES[route].method,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal,
      ...(post
        ? {
            headers: {
              'content-type': 'application/json',
              'x-ledgerdesk-csrf': csrf,
              'x-ledgerdesk-intent': request!.key,
            },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const raw = await r.text();
    assertLocalContext(admittedGeneration, generation.current);
    if (authenticated && !provisional)
      await verifySessionForView(apiOrigin, sessionToken, signal, () =>
        assertLocalContext(admittedGeneration, generation.current),
      );
    if (raw.length > 262144) throw Error('Invalid service response.');
    const result = JSON.parse(raw);
    if (!r.ok) {
      if (
        !validateAccessProblem(
          result,
          r.status,
          r.headers.get('content-type') ?? '',
        )
      )
        throw Error('Invalid service response.');
      if (request && r.status < 500) pending.current.confirm(request);
      throw Error(
        result.code === 'revision_conflict'
          ? 'The invitation changed. Load its current terms before accepting or changing it.'
          : result.code === 'technical_failure'
            ? 'The service could not confirm the result. Retry the unchanged request to reconcile it.'
            : result.code === 'rate_limited'
              ? 'Too many attempts. Wait before trying again.'
              : 'This operation is not permitted. Check your account, invitation and verification details.',
      );
    }
    if (
      r.headers.get('content-type')?.split(';')[0] !== 'application/json' ||
      !validateAccess(route, 'response', result)
    )
      throw Error('Invalid service response.');
    if (request) pending.current.confirm(request);
    if (result.operation_id && route !== 'operation_result')
      setOperationId(result.operation_id);
    return result;
  }
  async function run(action: () => Promise<void>) {
    const admittedGeneration = generation.current;
    setBusy(true);
    setMessage('Working…');
    try {
      await action();
    } catch (e) {
      if (admittedGeneration !== generation.current) return;
      if (e instanceof StaleView) {
        onSessionChanged();
        return;
      }
      setView(null);
      setMessage(
        e instanceof TypeError || e instanceof DOMException
          ? 'No result was received. The operation may have completed. Retry the unchanged request before starting another.'
          : (e as Error).message,
      );
    } finally {
      if (admittedGeneration === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    generation.current++;
    abort.current?.abort();
    abort.current = new AbortController();
    setOpen(false);
    setView(null);
    setProof('');
    setOptions([]);
    setBusy(false);
    setMessage('');
    setLocator('');
    setChallenge('');
    setCode('');
    setEmail('');
    setPassword('');
    setChoice('0');
    flowCsrf.current = '';
    sessionCsrf.current = '';
    pending.current.clear();
    setOperationId('');
    return () => {
      generation.current++;
      abort.current?.abort();
    };
  }, [authenticated, sessionToken]);
  const load = async () => {
    const v = await call('invitation_view', {}, { invitation_id: locator });
    setView(v);
    return v;
  };
  const actionId = { invitation_id: locator };
  const offered = (action: InvitationAction['action']) =>
    view?.available_actions.some((a) => a.action === action) ?? false;
  return (
    <section className="invitation-panel" aria-label="Invitations">
      <style>{`.invitation-panel{margin-top:32px;padding-top:24px;border-top:1px solid #d9e3f2}.invitation-panel h2{font-size:25px;margin:0 0 12px}.invitation-workspace{margin-top:20px;display:grid;grid-template-columns:1fr 1fr;gap:24px}.invitation-workspace>div{min-width:0}.invitation-panel select{max-width:100%;width:100%;padding:10px;font:inherit;background:white;border:1px solid #8fa3bf;border-radius:5px}.invitation-panel .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.invitation-panel dl{display:grid;grid-template-columns:minmax(90px,.5fr) 1fr;gap:10px;line-height:1.5}.invitation-panel dd{margin:0;overflow-wrap:anywhere}.invitation-terms{background:white;padding:22px;border-left:3px solid #2359ce;margin-top:20px}.invitation-panel .receipt{overflow-wrap:anywhere;font-size:14px}.invitation-panel label{margin-top:14px}@media(max-width:640px){.invitation-workspace{grid-template-columns:1fr}.invitation-panel dl{grid-template-columns:1fr;gap:5px}.invitation-panel dt{font-weight:600}}`}</style>
      <h2>Invitations, with exact terms.</h2>
      <p>
        Verify the nominated email, examine the current proposal and choose
        whether to accept it. An invitation never grants authority over material
        by itself.
      </p>
      {!open ? (
        <button
          disabled={busy || !ready}
          onClick={() =>
            void run(async () => {
              flowCsrf.current = (await call('reception')).csrf_token;
              if (authenticated) {
                sessionCsrf.current = (
                  await call('current_session')
                ).csrf_token;
                setOptions((await call('capabilities')).invitation_options);
              }
              setOpen(true);
              setMessage(
                'The service will check each operation against your current authority.',
              );
            })
          }
        >
          Open invitation workspace
        </button>
      ) : (
        <>
          <fieldset
            className="invitation-workspace"
            disabled={busy || !!pending.current.current}
            style={{ border: 0, padding: 0, minWidth: 0 }}
          >
            <div>
              <label htmlFor="invitation-id">Invitation identifier</label>
              <input
                id="invitation-id"
                value={locator}
                maxLength={128}
                onChange={(e) => {
                  setLocator(e.target.value);
                  setView(null);
                  setProof('');
                }}
              />
              <div className="actions">
                <button
                  disabled={busy || !locator}
                  onClick={() =>
                    void run(async () => {
                      await call('invitation_challenge', {}, actionId);
                      setMessage(
                        'Request received. If eligible, verification details will be delivered through the controlled mailbox.',
                      );
                    })
                  }
                >
                  Request invitation code
                </button>
                <button
                  disabled={busy || !locator}
                  onClick={() =>
                    void run(async () => {
                      await load();
                      setMessage(
                        'Current terms loaded. Review them before choosing an action.',
                      );
                    })
                  }
                >
                  Load invitation
                </button>
              </div>
              <label htmlFor="invitation-challenge">
                Invitation challenge identifier
              </label>
              <input
                id="invitation-challenge"
                value={challenge}
                maxLength={128}
                onChange={(e) => setChallenge(e.target.value)}
              />
              <label htmlFor="invitation-code">
                Invitation verification code
              </label>
              <input
                id="invitation-code"
                value={code}
                autoComplete="one-time-code"
                maxLength={43}
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="actions">
                <button
                  disabled={busy || !challenge || !code}
                  onClick={() =>
                    void run(async () => {
                      const p = await call(
                        'verify_invitation_email',
                        { code },
                        { challenge_id: challenge },
                      );
                      setProof(p.proof_id);
                      setCode('');
                      await load();
                      setMessage(
                        'Email verified. This has not accepted the invitation.',
                      );
                    })
                  }
                >
                  Verify invitation email
                </button>
              </div>
            </div>
            <div>
              {authenticated && options.length > 0 ? (
                <>
                  <h3>Prepare a proposal</h3>
                  <p>
                    Options come from your current granting authority. The
                    recipient must accept the exact proposal.
                  </p>
                  <label htmlFor="invitation-email">Recipient email</label>
                  <input
                    id="invitation-email"
                    type="email"
                    value={email}
                    maxLength={254}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <label htmlFor="invitation-option">Proposed permission</label>
                  <select
                    id="invitation-option"
                    value={choice}
                    onChange={(e) => setChoice(e.target.value)}
                  >
                    {options.map((o, i) => (
                      <option key={i} value={i}>
                        {o.term.permission_label} — {o.term.exercise_or_grant} —{' '}
                        {o.term.scope_label} — {o.term.support_label}
                      </option>
                    ))}
                  </select>
                  <div className="actions">
                    <button
                      disabled={busy || !email}
                      onClick={() =>
                        void run(async () => {
                          const o = options[Number(choice)];
                          const r = await call('issue_invitation', {
                            email,
                            family: o.family,
                            grants: [selector(o.term)],
                            expires_at: Math.min(
                              o.term.expires_at,
                              Date.now() + 300000,
                            ),
                          });
                          setLocator(r.invitation_id);
                          setView(null);
                          setMessage(
                            'Invitation recorded. It has not granted any permission.',
                          );
                        })
                      }
                    >
                      Create invitation
                    </button>
                  </div>
                </>
              ) : (
                <p>
                  Granting controls appear only when the service offers a
                  currently authorized proposal.
                </p>
              )}
              <label htmlFor="invitation-password">
                First password after acceptance
              </label>
              <input
                id="invitation-password"
                type="password"
                autoComplete="new-password"
                value={password}
                maxLength={1024}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="actions">
                <button
                  disabled={busy || !password}
                  onClick={() =>
                    void run(async () => {
                      await call('initial_credential', { password });
                      setPassword('');
                      setMessage(
                        'First password established. Use Sign in to start a session.',
                      );
                    })
                  }
                >
                  Set first password
                </button>
              </div>
              <small>
                If the acceptance flow was lost, use Recover with the same
                email. Recovery preserves the account and does not restore
                withdrawn permissions.
              </small>
            </div>
          </fieldset>
          {view && (
            <div className="invitation-terms">
              <h3>Review before accepting</h3>
              <dl>
                <dt>Recipient</dt>
                <dd>{view.email}</dd>
                <dt>Revision</dt>
                <dd>{view.revision}</dd>
                <dt>State</dt>
                <dd>{view.state}</dd>
                <dt>Invitation expires</dt>
                <dd>{new Date(view.expires_at).toISOString()}</dd>
              </dl>
              {view.terms.map((term, i) => (
                <dl key={i}>
                  <dt>Permission</dt>
                  <dd>
                    {term.permission_label} ({term.exercise_or_grant})
                  </dd>
                  <dt>Scope</dt>
                  <dd>{term.scope_label}</dd>
                  <dt>Purpose</dt>
                  <dd>{term.purpose_ref}</dd>
                  <dt>Continuity</dt>
                  <dd>
                    {term.support_label} ({term.continuity})
                  </dd>
                  <dt>Grant expires</dt>
                  <dd>{new Date(term.expires_at).toISOString()}</dd>
                  {term.authority_declarations.length > 0 && (
                    <>
                      <dt>Grantor declarations</dt>
                      <dd>
                        {term.authority_declarations.map((d) => (
                          <p key={d.declaration_ref}>
                            {d.declaration_ref}, revision {d.revision}:
                            registered, not externally accredited.
                          </p>
                        ))}
                      </dd>
                    </>
                  )}
                </dl>
              ))}
              <div className="actions">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !!pending.current.current ||
                    !proof ||
                    !offered('accept_invitation')
                  }
                  onClick={() =>
                    void run(async () => {
                      const r = await call(
                        'accept_invitation',
                        { expected_revision: view.revision, proof_id: proof },
                        actionId,
                      );
                      setView(null);
                      setMessage(
                        'Acceptance completed. Operation ' +
                          r.operation_id +
                          '. This does not establish an investiture or unrestricted reading.',
                      );
                    })
                  }
                >
                  Accept displayed revision
                </button>
                {offered('amend_invitation') && (
                  <>
                    <button
                      disabled={
                        busy ||
                        !!pending.current.current ||
                        !options[Number(choice)] ||
                        options[Number(choice)].family !== view.family
                      }
                      onClick={() =>
                        void run(async () => {
                          const o = options[Number(choice)];
                          await call(
                            'amend_invitation',
                            {
                              expected_revision: view.revision,
                              grants: [selector(o.term)],
                            },
                            actionId,
                          );
                          setView(null);
                          setMessage(
                            'Proposal amended. The recipient must accept its new revision.',
                          );
                        })
                      }
                    >
                      Amend proposed permission
                    </button>
                  </>
                )}
                {offered('withdraw_invitation') && (
                  <button
                    disabled={busy || !!pending.current.current}
                    onClick={() =>
                      void run(async () => {
                        await call(
                          'withdraw_invitation',
                          {
                            expected_revision: view.revision,
                            reason: 'Pending proposal withdrawn',
                          },
                          actionId,
                        );
                        setView(null);
                        setMessage('Pending invitation withdrawn.');
                      })
                    }
                  >
                    Withdraw pending invitation
                  </button>
                )}
                {view.available_actions
                  .filter((a) => a.action === 'withdraw_grant')
                  .map((g) => (
                    <button
                      key={g.target_id}
                      disabled={busy || !!pending.current.current}
                      onClick={() =>
                        void run(async () => {
                          await call(
                            'withdraw_grant',
                            {
                              expected_revision: g.revision,
                              reason: 'Granted scope withdrawn',
                            },
                            { grant_id: g.target_id },
                          );
                          setView(null);
                          setMessage(
                            'Permission withdrawn. The acceptance remains recorded.',
                          );
                        })
                      }
                    >
                      Withdraw accepted permission
                    </button>
                  ))}
              </div>
              {!view.available_actions.length && (
                <p>
                  No actions are available in this view. Its terms remain
                  readable.
                </p>
              )}
            </div>
          )}
        </>
      )}
      <p className="receipt" role="status" aria-live="polite">
        {message}
      </p>
      {pending.current.current && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const saved = pending.current.current!;
              const result = await call(
                saved.route as AccessRoute,
                { ...saved.body },
                { ...saved.parameters },
              );
              setView(null);
              if (result.invitation_id) setLocator(result.invitation_id);
              setMessage(
                'The exact request is now confirmed. Reload the invitation to inspect its current state.',
              );
            })
          }
        >
          Retry exact unconfirmed request
        </button>
      )}
      {operationId && (
        <div className="receipt">
          <p>Last confirmed operation: {operationId}</p>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const receipt = await call(
                  'operation_result',
                  {},
                  { operation_id: operationId },
                );
                setMessage(
                  'The server reports this operation as ' +
                    receipt.status +
                    '. This does not authorize a new operation.',
                );
              })
            }
          >
            Check recorded operation
          </button>
        </div>
      )}
    </section>
  );
}
