import {randomUUID} from 'node:crypto';
import {BINDINGS, PROCESSING_RESOLUTION, processingSignature, bindingConsistent} from '../../contracts/intake_bindings.ts';
import {exactReference} from '../../contracts/intake.ts';
import {WORKER_BINDING, type WorkerBinding, type Artifact} from '../../contracts/intake_extraction.ts';
import {canonicalValue} from '../../contracts/access_canonical.ts';
import {InvitationAuthority} from '../access/invitation_authority.ts';
import {currentIntakeControl,type Admission} from './authority.ts';
import type {IntakeConfig} from './config.ts';
import {IntakeStore} from './postgres/store.ts';
import {IntakeFailure} from './protocol.ts';
import {exact} from './reception.ts';

type Row = Record<string,any>;
export type ProcessingOperation = 'dispatch_extraction'|'accept_extraction_result';
export type ExtractionAdmission = {
  db:IntakeStore;now:number;deadline:number;control:Row;authority:InvitationAuthority;
  declaration:Row;entry:Row;treatment:Row;work:Row;receipt:Row;reception:Row;
  principal:Row;executor:Row;job:Row|null;binding:Row|null;
};
const equal=(a:unknown,b:unknown)=>canonicalValue(a)===canonicalValue(b);
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

/** Internal entry: no browser cookie, worker assertion or SQL-owner credential. */
export class ExtractionAuthority {
  readonly config:IntakeConfig;readonly observe:((event:Record<string,unknown>)=>void)|undefined;
  constructor(config:IntakeConfig,observe?:(event:Record<string,unknown>)=>void) {this.config=config;this.observe=observe;}
  private async declarations(db:IntakeStore,authority:InvitationAuthority,operation:ProcessingOperation,now:number){
    const entry=(await db.query('SELECT * FROM intake_control.catalog_entry WHERE operation=$1',[operation])).rows[0];
    if(!entry?.active||entry.partition!=='extraction_record'||!equal(entry.catalog,this.config.catalog)||
      !equal(entry.definition,BINDINGS[operation])||!exactReference(entry.source_comparison)||!exactReference(entry.route_reference))throw new IntakeFailure(503);
    const treatment=(await db.query(`SELECT t.*,c.enabled FROM intake_control.treatment_current c
      JOIN intake_control.treatment t USING(id,revision) WHERE c.singleton`)).rows[0];
    if(!treatment?.enabled||Number(treatment.expires_at)<=now||!treatment.fields.includes('intake-metadata')||
      !treatment.actions.includes('capture'))throw new IntakeFailure(404);
    const declared=(await db.query(`SELECT d.* FROM intake_control.processing_current c
      JOIN intake_control.processing_declaration d USING(id,revision,sha256,format) WHERE c.enabled`)).rows;
    const admitted=declared.filter(d=>Number(d.expires_at)>now&&equal(d.configuration,this.config.configuration)&&
      equal(d.limits,this.config.limits)&&d.scope_ref===entry.scope_ref&&d.purpose_ref===entry.purpose_ref&&
      authority.allows(authority.accounts.find(a=>a.id===d.executor_account),entry.permission_id,'exercise',d.scope_ref));
    return{entry,treatment,admitted};
  }
  private treatmentAllows(treatment:Row,declaration:Row,operation:ProcessingOperation){
    const processor=treatment.processor;
    return treatment.scope_ref===declaration.scope_ref&&treatment.purpose_ref===declaration.purpose_ref&&
      !!treatment.disposition_ref&&[treatment.receiver?.reference,treatment.storage?.reference,
        processor?.reference,treatment.response_destination?.reference].every(exactReference)&&
      processor.kind==='bounded-intake-workers'&&processor.extraction?.kind==='bounded-extraction-worker'&&
      equal(processor.extraction.reference,declaration.worker)&&
      BINDINGS[operation].treatment.every(action=>treatment.actions.includes(action))&&
      treatment.fields.includes(operation==='dispatch_extraction'?'original-body':'extraction-body');
  }
  /** Offered controlled path, not job admission, capacity or permission to run it.
   * No protected job, original or result is selected to construct this surface. */
  async availability(a:Admission,profiles:Row[]):Promise<Record<string,boolean>>{
    const result:Record<string,boolean>={};
    const contexts=await Promise.all((['dispatch_extraction','accept_extraction_result'] as const)
      .map(async operation=>({operation,...await this.declarations(a.db,a.authority,operation,a.now)})));
    for(const profile of profiles.filter(p=>p.revealable)){
      result[profile.format]=contexts.every(({operation,treatment,admitted})=>admitted.some(d=>
        d.format===profile.format&&equal(d.configuration,profile.configuration)&&
        equal(d.request,profile.processing_request)&&equal(d.plan,profile.processing_plan)&&
        d.scope_ref===a.entry.scope_ref&&d.purpose_ref===a.entry.purpose_ref&&
        ['origin_session','independent_of_origin_session'].includes(d.session_dependency)&&
        [d.configuration,d.limits,d.request,d.plan,d.assignment,d.worker,d.executor_reference].every(exactReference)&&
        this.treatmentAllows(treatment,d,operation)));
    }
    // The projection's clock also observes the controlled declaration window.
    for(const context of contexts){
      a.deadline=Math.min(a.deadline,Number(context.treatment.expires_at),a.authority.deadline);
      for(const declaration of context.admitted)if(result[declaration.format])a.deadline=Math.min(a.deadline,Number(declaration.expires_at));
    }
    return result;
  }
  async open(jobId:string,operation:ProcessingOperation,onLoss:()=>void):Promise<ExtractionAdmission> {
    if(!uuid(jobId)||!['dispatch_extraction','accept_extraction_result'].includes(operation))throw new IntakeFailure(404);
    const db=new IntakeStore(this.config,onLoss,'inc03_intake_runtime',this.observe);
    try {
      // A state-producing decision orders against current public projections.
      // The private-phase runner releases this admission before external work;
      // its durable fence, not an open SQL transaction, then coordinates writers.
      await db.admit(true);
      // Serialize the bounded capacity and the actual job before taking its snapshot.
      await db.begin(['intake:extraction-capacity','intake:extraction:'+jobId]);
      const now=await db.now(),{control,deployment}=await currentIntakeControl(db,this.config,now);
      const authority=new InvitationAuthority(db,now);await authority.load();
      // Controlled declarations may be inspected before a protected job record.
      // At least one current executor must be admitted to the requested scope.
      const {entry,treatment,admitted}=await this.declarations(db,authority,operation,now);
      if(!admitted.length)throw new IntakeFailure(404);
      const work=(await db.query('SELECT * FROM $INTAKE.work WHERE id=$1',[jobId])).rows[0];
      if(!work)throw new IntakeFailure(404);
      const receipt=(await db.query('SELECT * FROM $INTAKE.receipt WHERE id=$1',[work.receipt_id])).rows[0];
      const reception=receipt?(await db.query('SELECT * FROM $INTAKE.reception WHERE id=$1',[receipt.reception_id])).rows[0]:null;
      if(!reception||reception.stopped||work.state==='stopped')throw new IntakeFailure(404);
      const declaration=admitted.find(d=>d.format===reception.format&&equal(d.request,work.request)&&equal(d.plan,work.plan)&&
        d.scope_ref===reception.context.scope_id&&d.purpose_ref===reception.context.purpose_id);
      if(!declaration)throw new IntakeFailure(404);
      if(!['origin_session','independent_of_origin_session'].includes(declaration.session_dependency)||
        ![declaration.configuration,declaration.limits,declaration.request,declaration.plan,declaration.assignment,
          declaration.worker,declaration.executor_reference].every(exactReference))throw new IntakeFailure(503);
      const principal=authority.accounts.find(a=>a.id===reception.principal),executor=authority.accounts.find(a=>a.id===declaration.executor_account);
      if(!principal||principal.restricted||!executor||executor.restricted)throw new IntakeFailure(404);
      const parent=(await db.query("SELECT * FROM intake_control.catalog_entry WHERE operation='reserve_reception'")).rows[0];
      if(!parent?.active||!equal(parent.catalog,this.config.catalog)||!equal(parent.definition,BINDINGS.reserve_reception)||
        !authority.allows(principal,parent.permission_id,'exercise',declaration.scope_ref))throw new IntakeFailure(404);
      let deadline=Math.min(Number(control.expires_at),Number(declaration.expires_at),Number(treatment.expires_at),authority.deadline,deployment.root.termination.at);
      if(declaration.session_dependency==='origin_session') {
        const session=(await db.query('SELECT * FROM access_trial.session WHERE digest=$1',[reception.origin_session])).rows[0];
        if(!session||session.revoked||session.account_id!==principal.id||session.revision!==principal.revision||Number(session.expires_at)<=now)throw new IntakeFailure(404);
        deadline=Math.min(deadline,Number(session.expires_at));
      }
      if(!this.treatmentAllows(treatment,declaration,operation))throw new IntakeFailure(404);
      const job=(await db.query('SELECT * FROM $INTAKE.extraction_job WHERE id=$1',[jobId])).rows[0]??null;
      if(job&&(job.declaration_id!==declaration.id||job.declaration_revision!==declaration.revision||
        job.declaration_sha256!==declaration.sha256))throw new IntakeFailure(404);
      this.observe?.({origin:'processing-authority',kind:'admitted',operation,jobId,principal:principal.id,
        executor:executor.id,controlRevision:control.revision,backendPid:db.backendPid,atMs:Date.now()});
      return {db,now,deadline,control,authority,declaration,entry,treatment,work,receipt,reception,principal,executor,job,binding:null};
    } catch(error) {await db.close();throw error;}
  }
  resolveBinding(a:ExtractionAdmission,operation:ProcessingOperation,worker:WorkerBinding,result?:Artifact):Row {
    if(!a.job||!WORKER_BINDING(worker)||worker.job.id!==a.work.id||worker.receipt.id!==a.receipt.id||
      worker.original.id!==a.receipt.artifact_id||worker.original.generation!==a.receipt.generation||
      worker.original.bytes!==a.receipt.bytes||worker.original.sha256!==a.receipt.sha256||
      !equal(worker.request,a.declaration.request)||!equal(worker.plan,a.declaration.plan)||
      !equal(worker.assignment,a.declaration.assignment)||!equal(worker.worker,a.declaration.worker)||
      !equal(worker.configuration,this.config.configuration)||!equal(worker.limits,this.config.limits)||
      worker.output_namespace!==this.config.namespace)throw new IntakeFailure(404);
    const {authority,entry,declaration,receipt,reception}=a;
    const permission=authority.permissions.find(p=>p.id===entry.permission_id&&p.active),scope=authority.scopes.find(s=>s.id===declaration.scope_ref&&s.active);
    const grant=authority.grants.find(g=>g.account_id===a.executor.id&&g.permission_id===entry.permission_id&&g.faculty==='exercise'&&
      authority.contains(g.scope_ref,declaration.scope_ref)&&authority.grantAlive(g));
    const support=authority.supports.find(s=>s.id===grant?.support_ref);
    if(!permission||!scope||!support||scope.purpose_ref!==declaration.purpose_ref)throw new IntakeFailure(404);
    const load={...receipt.load_reference,original:worker.original,destination:a.treatment.storage.reference};
    const phase={executor:declaration.executor_reference,reservation:exact(reception.id,reception.revision,{id:reception.id,revision:reception.revision}),
      attempt:worker.attempt_generation,predecessor:worker.dispatch_effect};
    const work={id:worker.job,generation:worker.attempt_generation,originating_act:a.work.originating_act,receipt:worker.receipt,
      request:worker.request,plan:worker.plan,worker:worker.worker,acceptance_effect:exact(a.job.effect_slot,1,{effectId:a.job.effect_slot}),
      expires_at:a.deadline,session_dependency:declaration.session_dependency};
    const signature=processingSignature(operation,{load,phase,work,purpose:declaration.purpose_ref});
    if(!signature||!equal(signature,entry.signature))throw new IntakeFailure(503);
    const current={deployment:this.config.deployment,catalog:this.config.catalog,entry:{id:operation,revision:entry.entry_revision},
      permission:{id:permission.id,revision:permission.revision},support:{id:support.id,revision:support.revision},
      scope:{id:scope.id,revision:scope.revision},purpose:declaration.purpose_ref,route:entry.route_reference,
      treatment:{id:a.treatment.id,revision:a.treatment.revision,sha256:a.treatment.sha256},
      admission:exact('processing:'+this.config.controlSource,a.control.revision,{control:a.control.revision,executor:a.executor.id,assignment:declaration.assignment}),
      signature,view_partitions:[],load,phase,work,resolution:PROCESSING_RESOLUTION,...(result?{result}:{})};
    const binding:any={...current,profile:'intake-binding/2',operation,kind:'admitted_processing_phase',faculty:'exercise',
      basis:BINDINGS[operation].basis,effect:BINDINGS[operation].effect,holder:BINDINGS[operation].holder};
    delete binding.deployment;
    if(!bindingConsistent(binding,current))throw new IntakeFailure(503);
    a.binding=binding;return binding;
  }
  async evidence(a:ExtractionAdmission,operation:ProcessingOperation,phase:'read_admission'|'effect',status=200) {
    if(!a.binding)throw new IntakeFailure(503);
    const id=randomUUID();
    await a.db.query('INSERT INTO $INTAKE.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [id,phase,null,a.reception.id,a.receipt.artifact_id,a.receipt.generation,a.principal.id,operation,
        a.control.revision,JSON.stringify(a.binding),status,await a.db.now(),a.db.backendPid]);
    return id;
  }
}
