import type { AccessStore } from './postgres/store.ts';
import {
  canonicalValue,
  scalarOrder,
} from '../../contracts/access_canonical.ts';

export type GrantSelector = {
  permission_id: string;
  exercise_or_grant: 'exercise' | 'grant';
  scope_ref: string;
  support_ref: string;
};
export type InvitationTerm = GrantSelector & {
  permission_label: string;
  scope_label: string;
  purpose_ref: string;
  support_label: string;
  continuity: string;
  permission_revision: number;
  scope_revision: number;
  support_revision: number;
  expires_at: number;
  authority_declarations: {
    declaration_ref: string;
    revision: number;
    accreditation: 'not_externally_accredited';
  }[];
};
/** Current, bounded snapshot inputs. No browser-supplied administrator flag or inferred hierarchy. */
export class InvitationAuthority {
  deadline = Number.MAX_SAFE_INTEGER;
  accounts: any[] = [];
  permissions: any[] = [];
  scopes: any[] = [];
  supports: any[] = [];
  grants: any[] = [];
  investitures: any[] = [];
  rules: any[] = [];
  readonly db: AccessStore;
  readonly now: number;
  constructor(db: AccessStore, now: number) {
    this.db = db;
    this.now = now;
  }
  async load() {
    const lists = [
      'account',
      'permission_definition',
      'scope_definition',
      'support_definition',
      'grant_record',
      'investiture',
      'incompatibility',
    ];
    const rows = [];
    for (const name of lists) {
      const r = (
        await this.db.client.query(
          `SELECT * FROM access_trial.${name} LIMIT 1001`,
        )
      ).rows;
      if (r.length > 1000) throw new Error('AUTHORITY_SNAPSHOT_BOUND');
      rows.push(r);
    }
    [
      this.accounts,
      this.permissions,
      this.scopes,
      this.supports,
      this.grants,
      this.investitures,
      this.rules,
    ] = rows;
  }
  contains(parent: string, child: string): boolean {
    const visited = new Set<string>();
    for (let n: string | null = child; n && visited.size < 32; ) {
      if (visited.has(n)) return false;
      visited.add(n);
      const scope = this.scopes.find((s) => s.id === n && s.active);
      if (!scope) return false;
      if (n === parent) return true;
      n = scope.parent_id;
    }
    return false;
  }
  supportAlive(id: string, visited = new Set<string>()): boolean {
    const s = this.supports.find((x) => x.id === id);
    if (
      !s?.active ||
      Number(s.expires_at) <= this.now ||
      visited.size >= 32 ||
      visited.has('s:' + id)
    )
      return false;
    const next = new Set(visited).add('s:' + id);
    this.deadline = Math.min(this.deadline, Number(s.expires_at));
    return (
      s.kind === 'domain' ||
      this.grantAlive(
        this.grants.find((g) => g.id === s.authority_id),
        next,
      )
    );
  }
  grantAlive(g: any, visited = new Set<string>()): boolean {
    if (
      !g ||
      g.withdrawn ||
      Number(g.expires_at) <= this.now ||
      visited.has('g:' + g.id) ||
      visited.size >= 32
    )
      return false;
    const a = this.accounts.find((a) => a.id === g.account_id),
      p = this.permissions.find((p) => p.id === g.permission_id);
    this.deadline = Math.min(this.deadline, Number(g.expires_at));
    return (
      !!a &&
      !a.restricted &&
      !!p?.active &&
      this.contains(g.scope_ref, g.scope_ref) &&
      this.investitureAllows(a, g.permission_id, g.scope_ref) &&
      this.supportAlive(g.support_ref, new Set(visited).add('g:' + g.id))
    );
  }
  applicableInvestitures(person: string, permission: string, scope: string) {
    const ref = (v: unknown) =>
      typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
    return this.investitures
      .filter((i) => {
        const d = i.declaration;
        return (
          i.active &&
          i.person_ref === person &&
          i.permission_id === permission &&
          Number(i.expires_at) > this.now &&
          this.contains(i.scope_ref, scope) &&
          d?.holderPersonRef === person &&
          Number.isSafeInteger(d?.revision) &&
          d.revision === i.revision &&
          Number.isSafeInteger(d?.startsAt) &&
          d.startsAt <= this.now &&
          d?.termination?.kind === 'expires' &&
          Number.isSafeInteger(d.termination.at) &&
          d.termination.at > this.now &&
          [
            'issuerPersonRef',
            'issuerCapacityRef',
            'functionRef',
            'purposeRef',
            'maximumGradeRef',
            'independenceDeclarationRef',
            'replacementOrChallengeProcedureRef',
          ].every((k) => ref(d[k])) &&
          (d.continuousObligationAcceptanceRef === null ||
            ref(d.continuousObligationAcceptanceRef)) &&
          ['matters', 'partitions', 'risks'].every(
            (k) => Array.isArray(d.scope?.[k]) && d.scope[k].every(ref),
          ) &&
          ref(d.scope?.populationRef)
        );
      })
      .sort((a, b) => scalarOrder(a.id, b.id));
  }
  investitureAllows(account: any, permission: string, scope: string): boolean {
    const p = this.permissions.find((p) => p.id === permission);
    if (!p) return false;
    if (!p.requires_investiture) return true;
    const current = this.applicableInvestitures(
      account.person_ref,
      permission,
      scope,
    );
    for (const i of current)
      this.deadline = Math.min(
        this.deadline,
        Number(i.expires_at),
        i.declaration.termination.at,
      );
    return current.length > 0;
  }
  allows(
    account: any,
    permission: string,
    faculty: string,
    scope: string,
  ): boolean {
    return (
      !!account &&
      !account.restricted &&
      this.investitureAllows(account, permission, scope) &&
      this.grants.some(
        (g) =>
          g.account_id === account.id &&
          g.permission_id === permission &&
          g.faculty === faculty &&
          this.contains(g.scope_ref, scope) &&
          this.grantAlive(g),
      )
    );
  }
  compile(
    account: any,
    family: string,
    selectors: GrantSelector[],
    expiresAt: number,
  ): InvitationTerm[] | null {
    const seen = new Set<string>();
    const terms: InvitationTerm[] = [];
    for (const g of selectors) {
      const key = canonicalValue([
        g.permission_id,
        g.exercise_or_grant,
        g.scope_ref,
      ]);
      if (seen.has(key)) return null;
      seen.add(key);
      const p = this.permissions.find(
        (p) => p.id === g.permission_id && p.active && p.family === family,
      );
      const s = this.scopes.find((s) => s.id === g.scope_ref && s.active);
      const support = this.supports.find((s) => s.id === g.support_ref);
      if (
        !p ||
        !s ||
        !support ||
        !this.supportAlive(support.id) ||
        !this.allows(account, 'invite', 'exercise', g.scope_ref) ||
        !this.allows(account, g.permission_id, 'grant', g.scope_ref)
      )
        return null;
      if (support.kind === 'delegated') {
        const parent = this.grants.find((x) => x.id === support.authority_id);
        if (
          !parent ||
          parent.account_id !== account.id ||
          parent.permission_id !== g.permission_id ||
          parent.faculty !== 'grant' ||
          !this.contains(parent.scope_ref, g.scope_ref)
        )
          return null;
      }
      terms.push({
        ...g,
        permission_label: p.label,
        scope_label: s.label,
        purpose_ref: s.purpose_ref,
        support_label: support.label,
        continuity: support.kind,
        permission_revision: p.revision,
        scope_revision: s.revision,
        support_revision: support.revision,
        expires_at: Number(support.expires_at),
        authority_declarations: ['invite', g.permission_id].flatMap((id) =>
          this.permissions.find((p) => p.id === id)?.requires_investiture
            ? this.applicableInvestitures(
                account.person_ref,
                id,
                g.scope_ref,
              ).map((i) => ({
                declaration_ref: i.id,
                revision: i.revision,
                accreditation: 'not_externally_accredited' as const,
              }))
            : [],
        ),
      });
    }
    return terms;
  }
  incompatible(person: string, additions: GrantSelector[]): boolean {
    const existing = this.grants
      .filter(
        (g) =>
          this.accounts.some(
            (a) => a.id === g.account_id && a.person_ref === person,
          ) && this.grantAlive(g),
      )
      .map((g) => ({ permission_id: g.permission_id, scope_ref: g.scope_ref }));
    // A declared function is not a grant, but local separation rules cover both planes.
    for (const i of this.investitures)
      if (
        this.applicableInvestitures(person, i.permission_id, i.scope_ref).some(
          (x) => x.id === i.id,
        )
      )
        existing.push({
          permission_id: i.permission_id,
          scope_ref: i.scope_ref,
        });
    // A new grant may not create or reinforce an applicable prohibited accumulation.
    return additions.some((a) =>
      [...existing, ...additions].some((b) =>
        this.rules.some(
          (r) =>
            r.active &&
            ((r.first_permission === a.permission_id &&
              r.second_permission === b.permission_id) ||
              (r.second_permission === a.permission_id &&
                r.first_permission === b.permission_id)) &&
            (this.contains(r.scope_ref, a.scope_ref) ||
              this.contains(a.scope_ref, r.scope_ref)) &&
            (this.contains(r.scope_ref, b.scope_ref) ||
              this.contains(b.scope_ref, r.scope_ref)) &&
            (this.contains(a.scope_ref, b.scope_ref) ||
              this.contains(b.scope_ref, a.scope_ref)),
        ),
      ),
    );
  }
}
