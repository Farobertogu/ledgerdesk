import { randomUUID } from 'node:crypto';
import { canonicalValue } from '../../contracts/access_canonical.ts';
import {
  InvitationAuthority,
  type GrantSelector,
} from './invitation_authority.ts';
import type { AccessStore } from './postgres/store.ts';

export type InitialFaculty = GrantSelector & {
  permission_revision: number;
  scope_revision: number;
  support_revision: number;
  expires_at: number;
};
const ref = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
/** Declaration input, not a public grant route or a role-derived default. */
export function initialFaculties(value: unknown): InitialFaculty[] {
  if (!Array.isArray(value) || value.length > 16)
    throw Error('BOOTSTRAP_FACULTIES');
  const seen = new Set<string>();
  for (const f of value) {
    if (
      !f ||
      Object.keys(f).sort().join(',') !==
        'exercise_or_grant,expires_at,permission_id,permission_revision,scope_ref,scope_revision,support_ref,support_revision' ||
      !['permission_id', 'scope_ref', 'support_ref'].every((k) => ref(f[k])) ||
      ![
        'permission_revision',
        'scope_revision',
        'support_revision',
        'expires_at',
      ].every((k) => Number.isSafeInteger(f[k]) && f[k] > 0) ||
      !['exercise', 'grant'].includes(f.exercise_or_grant) ||
      (f.exercise_or_grant === 'exercise' &&
        !['invite', 'read_people'].includes(f.permission_id))
    )
      throw Error('BOOTSTRAP_FACULTIES');
    const key = canonicalValue([
      f.permission_id,
      f.exercise_or_grant,
      f.scope_ref,
    ]);
    if (seen.has(key)) throw Error('BOOTSTRAP_DUPLICATE');
    seen.add(key);
  }
  return value;
}

/** Called only by first activation, inside its existing snapshot/evidence transaction. */
export async function materializeBootstrap(
  db: AccessStore,
  control: any,
  accountId: string,
  evidenceId: string,
  now: number,
): Promise<number> {
  const q = (sql: string, args: unknown[] = []) => db.client.query(sql, args);
  // Earlier isolated schema profiles remain credential-only. Installing 004 never grants retroactively.
  if (
    !(
      await q(
        "SELECT to_regclass('access_trial.bootstrap_declaration') AS relation",
      )
    ).rows[0].relation
  )
    return control.root.termination.at;
  const declarations = (
    await q('SELECT * FROM access_trial.bootstrap_declaration')
  ).rows;
  const d = declarations[0];
  if (
    declarations.length !== 1 ||
    !ref(d.id) ||
    d.master_email !== control.master_email ||
    d.holder_person_ref !== control.root.holderPersonRef ||
    canonicalValue(d.root) !== canonicalValue(control.root)
  )
    throw Error('BOOTSTRAP_DECLARATION');
  const faculties = initialFaculties(d.faculties);
  const authority = new InvitationAuthority(db, now);
  await authority.load();
  const account = authority.accounts.find((a) => a.id === accountId);
  if (
    !account ||
    account.office !== 'master' ||
    account.person_ref !== d.holder_person_ref ||
    account.restricted
  )
    throw Error('BOOTSTRAP_ACCOUNT');
  let deadline = control.root.termination.at;
  for (const f of faculties) {
    const p = authority.permissions.find((p) => p.id === f.permission_id);
    const scope = authority.scopes.find((s) => s.id === f.scope_ref);
    const support = authority.supports.find((s) => s.id === f.support_ref);
    if (
      !p?.active ||
      p.revision !== f.permission_revision ||
      !scope?.active ||
      scope.revision !== f.scope_revision ||
      !authority.contains(scope.id, scope.id) ||
      !support?.active ||
      support.kind !== 'domain' ||
      support.revision !== f.support_revision ||
      !authority.supportAlive(support.id) ||
      f.expires_at <= now ||
      f.expires_at > Number(support.expires_at) ||
      f.expires_at > control.root.termination.at ||
      !authority.investitureAllows(account, p.id, scope.id)
    )
      throw Error('BOOTSTRAP_CURRENT_BASIS');
    deadline = Math.min(deadline, f.expires_at, authority.deadline);
  }
  if (authority.incompatible(account.person_ref, faculties))
    throw Error('BOOTSTRAP_INCOMPATIBILITY');
  // Evidence FK is checked at commit, preventing a grant-only successful transaction.
  await q('INSERT INTO access_trial.bootstrap_activation VALUES($1,$2,$3)', [
    accountId,
    d.id,
    evidenceId,
  ]);
  await q('INSERT INTO access_trial.person_account VALUES($1,$2,$3,$4)', [
    accountId,
    account.person_ref,
    'bootstrap:' + d.id,
    now,
  ]);
  for (const f of faculties)
    await q(
      'INSERT INTO access_trial.grant_record VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,false,1)',
      [
        randomUUID(),
        accountId,
        f.permission_id,
        f.exercise_or_grant,
        f.scope_ref,
        f.support_ref,
        'bootstrap:' + d.id,
        f.expires_at,
      ],
    );
  return deadline;
}
