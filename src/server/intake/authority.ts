import { createHash } from 'node:crypto';
import { BINDINGS, bindingConsistent } from '../../contracts/intake_bindings.ts';
import { exactReference, record } from '../../contracts/intake.ts';
import type { ExactReference, ReceptionRoute } from '../../contracts/intake_reception.ts';
import { canonicalValue } from '../../contracts/access_canonical.ts';
import { InvitationAuthority } from '../access/invitation_authority.ts';
import { startupAllowed } from '../access/service.ts';
import { tokenMatches } from '../access/transport.ts';
import { IntakeStore } from './postgres/store.ts';
import type { IntakeConfig, IntakeRole } from './config.ts';
import { IntakeFailure, type ReceptionRequest } from './protocol.ts';

export type IntakeSession = { digest: string; account_id: string; person_ref: string; expires_at: string | number; revision: number; account_revision: number; csrf: string };
export type Admission = {
  db: IntakeStore; now: number; deadline: number; session: IntakeSession;
  authority: InvitationAuthority; control: any; treatment: any; entry: any;
  binding: any; executor: ExactReference;
};
const equal = (a: unknown, b: unknown) => canonicalValue(a) === canonicalValue(b);
const reference = (id: string, revision: number, value: unknown): ExactReference => ({ id, revision,
  sha256: createHash('sha256').update(canonicalValue(value)).digest('hex') });
const validReference = (value: unknown): value is ExactReference => exactReference(value);

/** The adapter resolves controlled inputs; the established evaluator resolves grants. */
export class IntakeAuthority {
  readonly config: IntakeConfig;
  readonly digest: (value: string) => string;
  readonly observation:((event:Record<string,unknown>)=>void)|undefined;
  constructor(config: IntakeConfig, digest: (value: string) => string,observation?:(event:Record<string,unknown>)=>void) { this.config = config; this.digest = digest;this.observation=observation; }

  /** Admit metadata investigation before selecting a protected record or collecting a command. */
  async beforeMetadata(admission: Admission, operation: ReceptionRoute): Promise<void> {
    try { await this.evaluateMetadata(admission,operation); }
    catch(error){this.observeRefusal(admission,operation,error);throw error;}
  }
  private observeRefusal(admission:Admission,operation:ReceptionRoute,error:unknown) {
    this.observation?.({origin:'current-authority-boundary',kind:'refused',operation,principal:admission.session.account_id,
      status:error instanceof IntakeFailure?error.status:503,backendPid:admission.db.backendPid,
      controlSourceId:admission.control.source_id,controlRevision:admission.control.revision,atMs:Date.now()});
  }
  /** Resolve the current treatment scope before an original selector can reveal a record. */
  async beforeOriginalSelection(admission:Admission):Promise<{scope_id:string;purpose_id:string}> {
    const treatment=(await admission.db.query(`SELECT t.*,c.enabled FROM intake_control.treatment_current c
      JOIN intake_control.treatment t USING(id,revision) WHERE c.singleton`)).rows[0];
    if(!treatment?.enabled)throw new IntakeFailure(404);
    const context={scope_id:treatment.scope_ref,purpose_id:treatment.purpose_ref,
      treatment_revision:{id:treatment.id,revision:treatment.revision,sha256:treatment.sha256}};
    // Reuse the established evaluator, including descendant scopes; do not require
    // a root grant or use a target's existence to decide whether to evaluate it.
    await this.resolve(admission,'original',context);
    return {scope_id:context.scope_id,purpose_id:context.purpose_id};
  }
  private async evaluateMetadata(admission: Admission, operation: ReceptionRoute): Promise<void> {
    const entries = (await admission.db.query('SELECT * FROM intake_control.catalog_entry WHERE operation=ANY($1::text[])',
      [[operation, 'lookup_operation']])).rows;
    const actor = admission.authority.accounts.find(a => a.id === admission.session.account_id);
    const acceptable = entries.some(entry => entry.active && equal(entry.catalog, this.config.catalog) &&
      equal(entry.definition, BINDINGS[entry.operation]) && admission.authority.allows(actor, entry.permission_id, 'exercise', entry.scope_ref));
    if (!acceptable) throw new IntakeFailure(404);
    const treatment = (await admission.db.query(`SELECT t.*,c.enabled FROM intake_control.treatment_current c
      JOIN intake_control.treatment t USING(id,revision) WHERE c.singleton`)).rows[0];
    if (!treatment?.enabled || Number(treatment.expires_at) <= admission.now ||
        !treatment.fields.includes('intake-metadata') || treatment.receiver?.coverage !== 'first-receiver' ||
        !treatment.actions.includes('capture')) throw new IntakeFailure(404);
    admission.deadline = Math.min(admission.deadline, admission.authority.deadline, Number(treatment.expires_at));
    this.observation?.({origin:'current-authority-boundary',kind:'metadata-admitted',operation,principal:admission.session.account_id,
      backendPid:admission.db.backendPid,controlSourceId:admission.control.source_id,controlRevision:admission.control.revision,atMs:Date.now()});
  }

  async open(request: ReceptionRequest, token: string | null, keys: string[], onLoss: () => void,
    role: IntakeRole = 'inc03_intake_runtime'): Promise<Admission> {
    const db = new IntakeStore(this.config, onLoss, role,this.observation);
    try {
      await db.admit(false);
      const sessionDigest = token ? this.digest(token) : '';
      // Resolve the lock namespace from the authenticated session record, before the RR snapshot.
      // Object/revision stay in the compared payload, never in this intention namespace.
      const principal=sessionDigest?(await db.query('SELECT account_id FROM access_trial.session WHERE digest=$1',[sessionDigest])).rows[0]?.account_id:null;
      const intentionKey=principal&&request.clientKey?'intake:intention:'+this.config.deployment+':'+principal+':'+BINDINGS[request.route].basis+':'+request.route+':'+request.clientKey:null;
      await db.begin([...keys, ...(sessionDigest ? ['session:' + sessionDigest] : []),...(intentionKey?[intentionKey]:[])]);
      const now = await db.now();
      const control = (await db.query('SELECT * FROM intake_control.live WHERE singleton')).rows[0];
      const namespace = (await db.query('SELECT * FROM intake_control.namespace_admission WHERE namespace=$1', [this.config.namespace])).rows[0];
      if (!control || !control.enabled || control.source_id !== this.config.controlSource ||
          control.generation !== this.config.generation || control.incarnation !== this.config.incarnation ||
          Number(control.expires_at) <= now || !equal(control.catalog, this.config.catalog) ||
          !equal(control.configuration, this.config.configuration) || !equal(control.limits, this.config.limits) ||
          !namespace?.enabled || namespace.source_id !== control.source_id || namespace.generation !== control.generation ||
          (this.config.namespace === 'intake_restore' && !namespace.backup_anchor)) throw new IntakeFailure(503);
      const deployment = (await db.query('SELECT * FROM access_trial.deployment')).rows[0];
      if (!startupAllowed(deployment, now)) throw new IntakeFailure(503);
      const session = (await db.query(`SELECT s.*,a.person_ref,a.restricted,a.revision AS account_revision
        FROM access_trial.session s JOIN access_trial.account a ON a.id=s.account_id WHERE s.digest=$1`, [sessionDigest])).rows[0];
      if (!session || session.revoked || session.restricted || Number(session.expires_at) <= now ||
          session.revision !== session.account_revision || (request.method === 'POST' && !tokenMatches(request.csrf, session.csrf))) throw new IntakeFailure(403);
      const authority = new InvitationAuthority(db, now);
      await authority.load();
      this.observation?.({origin:'current-authority-boundary',kind:'principal-resolved',operation:request.route,principal:session.account_id,
        backendPid:db.backendPid,controlSourceId:control.source_id,controlRevision:control.revision,atMs:Date.now()});
      return { db, now, deadline: Math.min(Number(control.expires_at), Number(session.expires_at), deployment.root.termination.at),
        session, authority, control, treatment: null, entry: null, binding: null,
        executor: reference('intake-service:' + this.config.incarnation, this.config.generation, { incarnation: this.config.incarnation, generation: this.config.generation }) };
    } catch (error) { await db.close(); throw error; }
  }

  async resolve(admission: Admission, operation: ReceptionRoute, context?: { scope_id: string; purpose_id: string; treatment_revision: ExactReference },
    reception?: any, phase?: any): Promise<void> {
    try{await this.evaluate(admission,operation,context,reception,phase);}
    catch(error){this.observeRefusal(admission,operation,error);throw error;}
  }
  private async evaluate(admission: Admission, operation: ReceptionRoute, context?: { scope_id: string; purpose_id: string; treatment_revision: ExactReference },
    reception?: any, phase?: any): Promise<void> {
    const { db, authority, session } = admission;
    const entry = (await db.query('SELECT * FROM intake_control.catalog_entry WHERE operation=$1', [operation])).rows[0];
    if (!entry?.active || !equal(entry.catalog, this.config.catalog) || !equal(entry.definition, BINDINGS[operation]) ||
        !validReference(entry.route_reference) || !validReference(entry.source_comparison)) throw new IntakeFailure(503);
    const expectedPartition = operation === 'original' ? 'whole_original' : ['lookup_operation', 'reception'].includes(operation)
      ? 'own_record' : operation === 'profiles' ? 'visible_surfaces' : 'personal_load';
    if (entry.partition !== expectedPartition) throw new IntakeFailure(503);
    const scopeId = context?.scope_id ?? reception?.context?.scope_id ?? entry.scope_ref;
    const purpose = context?.purpose_id ?? reception?.context?.purpose_id ?? entry.purpose_ref;
    const scope = authority.scopes.find(s => s.id === scopeId && s.active);
    const permission = authority.permissions.find(p => p.id === entry.permission_id && p.active);
    const actor = authority.accounts.find(a => a.id === session.account_id);
    if (!scope || !permission || scope.purpose_ref !== purpose || purpose !== entry.purpose_ref ||
        !authority.contains(entry.scope_ref, scopeId) || !authority.allows(actor, permission.id, 'exercise', scopeId)) throw new IntakeFailure(404);
    // Query/whole-original views are scoped to an owned permitted record, not arbitrary selectors.
    if (reception && reception.principal !== session.account_id) throw new IntakeFailure(404);
    if (expectedPartition === 'personal_load' && reception && reception.origin_session !== session.digest) throw new IntakeFailure(404);
    const selectedGrant = authority.grants.find(g => g.account_id === session.account_id && g.permission_id === permission.id &&
      g.faculty === 'exercise' && authority.contains(g.scope_ref, scopeId) && authority.grantAlive(g));
    const support = authority.supports.find(s => s.id === selectedGrant?.support_ref);
    if (!support) throw new IntakeFailure(404);
    const treatment = (await db.query(`SELECT t.*,c.enabled FROM intake_control.treatment_current c
      JOIN intake_control.treatment t USING(id,revision) WHERE c.singleton`)).rows[0];
    if (!treatment?.enabled || treatment.scope_ref !== scopeId || treatment.purpose_ref !== purpose || Number(treatment.expires_at) <= admission.now ||
        !Array.isArray(treatment.fields) || !treatment.fields.includes('intake-metadata') ||
        !treatment.disposition_ref || !['receiver','storage','processor','response_destination'].every(name => validReference(treatment[name]?.reference))) throw new IntakeFailure(404);
    if (!['FN-APROBACION', 'FN-AMBITO'].includes(treatment.receiver.function) ||
        !treatment.receiver.responsible_person || treatment.receiver.coverage !== 'first-receiver' ||
        treatment.response_destination.kind !== 'current-session-origin') throw new IntakeFailure(404);
    const treatmentRef = { id: treatment.id, revision: treatment.revision, sha256: treatment.sha256 };
    if (context && !equal(context.treatment_revision, treatmentRef)) throw new IntakeFailure(409);
    const definition = BINDINGS[operation];
    if (definition.treatment.some(action => !treatment.actions.includes(action)) ||
        (['upload_original', 'finalize_reception', 'original'].includes(operation) && !treatment.fields.includes('original-body'))) throw new IntakeFailure(404);
    admission.deadline = Math.min(admission.deadline, authority.deadline, Number(treatment.expires_at));
    const current: Record<string, unknown> = {
      deployment: this.config.deployment, catalog: this.config.catalog,
      entry: { id: operation, revision: entry.entry_revision }, permission: { id: permission.id, revision: permission.revision },
      support: { id: support.id, revision: support.revision }, scope: { id: scopeId, revision: scope.revision }, purpose,
      route: entry.route_reference, treatment: treatmentRef,
      admission: reference('admission:' + this.config.controlSource, admission.control.revision,
        { control: admission.control.revision, treatment: treatmentRef, session: session.digest, scope: scopeId, permission: permission.id }),
      signature: entry.signature,
      view_partitions: ['whole_original', 'own_record'].includes(expectedPartition) ? [{ id: scopeId, revision: scope.revision }] : [],
    };
    if (expectedPartition === 'personal_load') {
      if (!reception?.load_reference || !phase) throw new IntakeFailure(503);
      const attempt=(await db.query('SELECT artifact_id,generation,reserved_bytes FROM $INTAKE.attempt WHERE reception_id=$1 AND generation=$2',
        [reception.id,phase.attempt])).rows[0];
      if(!attempt && (operation!=='reserve_reception'||phase.attempt!==1))throw new IntakeFailure(503);
      const original=attempt?{id:attempt.artifact_id,generation:attempt.generation,bytes:attempt.reserved_bytes,sha256:reception.declaration.sha256}:reception.load_reference.original;
      current.load = { ...reception.load_reference, original, destination: treatment.storage.reference };
      current.phase = phase;
    }
    if (operation === 'cancel_reception') current.comparison = entry.source_comparison;
    const binding = { profile: 'intake-binding/2', operation, catalog: current.catalog, entry: current.entry,
      basis: definition.basis, effect: definition.effect, holder: definition.holder, faculty: 'exercise', ...current,
      kind: expectedPartition === 'personal_load' ? 'personal_load_phase' : 'act', mode: 'person' } as any;
    delete binding.deployment;
    if (!bindingConsistent(binding, current)) throw new IntakeFailure(503);
    admission.entry = entry; admission.treatment = treatment; admission.binding = binding;
    this.observation?.({origin:'current-authority-boundary',kind:'authorized',operation,principal:session.account_id,
      receptionId:reception?.id??null,backendPid:db.backendPid,controlSourceId:admission.control.source_id,
      controlRevision:admission.control.revision,atMs:Date.now()});
  }

  /** Shape verification itself is processing; no body is opened without its treatment. */
  async permitVerification(admission: Admission): Promise<void> {
    if (!admission.treatment || !['read','conserve','process'].every(action => admission.treatment.actions.includes(action)) ||
        admission.treatment.processor.kind !== 'bounded-form-verifier') throw new IntakeFailure(404);
  }
}
