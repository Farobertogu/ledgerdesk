import { randomBytes, randomUUID } from 'node:crypto';
import { AccessStore } from './postgres/store.ts';
import { AccessService, startupAllowed } from './service.ts';
import { InvitationAuthority } from './invitation_authority.ts';
import { currentReadingControl } from './reading_control.ts';
import { authenticatedReadingConfig, type AuthenticatedReadingConfig } from './reading_config.ts';
import { accessProblem, validateAccess } from '../../contracts/access.ts';
import { PROBLEMS } from '../../contracts/material_reading.ts';
import { evaluatePolicy, prepareReading, type PolicyHierarchy, type Disclosure, type StoredMaterial } from '../reading/policy.ts';
import type { ReadingContext } from '../reading/context.ts';
import type { ReadingOperation } from '../kb/reading.ts';

export type ProtectedRequest = { kind: 'material'; operation: ReadingOperation } | { kind: 'people'; cursor: string };
export type ReadingHooks = {
  afterCommit?: (event: Readonly<{ evidenceId: string; backendPid: number; surface: string }>) => Promise<void>;
  afterLastClock?: (deadline: number) => void;
};
const levels = ['NONE','EXISTENCE','REFERENCE','EXCERPT','CONTENT'];
const limitHierarchy = (hierarchy: PolicyHierarchy | null, maximum: string, expiry: number): PolicyHierarchy => {
  const original = hierarchy ?? { unit: [], inherited: [], general: [] };
  // Only restrict an existing grant; never manufacture policy or resolve ambiguity here.
  return Object.fromEntries(['unit','inherited','general'].map(tier => [tier,
    Array.isArray((original as any)[tier]) ? (original as any)[tier].map((row: any) => {
      if (!row?.grant || !levels.includes(row.grant.maximum)) return row;
      return { ...row, grant: { ...row.grant,
        maximum: levels[Math.min(levels.indexOf(row.grant.maximum), levels.indexOf(maximum))] as Disclosure,
        validUntil: Math.min(row.grant.validUntil ?? Number.MAX_SAFE_INTEGER, expiry) } };
    }) : (original as any)[tier],
  ])) as PolicyHierarchy;
};

/** One current session/authority/material snapshot, one existing reading/1 projector. */
export class AuthenticatedReading {
  readonly service: AccessService;
  readonly config: AuthenticatedReadingConfig;
  readonly hooks: ReadingHooks;
  constructor(service: AccessService, config: AuthenticatedReadingConfig, hooks: ReadingHooks = {}) {
    this.service = service; this.config = authenticatedReadingConfig(config); this.hooks = hooks;
  }
  async prepare(input: ProtectedRequest, token: string | null, onLoss: () => void) {
    const db = new AccessStore({ ...this.service.config, connectionString: this.config.connectionString }, onLoss, 'inc02_reader');
    const close = () => db.close();
    const surfaceId = input.kind === 'people' ? 'people' : input.operation.kind === 'list' ? 'material-list' : 'material-exact';
    const failure = (status: 403 | 404 | 503) => input.kind === 'material' ? PROBLEMS[status] :
      accessProblem(status === 403 ? 'unauthenticated' : status === 404 ? 'unavailable' : 'technical_failure');
    const digest = (s: string) => this.service.digest(s);
    const sessionDigest = token ? digest(token) : '';
    const evidenceId = randomUUID();
    try {
      await db.admit(false);
      await currentReadingControl(db, this.config.generation);
      await db.begin(sessionDigest ? ['session:' + sessionDigest] : []);
      const q = (sql: string, args: unknown[] = []) => db.client.query(sql, args);
      const now = await db.now();
      const control = await currentReadingControl(db, this.config.generation);
      const deployment = (await q('SELECT * FROM access_trial.deployment')).rows[0];
      if (!startupAllowed(deployment, now)) throw new Error('RECEPTION_UNAVAILABLE');
      let session = (await q(`SELECT s.digest,s.account_id,s.expires_at,s.revoked,s.revision,
        a.restricted,a.person_ref,a.revision AS account_revision FROM access_trial.session s
        JOIN access_trial.account a ON a.id=s.account_id WHERE s.digest=$1`, [sessionDigest])).rows[0];
      if (session && (session.revoked || session.restricted || session.revision !== session.account_revision || Number(session.expires_at) <= now)) session = null;
      let body: any = failure(403);
      let expiresAt = Math.min(deployment.root.termination.at, session ? Number(session.expires_at) : Number.MAX_SAFE_INTEGER);
      let facts: Record<string, unknown> = { controlRevision: control.revision };
      const surface = (await q('SELECT * FROM material_trial.surface WHERE id=$1', [surfaceId])).rows[0];
      if (session) {
        if (!surface || !surface.policy_ready) body = failure(503);
        else if (!surface.enabled) body = failure(404);
        else {
          const authority = new InvitationAuthority(db, now);
          await authority.load();
          const actor = authority.accounts.find(a => a.id === session.account_id);
          const scope = authority.scopes.find(s => s.id === surface.scope_ref && s.active);
          const maximum = scope?.purpose_ref === surface.purpose_ref
            ? authority.readingMaximum(actor, surface.permission_id, surface.scope_ref, surface.purpose_ref) : 'NONE';
          expiresAt = Math.min(expiresAt, authority.deadline);
          facts = { ...facts, accountRevision: session.account_revision, surfaceRevision: surface.revision,
            grants: authority.grants.filter(g => g.account_id === session.account_id && g.permission_id === surface.permission_id)
              .map(g => ({ id: g.id, revision: g.revision })),
            declarations: authority.applicableInvestitures(session.person_ref, surface.permission_id, surface.scope_ref)
              .map(i => ({ id: i.id, revision: i.revision, accreditation: 'not_externally_accredited' })) };
          if (input.kind === 'people') {
            if (maximum === 'NONE') body = failure(404);
            else {
              const candidates = (await q('SELECT account_id,scope_ref,revision FROM material_trial.census_entry LIMIT 1001')).rows;
              if (candidates.length > 1000) throw new Error('CENSUS_BOUND');
              const entries = candidates.filter(e => authority.contains(surface.scope_ref, e.scope_ref) && authority.allows(actor, surface.permission_id, 'exercise', e.scope_ref));
              entries.sort((a,b) => a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0);
              const population = digest('census-population:' + JSON.stringify(['inc02-synthetic',control.generation,this.config.pageSize,surface.id,surface.scope_ref,surface.purpose_ref,surface.revision,
                authority.grants,authority.supports,authority.investitures,authority.revalidationEvents,authority.resolutions,entries]));
              let position = 0;
              let usable = true;
              if (input.cursor) {
                const row = (await q('SELECT * FROM material_trial.census_cursor WHERE digest=$1', [digest('census-cursor:' + input.cursor)])).rows[0];
                usable = !!row && row.account_id === session.account_id && row.session_digest === sessionDigest &&
                  row.population_digest === population && Number(row.expires_at) > now && row.position <= entries.length;
                if (usable) position = row.position;
              }
              if (!usable) body = failure(404);
              else {
                const page = entries.slice(position, position + this.config.pageSize);
                // Fetch names only after population authorization, ordering and page selection.
                const names = (await q('SELECT account_id,display_name FROM material_trial.census_entry WHERE account_id=ANY($1::uuid[])',
                  [page.map(e=>e.account_id)])).rows;
                let next = '';
                if (position + page.length < entries.length) {
                  await q('DELETE FROM material_trial.census_cursor WHERE session_digest=$1 AND expires_at<=$2', [sessionDigest,now]);
                  const count = (await q('SELECT count(*)::int AS n FROM material_trial.census_cursor WHERE session_digest=$1', [sessionDigest])).rows[0].n;
                  if (count >= this.config.cursorLimit) throw new Error('CURSOR_BOUND');
                  next = randomBytes(32).toString('base64url');
                  await q('INSERT INTO material_trial.census_cursor VALUES($1,$2,$3,$4,$5,$6,$7)', [digest('census-cursor:' + next),
                    session.account_id,sessionDigest,population,position+page.length,Math.min(expiresAt,now+this.config.cursorSeconds*1000),now]);
                }
                body = { people: page.map(e => ({ account_id:e.account_id,display_name:names.find(n=>n.account_id===e.account_id)?.display_name })),
                  revision: parseInt(population.slice(0,12),16)+1, next_cursor:next };
                if (!validateAccess('people','response',body)) throw new Error('CENSUS_PROFILE');
              }
            }
          } else {
            const context: ReadingContext = { deploymentId:'inc02-synthetic',scopeId:surface.scope_ref,
              subjectId:session.account_id,surface:surfaceId,purpose:surface.purpose_ref,generation:control.generation };
            const rows = (await q(`SELECT m.deployment_id,m.scope_id,m.unit_key,m.version_key,p.hierarchy
              FROM material_trial.material m LEFT JOIN material_trial.policy p USING(deployment_id,scope_id,unit_key,version_key)
              WHERE m.deployment_id=$1 AND m.scope_id=$2`, [context.deploymentId,context.scopeId])).rows;
            for (const row of rows) row.hierarchy = limitHierarchy(row.hierarchy,maximum,expiresAt);
            const selected = rows.flatMap(row => {
              const d = evaluatePolicy(row.hierarchy,context,input.operation.kind,now);
              return d.grant && !['NONE','EXISTENCE'].includes(d.grant.maximum) ? [{ unit_key:row.unit_key,version_key:row.version_key,
                needs_text:input.operation.kind==='exact' && ['EXCERPT','CONTENT'].includes(d.grant.maximum) }] : [];
            });
            const payloads = (await q(`SELECT m.unit_key,m.version_key,m.original_language,
              CASE WHEN s.needs_text THEN m.original_value ELSE '""'::json END AS original_value,m.metadata,
              CASE WHEN s.needs_text THEN m.fragments ELSE '[]'::json END AS fragments,m.requirements
              FROM material_trial.material m JOIN jsonb_to_recordset($3::jsonb) AS s(unit_key text,version_key text,needs_text boolean)
              USING(unit_key,version_key) WHERE m.deployment_id=$1 AND m.scope_id=$2`,
              [context.deploymentId,context.scopeId,JSON.stringify(selected)])).rows;
            const payloadByPair = new Map(payloads.map(r => [JSON.stringify([r.unit_key,r.version_key]),r]));
            const population: StoredMaterial[] = rows.map(row => {
              const data = payloadByPair.get(JSON.stringify([row.unit_key,row.version_key]));
              return { deploymentId:row.deployment_id,scopeId:row.scope_id,
                reference:{unit_id:JSON.parse(row.unit_key),version_id:JSON.parse(row.version_key)},
                originalText:data?.original_value ?? '',originalLanguage:data?.original_language ?? 'en',
                metadata:data?.metadata ?? {},fragments:data?.fragments ?? [],requirements:data?.requirements ?? {},policy:row.hierarchy };
            });
            const prepared = prepareReading(population,context,input.operation,now);
            body = prepared.response;
            expiresAt = Math.min(expiresAt,prepared.earliestExpiry ?? Number.MAX_SAFE_INTEGER);
            facts.decisions = prepared.decisions;
          }
        }
      }
      const status = 'status' in body ? body.status : 200;
      await q('INSERT INTO material_trial.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [evidenceId,
        session?.account_id ?? 'unverified',sessionDigest || 'none',surfaceId,surface?.purpose_ref ?? 'unavailable',
        input.kind==='material' && input.operation.kind==='exact' ? JSON.stringify(input.operation.reference) : null,
        control.generation,JSON.stringify(facts),status,now]);
      const backendPid = (await q('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await db.commit();
      await this.hooks.afterCommit?.({ evidenceId,backendPid,surface:surfaceId });
      return { status,body,expiresAt,evidenceId,healthy:()=>db.healthy,close,
        observe:async(outcome:'handed_off'|'interrupted') => {
          await q('INSERT INTO material_trial.observation VALUES($1,$2,$3)', [evidenceId,outcome,await db.now()]);
        } };
    } catch (e) {
      await close();
      throw e;
    }
  }
}
