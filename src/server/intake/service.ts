import { createHash, randomUUID } from 'node:crypto';
import { BINDINGS } from '../../contracts/intake_bindings.ts';
import { AVAILABILITY_RESPONSE, RECEPTION_FORMATS } from '../../contracts/intake_reception.ts';
import type {ServingRoute as ReceptionRoute} from './protocol.ts';
import {readExtraction} from './extraction_query.ts';
import {stopExtraction} from './extraction_stop.ts';
import {ExtractionAuthority} from './extraction_authority.ts';
import {AVAILABILITY_RESPONSE_V2} from '../../contracts/intake_reception_v2.ts';
import { IntakeAuthority, type Admission } from './authority.ts';
import { intakeConfig, RECEPTION_BOUNDS, type IntakeConfig } from './config.ts';
import { IntakeFailure, IntakeRepresentationFailure, receptionCanonical, type ReceptionRequest } from './protocol.ts';
import { IntakeStore } from './postgres/store.ts';
import { exact, newReception, phase, projection, selected,assertReceptionRepresentation } from './reception.ts';
import type { OriginalPort, VerificationPort } from './ports.ts';
import {privatePhase} from './private_phase.ts';

export type IntakeHooks = {
  barrier?: (label: string, event: Record<string, unknown>) => Promise<void>;
  comparison?: (event: Record<string, unknown>) => void;
  incumbentComparison?: (event: Record<string, unknown>) => void;
  evidence?: (event: Record<string, unknown>) => void;
  selection?: (event: Record<string, unknown>) => void;
  privateDispatch?: (event: Record<string, unknown>) => void;
  storage?: (event: Record<string, unknown>) => void;
  afterLastClock?: (event: Record<string, unknown>) => Promise<void>;
  failure?: (event: { status:number; code:string|null; locations:string[];
    phase?:'transport_observation'; evidenceId?:string; outcome?:'handed_off'|'interrupted';
    bytes?:number; responseStatus?:number }) => void;
  incomplete?: (event: Record<string, unknown>) => void;
  admission?: (event: Record<string, unknown>) => void;
};
export type PreparedIntake = {
  admission: Admission; status: number; body: unknown; evidenceId: string;
  operationId: string | null; originalBytes?: Buffer; headers?: Record<string,string>;
  close: () => Promise<void>; observe: (outcome:'handed_off'|'interrupted',bytes:number)=>Promise<void>;
};
const keyPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class ReceptionService {
  readonly config: IntakeConfig;
  readonly authority: IntakeAuthority;
  readonly objects: OriginalPort;
  readonly verifier: VerificationPort;
  readonly hooks: IntakeHooks;
  readonly digest: (value:string)=>string;
  readonly activeReceptions = new Set<string>();
  constructor(config:IntakeConfig,digest:(value:string)=>string,objects:OriginalPort,verifier:VerificationPort,hooks:IntakeHooks={}) {
    this.config=intakeConfig(config);this.digest=digest;this.objects=objects;this.verifier=verifier;this.hooks=hooks;
    this.authority=new IntakeAuthority(this.config,digest,hooks.admission);
  }
  async evidence(admission:Admission,route:ReceptionRoute,kind:'capture_admission'|'read_admission'|'effect'|'delivery'|'query',
    subject:{operationId?:string;receptionId?:string;artifactId?:string;generation?:number}={},status=200) {
    const id=randomUUID(),pid=(await admission.db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admission.db.query(`INSERT INTO $INTAKE.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id,kind,subject.operationId??null,subject.receptionId??null,subject.artifactId??null,subject.generation??null,
        admission.session.account_id,route,admission.control.revision,JSON.stringify(admission.binding??{scope:'metadata-capture',executor:admission.executor}),status,await admission.db.now(),pid]);
    this.hooks.evidence?.({origin:'evidence-insert-boundary',id,backendPid:pid,atMs:Date.now()});
    return {id,pid};
  }
  async clock(admission:Admission,point:string,route:ReceptionRoute) {
    const now=await admission.db.now();
    if(!admission.db.healthy||now>=admission.deadline)throw new IntakeFailure(404);
    await this.hooks.afterLastClock?.({point,route,deadlineMs:admission.deadline,lastEvaluationMs:now});
    // The writer-free interval after this evaluation remains a measured R24 obligation.
  }
  async metadata(request:ReceptionRequest,token:string|null,onLoss:()=>void) {
    const admission=await this.authority.open(request,token,[],onLoss);
    try {
      await this.authority.beforeMetadata(admission,request.route);
      const evidence=await this.evidence(admission,request.route,'capture_admission');
      await admission.db.commit();
      await this.hooks.barrier?.('before_metadata_read',{route:request.route,evidenceId:evidence.id,backendPid:evidence.pid});
      await this.clock(admission,'metadata-capture',request.route);
      return {admission,evidenceId:evidence.id,close:()=>admission.db.close()};
    }catch(error){await admission.db.close();throw error;}
  }
  async prepared(admission:Admission,request:ReceptionRequest,status:number,body:unknown,operationId:string|null,subject:any={}):Promise<PreparedIntake>{
    const event=await this.evidence(admission,request.route,'delivery',{...subject,operationId:operationId??undefined},status);
    await admission.db.commit();
    await this.hooks.barrier?.('before_handoff',{route:request.route,evidenceId:event.id,backendPid:event.pid,operationId});
    return {admission,status,body,evidenceId:event.id,operationId,close:()=>admission.db.close(),
      observe:async(outcome,bytes)=>{await admission.db.query('INSERT INTO $INTAKE.transport VALUES($1,$2,$3,$4,$5)',[randomUUID(),event.id,outcome,bytes,await admission.db.now()]);}};
  }
  async command(request:ReceptionRequest,body:any,token:string|null,onLoss:()=>void):Promise<PreparedIntake> {
    const sessionKey=this.digest(token??'');
    const keys=[...(request.route==='reserve_reception'||request.route==='resume_reception'?['intake:quota']:[]),
      request.parameters.id?'intake:reception:'+request.parameters.id:'intake:intention:'+sessionKey+':'+(request.clientKey??'query')];
    const admission=await this.authority.open(request,token,keys,onLoss,
      ['profiles','reception','lookup_operation','original','extraction'].includes(request.route)?'inc03_intake_reader':'inc03_intake_runtime');
    const db=admission.db;
    try {
      await this.authority.beforeMetadata(admission,request.route);
      if(request.route==='profiles')return await this.profiles(admission,request);
      if(request.route==='lookup_operation')return await this.lookup(admission,request,body);
      if(request.route==='reserve_reception')return await this.reserve(admission,request,body);
      if(!uuidPattern.test(request.parameters.id??''))throw new IntakeFailure(404);
      if(request.route==='extraction')return await readExtraction(this,admission,request);
      const originalContext=request.route==='original'?await this.authority.beforeOriginalSelection(admission):undefined;
      const {reception,attempt}=await selected(db,request.parameters.id,admission.session.account_id,originalContext);
      this.hooks.selection?.({origin:'reception-selection-boundary',receptionId:reception.id,principal:admission.session.account_id,
        artifactId:attempt.artifact_id,generation:attempt.generation,backendPid:db.backendPid,atMs:Date.now()});
      const operation=(await db.query("SELECT id FROM $INTAKE.intention WHERE reception_id=$1 AND variant='reserve_reception'",[reception.id])).rows[0];
      if(!operation)throw new IntakeFailure(503);
      if(request.route==='reception') {
        await this.authority.resolve(admission,'reception',undefined,reception);
        await this.evidence(admission,request.route,'query',{operationId:operation.id,receptionId:reception.id});
        return await this.prepared(admission,request,200,await projection(db,reception,attempt,operation.id,request.representation),operation.id,{receptionId:reception.id});
      }
      if(request.route==='original')return await this.original(admission,request,reception,attempt,operation.id);
      const canonical=receptionCanonical(request,body);
      const known=await this.intention(admission,request,canonical);
      if(known) return await this.known(admission,request,known,canonical);
      if(request.route==='finalize_reception') {
        const committed=(await db.query(`SELECT i.* FROM $INTAKE.receipt r JOIN $INTAKE.intention i ON i.id=r.operation_id WHERE r.reception_id=$1`,[reception.id])).rows[0];
        if(committed)return await this.known(admission,request,committed,canonical,'existing-reception-effect');
      }
      await this.authority.resolve(admission,request.route,undefined,reception,phase(admission,reception,attempt));
      await assertReceptionRepresentation(db,reception.id,request.representation);
      if(request.route==='finalize_reception')return await this.finalize(admission,request,body,reception,attempt,canonical);
      if(request.route==='cancel_reception')return await this.cancel(admission,request,body,reception,attempt,canonical,token,onLoss);
      if(request.route==='resume_reception')return await this.resume(admission,request,body,reception,attempt,canonical);
      throw new IntakeFailure(400);
    }catch(error){await db.close();throw error;}
  }
  async intention(admission:Admission,request:ReceptionRequest,canonical:string) {
    if(!request.clientKey)throw new IntakeFailure(400);
    const row=(await admission.db.query(`SELECT * FROM $INTAKE.intention WHERE deployment=$1 AND principal=$2 AND act=$3 AND variant=$4 AND client_key=$5`,
      [this.config.deployment,admission.session.account_id,BINDINGS[request.route].basis,request.route,request.clientKey])).rows[0];
    this.hooks.comparison?.({origin:'canonical-comparison-boundary',operationId:row?.id??null,principal:admission.session.account_id,
      act:BINDINGS[request.route].basis,variant:request.route,clientKey:request.clientKey,canonicalProfile:'canon_m09_1',keyVersion:1,
      comparedCanonicalSha256:createHash('sha256').update(canonical).digest('hex'),storedPayloadDigest:row?.payload_digest??null,
      outcome:!row?'new':row.payload_digest===this.digest(canonical)?'compatible':'incompatible',atMs:Date.now()});
    return row;
  }
  async known(admission:Admission,request:ReceptionRequest,intention:any,canonical:string,selection:'same-namespace'|'existing-reception-effect'='same-namespace') {
    await this.authority.resolve(admission,'lookup_operation');
    const {reception,attempt}=await selected(admission.db,intention.reception_id,admission.session.account_id);
    await this.authority.resolve(admission,'lookup_operation',undefined,reception);
    if(intention.canonical_profile!=='canon_m09_1'||intention.key_version!==this.config.digestKeyVersion)throw new IntakeFailure(503);
    const compatible=intention.payload_digest===this.digest(canonical);
    const receipt=(await admission.db.query('SELECT id,effect_id FROM $INTAKE.receipt WHERE operation_id=$1',[intention.id])).rows[0];
    this.hooks.incumbentComparison?.({origin:'canonical-comparison-boundary',phase:'incumbent-payload',selection,
      principal:admission.session.account_id,requestVariant:request.route,requestClientKey:request.clientKey,
      receptionId:reception.id,operationId:intention.id,incumbentClientKey:intention.client_key,
      canonicalProfile:intention.canonical_profile,keyVersion:intention.key_version,
      comparedCanonicalSha256:createHash('sha256').update(canonical).digest('hex'),storedPayloadDigest:intention.payload_digest,
      outcome:compatible?'compatible':'incompatible',effectId:receipt?.effect_id??null,receiptId:receipt?.id??null,observedAtMs:Date.now()});
    if(!compatible)throw new IntakeFailure(409);
    await this.evidence(admission,request.route,'query',{operationId:intention.id,receptionId:reception.id});
    return this.prepared(admission,request,200,await projection(admission.db,reception,attempt,intention.id,request.representation),intention.id,{receptionId:reception.id});
  }
  async insertIntention(admission:Admission,request:ReceptionRequest,canonical:string,receptionId:string,id=randomUUID(),effectId:string|null=null) {
    await admission.db.query('INSERT INTO $INTAKE.intention VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [id,this.config.deployment,admission.session.account_id,BINDINGS[request.route].basis,request.route,request.clientKey,'canon_m09_1',1,
        this.digest(canonical),receptionId,effectId,admission.now]);return id;
  }
  async reserve(admission:Admission,request:ReceptionRequest,body:any) {
    const canonical=receptionCanonical(request,body),known=await this.intention(admission,request,canonical);
    if(known)return this.known(admission,request,known,canonical);
    const {reception,attempt,operationId}=newReception(this.config,admission,body);
    await this.authority.resolve(admission,'reserve_reception',body.receiving_context,reception,phase(admission,reception,attempt));
    const format=(await admission.db.query('SELECT * FROM intake_control.profile WHERE format=$1',[body.format_profile])).rows[0];
    if(!format?.reception_enabled||format.configuration.id!==this.config.configuration.id||format.configuration.revision!==this.config.configuration.revision||format.configuration.sha256!==this.config.configuration.sha256)throw new IntakeFailure(415);
    const count=(await admission.db.query('SELECT count(*)::int AS n FROM $INTAKE.reception')).rows[0].n;
    const quota=Number((await admission.db.query('SELECT coalesce(sum(reserved_bytes),0) AS n FROM $INTAKE.attempt')).rows[0].n);
    if(count>=RECEPTION_BOUNDS.receptions||quota+body.original.bytes>RECEPTION_BOUNDS.storageBytes)throw new IntakeFailure(429);
    attempt.expires_at=Math.min(attempt.expires_at,admission.deadline);
    reception.load_reference=admission.binding.load;
    const r=reception;
    await admission.db.query('INSERT INTO $INTAKE.reception VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [r.id,r.deployment,r.principal,r.person_ref,r.origin_session,r.revision,r.generation,r.state,JSON.stringify(r.declaration),r.format,
        JSON.stringify(r.context),JSON.stringify(r.load_reference),JSON.stringify(r.configuration),r.effect_slot,r.stopped,r.created_at]);
    await this.insertAttempt(admission,attempt);
    await this.insertIntention(admission,request,canonical,r.id,operationId);
    await this.clock(admission,'reservation-commit',request.route);
    return this.prepared(admission,request,202,await projection(admission.db,r,attempt,operationId,request.representation),operationId,{receptionId:r.id});
  }
  async insertAttempt(admission:Admission,a:any) {
    await admission.db.query('INSERT INTO $INTAKE.attempt VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [a.reception_id,a.generation,a.artifact_id,a.incarnation,a.state,a.expires_at,a.reserved_bytes,a.actual_bytes,a.actual_sha256]);
  }
  async recordIncomplete(receptionId:string,generation:number,originSession:string,unresolved:boolean) {
    const db=new IntakeStore(this.config,()=>{});
    try {
      await db.admit(false);await db.begin(['intake:reception:'+receptionId]);
      const result=(await db.query('SELECT $INTAKE.record_incomplete($1,$2,$3,$4,$5) AS recorded',
        [receptionId,generation,this.config.incarnation,originSession,unresolved])).rows[0].recorded;
      await db.commit();
      this.hooks.incomplete?.({origin:'transfer-bookkeeping',receptionId,generation,recorded:result,unresolved,atMs:Date.now()});
    } catch {
      // Do not turn a failed cleanup into a claim of safe absence or overwrite
      // the original transport/authority failure. Recovery must reconcile it.
      this.hooks.incomplete?.({origin:'transfer-bookkeeping',receptionId,generation,recorded:false,unresolved:true,atMs:Date.now()});
    } finally {await db.close();}
  }
  async profiles(admission:Admission,request:ReceptionRequest) {
    await this.authority.resolve(admission,'profiles');
    const rows=(await admission.db.query('SELECT * FROM intake_control.profile ORDER BY format')).rows;
    const available=this.config.extraction==='intake-execution/1'?await new ExtractionAuthority(this.config).availability(admission,rows):{};
    const profiles=rows.filter(row=>row.revealable).map(row=>({format_profile:row.format,configuration:row.configuration,
      original_bytes:RECEPTION_BOUNDS.originalBytes,reception_available:row.reception_enabled,processing_available:available[row.format]??false}));
    if(request.representation!==2&&profiles.some(row=>row.processing_available))throw new IntakeRepresentationFailure();
    const body={profile:'intake/1',representation:request.representation===2?'intake-availability/2':'intake-availability/1',profiles};
    if(!(request.representation===2?AVAILABILITY_RESPONSE_V2:AVAILABILITY_RESPONSE)(body))throw new IntakeFailure(503);
    await this.evidence(admission,request.route,'query');
    return this.prepared(admission,request,200,body,null);
  }
  async lookup(admission:Admission,request:ReceptionRequest,body:any) {
    await this.authority.resolve(admission,'lookup_operation');
    let row;
    if(body.by==='operation') {
      if(!uuidPattern.test(body.operation_id))throw new IntakeFailure(404);
      row=(await admission.db.query('SELECT * FROM $INTAKE.intention WHERE id=$1 AND principal=$2',[body.operation_id,admission.session.account_id])).rows[0];
    } else {
      if(!keyPattern.test(body.client_key))throw new IntakeFailure(400);
      row=(await admission.db.query('SELECT * FROM $INTAKE.intention WHERE deployment=$1 AND principal=$2 AND act=$3 AND variant=$4 AND client_key=$5',
        [this.config.deployment,admission.session.account_id,body.act,body.variant,body.client_key])).rows[0];
    }
    if(!row)throw new IntakeFailure(404);
    const {reception,attempt}=await selected(admission.db,row.reception_id,admission.session.account_id);
    await this.authority.resolve(admission,'lookup_operation',undefined,reception);
    await this.evidence(admission,request.route,'query',{operationId:row.id,receptionId:reception.id});
    return this.prepared(admission,request,200,await projection(admission.db,reception,attempt,row.id,request.representation),row.id,{receptionId:reception.id});
  }
  async finalize(admission:Admission,request:ReceptionRequest,body:any,reception:any,attempt:any,canonical:string) {
    const prior=(await admission.db.query('SELECT * FROM $INTAKE.receipt WHERE reception_id=$1',[reception.id])).rows[0];
    if(prior){await this.authority.resolve(admission,'lookup_operation',undefined,reception);return this.prepared(admission,request,200,
      await projection(admission.db,reception,attempt,prior.operation_id,request.representation),prior.operation_id,{receptionId:reception.id});}
    this.expected(body,reception,attempt);
    if(reception.stopped||reception.state!=='staged'||attempt.state!=='sealed')throw new IntakeFailure(409);
    const artifact=(await admission.db.query('SELECT * FROM $INTAKE.artifact WHERE id=$1 AND reception_id=$2 AND generation=$3',
      [attempt.artifact_id,reception.id,attempt.generation])).rows[0];
    if(!artifact||artifact.sha256!==reception.declaration.sha256||artifact.bytes!==reception.declaration.bytes)throw new IntakeFailure(503);
    const format=(await admission.db.query('SELECT * FROM intake_control.profile WHERE format=$1',[reception.format])).rows[0];
    if(!format?.reception_enabled)throw new IntakeFailure(415);
    // A previous staging check is not current availability. Evidence commits before this open.
    const readEvent=await this.evidence(admission,request.route,'read_admission',{
      receptionId:reception.id,artifactId:artifact.id,generation:artifact.generation});
    const exactOriginal={id:artifact.id,generation:artifact.generation,bytes:artifact.bytes,sha256:artifact.sha256};
    const bounded=await privatePhase(this,admission,request,readEvent.id,exactOriginal,{objects:['read']},async ports=>{
      await this.hooks.barrier?.('before_original_read',{route:request.route,evidenceId:readEvent.id,backendPid:readEvent.pid,receptionId:reception.id});
      await this.clock(admission,'finalization-original-read',request.route);
      return ports.call({action:'read',original:exactOriginal,incarnation:this.config.incarnation,evidenceId:readEvent.id});
    });
    const reread=bounded.value;
    const bytes=reread.ok&&typeof reread.data==='string'?Buffer.from(reread.data,'base64'):null;
    const valid=bytes&&bytes.length===artifact.bytes&&createHash('sha256').update(bytes).digest('hex')===artifact.sha256;
    await admission.db.query('INSERT INTO $INTAKE.availability VALUES($1,$2,$3,$4)',[randomUUID(),artifact.id,
      valid?'available':reread.outcome==='missing'?'missing':'corrupt',await admission.db.now()]);
    if(!valid)throw new IntakeFailure(503);
    admission.now=await admission.db.now();
    await this.authority.resolve(admission,request.route,undefined,reception,phase(admission,reception,attempt));
    const id=await this.insertIntention(admission,request,canonical,reception.id,randomUUID(),reception.effect_slot);
    const event=await this.evidence(admission,request.route,'effect',{operationId:id,receptionId:reception.id,artifactId:artifact.id,generation:artifact.generation});
    const receiptId=randomUUID(),jobId=randomUUID();
    await admission.db.query('INSERT INTO $INTAKE.receipt VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [receiptId,reception.id,id,reception.effect_slot,artifact.id,artifact.generation,artifact.bytes,artifact.sha256,
        reception.person_ref,admission.executor.id,JSON.stringify(admission.binding.load),event.id,admission.now]);
    await admission.db.query('INSERT INTO $INTAKE.work VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [jobId,receiptId,artifact.id,artifact.generation,JSON.stringify(format.processing_request),JSON.stringify(format.processing_plan),JSON.stringify(reception.load_reference.intention),'not_started',false]);
    await admission.db.query('SELECT $INTAKE.complete_reception($1,$2,$3)',[reception.id,attempt.generation,reception.revision]);
    reception.state='received';reception.revision++;
    await this.hooks.barrier?.('before_receipt_commit',{route:request.route,receptionId:reception.id,operationId:id});
    await this.clock(admission,'receipt-commit',request.route);
    const result=await this.prepared(admission,request,200,await projection(admission.db,reception,attempt,id,request.representation),id,{receptionId:reception.id,artifactId:artifact.id,generation:artifact.generation});
    await this.hooks.barrier?.('after_receipt_commit',{route:request.route,receptionId:reception.id,operationId:id});
    return result;
  }
  expected(body:any,reception:any,attempt:any) {
    if(body.expected_revision!==reception.revision)throw new IntakeFailure(409);
    if(body.original&&(body.original.id!==attempt.artifact_id||body.original.generation!==attempt.generation||body.original.bytes!==reception.declaration.bytes||body.original.sha256!==reception.declaration.sha256))throw new IntakeFailure(409);
    if(body.format_profile&&body.format_profile!==reception.format)throw new IntakeFailure(409);
  }
  async cancel(admission:Admission,request:ReceptionRequest,body:any,reception:any,attempt:any,canonical:string,token:string|null,onLoss:()=>void) {
    this.expected(body,reception,attempt);
    const extractionStop=await stopExtraction(this,admission,request,body,reception,attempt,canonical,token,onLoss);
    if(extractionStop)return extractionStop;
    await this.fenceAttempt(admission,request,reception,attempt);
    await admission.db.query('SELECT $INTAKE.stop_reception($1,$2,$3)',[reception.id,attempt.generation,reception.revision]);
    reception.stopped=true;reception.state='stopped';reception.revision++;
    const id=await this.insertIntention(admission,request,canonical,reception.id);
    await this.clock(admission,'stop-commit',request.route);
    return this.prepared(admission,request,200,await projection(admission.db,reception,attempt,id,request.representation),id,{receptionId:reception.id});
  }
  async resume(admission:Admission,request:ReceptionRequest,body:any,reception:any,attempt:any,canonical:string) {
    this.expected(body,reception,attempt);
    if(body.expected_generation!==attempt.generation||reception.stopped||reception.generation>=RECEPTION_BOUNDS.attempts||
      !['interrupted','reserved','receiving'].includes(reception.state)||this.activeReceptions.has(reception.id))throw new IntakeFailure(409);
    const quota=Number((await admission.db.query('SELECT coalesce(sum(reserved_bytes),0) AS n FROM $INTAKE.attempt')).rows[0].n);
    if(quota+reception.declaration.bytes>RECEPTION_BOUNDS.storageBytes)throw new IntakeFailure(429);
    await this.fenceAttempt(admission,request,reception,attempt);
    const next={...attempt,generation:reception.generation+1,artifact_id:randomUUID(),incarnation:this.config.incarnation,state:'reserved',actual_bytes:0,actual_sha256:null,
      expires_at:admission.deadline};
    await admission.db.query('SELECT $INTAKE.resume_attempt($1,$2,$3,$4,$5,$6)',[reception.id,attempt.generation,reception.revision,next.artifact_id,next.incarnation,next.expires_at]);
    reception.generation++;reception.revision++;reception.state='reserved';
    const id=await this.insertIntention(admission,request,canonical,reception.id);
    await this.clock(admission,'generation-commit',request.route);
    return this.prepared(admission,request,202,await projection(admission.db,reception,next,id,request.representation),id,{receptionId:reception.id});
  }
  async fenceAttempt(admission:Admission,request:ReceptionRequest,reception:any,attempt:any) {
    const fenceEvidence=await this.evidence(admission,request.route,'effect',{receptionId:reception.id,artifactId:attempt.artifact_id,generation:attempt.generation});
    const original={id:attempt.artifact_id,generation:attempt.generation,bytes:reception.declaration.bytes,sha256:reception.declaration.sha256};
    const bounded=await privatePhase(this,admission,request,fenceEvidence.id,original,{objects:['fence']},async ports=>{
      await this.clock(admission,'attempt-fence',request.route);
      return ports.call({action:'fence',original,incarnation:this.config.incarnation,evidenceId:fenceEvidence.id});
    });
    const fence=bounded.value;
    if(!fence.ok)throw new IntakeFailure(503);
    admission.now=await admission.db.now();
    await this.authority.resolve(admission,request.route,undefined,reception,phase(admission,reception,attempt));
  }
  async original(admission:Admission,request:ReceptionRequest,reception:any,attempt:any,operationId:string) {
    await this.authority.resolve(admission,'original',undefined,reception);
    const receipt=(await admission.db.query('SELECT * FROM $INTAKE.receipt WHERE reception_id=$1',[reception.id])).rows[0];
    if(!receipt)throw new IntakeFailure(404);
    const event=await this.evidence(admission,request.route,'read_admission',{operationId,receptionId:reception.id,artifactId:receipt.artifact_id,generation:receipt.generation});
    const original={id:receipt.artifact_id,generation:receipt.generation,bytes:receipt.bytes,sha256:receipt.sha256};
    const bounded=await privatePhase(this,admission,request,event.id,original,{objects:['read']},async ports=>{
      await this.hooks.barrier?.('before_original_read',{route:request.route,evidenceId:event.id,backendPid:event.pid,receptionId:reception.id});
      await this.clock(admission,'original-read',request.route);
      return ports.call({action:'read',original,incarnation:this.config.incarnation,evidenceId:event.id});
    });
    const read=bounded.value;
    const bytes=read.ok&&typeof read.data==='string'?Buffer.from(read.data,'base64'):null;
    const valid=bytes&&bytes.length===receipt.bytes&&createHash('sha256').update(bytes).digest('hex')===receipt.sha256;
    await admission.db.query('INSERT INTO $INTAKE.availability VALUES($1,$2,$3,$4)',[randomUUID(),receipt.artifact_id,valid?'available':read.outcome==='missing'?'missing':'corrupt',await admission.db.now()]);
    if(!valid)throw new IntakeFailure(503);
    // The phase continuation has established the new snapshot and source epoch.
    admission.now=await admission.db.now();
    await this.authority.resolve(admission,'original',undefined,reception);
    const prepared=await this.prepared(admission,request,200,null,operationId,{receptionId:reception.id,artifactId:receipt.artifact_id,generation:receipt.generation});
    prepared.originalBytes=bytes;prepared.headers={'content-type':'application/octet-stream','content-disposition':'attachment; filename="original.bin"'};
    return prepared;
  }
}
