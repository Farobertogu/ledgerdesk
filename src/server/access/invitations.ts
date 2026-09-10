import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ACCESS_ROUTES,
  accessProblem,
  validateAccess,
  type AccessError,
} from '../../contracts/access.ts';
import {
  canonicalIntent,
  canonicalValue,
} from '../../contracts/access_canonical.ts';
import { invitationExpiryAllowed } from '../../contracts/access_security.ts';
import { tokenMatches } from './transport.ts';
import {
  InvitationAuthority,
  type GrantSelector,
} from './invitation_authority.ts';
import type { AccessStore } from './postgres/store.ts';
import type {
  AccessService,
  AccessInput,
  AccessOutput,
  AccessHooks,
  LocalMailbox,
} from './service.ts';

const failure = (code: AccessError): AccessOutput => ({
  status: accessProblem(code).status,
  body: accessProblem(code),
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const secret = () => randomBytes(32).toString('base64url');

/** No mail, browser wait or external retry occurs inside the effect transaction. */
export async function performInvitation(
  service: AccessService,
  input: AccessInput,
  db: AccessStore,
  hooks: AccessHooks,
  mailbox: LocalMailbox,
) {
  const { route, body } = input,
    path = input.parameters ?? {},
    security = service.config.security;
  const q = (sql: string, values: unknown[] = []) =>
    db.client.query(sql, values);
  const operation = randomUUID();
  let mail: Parameters<LocalMailbox['send']>[0] | undefined;
  let actor = 'unverified',
    subject: string | null = null,
    principal = '',
    inv: any = null;
  const close = () => db.close();
  try {
    // Discovery only identifies the lock set. All facts are re-read after locking.
    let inviteId = path.invitation_id;
    if (path.challenge_id && uuid.test(path.challenge_id))
      inviteId = (
        await q(
          'SELECT invitation_id FROM access_trial.email_proof WHERE id=$1',
          [path.challenge_id],
        )
      ).rows[0]?.invitation_id;
    const discovered =
      inviteId && uuid.test(inviteId)
        ? (
            await q(
              'SELECT email,issuer_id FROM access_trial.invitation WHERE id=$1',
              [inviteId],
            )
          ).rows[0]
        : null;
    const privateLookup = [
      'invitation_view',
      'invitation_challenge',
      'verify_invitation_email',
    ].includes(route);
    const email = privateLookup ? undefined : (discovered?.email ?? body.email);
    const determination = email
      ? (
          await q(
            'SELECT person_ref FROM access_trial.person_determination WHERE email=$1',
            [email],
          )
        ).rows[0]
      : null;
    const account = email
      ? (
          await q(
            'SELECT id,person_ref FROM access_trial.account WHERE email=$1',
            [email],
          )
        ).rows[0]
      : null;
    const keys = [
      ...(input.flow ? ['flow:' + service.digest(input.flow)] : []),
      ...(input.session ? ['session:' + service.digest(input.session)] : []),
      ...(email ? ['email:' + service.digest(String(email))] : []),
      ...(inviteId ? ['invitation:' + inviteId] : []),
      ...(!privateLookup && discovered
        ? ['account:' + discovered.issuer_id]
        : []),
      ...(determination || account
        ? ['person:' + (determination?.person_ref ?? account.person_ref)]
        : []),
      ...(path.grant_id ? ['grant:' + path.grant_id] : []),
    ];
    await db.begin(keys);
    const now = await db.now();
    const control = (await q('SELECT * FROM access_trial.deployment')).rows[0];
    let expiry = Number(control.root.termination.at);
    const authority = new InvitationAuthority(db, now);
    await authority.load();
    let flow = input.flow
      ? (
          await q('SELECT * FROM access_trial.flow WHERE digest=$1', [
            service.digest(input.flow),
          ])
        ).rows[0]
      : null;
    if (flow && Number(flow.expires_at) <= now) flow = null;
    let session = input.session
      ? (
          await q(
            `SELECT s.*,a.email,a.person_ref,a.office,a.restricted,a.revision AS account_revision
      FROM access_trial.session s JOIN access_trial.account a ON a.id=s.account_id WHERE s.digest=$1`,
            [service.digest(input.session)],
          )
        ).rows[0]
      : null;
    if (
      session &&
      (session.revoked ||
        session.restricted ||
        session.revision !== session.account_revision ||
        Number(session.expires_at) <= now)
    )
      session = null;
    const administrative = [
      'issue_invitation',
      'amend_invitation',
      'withdraw_invitation',
      'withdraw_grant',
    ].includes(route);
    const provisionalOnly = [
      'invitation_challenge',
      'verify_invitation_email',
      'initial_credential',
    ].includes(route);
    const context = administrative
      ? session
      : provisionalOnly
        ? flow
        : (session ?? flow);
    let proof: any = null;
    if (flow)
      proof = (
        await q(
          `SELECT p.*,i.email FROM access_trial.email_proof p JOIN access_trial.invitation i ON i.id=p.invitation_id
      WHERE p.flow_digest=$1 AND p.verified AND NOT p.superseded AND p.expires_at>$2
      AND ($3::uuid IS NULL OR p.invitation_id=$3) AND ($4::uuid IS NULL OR p.id=$4)
      ORDER BY p.created_at DESC LIMIT 1`,
          [
            flow.digest,
            now,
            route !== 'accept_invitation' && inviteId && uuid.test(inviteId)
              ? inviteId
              : null,
            route === 'accept_invitation'
              ? uuid.test(String(body.proof_id))
                ? body.proof_id
                : '00000000-0000-0000-0000-000000000000'
              : null,
          ],
        )
      ).rows[0];
    principal =
      session && !provisionalOnly
        ? 'email:' + service.digest(session.email)
        : proof && !provisionalOnly
          ? 'email:' + service.digest(proof.email)
          : 'flow:' + (flow?.digest ?? 'none');
    actor = session && !provisionalOnly ? session.account_id : principal;
    if (inviteId && uuid.test(inviteId))
      inv = (
        await q('SELECT * FROM access_trial.invitation WHERE id=$1', [inviteId])
      ).rows[0];
    subject = inv?.id ?? null;
    const issuer = inv
      ? authority.accounts.find((a) => a.id === inv.issuer_id)
      : null;
    const viewer = session
      ? authority.accounts.find((a) => a.id === session.account_id)
      : null;
    const current =
      (
        await q(
          'SELECT * FROM access_trial.invitation_revision WHERE invitation_id=$1 AND revision=$2',
          [
            inv?.id ?? '00000000-0000-0000-0000-000000000000',
            inv?.revision ?? 1,
          ],
        )
      ).rows[0] ?? null;
    const person = async (recipient: string) =>
      (
        await q('SELECT person_ref FROM access_trial.account WHERE email=$1', [
          recipient,
        ])
      ).rows[0]?.person_ref ??
      (
        await q(
          'SELECT person_ref FROM access_trial.person_determination WHERE email=$1',
          [recipient],
        )
      ).rows[0]?.person_ref ??
      'unlinked:' + service.digest(recipient);
    const currentTerms = () =>
      inv &&
      current &&
      authority.compile(
        issuer,
        inv.family,
        current.grants,
        Number(inv.expires_at),
      );
    const recipient = () =>
      !!inv &&
      (session
        ? session.email === inv.email
        : proof?.invitation_id === inv.id && proof.email === inv.email);
    const canInspect = () =>
      recipient() ||
      (!!viewer && viewer.id === inv?.issuer_id && !!currentTerms());
    const event = async (
      objectRef: string,
      revision: number,
      details: unknown,
    ) => {
      await q(
        'INSERT INTO access_trial.invitation_event VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          route,
          inv?.id ?? null,
          actor,
          objectRef,
          revision,
          details,
          now,
        ],
      );
    };
    const throttle = async (key: string) => {
      const r = (
        await q('SELECT * FROM access_trial.throttle WHERE key=$1', [key])
      ).rows[0];
      const fresh =
        !r || now - Number(r.window_start) >= security.proofSeconds * 1000;
      if (
        !fresh &&
        (r.count >= security.resendLimit ||
          now - Number(r.last_at) < security.resendSeconds * 1000)
      )
        return false;
      await q(
        `INSERT INTO access_trial.throttle VALUES($1,1,$2,$2) ON CONFLICT(key) DO UPDATE SET count=$3,window_start=$4,last_at=$2`,
        [
          key,
          now,
          fresh ? 1 : r.count + 1,
          fresh ? now : Number(r.window_start),
        ],
      );
      return true;
    };
    const run = async (): Promise<AccessOutput> => {
      if (!provisionalOnly && !administrative && input.session && !session)
        return failure('unauthenticated');
      if (!context) return failure('unauthenticated');
      expiry = Math.min(expiry, Number(context.expires_at));
      if (proof && !session && !provisionalOnly)
        expiry = Math.min(expiry, Number(proof.expires_at));
      const post = ACCESS_ROUTES[route].method === 'POST';
      if (post && !tokenMatches(input.csrf, context.csrf))
        return failure('forbidden');
      if (
        post &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.intent ?? '')
      )
        return failure('invalid_request');
      const payload = service.digest(canonicalIntent(route, path, body));
      if (administrative && !viewer) return failure('forbidden');
      if (route === 'operation_result') {
        if (!uuid.test(path.operation_id ?? '')) return failure('unavailable');
        const receiptPrincipals = [principal];
        if (flow && proof && (!session || session.email === proof.email))
          receiptPrincipals.push('flow:' + flow.digest);
        const r = (
          await q(
            'SELECT * FROM access_trial.invitation_intent WHERE operation_id=$1 AND principal=ANY($2::text[])',
            [path.operation_id, receiptPrincipals],
          )
        ).rows[0];
        if (!r || (!session && !proof)) return failure('unavailable');
        if (r.route === 'withdraw_grant') {
          const grant = authority.grants.find((g) => g.id === r.object_ref);
          if (
            !viewer ||
            !grant ||
            !authority.allows(
              viewer,
              grant.permission_id,
              'grant',
              grant.scope_ref,
            )
          )
            return failure('forbidden');
        }
        if (r.invitation_id) {
          const target = (
            await q('SELECT * FROM access_trial.invitation WHERE id=$1', [
              r.invitation_id,
            ])
          ).rows[0];
          if (
            session?.email !== target.email &&
            proof?.email !== target.email
          ) {
            const terms = (
              await q(
                'SELECT * FROM access_trial.invitation_revision WHERE invitation_id=$1 AND revision=$2',
                [target.id, target.revision],
              )
            ).rows[0];
            if (
              !viewer ||
              viewer.id !== target.issuer_id ||
              !authority.compile(
                viewer,
                target.family,
                terms.grants,
                Number(target.expires_at),
              )
            )
              return failure('forbidden');
          }
        }
        return {
          status: 200,
          body: { operation_id: r.operation_id, status: 'completed' },
        };
      }
      const prior = post
        ? (
            await q(
              'SELECT * FROM access_trial.invitation_intent WHERE principal=$1 AND route=$2 AND intention=$3',
              [principal, route, input.intent],
            )
          ).rows[0]
        : null;
      if (prior) {
        if (prior.payload_digest !== payload)
          return failure('revision_conflict');
        if (administrative) {
          if (
            route === 'issue_invitation' &&
            !authority.compile(
              viewer,
              String(body.family),
              body.grants as GrantSelector[],
              Number(body.expires_at),
            )
          )
            return failure('forbidden');
          if (inv && (viewer.id !== inv.issuer_id || !currentTerms()))
            return failure('forbidden');
          if (route === 'withdraw_grant') {
            const g = authority.grants.find((g) => g.id === path.grant_id);
            if (
              !g ||
              !authority.allows(viewer, g.permission_id, 'grant', g.scope_ref)
            )
              return failure('forbidden');
          }
        } else if (
          route === 'accept_invitation' &&
          (!recipient() ||
            !proof ||
            proof.id !== body.proof_id ||
            proof.superseded)
        )
          return failure('forbidden');
        // No response here contains a credential, cookie or one-time code.
        return { status: 200, body: prior.receipt };
      }
      let result: AccessOutput;
      if (route === 'issue_invitation') {
        if (!invitationExpiryAllowed(security, now, Number(body.expires_at)))
          return failure('invalid_request');
        if (body.email === control.master_email) return failure('forbidden');
        const terms = authority.compile(
          viewer,
          String(body.family),
          body.grants as GrantSelector[],
          Number(body.expires_at),
        );
        if (
          !terms ||
          authority.incompatible(
            await person(String(body.email)),
            body.grants as GrantSelector[],
          )
        )
          return failure('forbidden');
        const id = randomUUID();
        await q(
          'INSERT INTO access_trial.invitation VALUES($1,$2,$3,$4,$5,$6,1,$7,NULL,NULL)',
          [
            id,
            viewer.id,
            body.email,
            body.family,
            now,
            body.expires_at,
            'pending',
          ],
        );
        inv = { id, revision: 1 };
        subject = id;
        await q(
          'INSERT INTO access_trial.invitation_revision VALUES($1,1,$2,$3,$4,$5)',
          [
            id,
            JSON.stringify(body.grants),
            JSON.stringify(terms),
            viewer.id,
            now,
          ],
        );
        await event(id, 1, { terms });
        mail = {
          email: String(body.email),
          invitation_id: id,
          purpose: 'invitation_notice',
        };
        result = {
          status: 200,
          body: {
            invitation_id: id,
            revision: 1,
            status: 'pending_acceptance',
          },
        };
      } else if (route === 'invitation_challenge') {
        const allowed = await throttle(
          'invitation-mail:' +
            service.digest(String(path.invitation_id) + ':' + input.peer),
        );
        const eligible =
          inv &&
          inv.state === 'pending' &&
          Number(inv.expires_at) > now &&
          currentTerms();
        // Generic reception is identical for unknown, unauthorized, withdrawn and valid locators.
        if (allowed) {
          const id = randomUUID(),
            code = secret();
          await q(
            'UPDATE access_trial.email_proof SET superseded=true WHERE invitation_id IS NOT DISTINCT FROM $1 AND flow_digest=$2',
            [eligible ? inv.id : null, flow.digest],
          );
          await q(
            `INSERT INTO access_trial.email_proof(id,invitation_id,flow_digest,verifier,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
            [
              id,
              eligible ? inv.id : null,
              flow.digest,
              service.digest(code),
              Math.min(
                expiry,
                eligible ? Number(inv.expires_at) : expiry,
                now + security.proofSeconds * 1000,
              ),
              now,
            ],
          );
          if (eligible)
            mail = {
              email: inv.email,
              challenge_id: id,
              code,
              purpose: 'invitation',
            };
        }
        result = { status: 200, body: { status: 'accepted' } };
      } else if (route === 'verify_invitation_email') {
        const p = uuid.test(path.challenge_id ?? '')
          ? (
              await q('SELECT * FROM access_trial.email_proof WHERE id=$1', [
                path.challenge_id,
              ])
            ).rows[0]
          : null;
        if (
          !p ||
          p.flow_digest !== flow.digest ||
          p.used ||
          p.superseded ||
          p.attempts >= security.proofAttempts ||
          Number(p.expires_at) <= now ||
          !inv ||
          inv.state !== 'pending' ||
          Number(inv.expires_at) <= now
        )
          return failure('forbidden');
        await q(
          'UPDATE access_trial.email_proof SET attempts=attempts+1 WHERE id=$1',
          [p.id],
        );
        if (
          !timingSafeEqual(
            Buffer.from(service.digest(String(body.code))),
            Buffer.from(p.verifier),
          )
        )
          return failure('forbidden');
        await q(
          'UPDATE access_trial.email_proof SET verified=true WHERE id=$1',
          [p.id],
        );
        expiry = Math.min(expiry, Number(p.expires_at));
        result = {
          status: 200,
          body: { proof_id: p.id, expires_at: Number(p.expires_at) },
        };
      } else if (route === 'invitation_view') {
        if (!inv || !current || !canInspect()) return failure('unavailable');
        const grants = (
          await q(
            `SELECT g.id,g.revision FROM access_trial.grant_record g JOIN access_trial.acceptance a ON a.id=g.acceptance_id WHERE a.invitation_id=$1`,
            [inv.id],
          )
        ).rows;
        result = {
          status: 200,
          body: {
            invitation_id: inv.id,
            revision: inv.revision,
            email: inv.email,
            family: inv.family,
            grants: current.grants,
            expires_at: Number(inv.expires_at),
            state: inv.state,
            terms: current.terms,
            accepted_grants: grants.map((g) => ({
              grant_id: g.id,
              revision: g.revision,
            })),
          },
        };
      } else if (
        route === 'amend_invitation' ||
        route === 'withdraw_invitation'
      ) {
        if (!inv || !current || viewer.id !== inv.issuer_id || !currentTerms())
          return failure('forbidden');
        if (inv.revision !== body.expected_revision)
          return failure('revision_conflict');
        if (inv.state !== 'pending' || Number(inv.expires_at) <= now)
          return failure('forbidden');
        const revision = inv.revision + 1;
        if (route === 'amend_invitation') {
          const terms = authority.compile(
            viewer,
            inv.family,
            body.grants as GrantSelector[],
            Number(inv.expires_at),
          );
          if (
            !terms ||
            authority.incompatible(
              await person(inv.email),
              body.grants as GrantSelector[],
            )
          )
            return failure('forbidden');
          await q(
            'INSERT INTO access_trial.invitation_revision VALUES($1,$2,$3,$4,$5,$6)',
            [
              inv.id,
              revision,
              JSON.stringify(body.grants),
              JSON.stringify(terms),
              viewer.id,
              now,
            ],
          );
          await q(
            'UPDATE access_trial.invitation SET revision=$2 WHERE id=$1',
            [inv.id, revision],
          );
          await event(inv.id, revision, { terms });
          mail = {
            email: inv.email,
            invitation_id: inv.id,
            purpose: 'invitation_amended',
          };
        } else {
          await q(
            'UPDATE access_trial.invitation SET state=$2,withdrawn_at=$3 WHERE id=$1',
            [inv.id, 'withdrawn', now],
          );
          await event(inv.id, inv.revision, { reason: body.reason });
        }
        result = {
          status: 200,
          body: {
            operation_id: operation,
            status: 'completed',
            revision: route === 'amend_invitation' ? revision : inv.revision,
          },
        };
      } else if (route === 'accept_invitation') {
        if (
          !inv ||
          !current ||
          !recipient() ||
          !proof ||
          proof.id !== body.proof_id ||
          proof.invitation_id !== inv.id ||
          proof.used ||
          proof.superseded
        )
          return failure('forbidden');
        if (inv.revision !== body.expected_revision)
          return failure('revision_conflict');
        if (
          inv.state !== 'pending' ||
          Number(inv.expires_at) <= now ||
          !invitationExpiryAllowed(
            security,
            Number(inv.issued_at),
            Number(inv.expires_at),
          )
        )
          return failure('forbidden');
        expiry = Math.min(
          expiry,
          Number(inv.expires_at),
          Number(proof.expires_at),
        );
        const terms = currentTerms();
        if (!terms) return failure('forbidden');
        if (canonicalValue(terms) !== canonicalValue(current.terms))
          return failure('revision_conflict');
        const personRef = await person(inv.email);
        if (authority.incompatible(personRef, current.grants))
          return failure('forbidden');
        let target = (
          await q('SELECT * FROM access_trial.account WHERE email=$1', [
            inv.email,
          ])
        ).rows[0];
        if (target?.restricted || target?.office === 'master')
          return failure('forbidden');
        if (!target) {
          const id = randomUUID();
          await q(
            'INSERT INTO access_trial.account(id,email,person_ref,office,verifier,origin_invitation_id) VALUES($1,$2,$3,NULL,NULL,$4)',
            [id, inv.email, personRef, inv.id],
          );
          await q(
            'INSERT INTO access_trial.person_account VALUES($1,$2,$3,$4)',
            [id, personRef, 'invitation:' + inv.id, now],
          );
          target = { id, verifier: null };
        }
        await q(
          'INSERT INTO access_trial.acceptance VALUES($1,$2,$3,$4,$5,$6)',
          [operation, inv.id, inv.revision, target.id, proof.id, now],
        );
        for (const term of terms)
          await q(
            `INSERT INTO access_trial.grant_record VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false,1)`,
            [
              randomUUID(),
              target.id,
              term.permission_id,
              term.exercise_or_grant,
              term.scope_ref,
              term.support_ref,
              operation,
              'acceptance:' + operation,
              term.expires_at,
            ],
          );
        await q(
          "UPDATE access_trial.invitation SET state='accepted',accepted_at=$2 WHERE id=$1",
          [inv.id, now],
        );
        await q('UPDATE access_trial.email_proof SET used=true WHERE id=$1', [
          proof.id,
        ]);
        if (target.verifier === null)
          await q(
            'INSERT INTO access_trial.initial_credential_flow VALUES($1,$2,$3,$4,false) ON CONFLICT(flow_digest) DO NOTHING',
            [
              flow.digest,
              target.id,
              operation,
              Math.min(expiry, Number(proof.expires_at)),
            ],
          );
        await event(inv.id, inv.revision, {
          account_ref: target.id,
          acceptance_ref: operation,
          terms,
        });
        result = {
          status: 200,
          body: {
            operation_id: operation,
            status: 'completed',
            revision: inv.revision,
          },
        };
      } else if (route === 'initial_credential') {
        const f = (
          await q(
            'SELECT * FROM access_trial.initial_credential_flow WHERE flow_digest=$1',
            [flow.digest],
          )
        ).rows[0];
        if (!f || f.consumed || Number(f.expires_at) <= now)
          return failure('forbidden');
        expiry = Math.min(expiry, Number(f.expires_at));
        const target = (
          await q('SELECT * FROM access_trial.account WHERE id=$1', [
            f.account_id,
          ])
        ).rows[0];
        if (
          !target ||
          target.restricted ||
          target.office === 'master' ||
          target.verifier !== null
        )
          return failure('forbidden');
        const verifier = await service.passwords.create(String(body.password));
        await q(
          'UPDATE access_trial.account SET verifier=$2,revision=revision+1 WHERE id=$1',
          [target.id, verifier],
        );
        await q(
          'UPDATE access_trial.initial_credential_flow SET consumed=true WHERE account_id=$1',
          [target.id],
        );
        await event(target.id, target.revision + 1, {
          acceptance_ref: f.acceptance_id,
        });
        result = {
          status: 200,
          body: {
            operation_id: operation,
            status: 'completed',
            revision: target.revision + 1,
          },
        };
      } else if (route === 'withdraw_grant') {
        const g = authority.grants.find((g) => g.id === path.grant_id);
        const target =
          g && authority.accounts.find((a) => a.id === g.account_id);
        if (
          !g ||
          !target ||
          target.office === 'master' ||
          !authority.allows(viewer, g.permission_id, 'grant', g.scope_ref)
        ) {
          await event('restricted-grant', 0, {
            escalation: 'competent-domain',
            reason: 'outside-current-granting-authority',
          });
          return failure('forbidden');
        }
        if (g.revision !== body.expected_revision)
          return failure('revision_conflict');
        if (g.withdrawn) return failure('forbidden');
        await q(
          'UPDATE access_trial.grant_record SET withdrawn=true,revision=revision+1 WHERE id=$1',
          [g.id],
        );
        await event(g.id, g.revision + 1, { reason: body.reason });
        result = {
          status: 200,
          body: {
            operation_id: operation,
            status: 'completed',
            revision: g.revision + 1,
          },
        };
      } else return failure('unavailable');
      if (post && result.status === 200)
        await q(
          'INSERT INTO access_trial.invitation_intent VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            principal,
            route,
            input.intent,
            payload,
            'canon_m09_1',
            operation,
            inv?.id ?? null,
            result.body,
            now,
            path.grant_id ?? null,
          ],
        );
      return result;
    };
    const output = await run();
    expiry = Math.min(expiry, authority.deadline);
    if (
      output.status === 200 &&
      !validateAccess(route, 'response', output.body)
    )
      throw new Error('INVALID_INVITATION_PROJECTION');
    await hooks.beforeCommit?.(route);
    if (output.status === 200 && (await db.now()) >= expiry)
      throw new Error('DEADLINE_BEFORE_EFFECT');
    await q(
      'INSERT INTO access_trial.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        operation,
        route,
        actor,
        subject,
        output.status,
        control.revision,
        await db.now(),
        control.reception.purposeRef,
        'synthetic-local',
      ],
    );
    await db.commit();
    output.evidenceId = operation;
    output.expiresAt = expiry;
    await hooks.afterCommit?.(route);
    if (mail) void mailbox.send(mail).catch(() => {});
    return {
      output,
      close,
      observe: async (outcome: 'handed_off' | 'interrupted') => {
        await db.releaseAdmission();
        await q(
          'INSERT INTO access_trial.transport_observation VALUES($1,$2,$3)',
          [operation, outcome, await db.now()],
        );
      },
    };
  } catch (error) {
    hooks.failure?.(error);
    await close();
    return { output: failure('technical_failure'), close: async () => {} };
  }
}
