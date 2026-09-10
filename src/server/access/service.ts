import {
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import {
  ACCESS_ROUTES,
  accessProblem,
  validateAccess,
  type AccessRoute,
  type AccessError,
} from '../../contracts/access.ts';
import type { AccessConfig } from './config.ts';
import { AccessStore } from './postgres/store.ts';
import { PasswordVerifier } from './password.ts';
import { tokenMatches } from './transport.ts';
import { canonicalIntent } from '../../contracts/access_canonical.ts';
import { performInvitation } from './invitations.ts';
import { InvitationAuthority } from './invitation_authority.ts';
import { currentReadingControl } from './reading_control.ts';

export const FLOW_COOKIE = '__Host-ledgerdesk-flow';
// Synthetic-trial bound: keep distributed guessing finite without sharing the
// smaller peer budget. Exhausting this aggregate budget still denies all peers.
const LOGIN_ACCOUNT_ATTEMPT_FACTOR = 10;
const secret = () => randomBytes(32).toString('base64url');
export type AccessInput = {
  route: AccessRoute;
  body: Record<string, unknown>;
  session: string | null;
  flow: string | null;
  csrf?: string;
  intent?: string;
  peer: string;
  parameters?: Record<string, string>;
};
export type AccessOutput = {
  status: number;
  body: unknown;
  sessionCookie?: string;
  flowCookie?: string;
  expiresAt?: number;
  credentialExpiresAt?: number;
  evidenceId?: string;
};
export interface LocalMailbox {
  send(message: {
    email: string;
    challenge_id?: string;
    code?: string;
    invitation_id?: string;
    purpose: string;
  }): Promise<void>;
}
export type AccessHooks = {
  afterCommit?: (route: string) => Promise<void>;
  beforeCommit?: (route: string) => Promise<void>;
  failure?: (error: unknown) => void;
};
const fail = (code: AccessError): AccessOutput => ({
  status: accessProblem(code).status,
  body: accessProblem(code),
});
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isRef = (v: unknown) => typeof v === 'string' && opaque.test(v);
function rootValid(root: Record<string, any>, now: number): boolean {
  return (
    !!root &&
    [
      'issuerPersonRef',
      'issuerCapacityRef',
      'holderPersonRef',
      'functionRef',
      'purposeRef',
      'maximumGradeRef',
      'independenceDeclarationRef',
      'replacementOrChallengeProcedureRef',
    ].every((k) => isRef(root[k])) &&
    Number.isSafeInteger(root.revision) &&
    root.revision > 0 &&
    Number.isSafeInteger(root.startsAt) &&
    root.startsAt <= now &&
    root.termination?.kind === 'expires' &&
    Number.isSafeInteger(root.termination.at) &&
    root.termination.at > now &&
    !!root.scope &&
    ['matters', 'partitions', 'risks'].every(
      (k) => Array.isArray(root.scope[k]) && root.scope[k].every(isRef),
    ) &&
    isRef(root.scope.populationRef) &&
    (root.continuousObligationAcceptanceRef === null ||
      isRef(root.continuousObligationAcceptanceRef))
  );
}
function receptionValid(p: Record<string, any>): boolean {
  return (
    !!p &&
    ['purposeRef', 'custodianRef', 'readerRef', 'disposalRef'].every((k) =>
      isRef(p[k]),
    ) &&
    p.destination === 'local-test-mailbox' &&
    p.synthetic === true &&
    p.capture === true &&
    p.processing === true &&
    p.conservation === true &&
    p.evidence === true &&
    Number.isSafeInteger(p.retentionSeconds) &&
    p.retentionSeconds > 0 &&
    p.retentionSeconds <= 86400
  );
}
/** Current authority at the first consumer, not a grantor or substantive approval engine. */
export function startupAllowed(control: any, now: number): boolean {
  return (
    control?.active === true &&
    control.deployment_id === 'inc02-synthetic' &&
    typeof control.master_email === 'string' &&
    /^[^\s@]+@[^\s@]+\.test$/.test(control.master_email) &&
    rootValid(control.root, now) &&
    receptionValid(control.reception)
  );
}
export class AccessService {
  readonly passwords = new PasswordVerifier();
  readonly config: AccessConfig;
  private mailbox: LocalMailbox;
  private hooks: AccessHooks;
  private readingGeneration?: string;
  constructor(
    config: AccessConfig,
    mailbox: LocalMailbox,
    hooks: AccessHooks = {},
    readingGeneration?: string,
  ) {
    this.config = config;
    this.mailbox = mailbox;
    this.hooks = hooks;
    this.readingGeneration = readingGeneration;
  }
  digest(value: string) {
    return createHmac('sha256', Buffer.from(this.config.digestKey, 'hex'))
      .update(value)
      .digest('hex');
  }
  async initialize() {
    await this.passwords.initialize();
  }
  async receive(route: AccessRoute, onLoss: () => void): Promise<AccessStore> {
    const db = new AccessStore(this.config, onLoss);
    try {
      await db.admit(
        [
          'logout',
          'recover_credential',
          'amend_invitation',
          'withdraw_invitation',
          'withdraw_grant',
          'initial_credential',
        ].includes(route),
      );
      const control = (
        await db.client.query('SELECT * FROM access_trial.deployment')
      ).rows[0];
      if (!startupAllowed(control, await db.now()))
        throw new Error('RECEPTION_UNAVAILABLE');
      await currentReadingControl(db, this.readingGeneration, false);
      return db;
    } catch (e) {
      await db.close();
      throw e;
    }
  }
  async perform(
    input: AccessInput,
    onLoss: () => void,
    admitted?: AccessStore,
    attempt = 0,
  ): Promise<{
    output: AccessOutput;
    close: () => Promise<void>;
    observe?: (outcome: 'handed_off' | 'interrupted') => Promise<void>;
  }> {
    const { route, body } = input,
      s = this.config.security;
    const db = admitted ?? (await this.receive(route, onLoss));
    if (ACCESS_ROUTES[route].consumer === 'T03')
      return performInvitation(this, input, db, this.hooks, this.mailbox);
    const close = () => db.close();
    let output: AccessOutput;
    let pendingMail: Parameters<LocalMailbox['send']>[0] | undefined;
    const newId = randomUUID();
    try {
      const proofAccount =
        route === 'recover_credential' &&
        typeof body.challenge_id === 'string' &&
        /^[a-f0-9-]{36}$/.test(body.challenge_id)
          ? (
              await db.client.query(
                'SELECT email FROM access_trial.proof WHERE id=$1',
                [body.challenge_id],
              )
            ).rows[0]?.email
          : null;
      await db.begin([
        ...(input.flow ? ['flow:' + this.digest(input.flow)] : []),
        ...(input.session ? ['session:' + this.digest(input.session)] : []),
        this.digest(
          String(body.email ?? input.flow ?? input.session ?? input.peer),
        ),
        ...(body.email || proofAccount
          ? ['email:' + this.digest(String(body.email ?? proofAccount))]
          : []),
      ]);
      const q = (sql: string, args: unknown[] = []) =>
        db.client.query(sql, args);
      const now = await db.now();
      const control = (await q('SELECT * FROM access_trial.deployment'))
        .rows[0];
      if (!startupAllowed(control, now)) {
        await close();
        return { output: fail('technical_failure'), close: async () => {} };
      }
      let expiry = control.root.termination.at;
      const evidence = async (
        result: number,
        actor: string,
        subject: string | null = null,
      ) => {
        await q(
          'INSERT INTO access_trial.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            newId,
            route,
            actor,
            subject,
            result,
            control.revision,
            await db.now(),
            control.reception.purposeRef,
            'synthetic-local',
          ],
        );
      };
      const throttle = async (
        key: string,
        limit: number,
        window: number,
        spacing = 0,
      ) => {
        const r = (
          await q('SELECT * FROM access_trial.throttle WHERE key=$1', [key])
        ).rows[0];
        const fresh = !r || now - Number(r.window_start) >= window * 1000;
        if (
          !fresh &&
          (r.count >= limit || now - Number(r.last_at) < spacing * 1000)
        )
          return false;
        await q(
          `INSERT INTO access_trial.throttle VALUES($1,1,$2,$2) ON CONFLICT(key) DO UPDATE
          SET count=$3,window_start=$4,last_at=$2`,
          [
            key,
            now,
            fresh ? 1 : r.count + 1,
            fresh ? now : Number(r.window_start),
          ],
        );
        return true;
      };
      const flowDigest = input.flow ? this.digest(input.flow) : '';
      let flow = flowDigest
        ? (
            await q('SELECT * FROM access_trial.flow WHERE digest=$1', [
              flowDigest,
            ])
          ).rows[0]
        : null;
      if (flow && Number(flow.expires_at) <= now) flow = null;
      let session = input.session
        ? (
            await q(
              `SELECT s.*,a.restricted,a.revision AS account_revision FROM access_trial.session s
        JOIN access_trial.account a ON a.id=s.account_id WHERE s.digest=$1`,
              [this.digest(input.session)],
            )
          ).rows[0]
        : null;
      if (
        session &&
        (session.revoked ||
          session.restricted ||
          Number(session.expires_at) <= now ||
          session.revision !== session.account_revision)
      )
        session = null;
      const sessionRoute = [
        'logout',
        'current_session',
        'capabilities',
      ].includes(route);
      const binding = sessionRoute
        ? this.digest(input.session ?? '')
        : flowDigest;
      let actor = sessionRoute
        ? (session?.account_id ?? 'unverified')
        : flow
          ? `flow:${flowDigest}`
          : 'reception';
      let subject: string | null = null;
      const run = async (): Promise<AccessOutput> => {
        if (route === 'reception') {
          if (
            !(await throttle(`reception:${this.digest(input.peer)}`, 64, 300))
          )
            return fail('rate_limited');
          if (!flow) {
            const credential = secret(),
              csrf = secret();
            expiry = Math.min(expiry, now + s.proofSeconds * 1000);
            await q('INSERT INTO access_trial.flow VALUES($1,$2,$3,$4)', [
              this.digest(credential),
              csrf,
              expiry,
              now,
            ]);
            return {
              status: 200,
              body: { csrf_token: csrf },
              flowCookie: credential,
              expiresAt: expiry,
            };
          }
          expiry = Math.min(expiry, Number(flow.expires_at));
          return {
            status: 200,
            body: { csrf_token: flow.csrf },
            expiresAt: expiry,
          };
        }
        if (sessionRoute ? !session : !flow) return fail('unauthenticated');
        expiry = Math.min(
          expiry,
          Number((sessionRoute ? session : flow).expires_at),
        );
        if (
          ACCESS_ROUTES[route].method === 'POST' &&
          !tokenMatches(input.csrf, (sessionRoute ? session : flow).csrf)
        )
          return fail('forbidden');
        const post = ACCESS_ROUTES[route].method === 'POST';
        if (post && (!input.intent || !opaque.test(input.intent)))
          return fail('invalid_request');
        // HMAC rather than stored request bytes: password/code material is not an intent record.
        const legacyDigest = this.digest(
          JSON.stringify([
            route,
            Object.keys(body)
              .sort()
              .map((k) => [k, body[k]]),
          ]),
        );
        const payloadDigest = this.digest(canonicalIntent(route, {}, body));
        const intentKey = `${route}:${binding}`;
        if (post) {
          const prior = (
            await q(
              'SELECT * FROM access_trial.intent WHERE binding=$1 AND intention=$2',
              [intentKey, input.intent],
            )
          ).rows[0];
          if (prior) {
            if (
              prior.payload_digest !==
              (prior.canonical_profile === 'legacy_t02'
                ? legacyDigest
                : payloadDigest)
            )
              return fail('revision_conflict');
            // A login secret is never replayable. Retry with a fresh intention to authenticate again.
            if (route === 'login') return fail('revision_conflict');
            if (route === 'activate_master' || route === 'recover_credential') {
              const subject = (
                await q(
                  `SELECT a.restricted,a.office FROM access_trial.account a WHERE a.email=COALESCE(
                  (SELECT email FROM access_trial.proof WHERE id=$1),$2)`,
                  [body.challenge_id, control.master_email],
                )
              ).rows[0];
              if (
                !subject ||
                subject.restricted ||
                (route === 'recover_credential' &&
                  subject.office === 'master' &&
                  Number(control.recovery_until) <= now)
              )
                return fail('forbidden');
            }
            return { status: 200, body: prior.receipt, expiresAt: expiry };
          }
        }
        let result: AccessOutput;
        if (
          route === 'activation_challenge' ||
          route === 'recovery_challenge'
        ) {
          const purpose =
            route === 'activation_challenge' ? 'activation' : 'recovery';
          const email = String(body.email),
            key = `mail:${this.digest(email)}`;
          const allowed = await throttle(
            key,
            s.resendLimit,
            s.proofSeconds,
            s.resendSeconds,
          );
          const account = (
            await q('SELECT * FROM access_trial.account WHERE email=$1', [
              email,
            ])
          ).rows[0];
          const eligible =
            purpose === 'activation'
              ? email === control.master_email && !account
              : !!account &&
                !account.restricted &&
                (account.office !== 'master' ||
                  Number(control.recovery_until) > now);
          // Same persistent attempt bookkeeping for eligible and ineligible addresses.
          if (allowed) {
            const id = randomUUID(),
              code = secret();
            await q(
              'UPDATE access_trial.proof SET used=true WHERE email=$1 AND purpose=$2',
              [email, purpose],
            );
            await q(
              'INSERT INTO access_trial.proof VALUES($1,$2,$3,$4,$5,false,0,$6,$7,$8)',
              [
                id,
                email,
                purpose,
                this.digest(code),
                Math.min(
                  now + s.proofSeconds * 1000,
                  expiry,
                  purpose === 'recovery' && account?.office === 'master'
                    ? Number(control.recovery_until)
                    : expiry,
                ),
                control.revision,
                now,
                purpose === 'recovery' ? (account?.revision ?? null) : null,
              ],
            );
            if (eligible)
              pendingMail = { email, challenge_id: id, code, purpose };
          }
          result = {
            status: 200,
            body: { status: 'accepted' },
            expiresAt: expiry,
          };
        } else if (
          route === 'activate_master' ||
          route === 'recover_credential'
        ) {
          const purpose =
            route === 'activate_master' ? 'activation' : 'recovery';
          if (!/^[a-f0-9-]{36}$/.test(String(body.challenge_id)))
            return fail('forbidden');
          const proof = (
            await q('SELECT * FROM access_trial.proof WHERE id=$1', [
              body.challenge_id,
            ])
          ).rows[0];
          if (
            !proof ||
            proof.used ||
            proof.purpose !== purpose ||
            (purpose === 'activation' &&
              proof.email !== control.master_email) ||
            Number(proof.expires_at) <= now ||
            proof.deployment_revision !== control.revision ||
            proof.attempts >= s.proofAttempts
          )
            return fail('forbidden');
          await q(
            'UPDATE access_trial.proof SET attempts=attempts+1 WHERE id=$1',
            [proof.id],
          );
          if (
            !timingSafeEqual(
              Buffer.from(this.digest(String(body.code))),
              Buffer.from(proof.verifier),
            )
          )
            return fail('forbidden');
          expiry = Math.min(expiry, Number(proof.expires_at));
          const account = (
            await q('SELECT * FROM access_trial.account WHERE email=$1', [
              proof.email,
            ])
          ).rows[0];
          if (purpose === 'activation' && account) return fail('forbidden');
          if (
            purpose === 'recovery' &&
            account &&
            proof.account_revision !== null &&
            proof.account_revision !== account.revision
          )
            return fail('forbidden');
          if (
            purpose === 'recovery' &&
            (!account ||
              account.restricted ||
              (account.office === 'master' &&
                Number(control.recovery_until) <= now))
          )
            return fail('forbidden');
          if (purpose === 'recovery' && account.office === 'master')
            expiry = Math.min(expiry, Number(control.recovery_until));
          const verifier = await this.passwords.create(String(body.password));
          subject = account?.id ?? randomUUID();
          if (purpose === 'activation')
            await q(
              'INSERT INTO access_trial.account(id,email,person_ref,office,verifier) VALUES($1,$2,$3,$4,$5)',
              [
                subject,
                proof.email,
                control.root.holderPersonRef,
                'master',
                verifier,
              ],
            );
          else {
            await q(
              'UPDATE access_trial.account SET verifier=$1,revision=revision+1 WHERE id=$2',
              [verifier, account.id],
            );
            await q(
              'UPDATE access_trial.session SET revoked=true,revision=revision+1 WHERE account_id=$1',
              [account.id],
            );
            await q(
              'UPDATE access_trial.initial_credential_flow SET consumed=true WHERE account_id=$1',
              [account.id],
            );
          }
          await q('UPDATE access_trial.proof SET used=true WHERE id=$1', [
            proof.id,
          ]);
          result = {
            status: 200,
            body: {
              operation_id: newId,
              status: 'completed',
              revision: purpose === 'activation' ? 1 : account.revision + 1,
            },
            expiresAt: expiry,
          };
        } else if (route === 'login') {
          const email = String(body.email);
          const peerKey = this.digest(JSON.stringify([email, input.peer]));
          if (
            !(await throttle(
              `login:peer:${peerKey}`,
              s.loginAttempts,
              s.attemptWindowSeconds,
            ))
          )
            return fail('rate_limited');
          // A refused peer does not spend another peer's aggregate allowance.
          if (
            !(await throttle(
              `login:account:${this.digest(email)}`,
              s.loginAttempts * LOGIN_ACCOUNT_ATTEMPT_FACTOR,
              s.attemptWindowSeconds,
            ))
          )
            return fail('rate_limited');
          const account = (
            await q('SELECT * FROM access_trial.account WHERE email=$1', [
              body.email,
            ])
          ).rows[0];
          const correct = await this.passwords.matches(
            account?.verifier ?? null,
            String(body.password),
          );
          if (!correct || account.restricted) return fail('unauthenticated');
          actor = account.id;
          subject = account.id;
          const credential = secret(),
            csrf = secret();
          const sessionExpiry = Math.min(
            control.root.termination.at,
            now + s.sessionSeconds * 1000,
          );
          await q(
            'INSERT INTO access_trial.session VALUES($1,$2,$3,$4,false,$5)',
            [
              this.digest(credential),
              account.id,
              csrf,
              sessionExpiry,
              account.revision,
            ],
          );
          await q(
            'UPDATE access_trial.flow SET expires_at=$1 WHERE digest=$2',
            [now, flowDigest],
          );
          result = {
            status: 200,
            body: {
              authenticated: true,
              session_revision: account.revision,
              csrf_token: csrf,
            },
            sessionCookie: credential,
            credentialExpiresAt: sessionExpiry,
            expiresAt: Math.min(expiry, sessionExpiry),
          };
        } else if (route === 'logout') {
          await q(
            'UPDATE access_trial.session SET revoked=true WHERE digest=$1',
            [this.digest(input.session!)],
          );
          result = {
            status: 200,
            body: {
              operation_id: newId,
              status: 'completed',
              revision: session.revision,
            },
            sessionCookie: '',
            expiresAt: expiry,
          };
        } else if (route === 'current_session')
          result = {
            status: 200,
            body: {
              authenticated: true,
              session_revision: session.revision,
              csrf_token: session.csrf,
            },
            expiresAt: expiry,
          };
        else if (route === 'capabilities') {
          const authority = new InvitationAuthority(db, now);
          await authority.load();
          const viewer = authority.accounts.find(
            (a) => a.id === session.account_id,
          );
          const options: { family: string; term: unknown }[] = [];
          let optionChecks = 0;
          for (const scope of authority.scopes)
            for (const permission of authority.permissions)
              for (const support of authority.supports) {
                if (++optionChecks > 4096)
                  throw new Error('CAPABILITY_OPTIONS_BOUND');
                for (const faculty of ['exercise', 'grant'] as const) {
                  const compiled = authority.compile(
                    viewer,
                    permission.family,
                    [
                      {
                        permission_id: permission.id,
                        exercise_or_grant: faculty,
                        scope_ref: scope.id,
                        support_ref: support.id,
                      },
                    ],
                    now + s.invitationSeconds * 1000,
                  );
                  if (compiled)
                    options.push({
                      family: permission.family,
                      term: compiled[0],
                    });
                  if (options.length > 64)
                    throw new Error('CAPABILITY_PROJECTION_BOUND');
                }
              }
          expiry = Math.min(expiry, authority.deadline);
          const additional: { capability_id: string; implemented: boolean; enabled: boolean; authorized: string; executable: string }[] = [];
          if (this.readingGeneration) {
            const materialControl=(await q('SELECT * FROM material_trial.control')).rows[0];
            const treatmentReady=materialControl && ['capture_ready','processing_ready','conservation_ready','trace_ready','destination_ready'].every(k=>materialControl[k]===true);
            const surfaces = (await q('SELECT * FROM material_trial.surface ORDER BY id')).rows;
            for (const surface of surfaces) {
              if (!surface.revealable) continue;
              const scope=authority.scopes.find(s=>s.id===surface.scope_ref && s.active);
              const allowed = scope?.purpose_ref===surface.purpose_ref && authority.readingMaximum(viewer, surface.permission_id, surface.scope_ref, surface.purpose_ref) !== 'NONE';
              additional.push({ capability_id: surface.id, implemented: true, enabled: surface.enabled,
                authorized: allowed ? 'yes' : 'no', executable: surface.enabled && surface.policy_ready && treatmentReady && allowed ? 'yes' : 'no' });
            }
            expiry = Math.min(expiry, authority.deadline);
          }
          result = {
            status: 200,
            body: {
              revision: control.revision,
              invitation_options: options,
              capabilities: [
                ...additional,
                {
                  capability_id: 'session_status',
                  implemented: true,
                  enabled: true,
                  authorized: 'yes',
                  executable: 'yes',
                },
                {
                  capability_id: 'logout',
                  implemented: true,
                  enabled: true,
                  authorized: 'yes',
                  executable: 'yes',
                },
              ],
            },
            expiresAt: expiry,
          };
        } else return fail('unavailable');
        if (post && result.status === 200)
          await q(
            "INSERT INTO access_trial.intent(binding,intention,payload_digest,receipt,canonical_profile) VALUES($1,$2,$3,$4,'canon_m09_1')",
            [
              intentKey,
              input.intent,
              payloadDigest,
              JSON.stringify(
                route === 'login'
                  ? { operation_id: newId, status: 'completed' }
                  : result.body,
              ),
            ],
          );
        return result;
      };
      output = await run();
      if (
        output.status === 200 &&
        !validateAccess(route, 'response', output.body)
      )
        throw new Error('INVALID_PROJECTION');
      await this.hooks.beforeCommit?.(route);
      if (output.status === 200 && (await db.now()) >= expiry)
        throw new Error('DEADLINE_BEFORE_EFFECT');
      await evidence(output.status, actor, subject);
      await db.commit();
      output.evidenceId = newId;
      await this.hooks.afterCommit?.(route);
      // Mail never occupies a SQL transaction and never changes the public accepted response.
      if (pendingMail)
        void this.mailbox.send(pendingMail).catch(() => {
          /* Adapter records failed delivery; reception is not a delivery receipt. */
        });
      return {
        output,
        close,
        observe: async (outcome) => {
          // Observation is subsequent, append-only and never an assertion of human receipt.
          await db.releaseAdmission();
          await db.client.query(
            'INSERT INTO access_trial.transport_observation VALUES($1,$2,$3)',
            [newId, outcome, await db.now()],
          );
        },
      };
    } catch (error) {
      this.hooks.failure?.(error);
      await close();
      if (
        ['40001', '23505'].includes((error as { code?: string }).code ?? '') &&
        attempt < s.retryLimit
      )
        return this.perform(input, onLoss, undefined, attempt + 1);
      return { output: fail('technical_failure'), close: async () => {} };
    }
  }
}
