'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ACCESS_ROUTES,
  validateAccess,
  validateAccessProblem,
  type AccessRoute,
} from '../../contracts/access';
import { sessionTransport } from '../../contracts/access_transport';
import InvitationPanel from './InvitationPanel';
import CapabilityPanel from './CapabilityPanel';
import PeoplePanel from './PeoplePanel';
import type { Capability } from '../../contracts/access_presentation';
import { StaleView, verifySession, ViewLifetime } from './view_lifecycle';

type Mode = 'login' | 'activation' | 'recovery';
export default function AccessPanel({ apiOrigin }: { apiOrigin: string }) {
  const [mode, setMode] = useState<Mode>('login'),
    [busy, setBusy] = useState(true),
    [authenticated, setAuthenticated] = useState(false);
  const [message, setMessage] = useState('Checking the access service…');
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [challenge, setChallenge] = useState(''),
    [code, setCode] = useState('');
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [unconfirmedLogin, setUnconfirmedLogin] = useState(false);
  const lifetime = useRef(new ViewLifetime()),
    sessionToken = useRef('');
  function sessionChanged() {
    setUnconfirmedLogin(false);
    lifetime.current.reset();
    sessionToken.current = '';
    csrf.current = '';
    pending.current = null;
    setAuthenticated(false);
    setCapabilities([]);
    setSessionVersion((v) => v + 1);
    setBusy(false);
    setPassword('');
    setCode('');
    setChallenge('');
    setMessage('The session changed. Refresh the session before continuing.');
  }
  function adoptSession(token: string) {
    // A verified session replaces a provisional login context, not its missing receipt.
    // Other uncertain effects and same-session attempts are not reconciled by a read.
    if (pending.current?.route === 'login' && pending.current.context === '') {
      pending.current = null;
      setUnconfirmedLogin(true);
      setPassword('');
    }
    if (sessionToken.current !== token) {
      lifetime.current.reset();
      setSessionVersion((v) => v + 1);
    }
    sessionToken.current = token;
    csrf.current = token;
    setAuthenticated(true);
  }
  const csrf = useRef(''),
    pending = useRef<{
      signature: string;
      key: string;
      route: AccessRoute;
      context: string;
    } | null>(null);
  async function call(route: AccessRoute, body: Record<string, unknown> = {}) {
    const lease = lifetime.current.capture(),
      expected = sessionToken.current;
    const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(10000)]);
    sessionTransport({
      profile: 'session/1',
      uiOrigin: window.location.origin,
      terminalOrigin: apiOrigin,
    });
    if (!validateAccess(route, 'request', body))
      throw new Error('Check the fields and try again.');
    const definition = ACCESS_ROUTES[route],
      post = definition.method === 'POST';
    const signature = JSON.stringify([route, body]);
    if (post && pending.current && pending.current.signature !== signature)
      throw Error(
        'An earlier result is unconfirmed. Retry its unchanged request before starting another.',
      );
    if (post && !pending.current)
      pending.current = {
        signature,
        key: crypto.randomUUID(),
        route,
        context: expected,
      };
    const res = await fetch(apiOrigin + definition.path, {
      method: definition.method,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal,
      ...(post
        ? {
            headers: {
              'content-type': 'application/json',
              'x-ledgerdesk-csrf': csrf.current,
              'x-ledgerdesk-intent': pending.current!.key,
            },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const raw = await res.text();
    lifetime.current.assert(lease.epoch);
    if (route === 'capabilities' && expected) {
      try {
        await verifySession(apiOrigin, expected, signal);
        lifetime.current.assert(lease.epoch);
      } catch (e) {
        if (e instanceof StaleView) sessionChanged();
        throw e;
      }
    }
    if (raw.length > 32768)
      throw new Error('The service returned an invalid response.');
    const result = JSON.parse(raw);
    if (!res.ok) {
      if (
        !validateAccessProblem(
          result,
          res.status,
          res.headers.get('content-type') ?? '',
        )
      )
        throw new Error('The service returned an invalid response.');
      // A 5xx can follow a committed effect. Preserve its intention for reconciliation.
      if (post && res.status < 500) pending.current = null;
      throw Object.assign(
        new Error(
          result.code === 'unauthenticated'
            ? 'The credentials could not be verified.'
            : result.code === 'rate_limited'
              ? 'Too many attempts. Wait before trying again.'
              : result.code === 'technical_failure'
                ? 'The service could not confirm this operation.'
                : result.code === 'revision_conflict'
                  ? 'This attempt cannot be repeated with these details. Check its result before starting again.'
                  : 'This operation is not permitted.',
        ),
        { code: result.code },
      );
    }
    if (
      res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
        'application/json' ||
      !validateAccess(route, 'response', result)
    )
      throw new Error('The service returned an invalid response.');
    if (post) pending.current = null;
    return result;
  }
  async function reception() {
    csrf.current = (await call('reception')).csrf_token;
  }
  async function refreshSession() {
    setCapabilities([]);
    try {
      const s = await call('current_session');
      // Retire the old context's notice, not its missing receipt.
      if (sessionToken.current && sessionToken.current !== s.csrf_token)
        setUnconfirmedLogin(false);
      adoptSession(s.csrf_token);
      const caps = await call('capabilities');
      setCapabilities(caps.capabilities);
      setMessage('Current session verified by the server.');
    } catch (e) {
      if ((e as { code?: string }).code === 'unauthenticated') {
        setUnconfirmedLogin(false);
        sessionToken.current = '';
        setAuthenticated(false);
        await reception();
        setMessage(
          'Use your existing credentials, or activate the predeclared office account.',
        );
      } else throw e;
    }
  }
  useEffect(() => {
    let live = true;
    async function start() {
      try {
        try {
          const session = await call('current_session');
          if (!live) return;
          adoptSession(session.csrf_token);
          const caps = await call('capabilities');
          if (live) {
            setCapabilities(caps.capabilities);
            setMessage('Current session verified by the server.');
          }
        } catch (error) {
          if ((error as { code?: string }).code !== 'unauthenticated')
            throw error;
          await reception();
          if (live)
            setMessage(
              'Use your existing credentials, or activate the predeclared office account.',
            );
        }
      } catch {
        if (live)
          setMessage(
            'The access service is unavailable or not configured for this origin.',
          );
      } finally {
        if (live) setBusy(false);
      }
    }
    void start();
    return () => {
      live = false;
      lifetime.current.reset();
      sessionToken.current = '';
      csrf.current = '';
      pending.current = null;
    };
  }, []); // Configuration is fixed by the server-rendered page, never by a query or cookie.
  useEffect(() => {
    const check = () => {
      const lease = lifetime.current.capture(),
        token = sessionToken.current;
      if (!token) return;
      void verifySession(
        apiOrigin,
        token,
        AbortSignal.any([lease.signal, AbortSignal.timeout(10000)]),
      ).catch((e) => {
        if (lease.epoch === lifetime.current.epoch && e instanceof StaleView)
          sessionChanged();
      });
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [apiOrigin]);
  async function execute(action: () => Promise<void>) {
    setBusy(true);
    setMessage('Working…');
    try {
      await action();
    } catch (e) {
      setMessage(
        e instanceof TypeError || e instanceof DOMException
          ? mode === 'login'
            ? 'No result was received. Refresh the session to check current access before signing in again.'
            : 'No result was received. The operation may have completed; do not assume it failed. Retry the unchanged request to reconcile it.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    await execute(async () => {
      if (mode === 'login') {
        const result = await call('login', { email, password });
        setUnconfirmedLogin(false);
        adoptSession(result.csrf_token);
        setPassword('');
        setCapabilities((await call('capabilities')).capabilities);
        setMessage(
          'Signed in. This session does not grant corpus approval or unrestricted reading.',
        );
      } else {
        await call(
          mode === 'activation' ? 'activate_master' : 'recover_credential',
          { challenge_id: challenge, code, password },
        );
        setPassword('');
        setCode('');
        setChallenge('');
        setMode('login');
        setMessage(
          mode === 'activation'
            ? 'Account activated. You can now sign in.'
            : 'Credential replaced. Previous sessions are no longer valid. Sign in again.',
        );
      }
    });
  }
  const switchMode = (next: Mode) => {
    if (pending.current) {
      setMessage(
        'An earlier result is unconfirmed. Retry its unchanged request, or refresh the session after an uncertain sign-in.',
      );
      return;
    }
    setMode(next);
    setPassword('');
    setCode('');
    setChallenge('');
    setMessage('');
  };
  return (
    <main className="access-page">
      <style>{`
      .access-page{--ink:#182d49;--blue:#2359ce;color:var(--ink);background:#f6f8fc;min-height:100vh;padding:48px 24px;font-family:'Segoe UI',Arial,sans-serif;box-sizing:border-box}
      .access-wrap{max-width:960px;margin:0 auto}.access-brand{font-size:22px;font-weight:700;margin-bottom:42px}.access-grid{display:grid;grid-template-columns:1fr 1.2fr;gap:56px;align-items:start}
      .access-page h1{font-size:34px;line-height:1.15;margin:0 0 22px;letter-spacing:-.6px}.access-page p{line-height:1.6;max-width:52ch}.access-note{border-left:3px solid var(--blue);padding-left:18px;margin-top:32px}
      .access-form{background:white;padding:30px;border:1px solid #d9e3f2;border-radius:12px}.access-page label{display:block;font-weight:600;font-size:14px;margin:18px 0 7px}.access-page input{width:100%;box-sizing:border-box;border:1px solid #8fa3bf;border-radius:5px;padding:11px;font:inherit;color:var(--ink)}
      .access-page button{font:inherit;cursor:pointer;border-radius:5px;border:1px solid var(--blue);padding:10px 14px;background:white;color:var(--blue)}.access-page button:disabled{opacity:.5;cursor:wait}.access-page .primary{background:var(--blue);color:white;width:100%;margin-top:24px;font-weight:600}
      .access-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}.access-tabs button[aria-pressed=true]{background:#e9effc;border-width:2px}.access-status{min-height:48px;font-size:14px;margin-top:22px}.access-page :focus-visible{outline:3px solid #f0ae32;outline-offset:3px}
      .access-page small{display:block;margin-top:10px;line-height:1.5;color:#465d79}.access-page ul{padding-left:22px;line-height:1.8}
      .access-grid>section{min-width:0}.capability-panel,.people-panel{border-top:1px solid #d9e3f2;margin-top:32px;padding-top:24px}.capability-list{list-style:none;padding:0!important}.capability-list>li{padding:18px 0;border-bottom:1px solid #d9e3f2}.capability-list h3{margin:0 0 12px;overflow-wrap:anywhere}.capability-axes{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.capability-axes dt{font-size:14px;color:#465d79}.capability-axes dd{margin:5px 0 0;font-weight:600}.person-reference{display:block;overflow-wrap:anywhere;font-size:14px}.access-page a{color:var(--blue);text-underline-offset:3px}
      @media(max-width:640px){.access-page{padding:24px 16px}.access-brand{margin-bottom:24px}.access-grid{grid-template-columns:1fr;gap:24px}.access-form{padding:22px}.access-page h1{font-size:29px}.access-note{margin-top:18px}.capability-axes{grid-template-columns:repeat(2,1fr)}}
    `}</style>
      <div className="access-wrap">
        <div className="access-brand">LedgerDesk</div>
        <div className="access-grid">
          <section>
            <h1>A verified way in.</h1>
            <p>
              Activate the predeclared office account or accept a nominated
              invitation, then use your password to start a server-verified
              session.
            </p>
            <div className="access-note">
              <strong>Synthetic access environment</strong>
              <p>
                No public registration. No real email delivery. Holding the
                master office does not establish authority over material.
              </p>
            </div>
          </section>
          <section className="access-form" aria-label="Account access">
            {authenticated ? (
              <>
                <h2>Session active</h2>
                <p>
                  Capability states are shown below. A session alone grants no
                  unrestricted authority.
                </p>
                {capabilities.some(
                  (c) =>
                    c.capability_id === 'material-list' &&
                    c.executable === 'yes',
                ) && (
                  <p>
                    <a href="/access/material">Open material library</a>
                  </p>
                )}
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void execute(async () => {
                      await call('logout');
                      setUnconfirmedLogin(false);
                      lifetime.current.reset();
                      sessionToken.current = '';
                      setSessionVersion((v) => v + 1);
                      setAuthenticated(false);
                      setCapabilities([]);
                      csrf.current = '';
                      await reception();
                      setMessage(
                        'Signed out. The previous session is invalid.',
                      );
                    })
                  }
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <nav className="access-tabs" aria-label="Access options">
                  {(['login', 'activation', 'recovery'] as Mode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      disabled={busy}
                      aria-pressed={mode === m}
                      onClick={() => switchMode(m)}
                    >
                      {m === 'login'
                        ? 'Sign in'
                        : m === 'activation'
                          ? 'Activate'
                          : 'Recover'}
                    </button>
                  ))}
                </nav>
                <form onSubmit={submit}>
                  <label htmlFor="access-email">Email address</label>
                  <input
                    id="access-email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={254}
                  />
                  {mode !== 'login' && (
                    <>
                      <button
                        type="button"
                        disabled={busy || !email || !csrf.current}
                        style={{ marginTop: 12 }}
                        onClick={() =>
                          void execute(async () => {
                            await call(
                              mode === 'activation'
                                ? 'activation_challenge'
                                : 'recovery_challenge',
                              { email },
                            );
                            setMessage(
                              'Request received. If this flow is eligible, its details will be available through the controlled test mailbox.',
                            );
                          })
                        }
                      >
                        Request{' '}
                        {mode === 'activation' ? 'activation' : 'recovery'} code
                      </button>
                      {mode === 'recovery' && (
                        <small>
                          Master recovery requires separate, current
                          authorization from deployment control. Email control
                          alone cannot transfer the office.
                        </small>
                      )}
                      <label htmlFor="access-challenge">
                        Challenge identifier
                      </label>
                      <input
                        id="access-challenge"
                        value={challenge}
                        onChange={(e) => setChallenge(e.target.value)}
                        required
                        maxLength={128}
                      />
                      <label htmlFor="access-code">Verification code</label>
                      <input
                        id="access-code"
                        autoComplete="one-time-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        required
                        maxLength={43}
                      />
                    </>
                  )}
                  <label htmlFor="access-password">
                    {mode === 'login' ? 'Password' : 'New password'}
                  </label>
                  <input
                    id="access-password"
                    type="password"
                    autoComplete={
                      mode === 'login' ? 'current-password' : 'new-password'
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    maxLength={1024}
                  />
                  <button
                    className="primary"
                    disabled={busy || !csrf.current}
                    type="submit"
                  >
                    {mode === 'login'
                      ? 'Sign in'
                      : mode === 'activation'
                        ? 'Activate account'
                        : 'Replace password'}
                  </button>
                </form>
              </>
            )}
            <p className="access-status" role="status" aria-live="polite">
              {message}
            </p>
            {unconfirmedLogin && (
              <small>
                The earlier sign-in result remains unconfirmed. Current access
                was checked separately; refreshing did not recover that result.
              </small>
            )}
            <button
              disabled={busy}
              onClick={() => void execute(refreshSession)}
            >
              Refresh session
            </button>
          </section>
        </div>
        {authenticated && <CapabilityPanel capabilities={capabilities} />}
        {authenticated &&
          capabilities.some(
            (c) => c.capability_id === 'people' && c.executable === 'yes',
          ) && (
            <PeoplePanel
              key={'people:' + sessionVersion}
              apiOrigin={apiOrigin}
              sessionToken={sessionToken.current}
              onSessionChanged={sessionChanged}
            />
          )}
        <InvitationPanel
          key={'invitations:' + sessionVersion}
          apiOrigin={apiOrigin}
          authenticated={authenticated}
          sessionToken={sessionToken.current}
          onSessionChanged={sessionChanged}
          ready={!busy}
        />
      </div>
    </main>
  );
}
